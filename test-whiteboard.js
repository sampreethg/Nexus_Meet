const { io } = require('socket.io-client');
const { registerUser } = require('./auth');

async function testWhiteboardCollaboration() {
  console.log('\n--- STARTING REAL-TIME COLLABORATIVE WHITEBOARD TEST ---\n');

  const SERVER_URL = 'http://localhost:3000';
  const ROOM_ID = 'whiteboard-sync-room';

  const userA = await registerUser({ username: `wb_alice_${Date.now().toString().slice(-4)}`, email: `wba_${Date.now()}@test.local`, password: 'Password@123' });
  const userB = await registerUser({ username: `wb_bob_${Date.now().toString().slice(-4)}`, email: `wbb_${Date.now()}@test.local`, password: 'Password@123' });
  const userC = await registerUser({ username: `wb_charlie_${Date.now().toString().slice(-4)}`, email: `wbc_${Date.now()}@test.local`, password: 'Password@123' });

  const testResults = {
    clientAConnected: false,
    clientBReceivedStroke: false,
    clientCReceivedHistory: false,
    clientBReceivedClear: false
  };

  // 1. Client A joins
  const clientA = io(SERVER_URL, { auth: { token: userA.token } });
  clientA.on('connect', () => {
    clientA.emit('join-room', { roomId: ROOM_ID });
    testResults.clientAConnected = true;
  });

  await new Promise(res => setTimeout(res, 500));

  // 2. Client B joins
  const clientB = io(SERVER_URL, { auth: { token: userB.token } });
  clientB.on('connect', () => {
    clientB.emit('join-room', { roomId: ROOM_ID });
  });

  const sampleStroke = {
    prevX: 0.12,
    prevY: 0.34,
    currX: 0.56,
    currY: 0.78,
    color: '#3b82f6',
    width: 4,
    mode: 'pen'
  };

  clientB.on('whiteboard-draw', (stroke) => {
    console.log('🖌️ Client B received real-time stroke coordinates:', stroke);
    if (stroke.currX === sampleStroke.currX && stroke.color === sampleStroke.color) {
      testResults.clientBReceivedStroke = true;
    }
  });

  clientB.on('whiteboard-clear', () => {
    console.log('🧹 Client B received whiteboard clear event');
    testResults.clientBReceivedClear = true;
  });

  await new Promise(res => setTimeout(res, 500));

  // Client A emits drawing stroke
  console.log('✏️ Client A drawing a stroke on canvas...');
  clientA.emit('whiteboard-draw', sampleStroke);

  await new Promise(res => setTimeout(res, 800));

  // 3. Client C joins later and should receive whiteboard history
  const clientC = io(SERVER_URL, { auth: { token: userC.token } });
  clientC.on('connect', () => {
    clientC.emit('join-room', { roomId: ROOM_ID });
  });

  clientC.on('whiteboard-history', (history) => {
    console.log(`📜 Client C received whiteboard history (${history.length} strokes)`);
    if (history.length > 0 && history[0].currX === sampleStroke.currX) {
      testResults.clientCReceivedHistory = true;
    }
  });

  await new Promise(res => setTimeout(res, 800));

  // Client A clears the whiteboard
  console.log('🧼 Client A emitting whiteboard clear...');
  clientA.emit('whiteboard-clear');

  await new Promise(res => setTimeout(res, 800));

  clientA.disconnect();
  clientB.disconnect();
  clientC.disconnect();

  console.log('\n--- WHITEBOARD SYNC TEST RESULTS SUMMARY ---');
  console.log('1. Client A Joined Room:', testResults.clientAConnected ? 'PASSED' : 'FAILED');
  console.log('2. Client B Received Real-Time Coordinate Deltas:', testResults.clientBReceivedStroke ? 'PASSED' : 'FAILED');
  console.log('3. Client C Received Persistent Whiteboard History on Join:', testResults.clientCReceivedHistory ? 'PASSED' : 'FAILED');
  console.log('4. Client B Received Whiteboard Clear Event:', testResults.clientBReceivedClear ? 'PASSED' : 'FAILED');

  const allPassed = Object.values(testResults).every(v => v === true);
  if (allPassed) {
    console.log('\n🎉 ALL REAL-TIME COLLABORATIVE WHITEBOARD TESTS PASSED! 🎉\n');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

testWhiteboardCollaboration().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
