const { io } = require('socket.io-client');

async function testAuthAndSocketSecurity() {
  console.log('\n--- STARTING AUTHENTICATION & SOCKET SECURITY TEST ---\n');

  const BASE_URL = 'http://localhost:3000';
  const testResults = {
    registerSuccess: false,
    invalidLoginBlocked: false,
    validLoginSuccess: false,
    profileFetchSuccess: false,
    unauthenticatedSocketRejected: false,
    authenticatedSocketConnected: false
  };

  const testUser = {
    username: `tester_${Math.floor(1000 + Math.random() * 9000)}`,
    email: `tester_${Date.now()}@nexusmeet.com`,
    password: 'SecurePassword123!'
  };

  // 1. Test Registration
  console.log(`1️⃣ Registering user: ${testUser.username}...`);
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testUser)
  });
  const regData = await regRes.json();
  if (regRes.status === 201 && regData.token && regData.user.username === testUser.username) {
    console.log('✅ Registration successful. JWT Token received.');
    testResults.registerSuccess = true;
  }

  // 2. Test Invalid Login
  console.log('2️⃣ Testing invalid login with wrong password...');
  const badLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername: testUser.email, password: 'WrongPassword!' })
  });
  if (badLoginRes.status === 401) {
    console.log('✅ Invalid login rejected (401 Unauthorized).');
    testResults.invalidLoginBlocked = true;
  }

  // 3. Test Valid Login
  console.log('3️⃣ Logging in with valid credentials...');
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername: testUser.email, password: testUser.password })
  });
  const loginData = await loginRes.json();
  let jwtToken = null;
  if (loginRes.status === 200 && loginData.token) {
    jwtToken = loginData.token;
    console.log('✅ Valid login successful. Received valid JWT token.');
    testResults.validLoginSuccess = true;
  }

  // 4. Test Protected Profile Route
  console.log('4️⃣ Testing protected GET /api/auth/me...');
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { 'Authorization': `Bearer ${jwtToken}` }
  });
  const meData = await meRes.json();
  if (meRes.status === 200 && meData.user.username === testUser.username) {
    console.log('✅ Protected profile successfully retrieved using Bearer token.');
    testResults.profileFetchSuccess = true;
  }

  // 5. Test Unauthenticated Socket.io Handshake (Should be Rejected)
  console.log('5️⃣ Testing Socket.io connection without auth token (Expect rejection)...');
  await new Promise((resolve) => {
    const unauthSocket = io(BASE_URL, {
      auth: {}, // No token provided
      reconnection: false,
      timeout: 2000
    });

    unauthSocket.on('connect_error', (err) => {
      console.log('🛡️ Socket rejected as expected with error:', err.message);
      if (err.message.includes('AUTHENTICATION_ERROR')) {
        testResults.unauthenticatedSocketRejected = true;
      }
      unauthSocket.disconnect();
      resolve();
    });

    unauthSocket.on('connect', () => {
      console.error('❌ Unauthenticated socket unexpectedly connected!');
      unauthSocket.disconnect();
      resolve();
    });

    setTimeout(() => {
      unauthSocket.disconnect();
      resolve();
    }, 2000);
  });

  // 6. Test Authenticated Socket.io Handshake (Should be Accepted)
  console.log('6️⃣ Testing Socket.io connection WITH valid JWT token...');
  await new Promise((resolve) => {
    const authSocket = io(BASE_URL, {
      auth: { token: jwtToken },
      reconnection: false
    });

    authSocket.on('connect', () => {
      console.log('✅ Authenticated socket connected successfully with ID:', authSocket.id);
      testResults.authenticatedSocketConnected = true;
      authSocket.disconnect();
      resolve();
    });

    authSocket.on('connect_error', (err) => {
      console.error('❌ Authenticated socket failed to connect:', err.message);
      authSocket.disconnect();
      resolve();
    });
  });

  console.log('\n--- AUTHENTICATION & SECURITY TEST SUMMARY ---');
  console.log('1. User Registration (bcryptjs hashing):', testResults.registerSuccess ? 'PASSED' : 'FAILED');
  console.log('2. Invalid Password Login Blocked (401):', testResults.invalidLoginBlocked ? 'PASSED' : 'FAILED');
  console.log('3. Valid Credentials Login (JWT Issued):', testResults.validLoginSuccess ? 'PASSED' : 'FAILED');
  console.log('4. Protected Profile /api/auth/me Verification:', testResults.profileFetchSuccess ? 'PASSED' : 'FAILED');
  console.log('5. Unauthenticated Socket Handshake Blocked:', testResults.unauthenticatedSocketRejected ? 'PASSED' : 'FAILED');
  console.log('6. Authenticated Socket Handshake Accepted:', testResults.authenticatedSocketConnected ? 'PASSED' : 'FAILED');

  const allPassed = Object.values(testResults).every(v => v === true);
  if (allPassed) {
    console.log('\n🎉 ALL SECURITY & AUTHENTICATION TESTS PASSED SUCCESSFULLY! 🎉\n');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

testAuthAndSocketSecurity().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
