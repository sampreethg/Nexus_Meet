const { io } = require('socket.io-client');
const { registerUser } = require('./auth');

async function testWebRTCSignaling() {
  console.log('\n--- STARTING WEBRTC FULL SDP & ICE SIGNALING TEST ---\n');

  const SERVER_URL = 'http://localhost:3000';
  const ROOM_ID = 'webrtc-test-room';

  const userA = await registerUser({ username: `rtc_a_${Date.now().toString().slice(-4)}`, email: `rtca_${Date.now()}@test.local`, password: 'Password@123' });
  const userB = await registerUser({ username: `rtc_b_${Date.now().toString().slice(-4)}`, email: `rtcb_${Date.now()}@test.local`, password: 'Password@123' });

  const testResults = {
    clientAJoined: false,
    clientBJoined: false,
    clientBReceivedOffer: false,
    clientAReceivedAnswer: false,
    iceCandidatesExchanged: false
  };

  let iceCandidatesCount = 0;

  // 1. Setup Client A
  const clientA = io(SERVER_URL, { auth: { token: userA.token } });

  clientA.on('connect', () => {
    console.log('✅ Client A connected:', clientA.id);
    clientA.emit('join-room', { roomId: ROOM_ID, username: 'Alice' });
  });

  clientA.on('room-users', () => {
    console.log('✅ Client A joined room.');
    testResults.clientAJoined = true;
  });

  clientA.on('user-connected', (userB) => {
    console.log('📢 Client A detected User B connection:', userB.username, userB.socketId);
    
    // Client A generates SDP Offer
    const mockOffer = {
      type: 'offer',
      sdp: 'v=0\r\no=- 1234567890 2 IN IP4 127.0.0.1\r\ns=NexusMeet WebRTC Offer\r\nt=0 0\r\na=sendrecv\r\n'
    };

    console.log('📤 Client A emitting webrtc-offer to Client B...');
    clientA.emit('webrtc-offer', {
      targetSocketId: userB.socketId,
      offer: mockOffer
    });
  });

  clientA.on('webrtc-answer', ({ senderSocketId }) => {
    console.log('📥 Client A received SDP Answer from:', senderSocketId);
    testResults.clientAReceivedAnswer = true;

    // Client A emits ICE candidate
    clientA.emit('webrtc-ice-candidate', {
      targetSocketId: senderSocketId,
      candidate: { candidate: 'candidate:1 1 UDP 2122237439 127.0.0.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    });
  });

  clientA.on('webrtc-ice-candidate', ({ senderSocketId }) => {
    console.log('🧊 Client A received ICE Candidate from:', senderSocketId);
    iceCandidatesCount++;
    if (iceCandidatesCount >= 2) testResults.iceCandidatesExchanged = true;
  });

  // Wait 1 second before connecting Client B
  await new Promise(res => setTimeout(res, 1000));

  // 2. Setup Client B
  const clientB = io(SERVER_URL, { auth: { token: userB.token } });

  clientB.on('connect', () => {
    console.log('✅ Client B connected:', clientB.id);
    clientB.emit('join-room', { roomId: ROOM_ID, username: 'Bob' });
  });

  clientB.on('room-users', () => {
    console.log('✅ Client B joined room.');
    testResults.clientBJoined = true;
  });

  clientB.on('webrtc-offer', ({ senderSocketId, offer, username }) => {
    console.log('📥 Client B received SDP Offer from Client A:', senderSocketId);
    testResults.clientBReceivedOffer = true;

    const mockAnswer = {
      type: 'answer',
      sdp: 'v=0\r\no=- 9876543210 2 IN IP4 127.0.0.1\r\ns=NexusMeet WebRTC Answer\r\nt=0 0\r\na=sendrecv\r\n'
    };

    console.log('📤 Client B emitting webrtc-answer to Client A...');
    clientB.emit('webrtc-answer', {
      targetSocketId: senderSocketId,
      answer: mockAnswer
    });

    clientB.emit('webrtc-ice-candidate', {
      targetSocketId: senderSocketId,
      candidate: { candidate: 'candidate:2 1 UDP 2122237439 127.0.0.1 54322 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    });
  });

  clientB.on('webrtc-ice-candidate', ({ senderSocketId }) => {
    console.log('🧊 Client B received ICE Candidate from:', senderSocketId);
    iceCandidatesCount++;
    if (iceCandidatesCount >= 2) testResults.iceCandidatesExchanged = true;
  });

  await new Promise(res => setTimeout(res, 2500));

  clientA.disconnect();
  clientB.disconnect();

  console.log('\n--- WEBRTC SIGNALING TEST RESULTS SUMMARY ---');
  console.log('1. Client A Room Join:', testResults.clientAJoined ? 'PASSED' : 'FAILED');
  console.log('2. Client B Room Join:', testResults.clientBJoined ? 'PASSED' : 'FAILED');
  console.log('3. Client B Received SDP Offer:', testResults.clientBReceivedOffer ? 'PASSED' : 'FAILED');
  console.log('4. Client A Received SDP Answer:', testResults.clientAReceivedAnswer ? 'PASSED' : 'FAILED');
  console.log('5. ICE Candidates Bidirectional Relay:', testResults.iceCandidatesExchanged ? 'PASSED' : 'FAILED');

  const allPassed = Object.values(testResults).every(v => v === true);
  if (allPassed) {
    console.log('\n🎉 ALL WEBRTC PEER CONNECTION SIGNALING TESTS PASSED! 🎉\n');
    process.exit(0);
  } else {
    console.error('\n❌ WEBRTC SIGNALING TEST FAILED\n');
    process.exit(1);
  }
}

testWebRTCSignaling().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
