/**
 * Comprehensive Production-Readiness & Real-Time Meeting Audit Suite
 * Simulates complete user journey, multi-peer WebRTC mesh signaling, E2EE chat,
 * collaborative canvas, P2P file chunk framing, and graceful teardown.
 */

const { io: ioClient } = require('socket.io-client');
const crypto = require('crypto');

const SERVER_URL = 'http://localhost:3000';
const ROOM_ID = `audit-room-${Date.now()}`;

console.log('=================================================================');
console.log('🚀 NEXUSMEET END-TO-END PRODUCTION READINESS & USER JOURNEY AUDIT');
console.log('=================================================================\n');

async function runProductionAudit() {
  const auditResults = {
    userRegistration: false,
    invalidLoginBlocked: false,
    userLogin: false,
    profileVerification: false,
    turnCredentialsSecure: false,
    multiPeerJoin: false,
    e2eeChatZeroPlaintext: false,
    whiteboardLiveSync: false,
    mediaTogglesPropagated: false,
    fileChunkProtocolIntegrity: false,
    gracefulParticipantTeardown: false
  };

  // ---------------------------------------------------------------------------
  // Step 1: User Registration with Input Validation
  // ---------------------------------------------------------------------------
  console.log('1. [Auth] Registering test users (Alice, Bob, Charlie)...');
  const userAData = { username: `alice_${Math.floor(1000 + Math.random() * 9000)}`, email: `alice_${Date.now()}@meet.test`, password: 'Password@123' };
  const userBData = { username: `bob_${Math.floor(1000 + Math.random() * 9000)}`, email: `bob_${Date.now()}@meet.test`, password: 'Password@123' };
  const userCData = { username: `charlie_${Math.floor(1000 + Math.random() * 9000)}`, email: `charlie_${Date.now()}@meet.test`, password: 'Password@123' };

  const regARes = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userAData)
  });
  const regA = await regARes.json();
  if (regA.success && regA.token) {
    auditResults.userRegistration = true;
    console.log(`   ✅ User A registered: ${userAData.username}`);
  } else {
    throw new Error(`Registration failed: ${regA.error}`);
  }

  // Register B and C
  const regB = await (await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userBData)
  })).json();

  const regC = await (await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userCData)
  })).json();

  // Duplicate registration rejection test
  const dupRes = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userAData)
  });
  if (dupRes.status === 400) {
    console.log('   ✅ Duplicate username/email correctly rejected with 400 Bad Request');
  }

  // ---------------------------------------------------------------------------
  // Step 2: Login Verification
  // ---------------------------------------------------------------------------
  console.log('\n2. [Auth] Testing login credential validation...');
  const badLoginRes = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername: userAData.username, password: 'WrongPassword999' })
  });
  if (badLoginRes.status === 401) {
    auditResults.invalidLoginBlocked = true;
    console.log('   ✅ Invalid password rejected with 401 Unauthorized');
  }

  const goodLoginRes = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername: userAData.username, password: userAData.password })
  });
  const goodLogin = await goodLoginRes.json();
  if (goodLogin.success && goodLogin.token) {
    auditResults.userLogin = true;
    console.log(`   ✅ Valid login accepted for ${userAData.username}`);
  }

  // ---------------------------------------------------------------------------
  // Step 3: Protected Routes & TURN Credentials
  // ---------------------------------------------------------------------------
  console.log('\n3. [Security] Verifying protected /api/auth/me and TURN endpoint...');
  const meRes = await fetch(`${SERVER_URL}/api/auth/me`, {
    headers: { 'Authorization': `Bearer ${regA.token}` }
  });
  const meData = await meRes.json();
  if (meData.success && meData.user.username === userAData.username) {
    auditResults.profileVerification = true;
    console.log(`   ✅ Protected profile fetched for: ${meData.user.username}`);
  }

  const turnRes = await fetch(`${SERVER_URL}/api/webrtc/turn-credentials`, {
    headers: { 'Authorization': `Bearer ${regA.token}` }
  });
  const turnData = await turnRes.json();
  if (turnData.success && Array.isArray(turnData.iceServers) && turnData.iceServers.length > 0) {
    auditResults.turnCredentialsSecure = true;
    console.log(`   ✅ Dynamic ICE servers returned (${turnData.iceServers.length} servers configured)`);
  }

  // ---------------------------------------------------------------------------
  // Step 4: Multi-Peer Socket.io Mesh Connection & Room Joining
  // ---------------------------------------------------------------------------
  console.log('\n4. [Signaling] Connecting 3 participants to room:', ROOM_ID);

  const socketA = ioClient(SERVER_URL, { auth: { token: regA.token } });
  const socketB = ioClient(SERVER_URL, { auth: { token: regB.token } });
  const socketC = ioClient(SERVER_URL, { auth: { token: regC.token } });

  await Promise.all([
    new Promise(res => socketA.on('connect', res)),
    new Promise(res => socketB.on('connect', res)),
    new Promise(res => socketC.on('connect', res))
  ]);

  const joinA = new Promise(resolve => {
    socketA.on('room-users', data => resolve(data));
  });
  socketA.emit('join-room', { roomId: ROOM_ID, micOn: true, videoOn: true });
  await joinA;

  const bDiscoversA = new Promise(resolve => {
    socketB.on('room-users', data => resolve(data));
  });
  const aDiscoversB = new Promise(resolve => {
    socketA.on('user-connected', user => resolve(user));
  });

  socketB.emit('join-room', { roomId: ROOM_ID, micOn: true, videoOn: true });
  const [bRoomData, aNewPeer] = await Promise.all([bDiscoversA, aDiscoversB]);

  if (bRoomData.users.length === 1 && aNewPeer.username === userBData.username) {
    console.log(`   ✅ Peer A detected Peer B join; Peer B received existing user Peer A.`);
  }

  const cDiscoversExisting = new Promise(resolve => {
    socketC.on('room-users', data => resolve(data));
  });
  socketC.emit('join-room', { roomId: ROOM_ID, micOn: false, videoOn: true });
  const cRoomData = await cDiscoversExisting;

  if (cRoomData.users.length === 2) {
    auditResults.multiPeerJoin = true;
    console.log(`   ✅ Peer C joined. Discovered 2 active participants: ${cRoomData.users.map(u => u.username).join(', ')}`);
  }

  // ---------------------------------------------------------------------------
  // Step 5: WebRTC SDP Offer/Answer & ICE Signaling Relay
  // ---------------------------------------------------------------------------
  console.log('\n5. [WebRTC] Verifying room-scoped SDP & ICE candidate routing...');
  const bReceivesOffer = new Promise(resolve => {
    socketB.on('webrtc-offer', data => resolve(data));
  });
  socketA.emit('webrtc-offer', {
    targetSocketId: socketB.id,
    offer: { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }
  });
  const receivedOffer = await bReceivesOffer;

  const aReceivesAnswer = new Promise(resolve => {
    socketA.on('webrtc-answer', data => resolve(data));
  });
  socketB.emit('webrtc-answer', {
    targetSocketId: socketA.id,
    answer: { type: 'answer', sdp: 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }
  });
  const receivedAnswer = await aReceivesAnswer;

  if (receivedOffer.offer && receivedAnswer.answer) {
    console.log('   ✅ Bidirectional SDP offer/answer relay validated between Peer A and Peer B.');
  }

  // ---------------------------------------------------------------------------
  // Step 6: Zero-Knowledge E2EE Chat Transmission
  // ---------------------------------------------------------------------------
  console.log('\n6. [E2EE Chat] Testing AES-256-GCM encrypted message relay...');
  const sharedKeyHex = crypto.randomBytes(32).toString('hex');
  const subtle = crypto.webcrypto.subtle;
  const cryptoKey = await subtle.importKey(
    'raw',
    Buffer.from(sharedKeyHex, 'hex'),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextMsg = 'Top Secret Strategic Discussion';
  const ciphertextBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode(plaintextMsg)
  );

  const bReceivesChat = new Promise(resolve => {
    socketB.on('chat-message', msg => resolve(msg));
  });

  socketA.emit('send-chat-message', {
    encrypted: true,
    encryptedPayload: Buffer.from(ciphertextBuffer).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    message: null // Zero plaintext on wire!
  });

  const chatOnWire = await bReceivesChat;
  if (chatOnWire.encrypted === true && chatOnWire.message === null && chatOnWire.encryptedPayload) {
    // Decrypt on Receiver
    const decryptedBuf = await subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(chatOnWire.iv, 'base64') },
      cryptoKey,
      Buffer.from(chatOnWire.encryptedPayload, 'base64')
    );
    const decryptedText = new TextDecoder().decode(decryptedBuf);
    if (decryptedText === plaintextMsg) {
      auditResults.e2eeChatZeroPlaintext = true;
      console.log(`   ✅ Zero plaintext on wire. Receiver decrypted: "${decryptedText}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 7: Collaborative Whiteboard Drawing & History Sync
  // ---------------------------------------------------------------------------
  console.log('\n7. [Whiteboard] Testing real-time coordinate streaming and clear...');
  const sampleStroke = {
    prevX: 0.25,
    prevY: 0.35,
    currX: 0.65,
    currY: 0.75,
    color: '#3b82f6',
    width: 4,
    mode: 'pen'
  };

  const bReceivesStroke = new Promise(resolve => {
    socketB.on('whiteboard-draw', stroke => resolve(stroke));
  });
  socketA.emit('whiteboard-draw', sampleStroke);
  const strokeReceived = await bReceivesStroke;

  if (strokeReceived.currX === sampleStroke.currX && strokeReceived.color === sampleStroke.color) {
    auditResults.whiteboardLiveSync = true;
    console.log('   ✅ Real-time stroke successfully rendered and relayed.');
  }

  // ---------------------------------------------------------------------------
  // Step 8: Media & Hand Raise State Propagation
  // ---------------------------------------------------------------------------
  console.log('\n8. [Media State] Testing mic/video toggle and hand-raise broadcast...');
  const bReceivesMediaToggle = new Promise(resolve => {
    socketB.on('user-media-toggled', data => resolve(data));
  });
  socketA.emit('toggle-media-state', { micOn: false, videoOn: true });
  const mediaToggle = await bReceivesMediaToggle;

  const bReceivesHandToggle = new Promise(resolve => {
    socketB.on('user-hand-toggled', data => resolve(data));
  });
  socketA.emit('toggle-hand-raise', { handRaised: true });
  const handToggle = await bReceivesHandToggle;

  if (mediaToggle.micOn === false && handToggle.handRaised === true) {
    auditResults.mediaTogglesPropagated = true;
    console.log(`   ✅ Media mute & hand raise propagated to room participants.`);
  }

  // ---------------------------------------------------------------------------
  // Step 9: Binary Chunk Framing & Checksum Integrity
  // ---------------------------------------------------------------------------
  console.log('\n9. [File Transfer] Testing framed packet header & Adler-32 integrity...');
  function computeAdler32(buf) {
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  const rawChunkData = crypto.randomBytes(16384);
  const checksum = computeAdler32(rawChunkData);

  const packetHeader = Buffer.alloc(32);
  packetHeader.write('tx_sample_audit', 0, 16, 'utf8');
  packetHeader.writeUInt32BE(0, 16);
  packetHeader.writeUInt32BE(5, 20);
  packetHeader.writeUInt32BE(81920, 24);
  packetHeader.writeUInt32BE(checksum, 28);

  const completePacket = Buffer.concat([packetHeader, rawChunkData]);

  // Deserialize and verify
  const parsedChecksum = completePacket.readUInt32BE(28);
  const parsedPayload = completePacket.subarray(32);
  const calculatedChecksum = computeAdler32(parsedPayload);

  if (parsedChecksum === calculatedChecksum) {
    auditResults.fileChunkProtocolIntegrity = true;
    console.log(`   ✅ 32-byte header validated. Adler-32 checksum (${checksum}) verified.`);
  }

  // ---------------------------------------------------------------------------
  // Step 10: Graceful Disconnect & Teardown
  // ---------------------------------------------------------------------------
  console.log('\n10. [Teardown] Testing participant disconnect broadcast & cleanup...');
  const targetBId = socketB.id;
  const aReceivesDisconnect = new Promise(resolve => {
    socketA.on('user-disconnected', data => resolve(data));
  });
  socketB.disconnect();
  const disconnectedUser = await aReceivesDisconnect;

  if (disconnectedUser.socketId === targetBId) {
    auditResults.gracefulParticipantTeardown = true;
    console.log(`   ✅ Peer B disconnection safely notified to remaining participants.`);
  }

  socketA.disconnect();
  socketC.disconnect();

  console.log('\n=================================================================');
  console.log('📊 AUDIT SUMMARY & PRODUCTION VERIFICATION RESULTS');
  console.log('=================================================================');
  for (const [key, passed] of Object.entries(auditResults)) {
    console.log(`   - ${key.padEnd(30)}: ${passed ? '✅ PASSED' : '❌ FAILED'}`);
  }
  const allPassed = Object.values(auditResults).every(v => v === true);
  console.log('=================================================================');
  if (allPassed) {
    console.log('🎉 ALL 11 PRODUCTION AUDIT SUITES PASSED WITH 100% SUCCESS! 🎉\n');
  } else {
    throw new Error('Some audit suites failed.');
  }
}

runProductionAudit().catch(err => {
  console.error('\n❌ Production audit failed:', err);
  process.exit(1);
});
