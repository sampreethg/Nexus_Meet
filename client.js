/**
 * NexusMeet WebRTC Mesh, Screen Share, P2P File Transfer, Whiteboard & Secure JWT Auth
 *
 * Security Model:
 * - End-to-End Encryption (E2EE) uses AES-256-GCM with a cryptographically random 256-bit symmetric key.
 * - The room secret is distributed out-of-band via URL fragments (#key=...) and stored in sessionStorage.
 * - URL fragments are never transmitted to the HTTP server in request paths.
 * - The backend signaling server never receives or stores plaintext encryption keys or room secrets.
 * - Every encryption operation (chat messages and binary file chunks) uses a fresh, cryptographically
 *   unique 12-byte initialization vector (IV) generated via crypto.getRandomValues().
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ---------------------------------------------------------------------------
  // 1. Authentication Guard & Parameter Extraction
  // ---------------------------------------------------------------------------
  const urlParams = new URLSearchParams(window.location.search);
  const roomId = urlParams.get('room') || 'nexus-alpha';

  // Set Room Header immediately so it never stays stuck on "Room: Loading..."
  const roomHeaderEl = document.getElementById('room-display-id');
  if (roomHeaderEl) {
    roomHeaderEl.textContent = `Room: ${roomId}`;
  }

  const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
  if (!token) {
    window.location.href = '/login';
    return;
  }

  let verifiedUser = null;
  try {
    verifiedUser = typeof apiFetchProfile === 'function' ? await apiFetchProfile() : null;
  } catch (authErr) {
    console.warn('[Auth] Profile fetch failed:', authErr.message);
  }

  if (!verifiedUser) {
    if (typeof clearAuthSession === 'function') clearAuthSession();
    window.location.href = '/login';
    return;
  }

  const username = verifiedUser.username;

  // Read pre-selected Lobby media preferences if available
  const initialMicPref = sessionStorage.getItem('nexus_initial_mic') !== 'false';
  const initialVideoPref = sessionStorage.getItem('nexus_initial_video') !== 'false';

  // Local State
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

  const participantsMap = new Map();
  const peerConnections = new Map();
  const dataChannels = new Map();
  const iceCandidateQueues = new Map();
  const activeIncomingTransfers = new Map();
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

  /**
   * Securely fetch dynamic STUN and TURN server credentials from the backend
   * before initializing RTCPeerConnection instances.
   */
  async function fetchTurnCredentials() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch('/api/webrtc/turn-credentials', {
        headers: {
          'Authorization': `Bearer ${token}`
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        const data = await response.json();
        if (data.success && Array.isArray(data.iceServers)) {
          rtcConfig.iceServers = data.iceServers;
          console.log('[WebRTC] Dynamic STUN/TURN server credentials loaded successfully.');
        }
      }
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('[WebRTC] Dynamic TURN credentials unavailable, using fallback STUN servers.');
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Local Media Acquisition & Fallback Synthetic Stream
  // ---------------------------------------------------------------------------
  async function initLocalMedia() {
    try {
      const mediaPromise = navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Media acquisition timeout')), 3000)
      );

      localStream = await Promise.race([mediaPromise, timeoutPromise]);

      if (localStream.getAudioTracks().length > 0) {
        localStream.getAudioTracks().forEach(t => t.enabled = localState.micOn);
      }
      if (localStream.getVideoTracks().length > 0) {
        localStream.getVideoTracks().forEach(t => t.enabled = localState.videoOn);
      }
      console.log('[Media] Local camera and microphone stream acquired.');
    } catch (err) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (localStream.getVideoTracks().length > 0) {
          localStream.getVideoTracks().forEach(t => t.enabled = localState.videoOn);
        }
      } catch (e1) {
        console.warn('[Media] Using synthetic canvas fallback stream:', err.message);
        localStream = createSyntheticStream();
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
        gainNode.gain.value = 0.0001; // Safe silent audio track
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
      console.warn('[Media] AudioContext synthetic fallback failed:', audioErr.message);
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
  // 3. End-to-End Encryption (E2EE) Web Crypto API Layer (AES-256-GCM)
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

  /**
   * Initialize a cryptographically random 256-bit AES-GCM room key.
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

      // 2. Check sessionStorage fallback across page reloads
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

      console.log('[E2EE] Client-side AES-256-GCM session key initialized successfully.');
    } catch (err) {
      console.error('[E2EE] Failed to initialize AES-GCM key:', err.message);
    }
  }

  /**
   * Encrypt text payload with AES-GCM using a cryptographically unique 12-byte IV.
   */
  async function encryptTextMessage(plainText) {
    if (!roomAESKey) return { ciphertext: plainText, iv: null, encrypted: false };
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
  }

  /**
   * Decrypt AES-GCM text payload using the room key and provided IV.
   */
  async function decryptTextMessage(ciphertextBase64, ivBase64) {
    if (!roomAESKey || !ivBase64) return ciphertextBase64;
    const iv = new Uint8Array(base64ToArrayBuffer(ivBase64));
    const cipherBuffer = base64ToArrayBuffer(ciphertextBase64);
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      roomAESKey,
      cipherBuffer
    );
    return new TextDecoder().decode(decryptedBuffer);
  }

  /**
   * Encrypt binary chunk for WebRTC DataChannel file transfer.
   * Prepends a fresh 12-byte IV directly to the encrypted chunk buffer.
   */
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

  /**
   * Decrypt binary chunk received over WebRTC DataChannel.
   * Extracts the leading 12-byte IV and decrypts the remaining payload.
   */
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

  // Run media acquisition, E2EE key setup, and TURN credential fetching in parallel
  await Promise.all([
    initLocalMedia(),
    initRoomEncryption(roomId),
    fetchTurnCredentials()
  ]);

  // ---------------------------------------------------------------------------
  // 4. Authenticated Socket.io Connection & Safe Emission Helper
  // ---------------------------------------------------------------------------
  let socket = null;
  const statusDot = document.getElementById('connection-status-dot');

  function safeSocketEmit(event, data) {
    if (socket && socket.connected) {
      socket.emit(event, data);
      return true;
    }
    return false;
  }

  if (typeof io !== 'undefined') {
    try {
      socket = io({
        auth: { token: token },
        transports: ['websocket'],
        upgrade: false
      });
    } catch (sockInitErr) {
      console.error('[Socket] Initialization error:', sockInitErr);
      showToast('Connection initialization failed. Please reload.', 'danger');
    }
  } else {
    console.error('[Socket] Socket.io client library unavailable.');
    showToast('Real-time connection unavailable. Socket.io client failed to load.', 'danger');
  }

  // ---------------------------------------------------------------------------
  // 5. WebRTC Mesh Signaling, Candidate Queuing & Reconciled Peer Connections
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
      console.warn(`[WebRTC ICE] Candidate error for ${targetSocketId}:`, err.message);
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
        console.warn(`[WebRTC ICE] Error flushing candidate for ${targetSocketId}:`, err.message);
      }
    }
  }

  function cleanUpPeerConnection(targetSocketId) {
    iceCandidateQueues.delete(targetSocketId);

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

    // Attach active media tracks (screen video or camera, along with local microphone audio)
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
        console.error('[WebRTC DataChannel] Error creating caller data channel:', err);
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

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[WebRTC] Peer ${targetSocketId} connectionState: ${state}`);
      if (state === 'failed') {
        console.warn(`[WebRTC] Peer ${targetSocketId} connection permanently failed.`);
        cleanUpPeerConnection(targetSocketId);
        showToast('A peer connection experienced an unrecoverable failure.', 'warning');
      } else if (state === 'closed') {
        cleanUpPeerConnection(targetSocketId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      if (iceState === 'failed') {
        console.warn(`[WebRTC] Peer ${targetSocketId} ICE connection failed.`);
      }
    };

    return pc;
  }

  function setupDataChannelEvents(targetSocketId, channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 65536; // 64KB backpressure threshold
    dataChannels.set(targetSocketId, channel);

    channel.onopen = () => console.log(`[DataChannel] Connected with peer: ${targetSocketId}`);
    channel.onclose = () => {
      if (dataChannels.get(targetSocketId) === channel) {
        dataChannels.delete(targetSocketId);
      }
    };
    channel.onerror = (err) => {
      console.warn(`[DataChannel] Error on peer channel ${targetSocketId}:`, err);
    };
    channel.onmessage = (event) => handleIncomingDataChannelMessage(targetSocketId, event.data);
  }

  async function initiatePeerConnection(targetSocketId) {
    if (!targetSocketId || targetSocketId === socket?.id) return;
    try {
      const pc = createPeerConnection(targetSocketId, true);
      if (pc.signalingState !== 'stable') {
        console.warn(`[WebRTC] Peer ${targetSocketId} signalingState is ${pc.signalingState}, skipping duplicate offer.`);
        return;
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      safeSocketEmit('webrtc-offer', {
        targetSocketId: targetSocketId,
        offer: offer
      });
    } catch (err) {
      console.error('[WebRTC] Error initiating peer offer:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Socket.io Event Listeners (Safe & Bound)
  // ---------------------------------------------------------------------------
  if (socket) {
    socket.on('connect_error', (err) => {
      console.error('[Socket Error]', err.message);
      if (statusDot) {
        statusDot.style.backgroundColor = 'var(--status-danger)';
        statusDot.style.boxShadow = 'none';
      }
      if (err.message.includes('AUTHENTICATION_ERROR')) {
        showToast('Session expired. Please log in again.', 'warning');
        if (typeof clearAuthSession === 'function') clearAuthSession();
        setTimeout(() => window.location.href = '/login', 1500);
      } else {
        showToast('Server connection failed. Retrying...', 'warning');
      }
    });

    socket.on('connect', () => {
      localState.socketId = socket.id;
      if (statusDot) {
        statusDot.style.backgroundColor = 'var(--status-live)';
        statusDot.style.boxShadow = '0 0 6px var(--status-live)';
      }

      socket.emit('join-room', {
        roomId: roomId,
        micOn: localState.micOn,
        videoOn: localState.videoOn
      });
    });

    socket.on('disconnect', (reason) => {
      if (statusDot) {
        statusDot.style.backgroundColor = 'var(--status-danger)';
        statusDot.style.boxShadow = 'none';
      }
      showToast(`Disconnected from conference: ${reason}`, 'warning');
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

      showToast(`${userInfo.username || 'Participant'} joined conference`, 'info');
      await initiatePeerConnection(userInfo.socketId);
    });

    socket.on('user-disconnected', ({ socketId, username }) => {
      cleanUpPeerConnection(socketId);
      participantsMap.delete(socketId);

      const tile = document.getElementById(`tile-${socketId}`);
      if (tile) tile.remove();

      updateParticipantCounts();
      updateParticipantsListUI();
      showToast(`${username || 'Participant'} left conference`, 'info');
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
        console.error('[WebRTC] Error handling SDP offer:', err);
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
        console.error('[WebRTC] Error setting remote answer:', err);
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
          showToast(`✋ ${peerName || 'Peer'} raised hand`, 'info');
        }
      }
    });

    socket.on('chat-message', async (data) => {
      if (data.encrypted && data.encryptedPayload && data.iv) {
        try {
          const decryptedText = await decryptTextMessage(data.encryptedPayload, data.iv);
          renderChatMessage({ ...data, message: decryptedText, isEncrypted: true });
        } catch (err) {
          console.error('[E2EE] Error decrypting incoming chat message:', err);
          renderChatMessage({ ...data, message: '[🔒 Decryption error: Invalid key or message corrupted]', isEncrypted: true });
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
        history.forEach(s => whiteboardHistory.push(s));
      }
      resizeCanvas();
    });

    socket.on('whiteboard-clear', () => {
      whiteboardHistory.length = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      showToast('Collaborative canvas cleared by peer', 'info');
    });
  }

  // ---------------------------------------------------------------------------
  // 7. Screen Sharing with replaceTrack & Native Cancellation
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
          videoSender.replaceTrack(screenTrack);
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

      showToast('Screen sharing active', 'info');
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        console.error('[ScreenShare] Error starting screen share:', err);
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
            videoSender.replaceTrack(cameraTrack);
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

    showToast('Screen sharing stopped');
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
  // 8. P2P File Transfer Protocol & RTCDataChannel Backpressure
  // ---------------------------------------------------------------------------
  const CHUNK_SIZE = 16384; // 16KB payload chunk

  function createChunkPacket(transferId, chunkIndex, totalChunks, encryptedChunkBuffer) {
    const enc = new TextEncoder();
    const idBytes = enc.encode(transferId);
    const headerSize = 1 + 1 + idBytes.length + 4 + 4;
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
    packet.set(new Uint8Array(encryptedChunkBuffer), offset);

    return packet.buffer;
  }

  function parseChunkPacket(arrayBuffer) {
    if (arrayBuffer.byteLength < 10) return null;
    const view = new DataView(arrayBuffer);
    let offset = 0;
    const msgType = view.getUint8(offset++);
    if (msgType !== 0x01) return null;

    const idLen = view.getUint8(offset++);
    if (arrayBuffer.byteLength < 2 + idLen + 8) return null;

    const dec = new TextDecoder();
    const transferId = dec.decode(new Uint8Array(arrayBuffer, offset, idLen));
    offset += idLen;

    const chunkIndex = view.getUint32(offset, false);
    offset += 4;
    const totalChunks = view.getUint32(offset, false);
    offset += 4;

    const payload = arrayBuffer.slice(offset);
    return { transferId, chunkIndex, totalChunks, payload };
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
      showToast('No active peer data channels available to receive file', 'warning');
      return;
    }

    const transferId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    renderFileTransferCard({
      transferId: transferId,
      fileName: file.name,
      fileSize: file.size,
      isSender: true,
      progress: 0,
      isEncrypted: true
    });

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
        console.warn('[DataChannel] Error sending metadata message:', err);
      }
    }

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const rawSlice = await file.slice(start, end).arrayBuffer();
        const encryptedChunk = await encryptBinaryChunk(rawSlice);
        const packet = createChunkPacket(transferId, chunkIndex, totalChunks, encryptedChunk);

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
      showToast(`Sent encrypted ${file.name} to peers`, 'info');
    } catch (err) {
      console.error('[DataChannel Transfer Error]', err);
      markTransferFailed(transferId, file.name, err.message);
      showToast(`File transfer failed: ${err.message}`, 'danger');
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
            }, 180000)
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
        console.error('[DataChannel] Error parsing metadata message:', err);
      }
    } else if (data instanceof ArrayBuffer) {
      const packet = parseChunkPacket(data);
      if (!packet) {
        console.warn('[DataChannel] Discarded malformed binary chunk');
        return;
      }

      const { transferId, chunkIndex, totalChunks, payload } = packet;
      const transfer = activeIncomingTransfers.get(transferId);
      if (!transfer) {
        return;
      }

      if (chunkIndex >= transfer.meta.totalChunks) {
        console.warn(`[DataChannel] Out of range chunk index: ${chunkIndex}`);
        return;
      }

      if (transfer.chunks.has(chunkIndex)) {
        return; // Duplicate chunk
      }

      let decryptedChunk;
      if (transfer.isEncrypted) {
        try {
          decryptedChunk = await decryptBinaryChunk(payload);
        } catch (decErr) {
          console.error('[DataChannel] Failed to decrypt chunk:', decErr);
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

      // Reconstruct only when all required chunks have arrived
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
          console.error(`[DataChannel] File size verification mismatch: assembled ${totalSize}, expected ${transfer.meta.fileSize}`);
          markTransferFailed(transferId, transfer.meta.fileName, 'Integrity verification failed');
          activeIncomingTransfers.delete(transferId);
          return;
        }

        const fileBlob = new Blob(orderedChunks, { type: transfer.meta.fileType });
        const downloadUrl = URL.createObjectURL(fileBlob);
        activeObjectUrls.push(downloadUrl);

        markTransferCompleted(transferId, downloadUrl, transfer.meta.fileName);
        activeIncomingTransfers.delete(transferId);
        showToast(`Decrypted & verified file: ${transfer.meta.fileName}`, 'info');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 9. DOM Injection Safety & File Transfer UI Rendering
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
        sentSpan.style.color = 'var(--status-live)';
        sentSpan.style.fontWeight = '500';
        sentSpan.innerHTML = '<i class="fa-solid fa-check"></i> Sent';
        actionContainer.appendChild(sentSpan);
      }
    }
  }

  function markTransferFailed(transferId, fileName, reason = 'Transfer failed') {
    const fill = document.getElementById(`progress-fill-${transferId}`);
    if (fill) fill.style.backgroundColor = 'var(--status-danger)';

    const text = document.getElementById(`progress-text-${transferId}`);
    if (text) {
      text.textContent = 'Failed';
      text.style.color = 'var(--status-danger)';
    }

    const actionContainer = document.getElementById(`transfer-action-${transferId}`);
    if (actionContainer) {
      actionContainer.innerHTML = `
        <span style="font-size: 0.72rem; color: var(--status-danger); font-weight: 500;" title="${escapeHTML(reason)}">
          <i class="fa-solid fa-triangle-exclamation"></i> Failed
        </span>
      `;
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
  // 10. Collaborative Whiteboard Engine
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
  const whiteboardHistory = [];

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
    safeSocketEmit('whiteboard-draw', strokeData);

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
    showToast('Collaborative Canvas active', 'info');
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
        showToast('Canvas cleared');
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
      showToast('Canvas snapshot exported', 'info');
    });
  }

  // ---------------------------------------------------------------------------
  // 11. Participant Video Tiles & State
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

      <div class="quality-badge">${isSelf ? 'HOST' : 'PEER'}</div>

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
  // 12. Media Control Buttons
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
      showToast(localState.micOn ? 'Microphone unmuted' : 'Microphone muted');
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
      showToast(localState.videoOn ? 'Camera turned on' : 'Camera turned off');
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
      showToast(localState.handRaised ? 'Hand raised' : 'Hand lowered');
    });
  }

  // ---------------------------------------------------------------------------
  // 13. Sidebar Tabs & Toggles
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
  // 14. Chat Form & XSS-Immune Message Rendering
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
        console.error('[E2EE] Error encrypting chat message:', err);
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
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  // ---------------------------------------------------------------------------
  // 15. Room Link Sharing (Includes E2EE Key Fragment)
  // ---------------------------------------------------------------------------
  const copyBtn = document.getElementById('copy-room-link-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const fullUrl = window.location.origin + `/room?room=${encodeURIComponent(roomId)}${window.location.hash}`;
      navigator.clipboard.writeText(fullUrl).then(() => {
        showToast('Secure room invite link (with E2EE key) copied!');
      }).catch(() => {
        showToast(`Room ID: ${roomId}`);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 16. Comprehensive Room Teardown & Resource Cleanup
  // ---------------------------------------------------------------------------
  function cleanupRoomResources() {
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

    for (const url of activeObjectUrls) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    activeObjectUrls.length = 0;

    for (const transfer of activeIncomingTransfers.values()) {
      if (transfer.timeoutId) clearTimeout(transfer.timeoutId);
    }
    activeIncomingTransfers.clear();

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
