const { io } = require('socket.io-client');
const { registerUser } = require('./auth');

async function testSignaling() {
  console.log('\n--- STARTING SOCKET.IO MULTI-CLIENT SIGNALING TEST ---\n');

  const SERVER_URL = 'http://localhost:3000';
  const ROOM_ID = 'test-room-777';

  const user1 = await registerUser({ username: `alice_${Date.now().toString().slice(-4)}`, email: `alice_${Date.now()}@test.local`, password: 'Password@123' });
  const user2 = await registerUser({ username: `bob_${Date.now().toString().slice(-4)}`, email: `bob_${Date.now()}@test.local`, password: 'Password@123' });

  let client1Connected = false;
  let client2Connected = false;

  const results = {
    client1Joined: false,
    client2Joined: false,
    client1ReceivedUser2Connect: false,
    client2ReceivedChatFromUser1: false,
    client1ReceivedMediaToggleFromUser2: false,
    client1ReceivedUser2Disconnect: false
  };

  // Client 1 Connection
  const client1 = io(SERVER_URL, { auth: { token: user1.token } });

  client1.on('connect', () => {
    console.log('✅ Client 1 connected to server with ID:', client1.id);
    client1Connected = true;
    client1.emit('join-room', { roomId: ROOM_ID, username: user1.user.username });
  });

  client1.on('room-users', (data) => {
    console.log('✅ Client 1 received room-users event:', data.self.username);
    results.client1Joined = true;
  });

  // Client 2 joins after Client 1
  client1.on('user-connected', (user) => {
    console.log('📢 Client 1 received user-connected event:', user.username);
    results.client1ReceivedUser2Connect = true;
  });

  client1.on('user-media-toggled', (data) => {
    console.log('📢 Client 1 received user-media-toggled:', data);
    results.client1ReceivedMediaToggleFromUser2 = true;
  });

  client1.on('user-disconnected', (user) => {
    console.log('📢 Client 1 received user-disconnected:', user.username);
    results.client1ReceivedUser2Disconnect = true;
  });

  // Wait 1 second before joining Client 2
  await new Promise(res => setTimeout(res, 1000));

  const client2 = io(SERVER_URL, { auth: { token: user2.token } });
  
  client2.on('connect', () => {
    console.log('✅ Client 2 connected to server with ID:', client2.id);
    client2Connected = true;
    client2.emit('join-room', { roomId: ROOM_ID, username: user2.user.username });
  });

  client2.on('room-users', (data) => {
    console.log('✅ Client 2 received room-users event. Existing room count:', data.users.length);
    results.client2Joined = true;

    // Send chat message from Client 1
    console.log('💬 Client 1 sending chat message to room...');
    client1.emit('send-chat-message', { message: 'Hello from Alice in Tab 1!' });
  });

  client2.on('chat-message', (data) => {
    if (data.username === user1.user.username && data.message.includes('Hello from Alice')) {
      console.log('💬 Client 2 received chat message from Alice:', data.message);
      results.client2ReceivedChatFromUser1 = true;

      // Now trigger media state toggle from Bob (Client 2)
      console.log('🎙️ Client 2 toggling media state...');
      client2.emit('toggle-media-state', { micOn: false, videoOn: true });

      // Disconnect Client 2 after 1 second
      setTimeout(() => {
        console.log('🔌 Client 2 disconnecting...');
        client2.disconnect();
      }, 800);
    }
  });

  // Wait for test completion
  await new Promise(res => setTimeout(res, 3500));

  client1.disconnect();

  console.log('\n--- SIGNALING TEST RESULTS SUMMARY ---');
  console.log('1. Client 1 Room Join:', results.client1Joined ? 'PASSED' : 'FAILED');
  console.log('2. Client 2 Room Join:', results.client2Joined ? 'PASSED' : 'FAILED');
  console.log('3. Client 1 received User 2 Connection Event:', results.client1ReceivedUser2Connect ? 'PASSED' : 'FAILED');
  console.log('4. Client 2 received Chat Message from Client 1:', results.client2ReceivedChatFromUser1 ? 'PASSED' : 'FAILED');
  console.log('5. Client 1 received Media Toggle from Client 2:', results.client1ReceivedMediaToggleFromUser2 ? 'PASSED' : 'FAILED');
  console.log('6. Client 1 received User 2 Disconnect Event:', results.client1ReceivedUser2Disconnect ? 'PASSED' : 'FAILED');

  const allPassed = Object.values(results).every(v => v === true);
  if (allPassed) {
    console.log('\n🎉 ALL SOCKET.IO BROADCAST SIGNALING TESTS PASSED SUCCESSFULLY! 🎉\n');
    process.exit(0);
  } else {
    console.error('\n❌ SOME SIGNALING TESTS FAILED\n');
    process.exit(1);
  }
}

testSignaling().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
