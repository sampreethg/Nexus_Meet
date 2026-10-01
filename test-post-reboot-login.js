const http = require('http');

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

async function verifyPostRebootLogin() {
  console.log('--- Post-Reboot Login Verification ---');
  // From reboot test before server kill:
  const email = 'reboot_1790818081839@nexusmeet.test';
  const expectedUserId = 'usr_1790818082139_uqnokb';
  const expectedAvatar = '/uploads/avatars/avatar-usr_1790818082139_uqnokb-1790818082139.png';
  const password = 'RebootPass123!_1790818081839';

  const loginRes = await request('POST', '/api/auth/login', {
    emailOrUsername: email,
    password: password
  });

  console.log(`Status: ${loginRes.status}`);
  console.log(`Response: ${JSON.stringify(loginRes.json, null, 2)}`);

  if (loginRes.status !== 200) {
    throw new Error(`Login failed after reboot: ${loginRes.rawBody}`);
  }

  if (loginRes.json.user.id !== expectedUserId) {
    throw new Error(`User ID mismatch! Expected ${expectedUserId}, got ${loginRes.json.user.id}`);
  }

  if (loginRes.json.user.avatarUrl !== expectedAvatar) {
    throw new Error(`Avatar URL mismatch! Expected ${expectedAvatar}, got ${loginRes.json.user.avatarUrl}`);
  }

  // Verify avatar file is accessible
  const avatarRes = await request('GET', loginRes.json.user.avatarUrl);
  if (avatarRes.status !== 200) {
    throw new Error(`Avatar image not accessible: status ${avatarRes.status}`);
  }

  // Verify session endpoint
  const token = loginRes.json.token;
  const meRes = await request('GET', '/api/auth/me', null, {
    'Authorization': `Bearer ${token}`
  });

  if (meRes.status !== 200 || meRes.json.user.avatarUrl !== expectedAvatar) {
    throw new Error(`GET /api/auth/me verification failed: ${meRes.rawBody}`);
  }

  console.log('\n✅ POST-REBOOT LOGIN & PROFILE IMAGE PERSISTENCE VERIFIED 100%!');
}

verifyPostRebootLogin().catch(e => {
  console.error(e);
  process.exit(1);
});
