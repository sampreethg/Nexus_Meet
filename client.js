/**
 * NexusMeet WebRTC Mesh, Screen Share, P2P File Transfer, Whiteboard & Secure JWT Auth
 *
 * Architecture & Reliability Model:
 * - Detects, explains, recovers, retries, fails safely, and logs all runtime events.
 * - End-to-End Encryption (E2EE) uses AES-256-GCM with a cryptographically random 256-bit symmetric key.
 * - Key distributed out-of-band via URL fragment (#key=...) and sessionStorage; never sent to backend.
 * - Resilient WebRTC peer connection state machine with automatic ICE restart and candidate queuing.
 * - Backpressure-protected P2P file transfer with 32-bit checksum integrity verification and retry.
 * - Centralized Error & Reliability Manager integration with safe secret redaction.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ---------------------------------------------------------------------------
  // 1. Error & Reliability Manager Integration
  // ---------------------------------------------------------------------------
  const EM = (typeof window !== 'undefined' && window.NexusErrorManager) ? window.NexusErrorManager : {
    CATEGORIES: {
      AUTH: 'AUTH', API: 'API', MEDIA: 'MEDIA', SOCKET: 'SOCKET', WEBRTC: 'WEBRTC',
      DATACHANNEL: 'DATACHANNEL', FILE_TRANSFER: 'FILE_TRANSFER', ENCRYPTION: 'ENCRYPTION',
      WHITEBOARD: 'WHITEBOARD', SCREEN_SHARE: 'SCREEN_SHARE', VALIDATION: 'VALIDATION', UNKNOWN: 'UNKNOWN'
    },
    logger: {
      debug: (cat, op, msg, ctx) => console.debug(`[NexusMeet] [DEBUG] [${cat}] [${op}]`, msg, ctx || ''),
      info: (cat, op, msg, ctx) => console.log(`[NexusMeet] [INFO] [${cat}] [${op}]`, msg, ctx || ''),
      warn: (cat, op, msg, ctx) => console.warn(`[NexusMeet] [WARN] [${cat}] [${op}]`, msg, ctx || ''),
      error: (cat, op, msg, ctx) => console.error(`[NexusMeet] [ERROR] [${cat}] [${op}]`, msg, ctx || '')
    },
    getUserFriendlyMessage: (cat, err) => err?.message || 'An unexpected issue occurred.',
    showNotification: (msg, type) => showToast(msg, type),
    apiFetch: async (url, opts) => {
      const res = await fetch(url, opts);
      return res.json();
    }
  };

  const CAT = EM.CATEGORIES;

  // ---------------------------------------------------------------------------
  // 2. Authentication Guard & Parameter Extraction
  // ---------------------------------------------------------------------------
  const urlParams = new URLSearchParams(window.location.search);
  const rawRoomParam = urlParams.get('room');
  const roomId = (rawRoomParam && rawRoomParam.trim()) ? rawRoomParam.trim().replace(/[^a-zA-Z0-9_-]/g, '') : 'nexus-alpha';

  // Set Room Header immediately so it never stays stuck on "Room: Loading..."
  const roomHeaderEl = document.getElementById('room-display-id');
  if (roomHeaderEl) {
    roomHeaderEl.textContent = `Room: ${roomId}`;
  }

  const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
  if (!token) {
    EM.logger.warn(CAT.AUTH, 'guard', 'No JWT token found in localStorage, redirecting to login.');
    window.location.href = '/login';
    return;
  }

  let verifiedUser = null;
  try {
    verifiedUser = typeof apiFetchProfile === 'function' ? await apiFetchProfile() : null;
  } catch (authErr) {
    EM.logger.warn(CAT.AUTH, 'profileFetch', 'User profile verification failed:', { error: authErr.message });
  }

  if (!verifiedUser) {
    EM.logger.warn(CAT.AUTH, 'guard', 'Unverified user token, clearing session and redirecting.');
    if (typeof clearAuthSession === 'function') clearAuthSession();
    window.location.href = '/login';
    return;
  }

  const username = verifiedUser.username;

  // Read pre-selected Lobby media preferences
  const initialMicPref = sessionStorage.getItem('nexus_initial_mic') !== 'false';
  const initialVideoPref = sessionStorage.getItem('nexus_initial_video') !== 'false';

  // Core Local State
  const localState = {
    socketId: null,
    userId: verifiedUser.id,
    username: username,
    email: verifiedUser.email,
    micOn: initialMicPref,
    videoOn: initialVideoPref,
    handRaised: false
  };

  let localStream = null;
  let screenStream = null;
  let isSharingScreen = false;
  let syntheticStreamCleanup = null;

  // Peer & Transfer State
  const participantsMap = new Map();
  const peerConnections = new Map();
  const dataChannels = new Map();
  const iceCandidateQueues = new Map();
  const peerRetryCounts = new Map();
  const activeIncomingTransfers = new Map();
  const senderFileRegistry = new Map(); // transferId -> File (for UI Retry)
  const activeObjectUrls = [];
  let sharedFilesCount = 0;

  // UI State
  let unreadChatCount = 0;
  let isSidebarOpen = true;
  let activeTab = 'chat';

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // ---------------------------------------------------------------------------
  // 3. Dynamic TURN/STUN Credentials Fetching
  // ---------------------------------------------------------------------------
  async function fetchTurnCredentials() {
    try {
      const data = await EM.apiFetch('/api/webrtc/turn-credentials', {
        headers: { 'Authorization': `Bearer ${token}` }
      }, {
        timeoutMs: 2500,
        maxRetries: 1,
        category: CAT.WEBRTC,
        operation: 'fetchTurnCredentials'
      });

      if (data && data.success && Array.isArray(data.iceServers)) {
        rtcConfig.iceServers = data.iceServers;
        EM.logger.info(CAT.WEBRTC, 'turnCredentials', 'Dynamic STUN/TURN server credentials loaded successfully.');
      }
    } catch (err) {
      EM.logger.warn(CAT.WEBRTC, 'turnCredentials', 'Dynamic TURN request unavailable, using default STUN fallbacks.');
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Local Media Acquisition (Graceful Degradation & Fallback)
  // ---------------------------------------------------------------------------
  async function initLocalMedia() {
    try {
      // 1. Attempt Full Camera + Microphone stream
      const mediaPromise = navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      const timeoutPromise = new Promise((_, reject) => {
        const tId = setTimeout(() => reject(new Error('Media acquisition timeout')), 3000);
        mediaPromise.then(() => clearTimeout(tId)).catch(() => clearTimeout(tId));
      });

      localStream = await Promise.race([mediaPromise, timeoutPromise]);
      EM.logger.info(CAT.MEDIA, 'getUserMedia', 'Acquired camera and microphone successfully.');

    } catch (err) {
      EM.logger.warn(CAT.MEDIA, 'getUserMedia', 'Full media acquisition failed. Attempting audio/video fallback...', { error: err.name || err.message });

      // 2. Try Video-Only fallback
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true });
        EM.showNotification(EM.getUserFriendlyMessage(CAT.MEDIA, err, { kind: 'audio' }), 'warning');
      } catch (videoErr) {
        // 3. Try Audio-Only fallback
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          EM.showNotification(EM.getUserFriendlyMessage(CAT.MEDIA, err, { kind: 'video' }), 'warning');
        } catch (audioErr) {
          // 4. Full Fallback to Synthetic Canvas Stream so user can still collaborate
          EM.logger.warn(CAT.MEDIA, 'fallback', 'Hardware media completely unavailable. Using synthetic fallback stream.');
          EM.showNotification(EM.getUserFriendlyMessage(CAT.MEDIA, err), 'warning', 4500);
          localStream = createSyntheticStream();
        }
      }
    }

    // Apply initial mute/video toggle preferences
    if (localStream) {
      if (localStream.getAudioTracks().length > 0) {
        localStream.getAudioTracks().forEach(t => {
          t.enabled = localState.micOn;
          t.onended = () => {
            EM.logger.warn(CAT.MEDIA, 'deviceDisconnected', 'Audio input track ended unexpectedly.');
            EM.showNotification('Microphone was disconnected.', 'warning');
          };
        });
      }
      if (localStream.getVideoTracks().length > 0) {
        localStream.getVideoTracks().forEach(t => {
          t.enabled = localState.videoOn;
          t.onended = () => {
            EM.logger.warn(CAT.MEDIA, 'deviceDisconnected', 'Video input track ended unexpectedly.');
            EM.showNotification('Camera was disconnected.', 'warning');
          };
        });
      }
    }
  }

  function createSyntheticStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    const animInterval = setInterval(() => {
      ctx.fillStyle = '#141418';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#f4f4f5';
      ctx.font = '20px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Local Feed: ${username || 'User'}`, canvas.width / 2, canvas.height / 2);
    }, 100);

    const stream = canvas.captureStream(30);
    let audioCtx = null;
    let osc = null;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
        osc = audioCtx.createOscillator();
        const dst = audioCtx.createMediaStreamDestination();
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 0.0001; // Safe virtually-silent audio track
        osc.connect(gainNode);
        gainNode.connect(dst);
        osc.start();
        const audioTrack = dst.stream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = localState.micOn;
          stream.addTrack(audioTrack);
        }
      }
    } catch (audioErr) {
      EM.logger.warn(CAT.MEDIA, 'syntheticAudio', 'AudioContext synthetic fallback failed:', { error: audioErr.message });
    }

    syntheticStreamCleanup = () => {
      clearInterval(animInterval);
      if (osc) {
        try { osc.stop(); } catch (_) {}
      }
      if (audioCtx && audioCtx.state !== 'closed') {
        try { audioCtx.close(); } catch (_) {}
      }
    };

    return stream;
  }

  // ---------------------------------------------------------------------------
  // 5. End-to-End Encryption (E2EE) Web Crypto API Layer (AES-256-GCM)
  // ---------------------------------------------------------------------------
  let roomAESKey = null;

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Fast 32-bit Adler-32 Checksum for File Chunk Integrity
  function computeAdler32(arrayBuffer) {
    let a = 1, b = 0;
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.length;
    for (let i = 0; i < len; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  /**
   * Derive or import the random 256-bit AES-GCM room key.
   * Distributed out-of-band via URL fragment (#key=...) and sessionStorage.
   * Never sent to or stored on the backend.
   */
  async function initRoomEncryption(roomIdentifier) {
    try {
      let rawKeyHex = null;

      // 1. Check URL fragment for #key=...
      const hash = window.location.hash;
      const keyMatch = hash.match(/key=([0-9a-fA-F]{64})/);
      if (keyMatch) {
        rawKeyHex = keyMatch[1];
        try {
          sessionStorage.setItem(`nexus_e2ee_key_${roomIdentifier}`, rawKeyHex);
        } catch (_) {}
      }

      // 2. Check sessionStorage fallback across page refreshes
      if (!rawKeyHex) {
        try {
          rawKeyHex = sessionStorage.getItem(`nexus_e2ee_key_${roomIdentifier}`);
          if (rawKeyHex && rawKeyHex.length === 64) {
            window.location.hash = `key=${rawKeyHex}`;
          }
        } catch (_) {}
      }

      // 3. Generate fresh 256-bit cryptographically secure random key if none exists
      if (!rawKeyHex || rawKeyHex.length !== 64) {
        const randomBytes = crypto.getRandomValues(new Uint8Array(32));
        rawKeyHex = bytesToHex(randomBytes);
        try {
          sessionStorage.setItem(`nexus_e2ee_key_${roomIdentifier}`, rawKeyHex);
        } catch (_) {}
        window.location.hash = `key=${rawKeyHex}`;
      }

      const keyBytes = hexToBytes(rawKeyHex);

      roomAESKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      EM.logger.info(CAT.ENCRYPTION, 'initKey', 'Client-side AES-256-GCM symmetric session key initialized.');
    } catch (err) {
      EM.logger.error(CAT.ENCRYPTION, 'initKey', 'Failed to initialize AES-GCM session key:', { error: err.message });
      EM.showNotification('Encryption key initialization failed. End-to-end encryption may be limited.', 'warning');
    }
  }

  async function encryptTextMessage(plainText) {
    if (!roomAESKey) return { ciphertext: plainText, iv: null, encrypted: false };
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(plainText);
      const cipherBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        roomAESKey,
        encoded
      );
      return {
        ciphertext: arrayBufferToBase64(cipherBuffer),
        iv: arrayBufferToBase64(iv),
        encrypted: true
      };
    } catch (err) {
      EM.logger.error(CAT.ENCRYPTION, 'encryptText', 'Error encrypting message:', { error: err.message });
      throw new Error('Message encryption failed');
    }
  }

  async function decryptTextMessage(ciphertextBase64, ivBase64) {
    if (!roomAESKey || !ivBase64) return ciphertextBase64;
    try {
      const iv = new Uint8Array(base64ToArrayBuffer(ivBase64));
      const cipherBuffer = base64ToArrayBuffer(ciphertextBase64);
      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        roomAESKey,
        cipherBuffer
      );
      return new TextDecoder().decode(decryptedBuffer);
    } catch (err) {
      EM.logger.warn(CAT.ENCRYPTION, 'decryptText', 'Decryption failed for incoming message.');
      return 'Unable to decrypt this message.';
    }
  }

  async function encryptBinaryChunk(chunkArrayBuffer) {
    if (!roomAESKey) return chunkArrayBuffer;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      roomAESKey,
      chunkArrayBuffer
    );
    const combined = new Uint8Array(12 + cipherBuffer.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuffer), 12);
    return combined.buffer;
  }

  async function decryptBinaryChunk(combinedArrayBuffer) {
    if (!roomAESKey) return combinedArrayBuffer;
    if (combinedArrayBuffer.byteLength < 13) {
      throw new Error('Malformed encrypted chunk buffer: too short');
    }
    const iv = new Uint8Array(combinedArrayBuffer.slice(0, 12));
    const cipherSlice = combinedArrayBuffer.slice(12);
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      roomAESKey,
      cipherSlice
    );
    return decryptedBuffer;
  }

  // Initialize Media, Encryption, and Credentials in parallel
  await Promise.all([
    initLocalMedia(),
    initRoomEncryption(roomId),
    fetchTurnCredentials()
  ]);

  // ---------------------------------------------------------------------------
  // 6. Resilient Socket.io Connection & Event Handling
  // ---------------------------------------------------------------------------
  let socket = null;
  let isSocketConnected = false;
  let reconnectCount = 0;
  const statusDot = document.getElementById('connection-status-dot');

  function updateConnectionStatusUI(status) {
    if (!statusDot) return;
    if (status === 'connected') {
      statusDot.style.backgroundColor = 'var(--status-live, #10b981)';
      statusDot.style.boxShadow = '0 0 6px var(--status-live, #10b981)';
      statusDot.title = 'Connected to conference server';
    } else if (status === 'reconnecting') {
      statusDot.style.backgroundColor = '#f59e0b';
      statusDot.style.boxShadow = '0 0 6px #f59e0b';
      statusDot.title = 'Reconnecting to conference server...';
    } else {
      statusDot.style.backgroundColor = 'var(--status-danger, #ef4444)';
      statusDot.style.boxShadow = 'none';
      statusDot.title = 'Disconnected from conference server';
    }
  }

  function safeSocketEmit(event, data) {
    if (socket && socket.connected) {
      socket.emit(event, data);
      return true;
    }
    EM.logger.warn(CAT.SOCKET, 'safeSocketEmit', `Cannot emit "${event}": Socket not connected.`);
    return false;
  }

  if (typeof io !== 'undefined') {
    try {
      socket = io({
        auth: { token: token },
        transports: ['websocket'],
        upgrade: false,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
      });
    } catch (sockInitErr) {
      EM.logger.error(CAT.SOCKET, 'init', 'Socket.io initialization error:', { error: sockInitErr.message });
      EM.showNotification('Connection initialization failed. Please reload.', 'danger');
    }
  } else {
    EM.logger.error(CAT.SOCKET, 'init', 'Socket.io client library not loaded in DOM.');
    EM.showNotification('Real-time connection unavailable. Socket.io client failed to load.', 'danger');
  }

  // ---------------------------------------------------------------------------
  // 7. WebRTC Mesh Signaling, Candidate Queuing & Reconciled Connections
  // ---------------------------------------------------------------------------

  function queueOrAddIceCandidate(targetSocketId, candidate) {
    const pc = peerConnections.get(targetSocketId);
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      if (!iceCandidateQueues.has(targetSocketId)) {
        iceCandidateQueues.set(targetSocketId, []);
      }
      iceCandidateQueues.get(targetSocketId).push(candidate);
      return;
    }

    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
      EM.logger.warn(CAT.WEBRTC, 'addIceCandidate', `Candidate error for ${targetSocketId}:`, { error: err.message });
    });
  }

  async function flushIceCandidateQueue(targetSocketId) {
    const pc = peerConnections.get(targetSocketId);
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;

    const queue = iceCandidateQueues.get(targetSocketId);
    if (!queue || queue.length === 0) return;

    iceCandidateQueues.set(targetSocketId, []);
    for (const cand of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        EM.logger.warn(CAT.WEBRTC, 'flushIceQueue', `Error applying candidate for ${targetSocketId}:`, { error: err.message });
      }
    }
  }

  function cleanUpPeerConnection(targetSocketId) {
    iceCandidateQueues.delete(targetSocketId);
    peerRetryCounts.delete(targetSocketId);

    if (dataChannels.has(targetSocketId)) {
      const dc = dataChannels.get(targetSocketId);
      try {
        dc.onmessage = null;
        dc.onopen = null;
        dc.onclose = null;
        dc.onerror = null;
        dc.close();
      } catch (_) {}
      dataChannels.delete(targetSocketId);
    }

    if (peerConnections.has(targetSocketId)) {
      const pc = peerConnections.get(targetSocketId);
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.ondatachannel = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.onsignalingstatechange = null;
        pc.close();
      } catch (_) {}
      peerConnections.delete(targetSocketId);
    }
  }

  function createPeerConnection(targetSocketId, isCaller = false) {
    if (peerConnections.has(targetSocketId)) {
      return peerConnections.get(targetSocketId);
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(targetSocketId, pc);
    if (!iceCandidateQueues.has(targetSocketId)) {
      iceCandidateQueues.set(targetSocketId, []);
    }
    if (!peerRetryCounts.has(targetSocketId)) {
      peerRetryCounts.set(targetSocketId, 0);
    }

    // Attach local media streams
    if (isSharingScreen && screenStream) {
      screenStream.getVideoTracks().forEach(track => pc.addTrack(track, screenStream));
      if (localStream) {
        localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));
      }
    } else if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    if (isCaller) {
      try {
        const dc = pc.createDataChannel('nexusFileTransfer', { ordered: true });
        setupDataChannelEvents(targetSocketId, dc);
      } catch (err) {
        EM.logger.error(CAT.DATACHANNEL, 'createChannel', 'Caller data channel creation failed:', { error: err.message });
      }
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannelEvents(targetSocketId, event.channel);
      };
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        safeSocketEmit('webrtc-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        attachRemoteMediaStream(targetSocketId, event.streams[0]);
      }
    };

    // Robust WebRTC State Machine with Automatic Recovery (DETECT → RECOVER → RETRY)
    pc.onconnectionstatechange = async () => {
      const state = pc.connectionState;
      EM.logger.info(CAT.WEBRTC, 'connectionState', `Peer ${targetSocketId} connectionState changed to: ${state}`);

      const badge = document.getElementById(`peer-badge-${targetSocketId}`);
      if (state === 'connected') {
        peerRetryCounts.set(targetSocketId, 0);
        if (badge) {
          badge.textContent = 'CONNECTED';
          badge.style.color = 'var(--status-live, #10b981)';
          badge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        }
      } else if (state === 'connecting') {
        if (badge) {
          badge.textContent = 'CONNECTING';
          badge.style.color = '#f59e0b';
          badge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
        }
      } else if (state === 'failed') {
        if (badge) {
          badge.textContent = 'RETRYING';
          badge.style.color = 'var(--status-danger, #ef4444)';
          badge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        }
        const retries = peerRetryCounts.get(targetSocketId) || 0;
        if (retries < 2) {
          peerRetryCounts.set(targetSocketId, retries + 1);
          EM.logger.warn(CAT.WEBRTC, 'recovery', `Peer ${targetSocketId} connection failed. Attempting ICE restart (${retries + 1}/2)...`);
          EM.showNotification('Connection with participant interrupted. Retrying...', 'warning');

          try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            safeSocketEmit('webrtc-offer', {
              targetSocketId: targetSocketId,
              offer: offer
            });
          } catch (restartErr) {
            EM.logger.error(CAT.WEBRTC, 'iceRestart', 'ICE restart offer failed:', { error: restartErr.message });
          }
        } else {
          EM.logger.error(CAT.WEBRTC, 'recovery', `Peer ${targetSocketId} connection permanently failed after ${retries} retries.`);
          EM.showNotification('Unable to connect to this participant. Connection unrecoverable.', 'danger');
          cleanUpPeerConnection(targetSocketId);
        }
      } else if (state === 'disconnected') {
        if (badge) {
          badge.textContent = 'DISCONNECTED';
          badge.style.color = '#f59e0b';
          badge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
        }
      } else if (state === 'closed') {
        cleanUpPeerConnection(targetSocketId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      EM.logger.info(CAT.WEBRTC, 'iceConnectionState', `Peer ${targetSocketId} ICE state: ${iceState}`);
      if (iceState === 'failed' && pc.connectionState !== 'failed') {
        EM.logger.warn(CAT.WEBRTC, 'iceConnectionState', `Peer ${targetSocketId} ICE connection failed.`);
      }
    };

    return pc;
  }

  function setupDataChannelEvents(targetSocketId, channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 65536; // 64KB backpressure threshold
    dataChannels.set(targetSocketId, channel);

    channel.onopen = () => {
      EM.logger.info(CAT.DATACHANNEL, 'onopen', `DataChannel open with peer: ${targetSocketId}`);
    };

    channel.onclose = () => {
      EM.logger.info(CAT.DATACHANNEL, 'onclose', `DataChannel closed with peer: ${targetSocketId}`);
      if (dataChannels.get(targetSocketId) === channel) {
        dataChannels.delete(targetSocketId);
      }
    };

    channel.onerror = (err) => {
      EM.logger.warn(CAT.DATACHANNEL, 'onerror', `DataChannel error with peer ${targetSocketId}:`, { error: err.message });
    };

    channel.onmessage = (event) => handleIncomingDataChannelMessage(targetSocketId, event.data);
  }

  async function initiatePeerConnection(targetSocketId) {
    if (!targetSocketId || targetSocketId === socket?.id) return;
    try {
      const pc = createPeerConnection(targetSocketId, true);
      if (pc.signalingState !== 'stable') {
        EM.logger.warn(CAT.WEBRTC, 'initiatePeer', `Skipping offer for ${targetSocketId}: signalingState is ${pc.signalingState}`);
        return;
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      safeSocketEmit('webrtc-offer', {
        targetSocketId: targetSocketId,
        offer: offer
      });
    } catch (err) {
      EM.logger.error(CAT.WEBRTC, 'initiatePeer', 'Failed to initiate peer connection offer:', { error: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Socket.io Event Listeners & Auto-Recovery
  // ---------------------------------------------------------------------------
  if (socket) {
    socket.on('connect_error', (err) => {
      EM.logger.error(CAT.SOCKET, 'connect_error', 'Socket connection error:', { error: err.message });
      updateConnectionStatusUI('reconnecting');

      if (err.message.includes('AUTHENTICATION_ERROR')) {
        EM.showNotification('Your session has expired. Please sign in again.', 'warning');
        if (typeof clearAuthSession === 'function') clearAuthSession();
        setTimeout(() => window.location.href = '/login', 1500);
      } else {
        reconnectCount++;
        EM.showNotification(`Connection lost. Reconnecting to meeting server...`, 'warning', 2500);
      }
    });

    socket.on('connect', () => {
      localState.socketId = socket.id;
      isSocketConnected = true;
      updateConnectionStatusUI('connected');
      EM.logger.info(CAT.SOCKET, 'connect', `Connected to Socket server with ID: ${socket.id}`);

      if (reconnectCount > 0) {
        EM.showNotification('Reconnected to conference server.', 'success');
        reconnectCount = 0;
      }

      // Re-join room and restore conference state
      socket.emit('join-room', {
        roomId: roomId,
        micOn: localState.micOn,
        videoOn: localState.videoOn
      });

      if (localState.handRaised) {
        socket.emit('toggle-hand-raise', { handRaised: true });
      }
    });

    socket.on('disconnect', (reason) => {
      isSocketConnected = false;
      updateConnectionStatusUI('disconnected');
      EM.logger.warn(CAT.SOCKET, 'disconnect', `Socket disconnected: ${reason}`);

      if (reason === 'io server disconnect') {
        // Server forcefully closed connection; manually reconnect
        socket.connect();
      }
      EM.showNotification('Connection to the meeting server was lost. Reconnecting...', 'warning');
    });

    // Reconciled room-users handler (does NOT destroy healthy existing connections)
    socket.on('room-users', async ({ self, users }) => {
      participantsMap.set(self.socketId, { ...self, isSelf: true });
      renderParticipantTile(self, true);
      attachLocalMediaStream(self.socketId);

      const newUserSocketIds = new Set(users.map(u => u.socketId));

      // Close and remove only peers that are no longer in the room
      for (const [existingSocketId] of peerConnections.entries()) {
        if (!newUserSocketIds.has(existingSocketId)) {
          cleanUpPeerConnection(existingSocketId);
          participantsMap.delete(existingSocketId);
          const tile = document.getElementById(`tile-${existingSocketId}`);
          if (tile) tile.remove();
        }
      }

      // Add or update participants
      for (const user of users) {
        participantsMap.set(user.socketId, { ...user, isSelf: false });
        renderParticipantTile(user, false);

        // Initiate connection only for newly joined peers without an active connection
        if (!peerConnections.has(user.socketId)) {
          await initiatePeerConnection(user.socketId);
        }
      }

      updateParticipantCounts();
      updateParticipantsListUI();
    });

    socket.on('user-connected', async (userInfo) => {
      participantsMap.set(userInfo.socketId, { ...userInfo, isSelf: false });
      renderParticipantTile(userInfo, false);
      updateParticipantCounts();
      updateParticipantsListUI();

      EM.showNotification(`${userInfo.username || 'Participant'} joined conference`, 'info');
      await initiatePeerConnection(userInfo.socketId);
    });

    socket.on('user-disconnected', ({ socketId, username: peerName }) => {
      cleanUpPeerConnection(socketId);
      participantsMap.delete(socketId);

      const tile = document.getElementById(`tile-${socketId}`);
      if (tile) tile.remove();

      updateParticipantCounts();
      updateParticipantsListUI();
      EM.showNotification(`${peerName || 'Participant'} left conference`, 'info');
    });

    socket.on('webrtc-offer', async ({ senderSocketId, offer }) => {
      try {
        const pc = createPeerConnection(senderSocketId, false);
        if (pc.signalingState !== 'stable') {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }).catch(() => {}),
            pc.setRemoteDescription(new RTCSessionDescription(offer))
          ]);
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
        }

        await flushIceCandidateQueue(senderSocketId);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        safeSocketEmit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer: answer
        });
      } catch (err) {
        EM.logger.error(CAT.WEBRTC, 'handleOffer', 'Error handling incoming SDP offer:', { error: err.message });
      }
    });

    socket.on('webrtc-answer', async ({ senderSocketId, answer }) => {
      try {
        const pc = peerConnections.get(senderSocketId);
        if (pc && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          await flushIceCandidateQueue(senderSocketId);
        }
      } catch (err) {
        EM.logger.error(CAT.WEBRTC, 'handleAnswer', 'Error setting remote answer:', { error: err.message });
      }
    });

    socket.on('webrtc-ice-candidate', ({ senderSocketId, candidate }) => {
      if (candidate) {
        queueOrAddIceCandidate(senderSocketId, candidate);
      }
    });

    socket.on('user-media-toggled', ({ socketId, micOn, videoOn }) => {
      const user = participantsMap.get(socketId);
      if (user) {
        user.micOn = micOn;
        user.videoOn = videoOn;
        updateParticipantTileState(socketId, micOn, videoOn);
        updateParticipantsListUI();
      }
    });

    socket.on('user-hand-toggled', ({ socketId, username: peerName, handRaised }) => {
      const user = participantsMap.get(socketId);
      if (user) {
        user.handRaised = handRaised;
        updateHandRaiseBadgeUI(socketId, handRaised);
        updateParticipantsListUI();
        if (handRaised && socketId !== socket.id) {
          EM.showNotification(`✋ ${peerName || 'Peer'} raised hand`, 'info');
        }
      }
    });

    socket.on('chat-message', async (data) => {
      if (data.encrypted && data.encryptedPayload && data.iv) {
        try {
          const decryptedText = await decryptTextMessage(data.encryptedPayload, data.iv);
          renderChatMessage({ ...data, message: decryptedText, isEncrypted: true });
        } catch (err) {
          renderChatMessage({ ...data, message: 'Unable to decrypt this message.', isEncrypted: true });
        }
      } else {
        renderChatMessage(data);
      }

      if (!isSidebarOpen || activeTab !== 'chat') {
        if (!data.isSystem && data.senderId !== socket.id) {
          unreadChatCount++;
          const unreadDot = document.getElementById('unread-chat-dot');
          if (unreadDot) unreadDot.style.display = 'block';
        }
      }
    });

    socket.on('whiteboard-draw', (data) => {
      if (!isValidStrokeData(data)) {
        EM.logger.warn(CAT.WHITEBOARD, 'validate', 'Ignored malformed whiteboard stroke from socket.');
        return;
      }
      whiteboardHistory.push(data);
      const rect = canvas.getBoundingClientRect();
      const x1 = data.prevX * rect.width;
      const y1 = data.prevY * rect.height;
      const x2 = data.currX * rect.width;
      const y2 = data.currY * rect.height;
      renderStroke(x1, y1, x2, y2, data.color, data.width, data.mode);
    });

    socket.on('whiteboard-history', (history) => {
      whiteboardHistory.length = 0;
      if (Array.isArray(history)) {
        history.forEach(s => {
          if (isValidStrokeData(s)) whiteboardHistory.push(s);
        });
      }
      resizeCanvas();
    });

    socket.on('whiteboard-clear', () => {
      whiteboardHistory.length = 0;
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
      EM.showNotification('Collaborative canvas cleared by peer', 'info');
    });
  }

  // ---------------------------------------------------------------------------
  // 9. Screen Sharing with replaceTrack & Native Cancellation
  // ---------------------------------------------------------------------------
  async function toggleScreenSharing() {
    if (isSharingScreen) {
      stopScreenSharing();
      return;
    }

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false
      });

      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) {
        throw new Error('No video track available in display media stream');
      }

      isSharingScreen = true;
      updateScreenShareUI(true);

      // Replace track on all active peer connection video senders
      peerConnections.forEach((pc) => {
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
          videoSender.replaceTrack(screenTrack).catch(err => {
            EM.logger.warn(CAT.SCREEN_SHARE, 'replaceTrack', 'Sender track replacement failed:', { error: err.message });
          });
        }
      });

      const localVideoEl = document.getElementById(`video-stream-${localState.socketId}`);
      const placeholder = document.getElementById(`placeholder-${localState.socketId}`);
      if (localVideoEl) {
        localVideoEl.srcObject = screenStream;
        localVideoEl.classList.remove('mirrored');
        localVideoEl.classList.remove('hidden');
      }
      if (placeholder) {
        placeholder.classList.add('hidden');
      }

      // Handle native browser "Stop sharing" chrome banner
      screenTrack.onended = () => {
        stopScreenSharing();
      };

      EM.showNotification('Screen sharing active', 'info');
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        EM.logger.error(CAT.SCREEN_SHARE, 'startScreenShare', 'Error starting screen share:', { error: err.message });
      }
      isSharingScreen = false;
      updateScreenShareUI(false);
    }
  }

  function stopScreenSharing() {
    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
      });
      screenStream = null;
    }
    isSharingScreen = false;
    updateScreenShareUI(false);

    // Restore camera video track on all peer connections
    if (localStream) {
      const cameraTrack = localStream.getVideoTracks()[0];
      if (cameraTrack) {
        cameraTrack.enabled = localState.videoOn;
        peerConnections.forEach((pc) => {
          const senders = pc.getSenders();
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          if (videoSender) {
            videoSender.replaceTrack(cameraTrack).catch(err => {
              EM.logger.warn(CAT.SCREEN_SHARE, 'restoreCamera', 'Failed to restore camera track on peer:', { error: err.message });
            });
          }
        });
      }

      const localVideoEl = document.getElementById(`video-stream-${localState.socketId}`);
      const placeholder = document.getElementById(`placeholder-${localState.socketId}`);
      if (localVideoEl) {
        localVideoEl.srcObject = localStream;
        localVideoEl.classList.add('mirrored');
        if (localState.videoOn) {
          localVideoEl.classList.remove('hidden');
          if (placeholder) placeholder.classList.add('hidden');
        } else {
          localVideoEl.classList.add('hidden');
          if (placeholder) placeholder.classList.remove('hidden');
        }
      }
    }

    EM.showNotification('Screen sharing stopped');
  }

  function updateScreenShareUI(active) {
    const screenBtn = document.getElementById('toggle-screenshare');
    if (screenBtn) {
      if (active) {
        screenBtn.className = 'control-btn screen-active';
        screenBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
        screenBtn.title = 'Stop Sharing Screen';
      } else {
        screenBtn.className = 'control-btn';
        screenBtn.innerHTML = '<i class="fa-solid fa-desktop"></i>';
        screenBtn.title = 'Share Screen';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 10. P2P File Transfer Protocol, Backpressure & Checksum Verification
  // ---------------------------------------------------------------------------
  const CHUNK_SIZE = 16384; // 16KB payload chunk

  function createChunkPacket(transferId, chunkIndex, totalChunks, checksum, encryptedChunkBuffer) {
    const enc = new TextEncoder();
    const idBytes = enc.encode(transferId);
    const headerSize = 1 + 1 + idBytes.length + 4 + 4 + 4;
    const packet = new Uint8Array(headerSize + encryptedChunkBuffer.byteLength);
    const view = new DataView(packet.buffer);

    let offset = 0;
    view.setUint8(offset++, 0x01); // Packet type: 0x01 = file-chunk
    view.setUint8(offset++, idBytes.length);
    packet.set(idBytes, offset);
    offset += idBytes.length;
    view.setUint32(offset, chunkIndex, false);
    offset += 4;
    view.setUint32(offset, totalChunks, false);
    offset += 4;
    view.setUint32(offset, checksum, false);
    offset += 4;
    packet.set(new Uint8Array(encryptedChunkBuffer), offset);

    return packet.buffer;
  }

  function parseChunkPacket(arrayBuffer) {
    if (arrayBuffer.byteLength < 14) return null;
    const view = new DataView(arrayBuffer);
    let offset = 0;
    const msgType = view.getUint8(offset++);
    if (msgType !== 0x01) return null;

    const idLen = view.getUint8(offset++);
    if (arrayBuffer.byteLength < 2 + idLen + 12) return null;

    const dec = new TextDecoder();
    const transferId = dec.decode(new Uint8Array(arrayBuffer, offset, idLen));
    offset += idLen;

    const chunkIndex = view.getUint32(offset, false);
    offset += 4;
    const totalChunks = view.getUint32(offset, false);
    offset += 4;
    const checksum = view.getUint32(offset, false);
    offset += 4;

    const payload = arrayBuffer.slice(offset);
    return { transferId, chunkIndex, totalChunks, checksum, payload };
  }

  function waitForBufferDrain(dc, threshold = 65536) {
    return new Promise((resolve, reject) => {
      if (dc.readyState !== 'open') {
        return reject(new Error('DataChannel closed during transfer'));
      }
      if (dc.bufferedAmount <= threshold) {
        return resolve();
      }

      dc.bufferedAmountLowThreshold = threshold;

      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('DataChannel disconnected before buffer drained'));
      };
      const onError = (e) => {
        cleanup();
        reject(new Error('DataChannel error: ' + (e.message || 'unknown')));
      };

      function cleanup() {
        dc.removeEventListener('bufferedamountlow', onLow);
        dc.removeEventListener('close', onClose);
        dc.removeEventListener('error', onError);
      }

      dc.addEventListener('bufferedamountlow', onLow);
      dc.addEventListener('close', onClose);
      dc.addEventListener('error', onError);
    });
  }

  async function sendFileOverDataChannel(file) {
    const openDataChannels = Array.from(dataChannels.values()).filter(dc => dc.readyState === 'open');
    if (openDataChannels.length === 0) {
      EM.showNotification('No active peer data channels available to receive file', 'warning');
      return;
    }

    const transferId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    senderFileRegistry.set(transferId, file);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    renderFileTransferCard({
      transferId: transferId,
      fileName: file.name,
      fileSize: file.size,
      isSender: true,
      progress: 0,
      isEncrypted: true
    });

    sharedFilesCount++;
    const filesBadge = document.getElementById('tab-files-count');
    if (filesBadge) {
      filesBadge.style.display = 'inline-block';
      filesBadge.textContent = sharedFilesCount.toString();
    }

    const rawMetadata = JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      totalChunks: totalChunks
    });

    const encryptedMeta = await encryptTextMessage(rawMetadata);
    const metadataMessage = JSON.stringify({
      type: 'encrypted-file-meta',
      transferId: transferId,
      payload: encryptedMeta.ciphertext,
      iv: encryptedMeta.iv
    });

    for (const dc of openDataChannels) {
      try {
        dc.send(metadataMessage);
      } catch (err) {
        EM.logger.warn(CAT.FILE_TRANSFER, 'sendMeta', 'Error sending metadata message:', { error: err.message });
      }
    }

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const rawSlice = await file.slice(start, end).arrayBuffer();
        const encryptedChunk = await encryptBinaryChunk(rawSlice);
        const checksum = computeAdler32(encryptedChunk);
        const packet = createChunkPacket(transferId, chunkIndex, totalChunks, checksum, encryptedChunk);

        for (const dc of openDataChannels) {
          if (dc.readyState !== 'open') continue;
          if (dc.bufferedAmount > 262144) {
            await waitForBufferDrain(dc, 65536);
          }
          dc.send(packet);
        }

        const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
        updateTransferProgressUI(transferId, progress);
      }

      markTransferCompleted(transferId, null, file.name);
      EM.showNotification(`Sent encrypted ${file.name} to peers`, 'info');
    } catch (err) {
      EM.logger.error(CAT.FILE_TRANSFER, 'send', 'Transfer failed:', { error: err.message });
      markTransferFailed(transferId, file.name, err.message);
      EM.showNotification(`File transfer failed: ${err.message}`, 'danger');
    }
  }

  async function handleIncomingDataChannelMessage(senderSocketId, data) {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'encrypted-file-meta') {
          const decryptedMetaStr = await decryptTextMessage(parsed.payload, parsed.iv);
          const meta = JSON.parse(decryptedMetaStr);

          activeIncomingTransfers.set(parsed.transferId, {
            meta: meta,
            chunks: new Map(),
            receivedCount: 0,
            receivedBytes: 0,
            isEncrypted: true,
            timeoutId: setTimeout(() => {
              if (activeIncomingTransfers.has(parsed.transferId)) {
                activeIncomingTransfers.delete(parsed.transferId);
                markTransferFailed(parsed.transferId, meta.fileName, 'Transfer timed out');
              }
            }, 120000)
          });

          renderFileTransferCard({
            transferId: parsed.transferId,
            fileName: meta.fileName,
            fileSize: meta.fileSize,
            isSender: false,
            progress: 0,
            isEncrypted: true
          });

          sharedFilesCount++;
          const filesBadge = document.getElementById('tab-files-count');
          if (filesBadge) {
            filesBadge.style.display = 'inline-block';
            filesBadge.textContent = sharedFilesCount.toString();
          }
        }
      } catch (err) {
        EM.logger.error(CAT.DATACHANNEL, 'parseMeta', 'Error parsing file metadata message:', { error: err.message });
      }
    } else if (data instanceof ArrayBuffer) {
      const packet = parseChunkPacket(data);
      if (!packet) {
        EM.logger.warn(CAT.FILE_TRANSFER, 'parsePacket', 'Discarded malformed binary chunk packet.');
        return;
      }

      const { transferId, chunkIndex, totalChunks, checksum, payload } = packet;
      const transfer = activeIncomingTransfers.get(transferId);
      if (!transfer) {
        return;
      }

      if (chunkIndex >= transfer.meta.totalChunks) {
        EM.logger.warn(CAT.FILE_TRANSFER, 'bounds', `Out of range chunk index: ${chunkIndex}`);
        return;
      }

      if (transfer.chunks.has(chunkIndex)) {
        return; // Duplicate chunk safely ignored
      }

      // Checksum validation
      const calculatedChecksum = computeAdler32(payload);
      if (calculatedChecksum !== checksum) {
        EM.logger.error(CAT.FILE_TRANSFER, 'checksum', `Checksum mismatch on chunk ${chunkIndex} for ${transferId}`);
        markTransferFailed(transferId, transfer.meta.fileName, 'Checksum integrity verification failed');
        activeIncomingTransfers.delete(transferId);
        return;
      }

      let decryptedChunk;
      if (transfer.isEncrypted) {
        try {
          decryptedChunk = await decryptBinaryChunk(payload);
        } catch (decErr) {
          EM.logger.error(CAT.FILE_TRANSFER, 'decryptChunk', 'Failed to decrypt binary chunk:', { error: decErr.message });
          return;
        }
      } else {
        decryptedChunk = payload;
      }

      transfer.chunks.set(chunkIndex, decryptedChunk);
      transfer.receivedCount++;
      transfer.receivedBytes += decryptedChunk.byteLength;

      const progress = Math.min(99, Math.round((transfer.receivedCount / transfer.meta.totalChunks) * 100));
      updateTransferProgressUI(transferId, progress);

      // Reconstruct file once all chunks arrive
      if (transfer.receivedCount === transfer.meta.totalChunks) {
        clearTimeout(transfer.timeoutId);

        const orderedChunks = [];
        let totalSize = 0;
        for (let i = 0; i < transfer.meta.totalChunks; i++) {
          const c = transfer.chunks.get(i);
          if (!c) {
            markTransferFailed(transferId, transfer.meta.fileName, 'Missing chunk: ' + i);
            activeIncomingTransfers.delete(transferId);
            return;
          }
          orderedChunks.push(c);
          totalSize += c.byteLength;
        }

        if (totalSize !== transfer.meta.fileSize) {
          EM.logger.error(CAT.FILE_TRANSFER, 'verifySize', `Size verification mismatch: assembled ${totalSize}, expected ${transfer.meta.fileSize}`);
          markTransferFailed(transferId, transfer.meta.fileName, 'Integrity verification failed');
          activeIncomingTransfers.delete(transferId);
          return;
        }

        const fileBlob = new Blob(orderedChunks, { type: transfer.meta.fileType });
        const downloadUrl = URL.createObjectURL(fileBlob);
        activeObjectUrls.push(downloadUrl);

        markTransferCompleted(transferId, downloadUrl, transfer.meta.fileName);
        activeIncomingTransfers.delete(transferId);
        EM.showNotification(`Decrypted & verified file: ${transfer.meta.fileName}`, 'info');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 11. DOM Injection Safety & File Transfer UI Rendering
  // ---------------------------------------------------------------------------
  function renderFileTransferCard({ transferId, fileName, fileSize, isSender, progress, isEncrypted = true }) {
    const list = document.getElementById('files-transfers-list');
    if (!list) return;

    const card = document.createElement('div');
    card.id = `transfer-${transferId}`;
    card.className = 'file-transfer-card';

    const formattedSize = formatBytes(fileSize);

    const header = document.createElement('div');
    header.className = 'transfer-header';

    const fileInfo = document.createElement('div');
    fileInfo.className = 'transfer-file-info';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'file-type-icon';
    iconDiv.innerHTML = '<i class="fa-solid fa-file"></i>';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name-text';
    nameSpan.title = fileName;
    nameSpan.textContent = fileName;

    fileInfo.appendChild(iconDiv);
    fileInfo.appendChild(nameSpan);

    const actionDiv = document.createElement('div');
    actionDiv.id = `transfer-action-${transferId}`;
    const actionText = document.createElement('span');
    actionText.style.fontSize = '0.72rem';
    actionText.style.color = 'var(--text-muted)';
    actionText.textContent = isSender ? 'Sending...' : 'Receiving...';
    actionDiv.appendChild(actionText);

    header.appendChild(fileInfo);
    header.appendChild(actionDiv);

    const progressTrack = document.createElement('div');
    progressTrack.className = 'custom-progress-track';
    const progressFill = document.createElement('div');
    progressFill.id = `progress-fill-${transferId}`;
    progressFill.className = 'custom-progress-fill';
    progressFill.style.width = `${progress}%`;
    progressTrack.appendChild(progressFill);

    const metaRow = document.createElement('div');
    metaRow.className = 'file-meta-row';

    const sizeSpan = document.createElement('span');
    sizeSpan.textContent = formattedSize;
    metaRow.appendChild(sizeSpan);

    if (isEncrypted) {
      const e2eeTag = document.createElement('span');
      e2eeTag.className = 'e2ee-file-tag';
      e2eeTag.innerHTML = '<i class="fa-solid fa-lock"></i> E2EE';
      metaRow.appendChild(e2eeTag);
    }

    const progressText = document.createElement('span');
    progressText.id = `progress-text-${transferId}`;
    progressText.textContent = `${progress}%`;
    metaRow.appendChild(progressText);

    card.appendChild(header);
    card.appendChild(progressTrack);
    card.appendChild(metaRow);

    list.prepend(card);
  }

  function updateTransferProgressUI(transferId, progress) {
    const fill = document.getElementById(`progress-fill-${transferId}`);
    const text = document.getElementById(`progress-text-${transferId}`);
    if (fill) fill.style.width = `${progress}%`;
    if (text) text.textContent = `${progress}%`;
  }

  function markTransferCompleted(transferId, downloadUrl, fileName) {
    updateTransferProgressUI(transferId, 100);
    const fill = document.getElementById(`progress-fill-${transferId}`);
    if (fill) fill.classList.add('completed');

    const actionContainer = document.getElementById(`transfer-action-${transferId}`);
    if (actionContainer) {
      actionContainer.innerHTML = '';
      if (downloadUrl) {
        const downloadLink = document.createElement('a');
        downloadLink.href = downloadUrl;
        downloadLink.download = fileName;
        downloadLink.className = 'btn-file-action';
        downloadLink.innerHTML = '<i class="fa-solid fa-download"></i> ';
        const span = document.createElement('span');
        span.textContent = 'Save';
        downloadLink.appendChild(span);
        actionContainer.appendChild(downloadLink);
      } else {
        const sentSpan = document.createElement('span');
        sentSpan.style.fontSize = '0.72rem';
        sentSpan.style.color = 'var(--status-live, #10b981)';
        sentSpan.style.fontWeight = '500';
        sentSpan.innerHTML = '<i class="fa-solid fa-check"></i> Sent';
        actionContainer.appendChild(sentSpan);
      }
    }
  }

  function markTransferFailed(transferId, fileName, reason = 'Transfer failed') {
    const fill = document.getElementById(`progress-fill-${transferId}`);
    if (fill) fill.style.backgroundColor = 'var(--status-danger, #ef4444)';

    const text = document.getElementById(`progress-text-${transferId}`);
    if (text) {
      text.textContent = 'Failed';
      text.style.color = 'var(--status-danger, #ef4444)';
    }

    const actionContainer = document.getElementById(`transfer-action-${transferId}`);
    if (actionContainer) {
      actionContainer.innerHTML = '';

      const failText = document.createElement('span');
      failText.style.fontSize = '0.72rem';
      failText.style.color = 'var(--status-danger, #ef4444)';
      failText.style.fontWeight = '500';
      failText.title = reason;
      failText.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Failed ';
      actionContainer.appendChild(failText);

      // Add actionable Retry button if this client was the sender
      if (senderFileRegistry.has(transferId)) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-retry-action';
        retryBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Retry';
        retryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const fileToRetry = senderFileRegistry.get(transferId);
          if (fileToRetry) {
            sendFileOverDataChannel(fileToRetry);
          }
        });
        actionContainer.appendChild(retryBtn);
      }
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  const dropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        sendFileOverDataChannel(e.target.files[0]);
        fileInput.value = '';
      }
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        sendFileOverDataChannel(e.dataTransfer.files[0]);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 12. Collaborative Whiteboard Engine (Validation & Rapid-Event Throttling)
  // ---------------------------------------------------------------------------
  const whiteboardOverlay = document.getElementById('whiteboard-overlay');
  const canvas = document.getElementById('whiteboard-canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;

  let isWhiteboardOpen = false;
  let isDrawing = false;
  let currentTool = 'pen';
  let currentColor = '#fafafa';
  let currentWidth = 2;
  let lastX = 0;
  let lastY = 0;
  let lastDrawEmitTime = 0;
  const whiteboardHistory = [];

  function isValidStrokeData(data) {
    if (!data || typeof data !== 'object') return false;
    const { prevX, prevY, currX, currY, color, width, mode } = data;
    if (typeof prevX !== 'number' || typeof prevY !== 'number' || typeof currX !== 'number' || typeof currY !== 'number') return false;
    if (isNaN(prevX) || isNaN(prevY) || isNaN(currX) || isNaN(currY)) return false;
    if (prevX < 0 || prevX > 1 || prevY < 0 || prevY > 1 || currX < 0 || currX > 1 || currY < 0 || currY > 1) return false;
    const safeColorRegex = /^#([0-9a-fA-F]{3,8})$|^rgba?\([\d\s,.]+\)$|^hsla?\([\d\s,.]+\)$|^[a-zA-Z]{3,20}$/;
    if (typeof color !== 'string' || !safeColorRegex.test(color.trim())) return false;
    if (typeof width !== 'number' || width < 1 || width > 50) return false;
    if (mode !== 'pen' && mode !== 'eraser') return false;
    return true;
  }

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    if (typeof ctx.resetTransform === 'function') {
      ctx.resetTransform();
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.scale(dpr, dpr);

    // Redraw all strokes from normalized coordinates
    ctx.clearRect(0, 0, rect.width, rect.height);
    for (const stroke of whiteboardHistory) {
      const x1 = stroke.prevX * rect.width;
      const y1 = stroke.prevY * rect.height;
      const x2 = stroke.currX * rect.width;
      const y2 = stroke.currY * rect.height;
      renderStroke(x1, y1, x2, y2, stroke.color, stroke.width, stroke.mode);
    }
  }

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    let clientX = e.clientX;
    let clientY = e.clientY;

    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    }

    return {
      x: (clientX - rect.left),
      y: (clientY - rect.top),
      normX: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      normY: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    };
  }

  function startDrawing(e) {
    if (e.type.startsWith('touch')) e.preventDefault();
    isDrawing = true;
    const coords = getCanvasCoords(e);
    lastX = coords.x;
    lastY = coords.y;
  }

  function draw(e) {
    if (!isDrawing) return;
    if (e.type.startsWith('touch')) e.preventDefault();

    const coords = getCanvasCoords(e);
    const rect = canvas.getBoundingClientRect();

    const prevNormX = lastX / rect.width;
    const prevNormY = lastY / rect.height;
    const currNormX = coords.normX;
    const currNormY = coords.normY;

    renderStroke(lastX, lastY, coords.x, coords.y, currentColor, currentWidth, currentTool);

    const strokeData = {
      prevX: prevNormX,
      prevY: prevNormY,
      currX: currNormX,
      currY: currNormY,
      color: currentColor,
      width: currentWidth,
      mode: currentTool
    };

    whiteboardHistory.push(strokeData);

    // Throttle socket draw emissions to 60fps max
    const now = Date.now();
    if (now - lastDrawEmitTime > 16) {
      lastDrawEmitTime = now;
      safeSocketEmit('whiteboard-draw', strokeData);
    }

    lastX = coords.x;
    lastY = coords.y;
  }

  function stopDrawing() {
    isDrawing = false;
  }

  function renderStroke(x1, y1, x2, y2, color, width, mode) {
    if (!ctx) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;

    if (mode === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = width * 3;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
    }

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  if (canvas) {
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseleave', stopDrawing);

    canvas.addEventListener('touchstart', startDrawing, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', stopDrawing);
  }

  const toggleWhiteboardBtn = document.getElementById('toggle-whiteboard-btn');
  const closeWhiteboardBtn = document.getElementById('close-whiteboard-btn');

  function openWhiteboard() {
    if (!whiteboardOverlay) return;
    whiteboardOverlay.classList.remove('hidden');
    isWhiteboardOpen = true;
    if (toggleWhiteboardBtn) toggleWhiteboardBtn.classList.add('active');
    setTimeout(resizeCanvas, 50);
    EM.showNotification('Collaborative Canvas active', 'info');
  }

  function closeWhiteboard() {
    if (!whiteboardOverlay) return;
    whiteboardOverlay.classList.add('hidden');
    isWhiteboardOpen = false;
    if (toggleWhiteboardBtn) toggleWhiteboardBtn.classList.remove('active');
  }

  if (toggleWhiteboardBtn) {
    toggleWhiteboardBtn.addEventListener('click', () => {
      if (isWhiteboardOpen) closeWhiteboard();
      else openWhiteboard();
    });
  }

  if (closeWhiteboardBtn) closeWhiteboardBtn.addEventListener('click', closeWhiteboard);
  window.addEventListener('resize', resizeCanvas);

  const toolPenBtn = document.getElementById('tool-pen');
  const toolEraserBtn = document.getElementById('tool-eraser');

  if (toolPenBtn) {
    toolPenBtn.addEventListener('click', () => {
      currentTool = 'pen';
      toolPenBtn.classList.add('active');
      if (toolEraserBtn) toolEraserBtn.classList.remove('active');
    });
  }

  if (toolEraserBtn) {
    toolEraserBtn.addEventListener('click', () => {
      currentTool = 'eraser';
      toolEraserBtn.classList.add('active');
      if (toolPenBtn) toolPenBtn.classList.remove('active');
    });
  }

  const colorSwatches = document.querySelectorAll('.color-swatch');
  colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      currentColor = e.currentTarget.getAttribute('data-color') || '#fafafa';
      colorSwatches.forEach(s => s.classList.remove('active'));
      e.currentTarget.classList.add('active');
      if (currentTool === 'eraser') {
        currentTool = 'pen';
        if (toolPenBtn) toolPenBtn.classList.add('active');
        if (toolEraserBtn) toolEraserBtn.classList.remove('active');
      }
    });
  });

  const widthBtns = document.querySelectorAll('.width-btn');
  widthBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      currentWidth = parseInt(e.currentTarget.getAttribute('data-width'), 10) || 2;
      widthBtns.forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
    });
  });

  const clearWbBtn = document.getElementById('clear-whiteboard-btn');
  if (clearWbBtn) {
    clearWbBtn.addEventListener('click', () => {
      if (confirm('Clear the collaborative canvas for everyone in the room?')) {
        whiteboardHistory.length = 0;
        if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
        safeSocketEmit('whiteboard-clear', {});
        EM.showNotification('Canvas cleared');
      }
    });
  }

  const exportWbBtn = document.getElementById('export-whiteboard-btn');
  if (exportWbBtn && canvas) {
    exportWbBtn.addEventListener('click', () => {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = canvas.width;
      exportCanvas.height = canvas.height;
      const expCtx = exportCanvas.getContext('2d');

      expCtx.fillStyle = '#09090b';
      expCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      expCtx.drawImage(canvas, 0, 0);

      const link = document.createElement('a');
      link.download = `whiteboard-${roomId}-${Date.now()}.png`;
      link.href = exportCanvas.toDataURL('image/png');
      link.click();
      EM.showNotification('Canvas snapshot exported', 'info');
    });
  }

  // ---------------------------------------------------------------------------
  // 13. Participant Video Tiles & State
  // ---------------------------------------------------------------------------
  function renderParticipantTile(user, isSelf = false) {
    const videoGrid = document.getElementById('video-grid');
    if (!videoGrid) return;

    const existingTile = document.getElementById(`tile-${user.socketId}`);
    if (existingTile) return;

    const tile = document.createElement('div');
    tile.id = `tile-${user.socketId}`;
    tile.className = `video-tile ${isSelf ? 'local-user' : ''}`;

    const safeUsername = escapeHTML(user.username || 'User');
    const initials = escapeHTML((user.username || 'U').substring(0, 2).toUpperCase());

    tile.innerHTML = `
      <div class="video-vignette-overlay"></div>
      
      <video 
        id="video-stream-${user.socketId}" 
        class="video-element-stream ${isSelf ? 'mirrored' : ''} ${user.videoOn ? '' : 'hidden'}" 
        autoplay 
        playsinline 
        ${isSelf ? 'muted' : ''}
      ></video>

      <div id="placeholder-${user.socketId}" class="video-element-placeholder ${user.videoOn ? 'hidden' : ''}">
        <div class="avatar-wrapper">
          <div class="audio-pulse-ring"></div>
          <div class="user-avatar-circle">${initials}</div>
        </div>
      </div>

      <div class="quality-badge" id="peer-badge-${user.socketId}">${isSelf ? 'HOST (YOU)' : 'CONNECTING'}</div>

      <div class="hand-raise-badge" id="hand-badge-${user.socketId}" style="display: ${user.handRaised ? 'flex' : 'none'};">
        <i class="fa-solid fa-hand"></i>
        <span>Raised</span>
      </div>

      <div class="tile-overlay-bottom">
        <div class="user-name-tag">
          <span>${safeUsername} ${isSelf ? '(You)' : ''}</span>
        </div>

        <div class="tile-badges-right">
          <div class="status-icon-pill ${user.micOn ? '' : 'muted'}" id="mic-status-${user.socketId}">
            <i class="fa-solid ${user.micOn ? 'fa-microphone' : 'fa-microphone-slash'}"></i>
          </div>
        </div>
      </div>
    `;

    videoGrid.appendChild(tile);
  }

  function attachLocalMediaStream(socketId) {
    const videoEl = document.getElementById(`video-stream-${socketId}`);
    if (videoEl && localStream) videoEl.srcObject = localStream;
  }

  function attachRemoteMediaStream(socketId, remoteStream) {
    const videoEl = document.getElementById(`video-stream-${socketId}`);
    if (videoEl) {
      videoEl.srcObject = remoteStream;
      videoEl.classList.remove('hidden');

      const placeholder = document.getElementById(`placeholder-${socketId}`);
      if (placeholder) placeholder.classList.add('hidden');
    }
  }

  function updateParticipantTileState(socketId, micOn, videoOn) {
    const micIconPill = document.getElementById(`mic-status-${socketId}`);
    if (micIconPill) {
      micIconPill.className = `status-icon-pill ${micOn ? '' : 'muted'}`;
      micIconPill.innerHTML = `<i class="fa-solid ${micOn ? 'fa-microphone' : 'fa-microphone-slash'}"></i>`;
    }

    const videoEl = document.getElementById(`video-stream-${socketId}`);
    const placeholder = document.getElementById(`placeholder-${socketId}`);

    if (videoEl && placeholder) {
      if (videoOn) {
        videoEl.classList.remove('hidden');
        placeholder.classList.add('hidden');
      } else {
        videoEl.classList.add('hidden');
        placeholder.classList.remove('hidden');
      }
    }
  }

  function updateHandRaiseBadgeUI(socketId, handRaised) {
    const handBadge = document.getElementById(`hand-badge-${socketId}`);
    if (handBadge) handBadge.style.display = handRaised ? 'flex' : 'none';
  }

  function updateParticipantCounts() {
    const totalCount = participantsMap.size;
    const videoGrid = document.getElementById('video-grid');
    if (videoGrid) videoGrid.setAttribute('data-participants', totalCount.toString());

    const tabCount = document.getElementById('tab-participant-count');
    if (tabCount) tabCount.textContent = totalCount.toString();

    const dockCount = document.getElementById('dock-participant-badge');
    if (dockCount) dockCount.textContent = totalCount.toString();
  }

  function updateParticipantsListUI() {
    const listContainer = document.getElementById('participants-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    participantsMap.forEach((user) => {
      const initials = escapeHTML((user.username || 'U').substring(0, 2).toUpperCase());
      const isSelf = socket && user.socketId === socket.id;

      const item = document.createElement('div');
      item.className = 'participant-item';
      item.innerHTML = `
        <div class="participant-info">
          <div class="mini-avatar">${initials}</div>
          <div class="participant-name-group">
            <span class="participant-name">${escapeHTML(user.username || 'User')} ${isSelf ? '(You)' : ''}</span>
            <span class="participant-tag">${isSelf ? 'Host / Verified' : 'Peer / Verified'}</span>
          </div>
        </div>

        <div class="participant-actions">
          ${user.handRaised ? `<span class="mini-status-icon active" title="Hand Raised">✋</span>` : ''}
          <span class="mini-status-icon ${user.micOn ? 'active' : 'off'}">
            <i class="fa-solid ${user.micOn ? 'fa-microphone' : 'fa-microphone-slash'}"></i>
          </span>
          <span class="mini-status-icon ${user.videoOn ? 'active' : 'off'}">
            <i class="fa-solid ${user.videoOn ? 'fa-video' : 'fa-video-slash'}"></i>
          </span>
        </div>
      `;
      listContainer.appendChild(item);
    });
  }

  // ---------------------------------------------------------------------------
  // 14. Media Control Buttons
  // ---------------------------------------------------------------------------
  const micBtn = document.getElementById('toggle-mic');
  if (micBtn) {
    micBtn.className = `control-btn ${localState.micOn ? 'active' : 'muted'}`;
    micBtn.innerHTML = `<i class="fa-solid ${localState.micOn ? 'fa-microphone' : 'fa-microphone-slash'}"></i>`;

    micBtn.addEventListener('click', () => {
      localState.micOn = !localState.micOn;
      if (localStream && localStream.getAudioTracks().length > 0) {
        localStream.getAudioTracks().forEach(track => track.enabled = localState.micOn);
      }

      micBtn.className = `control-btn ${localState.micOn ? 'active' : 'muted'}`;
      micBtn.innerHTML = `<i class="fa-solid ${localState.micOn ? 'fa-microphone' : 'fa-microphone-slash'}"></i>`;

      if (socket && socket.id) {
        updateParticipantTileState(socket.id, localState.micOn, localState.videoOn);
        safeSocketEmit('toggle-media-state', { micOn: localState.micOn, videoOn: localState.videoOn });
      }
      updateParticipantsListUI();
      EM.showNotification(localState.micOn ? 'Microphone unmuted' : 'Microphone muted');
    });
  }

  const videoBtn = document.getElementById('toggle-video');
  if (videoBtn) {
    videoBtn.className = `control-btn ${localState.videoOn ? 'active' : 'off'}`;
    videoBtn.innerHTML = `<i class="fa-solid ${localState.videoOn ? 'fa-video' : 'fa-video-slash'}"></i>`;

    videoBtn.addEventListener('click', () => {
      localState.videoOn = !localState.videoOn;
      if (localStream && localStream.getVideoTracks().length > 0) {
        localStream.getVideoTracks().forEach(track => track.enabled = localState.videoOn);
      }

      videoBtn.className = `control-btn ${localState.videoOn ? 'active' : 'off'}`;
      videoBtn.innerHTML = `<i class="fa-solid ${localState.videoOn ? 'fa-video' : 'fa-video-slash'}"></i>`;

      if (socket && socket.id) {
        updateParticipantTileState(socket.id, localState.micOn, localState.videoOn);
        safeSocketEmit('toggle-media-state', { micOn: localState.micOn, videoOn: localState.videoOn });
      }
      updateParticipantsListUI();
      EM.showNotification(localState.videoOn ? 'Camera turned on' : 'Camera turned off');
    });
  }

  const screenShareBtn = document.getElementById('toggle-screenshare');
  if (screenShareBtn) {
    screenShareBtn.addEventListener('click', () => toggleScreenSharing());
  }

  const handBtn = document.getElementById('toggle-hand');
  if (handBtn) {
    handBtn.addEventListener('click', () => {
      localState.handRaised = !localState.handRaised;
      handBtn.classList.toggle('active', localState.handRaised);

      if (socket && socket.id) {
        updateHandRaiseBadgeUI(socket.id, localState.handRaised);
        safeSocketEmit('toggle-hand-raise', { handRaised: localState.handRaised });
      }
      updateParticipantsListUI();
      EM.showNotification(localState.handRaised ? 'Hand raised' : 'Hand lowered');
    });
  }

  // ---------------------------------------------------------------------------
  // 15. Sidebar Tabs & Toggles
  // ---------------------------------------------------------------------------
  const sidebar = document.getElementById('sidebar');

  const toggleChatBtn = document.getElementById('toggle-chat-btn');
  if (toggleChatBtn) {
    toggleChatBtn.addEventListener('click', () => {
      if (!isSidebarOpen) {
        sidebar.classList.remove('collapsed');
        isSidebarOpen = true;
        switchTab('chat');
      } else if (activeTab === 'chat') {
        sidebar.classList.add('collapsed');
        isSidebarOpen = false;
      } else {
        switchTab('chat');
      }
    });
  }

  const toggleFilesBtn = document.getElementById('toggle-files-btn');
  if (toggleFilesBtn) {
    toggleFilesBtn.addEventListener('click', () => {
      if (!isSidebarOpen) {
        sidebar.classList.remove('collapsed');
        isSidebarOpen = true;
        switchTab('files');
      } else if (activeTab === 'files') {
        sidebar.classList.add('collapsed');
        isSidebarOpen = false;
      } else {
        switchTab('files');
      }
    });
  }

  const toggleParticipantsBtn = document.getElementById('toggle-participants-btn');
  if (toggleParticipantsBtn) {
    toggleParticipantsBtn.addEventListener('click', () => {
      if (!isSidebarOpen) {
        sidebar.classList.remove('collapsed');
        isSidebarOpen = true;
        switchTab('participants');
      } else if (activeTab === 'participants') {
        sidebar.classList.add('collapsed');
        isSidebarOpen = false;
      } else {
        switchTab('participants');
      }
    });
  }

  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => switchTab(e.currentTarget.getAttribute('data-tab')));
  });

  function switchTab(tabName) {
    activeTab = tabName;
    tabBtns.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName));

    const chatPanel = document.getElementById('chat-panel');
    const filesPanel = document.getElementById('files-panel');
    const peersPanel = document.getElementById('participants-panel');

    if (chatPanel) chatPanel.classList.toggle('hidden', tabName !== 'chat');
    if (filesPanel) filesPanel.classList.toggle('hidden', tabName !== 'files');
    if (peersPanel) peersPanel.classList.toggle('hidden', tabName !== 'participants');

    if (tabName === 'chat') {
      unreadChatCount = 0;
      const unreadDot = document.getElementById('unread-chat-dot');
      if (unreadDot) unreadDot.style.display = 'none';
    }
  }

  // ---------------------------------------------------------------------------
  // 16. Chat Form & XSS-Immune Message Rendering
  // ---------------------------------------------------------------------------
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = chatInput.value.trim();
      if (!msg) return;

      chatInput.value = '';
      try {
        const encrypted = await encryptTextMessage(msg);
        safeSocketEmit('send-chat-message', {
          encryptedPayload: encrypted.ciphertext,
          iv: encrypted.iv,
          encrypted: encrypted.encrypted,
          // Zero plaintext sent to server when encryption is active
          message: encrypted.encrypted ? null : msg
        });
      } catch (err) {
        EM.logger.error(CAT.CHAT, 'send', 'Error encrypting chat message:', { error: err.message });
        safeSocketEmit('send-chat-message', { message: msg });
      }
    });
  }

  function renderChatMessage(data) {
    const chatContainer = document.getElementById('chat-messages');
    if (!chatContainer) return;

    const bubble = document.createElement('div');

    if (data.isSystem) {
      bubble.className = 'chat-bubble system';
      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = data.message;
      bubble.appendChild(body);
    } else {
      const isSelf = socket && data.senderId === socket.id;
      bubble.className = `chat-bubble ${isSelf ? 'self' : 'other'}`;

      const senderInfo = document.createElement('div');
      senderInfo.className = 'chat-sender-info';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = data.username || 'User';

      const dotSpan = document.createElement('span');
      dotSpan.textContent = '•';

      const timeSpan = document.createElement('span');
      timeSpan.textContent = data.timestamp || '';

      senderInfo.appendChild(nameSpan);
      senderInfo.appendChild(dotSpan);
      senderInfo.appendChild(timeSpan);

      if (data.isEncrypted) {
        const lockSpan = document.createElement('span');
        lockSpan.className = 'e2ee-shield-icon';
        lockSpan.title = 'End-to-End Encrypted (AES-256-GCM)';
        lockSpan.innerHTML = '<i class="fa-solid fa-lock"></i>';
        senderInfo.appendChild(lockSpan);
      }

      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = data.message; // Safe DOM textContent prevents HTML injection / XSS

      bubble.appendChild(senderInfo);
      bubble.appendChild(body);
    }

    chatContainer.appendChild(bubble);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    if (!toast || !msgEl) return;

    msgEl.textContent = message;
    toast.className = 'toast-notification show';
    if (type === 'danger' || type === 'error') {
      toast.classList.add('toast-danger');
    } else if (type === 'warning') {
      toast.classList.add('toast-warning');
    } else if (type === 'success') {
      toast.classList.add('toast-success');
    } else {
      toast.classList.add('toast-info');
    }

    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
  }

  // ---------------------------------------------------------------------------
  // 17. Room Link Sharing (Includes E2EE Key Fragment)
  // ---------------------------------------------------------------------------
  const copyBtn = document.getElementById('copy-room-link-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const fullUrl = window.location.origin + `/room?room=${encodeURIComponent(roomId)}${window.location.hash}`;
      navigator.clipboard.writeText(fullUrl).then(() => {
        EM.showNotification('Secure room invite link (with E2EE key) copied!');
      }).catch(() => {
        EM.showNotification(`Room ID: ${roomId}`);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 18. Comprehensive Room Teardown & Resource Cleanup
  // ---------------------------------------------------------------------------
  function cleanupRoomResources() {
    EM.logger.info(CAT.UNKNOWN, 'teardown', 'Cleaning up all room media, peer connections, and channels.');

    if (localStream) {
      localStream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
      });
      localStream = null;
    }

    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
      });
      screenStream = null;
    }

    if (syntheticStreamCleanup) {
      try { syntheticStreamCleanup(); } catch (_) {}
      syntheticStreamCleanup = null;
    }

    peerConnections.forEach((pc, id) => {
      cleanUpPeerConnection(id);
    });
    peerConnections.clear();
    dataChannels.clear();
    iceCandidateQueues.clear();
    peerRetryCounts.clear();

    for (const url of activeObjectUrls) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    activeObjectUrls.length = 0;

    for (const transfer of activeIncomingTransfers.values()) {
      if (transfer.timeoutId) clearTimeout(transfer.timeoutId);
    }
    activeIncomingTransfers.clear();
    senderFileRegistry.clear();

    if (socket) {
      try { socket.disconnect(); } catch (_) {}
      socket = null;
    }
  }

  const leaveBtn = document.getElementById('leave-call-btn');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to leave this conference?')) {
        cleanupRoomResources();
        window.location.href = '/lobby';
      }
    });
  }

  window.addEventListener('beforeunload', () => {
    cleanupRoomResources();
  });
});
