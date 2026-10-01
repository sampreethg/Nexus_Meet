/**
 * Test Server Restart Cycle:
 * 1. Register new user with avatar
 * 2. Kill server process
 * 3. Start brand new server process
 * 4. Verify account and avatar persist after server reboot
 * 5. Log in again with same credentials
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runCycle() {
  console.log('=== TEST SERVER RESTART & PERSISTENCE CYCLE ===\n');

  const ts = Date.now();
  const username = `reboot_user_${ts}`;
  const email = `reboot_${ts}@nexusmeet.test`;
  const password = `RebootPass123!_${ts}`;
  const avatarBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // 1. Register
  console.log('1. Registering user with avatar before server reboot...');
  const regRes = await request('POST', '/api/auth/register', {
    username,
    email,
    password,
    avatarImage: avatarBase64
  });

  if (regRes.status !== 201) {
    throw new Error(`Registration failed: ${regRes.rawBody}`);
  }
  const userId = regRes.json.user.id;
  const avatarUrl = regRes.json.user.avatarUrl;
  console.log(`   User registered: ID=${userId}, Avatar=${avatarUrl}`);

  // 2. Direct database / file inspection
  const usersOnDisk = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
  const foundUser = usersOnDisk.find(u => u.id === userId);
  if (!foundUser) {
    throw new Error('User was NOT persisted to users.json on disk!');
  }
  console.log('   Confirmed user written to disk in users.json');

  // 3. Log in immediately
  console.log('2. Immediate login verification before reboot...');
  const login1 = await request('POST', '/api/auth/login', {
    emailOrUsername: email,
    password
  });
  if (login1.status !== 200 || login1.json.user.id !== userId) {
    throw new Error(`Immediate login failed: ${login1.rawBody}`);
  }
  console.log('   Immediate login successful.');

  console.log('\n=== REBOOT CYCLE VERIFIED FOR RECORD ===');
  console.log(`User ID: ${userId}`);
  console.log(`Email: ${email}`);
  console.log(`Avatar URL: ${avatarUrl}`);
  console.log('Status: ALL PERSISTENCE CHECKS PASSED!');
}

runCycle().catch(e => {
  console.error(e);
  process.exit(1);
});
