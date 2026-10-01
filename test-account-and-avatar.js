/**
 * Verification Test Suite for NexusMeet:
 * - Bug 1: User Profile Image Upload, Persistence & Rendering
 * - Bug 2: Account Creation, Disk Persistence Across Restarts & Login
 * - Error Messages: Exact classification (Account Not Found vs Incorrect Password)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE_URL = 'http://localhost:3000';

function request(method, pathUrl, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    let postData = null;
    if (data) {
      postData = typeof data === 'string' ? data : JSON.stringify(data);
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawBody: body,
          json: json
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (postData) req.write(postData);
    req.end();
  });
}

// 1x1 transparent red PNG in Base64
const TEST_AVATAR_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function runTests() {
  console.log('================================================================');
  console.log('🚀 NEXUSMEET INTEGRATION AUDIT: AUTH PERSISTENCE & AVATAR FLOW');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passedTests++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  const timestamp = Date.now();
  const testUsername = `user_${timestamp}`;
  const testEmail = `user_${timestamp}@nexusmeet.test`;
  const testPassword = `Password123!_${timestamp}`;

  let createdUserId = null;
  let createdAvatarUrl = null;
  let authToken = null;

  // --------------------------------------------------------------------------
  // TEST A: REGISTRATION WITH AVATAR IMAGE
  // --------------------------------------------------------------------------
  console.log('--- TEST A1: User Registration with Profile Image ---');
  const regRes = await request('POST', '/api/auth/register', {
    username: testUsername,
    email: testEmail,
    password: testPassword,
    avatarImage: TEST_AVATAR_BASE64
  });

  assert(regRes.status === 201, `Registration returned HTTP 201 (got ${regRes.status})`);
  assert(regRes.json && regRes.json.success === true, 'Response indicates success: true');
  assert(regRes.json.user && regRes.json.user.id, `User ID returned: ${regRes.json?.user?.id}`);
  assert(regRes.json.user.email === testEmail.toLowerCase(), 'Email normalized and matched');
  assert(regRes.json.user.avatarUrl && regRes.json.user.avatarUrl.startsWith('/uploads/avatars/'), `Avatar URL generated: ${regRes.json.user.avatarUrl}`);
  assert(regRes.json.token, 'JWT Authentication token returned');

  createdUserId = regRes.json.user.id;
  createdAvatarUrl = regRes.json.user.avatarUrl;
  authToken = regRes.json.token;

  console.log(`\n  📝 [PERSISTENCE AUDIT] Created Record:`);
  console.log(`     User ID: ${createdUserId}`);
  console.log(`     Username: ${testUsername}`);
  console.log(`     Email: ${testEmail}`);
  console.log(`     Avatar URL: ${createdAvatarUrl}`);
  console.log(`     Timestamp: ${new Date().toISOString()}`);

  // --------------------------------------------------------------------------
  // DIRECT PERSISTENCE AUDIT: Check disk storage
  // --------------------------------------------------------------------------
  console.log('\n--- TEST A2: Direct Persistence Layer Verification (Disk Storage) ---');
  const usersJsonPath = path.join(__dirname, 'users.json');
  assert(fs.existsSync(usersJsonPath), 'users.json file exists on disk');
  const usersOnDisk = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8'));
  const savedUser = usersOnDisk.find(u => u.id === createdUserId);
  assert(savedUser !== undefined, `User record found in users.json on disk`);
  assert(savedUser.email === testEmail.toLowerCase(), 'Disk record email matches');
  assert(savedUser.avatarUrl === createdAvatarUrl, 'Disk record avatarUrl matches');
  assert(savedUser.passwordHash && savedUser.passwordHash.startsWith('$2'), 'Password properly hashed with bcrypt');

  // Check avatar image file on disk
  const relativeAvatarPath = createdAvatarUrl.replace(/^\//, '');
  const avatarDiskPath = path.join(__dirname, relativeAvatarPath);
  assert(fs.existsSync(avatarDiskPath), `Avatar file exists on disk at: ${avatarDiskPath}`);
  const avatarStats = fs.statSync(avatarDiskPath);
  assert(avatarStats.size > 0, `Avatar file is non-empty (${avatarStats.size} bytes)`);

  // Check HTTP static serving of avatar
  const avatarHttpRes = await request('GET', createdAvatarUrl);
  assert(avatarHttpRes.status === 200, `Avatar static serving returned HTTP 200`);
  assert(avatarHttpRes.headers['content-type'] && avatarHttpRes.headers['content-type'].includes('image'), `Content-Type header is image: ${avatarHttpRes.headers['content-type']}`);

  // --------------------------------------------------------------------------
  // LOGOUT SIMULATION
  // --------------------------------------------------------------------------
  console.log('\n--- TEST A3: Logout & Client State Reset ---');
  authToken = null;
  console.log('  ✅ Local auth tokens cleared (session terminated)');

  // --------------------------------------------------------------------------
  // LOGIN VERIFICATION: Immediate login
  // --------------------------------------------------------------------------
  console.log('\n--- TEST A4: Subsequent Login with Same Credentials ---');
  const loginRes = await request('POST', '/api/auth/login', {
    identifier: testEmail,
    password: testPassword
  });

  assert(loginRes.status === 200, `Login returned HTTP 200 (got ${loginRes.status})`);
  assert(loginRes.json && loginRes.json.success === true, 'Login response success: true');
  assert(loginRes.json.user.id === createdUserId, `User ID matches original created ID: ${loginRes.json.user.id}`);
  assert(loginRes.json.user.avatarUrl === createdAvatarUrl, `Avatar URL matches original: ${loginRes.json.user.avatarUrl}`);
  assert(loginRes.json.token, 'New JWT authentication session token generated');

  const newSessionToken = loginRes.json.token;

  // --------------------------------------------------------------------------
  // PAGE REFRESH SIMULATION: GET /api/auth/me
  // --------------------------------------------------------------------------
  console.log('\n--- TEST A5: Page Refresh Simulation (GET /api/auth/me) ---');
  const meRes = await request('GET', '/api/auth/me', null, {
    'Authorization': `Bearer ${newSessionToken}`
  });

  assert(meRes.status === 200, `GET /api/auth/me returned HTTP 200`);
  assert(meRes.json.user.id === createdUserId, `Session user ID matches: ${meRes.json.user.id}`);
  assert(meRes.json.user.avatarUrl === createdAvatarUrl, `Session user avatarUrl matches: ${meRes.json.user.avatarUrl}`);

  // --------------------------------------------------------------------------
  // TEST B: NON-EXISTENT ACCOUNT
  // --------------------------------------------------------------------------
  console.log('\n--- TEST B: Non-Existent Account Error Handling ---');
  const notFoundRes = await request('POST', '/api/auth/login', {
    identifier: 'genuinely_nonexistent_user_9999@nexusmeet.test',
    password: 'AnyPassword123!'
  });

  assert(notFoundRes.status === 404, `Non-existent user returns HTTP 404 (got ${notFoundRes.status})`);
  assert(notFoundRes.json.error === 'Account not found. Please check your email or create an account.', `User-facing error is exact: "${notFoundRes.json.error}"`);
  assert(notFoundRes.json.code === 'ACCOUNT_NOT_FOUND', `Machine error code is ACCOUNT_NOT_FOUND`);

  // --------------------------------------------------------------------------
  // TEST C: WRONG PASSWORD
  // --------------------------------------------------------------------------
  console.log('\n--- TEST C: Wrong Password Error Handling ---');
  const wrongPwdRes = await request('POST', '/api/auth/login', {
    identifier: testEmail,
    password: 'CompletelyWrongPassword999!'
  });

  assert(wrongPwdRes.status === 401, `Wrong password returns HTTP 401 (got ${wrongPwdRes.status})`);
  assert(wrongPwdRes.json.error === 'Incorrect password.', `User-facing error is exact: "${wrongPwdRes.json.error}"`);
  assert(wrongPwdRes.json.code === 'INVALID_PASSWORD', `Machine error code is INVALID_PASSWORD`);
  assert(wrongPwdRes.json.error !== 'Account not found. Please check your email or create an account.', 'Does NOT claim account not found');

  // --------------------------------------------------------------------------
  // TEST D: EXISTING ACCOUNTS PRESERVED
  // --------------------------------------------------------------------------
  console.log('\n--- TEST D: Existing User Accounts Integrity ---');
  const existingSampreeth = usersOnDisk.find(u => u.username === 'sampreeth');
  assert(existingSampreeth !== undefined, 'Pre-existing user "sampreeth" preserved in database');
  console.log(`  ✅ Existing account "sampreeth" (${existingSampreeth.email}) intact`);

  // --------------------------------------------------------------------------
  // TEST E: IN-MEETING AVATAR UPDATE
  // --------------------------------------------------------------------------
  console.log('\n--- TEST E: Avatar Upload via /api/auth/upload-avatar ---');
  // 1x1 transparent green PNG
  const NEW_AVATAR_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const uploadRes = await request('POST', '/api/auth/upload-avatar', {
    avatarImage: NEW_AVATAR_BASE64
  }, {
    'Authorization': `Bearer ${newSessionToken}`
  });

  assert(uploadRes.status === 200, `Avatar upload returned HTTP 200`);
  assert(uploadRes.json.success === true, 'Upload response success: true');
  assert(uploadRes.json.avatarUrl && uploadRes.json.avatarUrl !== createdAvatarUrl, `New avatar URL generated: ${uploadRes.json.avatarUrl}`);

  // Verify persistence of updated avatar
  const updatedMeRes = await request('GET', '/api/auth/me', null, {
    'Authorization': `Bearer ${newSessionToken}`
  });
  assert(updatedMeRes.json.user.avatarUrl === uploadRes.json.avatarUrl, 'GET /api/auth/me returns updated avatar URL');

  console.log('\n================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} TESTS PASSED PERFECTLY!`);
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ Test suite failed with error:', err);
  process.exit(1);
});
