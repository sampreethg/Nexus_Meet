const { registerUser } = require('./auth');

async function testTurnEndpoint() {
  console.log('\n--- STARTING WEBRTC TURN CREDENTIALS ENDPOINT TEST ---\n');

  const BASE_URL = 'http://localhost:3000';

  // 1. Register a test user
  const user = await registerUser({
    username: `turn_tester_${Date.now().toString().slice(-4)}`,
    email: `turn_${Date.now()}@nexusmeet.com`,
    password: 'Password123!'
  });

  // 2. Test unauthenticated fetch (should fail 401)
  console.log('1️⃣ Fetching TURN credentials without token (Expect 401)...');
  const unauthRes = await fetch(`${BASE_URL}/api/webrtc/turn-credentials`);
  if (unauthRes.status === 401) {
    console.log('✅ Unauthenticated request correctly rejected with 401.');
  } else {
    throw new Error(`Expected 401 but got ${unauthRes.status}`);
  }

  // 3. Test authenticated fetch (should return iceServers)
  console.log('2️⃣ Fetching TURN credentials WITH Bearer token (Expect 200 + iceServers)...');
  const authRes = await fetch(`${BASE_URL}/api/webrtc/turn-credentials`, {
    headers: { 'Authorization': `Bearer ${user.token}` }
  });
  const data = await authRes.json();

  if (authRes.status === 200 && data.success && Array.isArray(data.iceServers)) {
    console.log('✅ Dynamic STUN/TURN credentials returned successfully!');
    console.log('📦 Returned ICE Servers:', JSON.stringify(data.iceServers, null, 2));

    const hasStun = data.iceServers.some(s => s.urls && (typeof s.urls === 'string' ? s.urls.includes('stun:') : s.urls.some(u => u.includes('stun:'))));
    const hasTurn = data.iceServers.some(s => s.urls && (typeof s.urls === 'string' ? s.urls.includes('turn:') : s.urls.some(u => u.includes('turn:'))));

    if (hasStun && hasTurn) {
      console.log('✅ Contains both STUN and TURN server configurations.');
      console.log('\n🎉 WEBRTC TURN CREDENTIALS ENDPOINT TEST PASSED! 🎉\n');
      return;
    } else {
      throw new Error('Missing STUN or TURN servers in response');
    }
  } else {
    throw new Error(`Failed to retrieve TURN credentials: ${JSON.stringify(data)}`);
  }
}

testTurnEndpoint().catch(err => {
  console.error('❌ TURN Endpoint Test Error:', err);
  process.exit(1);
});
