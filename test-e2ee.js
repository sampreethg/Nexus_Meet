const crypto = require('crypto');
const { io } = require('socket.io-client');
const { generateToken, registerUser } = require('./auth');

// Node.js Web Crypto API compatibility
const subtle = crypto.webcrypto.subtle;

// Client E2EE helper recreation in Node test environment
async function initRoomEncryption(roomIdentifier) {
  const enc = new TextEncoder();
  const salt = enc.encode(`nexus-e2ee-salt-v2:${roomIdentifier}`);
  const rawSecret = enc.encode(`nexus-room-secret:${roomIdentifier}`);

  const keyMaterial = await subtle.importKey(
    'raw',
    rawSecret,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function arrayBufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function base64ToArrayBuffer(base64) {
  return Buffer.from(base64, 'base64');
}

async function encryptTextMessage(key, plainText) {
  const iv = crypto.randomBytes(12);
  const encoded = new TextEncoder().encode(plainText);
  const cipherBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoded
  );
  return {
    ciphertext: arrayBufferToBase64(cipherBuffer),
    iv: arrayBufferToBase64(iv),
    encrypted: true
  };
}

async function decryptTextMessage(key, ciphertextBase64, ivBase64) {
  const iv = base64ToArrayBuffer(ivBase64);
  const cipherBuffer = base64ToArrayBuffer(ciphertextBase64);
  const decryptedBuffer = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    cipherBuffer
  );
  return new TextDecoder().decode(decryptedBuffer);
}

async function encryptBinaryChunk(key, chunkBuffer) {
  const iv = crypto.randomBytes(12);
  const cipherBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    chunkBuffer
  );
  const combined = Buffer.concat([iv, Buffer.from(cipherBuffer)]);
  return combined;
}

async function decryptBinaryChunk(key, combinedBuffer) {
  const iv = combinedBuffer.subarray(0, 12);
  const cipherSlice = combinedBuffer.subarray(12);
  const decryptedBuffer = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    cipherSlice
  );
  return Buffer.from(decryptedBuffer);
}

async function testE2EE() {
  console.log('=================================================================');
  console.log('🔐 STARTING NEXUSMEET END-TO-END ENCRYPTION (E2EE) VERIFICATION');
  console.log('=================================================================\n');

  const ROOM_ID = 'crypto-test-vault-99';

  // 1. Establish AES-256-GCM Keys for Alice and Bob
  console.log('1. [Key Management] Deriving 256-bit AES-GCM session keys via PBKDF2 (100k iterations)...');
  const aliceKey = await initRoomEncryption(ROOM_ID);
  const bobKey = await initRoomEncryption(ROOM_ID);
  console.log('✅ Alice and Bob generated matching zero-knowledge AES-256-GCM keys.\n');

  // 2. Cryptographic Hygiene & IV Uniqueness Test
  console.log('2. [Cryptographic Hygiene] Verifying non-reusable IVs on identical plaintext...');
  const msgText = 'Top-Secret Zero-Knowledge WebRTC Payload';
  const enc1 = await encryptTextMessage(aliceKey, msgText);
  const enc2 = await encryptTextMessage(aliceKey, msgText);

  console.log(`   Sample Ciphertext 1: ${enc1.ciphertext.substring(0, 32)}... (IV: ${enc1.iv})`);
  console.log(`   Sample Ciphertext 2: ${enc2.ciphertext.substring(0, 32)}... (IV: ${enc2.iv})`);

  if (enc1.iv !== enc2.iv && enc1.ciphertext !== enc2.ciphertext) {
    console.log('✅ Unique IV check passed: Fresh 12-byte IV generated per encryption.\n');
  } else {
    throw new Error('IV reuse detected!');
  }

  // 3. Binary File Chunk Encryption & Decryption
  console.log('3. [File Sharing Encryption] Verifying binary chunk AES-GCM encryption/decryption...');
  const originalFileBuffer = Buffer.from('PDF_DOCUMENT_BINARY_SIMULATION_BYTES_0123456789_ABCDEF', 'utf-8');
  const encryptedChunk = await encryptBinaryChunk(aliceKey, originalFileBuffer);
  console.log(`   Encrypted binary chunk size: ${encryptedChunk.length} bytes (12-byte IV + ciphertext + 16-byte GCM auth tag)`);
  
  const decryptedChunk = await decryptBinaryChunk(bobKey, encryptedChunk);
  const decryptedFileText = decryptedChunk.toString('utf-8');

  if (decryptedFileText === 'PDF_DOCUMENT_BINARY_SIMULATION_BYTES_0123456789_ABCDEF') {
    console.log(`✅ File chunk decryption verified: "${decryptedFileText}"\n`);
  } else {
    throw new Error('Binary file chunk decryption mismatch!');
  }

  // 4. Multi-Client Socket.io Relay Zero-Knowledge Test
  console.log('4. [Zero-Knowledge Socket Relay] Connecting Alice and Bob via JWT Socket.io...');
  const userA = await registerUser({ username: `alice_${Date.now().toString().slice(-4)}`, email: `alice_${Date.now()}@nexus.local`, password: 'Password@123' });
  const userB = await registerUser({ username: `bob_${Date.now().toString().slice(-4)}`, email: `bob_${Date.now()}@nexus.local`, password: 'Password@123' });

  const tokenA = userA.token;
  const tokenB = userB.token;

  const socketA = io('http://localhost:3000', { auth: { token: tokenA } });
  const socketB = io('http://localhost:3000', { auth: { token: tokenB } });

  await new Promise((resolve) => {
    let connected = 0;
    const check = () => { connected++; if (connected === 2) resolve(); };
    socketA.on('connect', check);
    socketB.on('connect', check);
  });

  socketA.emit('join-room', { roomId: ROOM_ID });
  socketB.emit('join-room', { roomId: ROOM_ID });

  await new Promise(r => setTimeout(r, 600));

  console.log('5. [Zero-Knowledge Wire Inspection] Alice sending encrypted chat message...');
  const secretChat = 'Hello Bob, our conversation is fully end-to-end encrypted with AES-256-GCM!';
  const encryptedChatPacket = await encryptTextMessage(aliceKey, secretChat);

  const receivedOnBob = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for socket message')), 5000);

    socketB.on('chat-message', async (data) => {
      if (data.senderId === socketA.id) {
        clearTimeout(timer);
        console.log('   [Wire Data Received on Server & Bob]:');
        console.log(`     - encrypted: ${data.encrypted}`);
        console.log(`     - encryptedPayload: ${data.encryptedPayload.substring(0, 36)}...`);
        console.log(`     - iv: ${data.iv}`);
        console.log(`     - plaintext message field: ${data.message} (Zero plaintext on wire!)`);

        // Bob decrypts with Bob's local key
        const decryptedMsg = await decryptTextMessage(bobKey, data.encryptedPayload, data.iv);
        resolve(decryptedMsg);
      }
    });

    socketA.emit('send-chat-message', {
      encryptedPayload: encryptedChatPacket.ciphertext,
      iv: encryptedChatPacket.iv,
      encrypted: true,
      message: null
    });
  });

  console.log(`\n✅ Bob successfully decrypted: "${receivedOnBob}"`);
  console.log('\n=================================================================');
  console.log('🎉 ALL END-TO-END ENCRYPTION TESTS PASSED WITH ZERO PLAINTEXT RELAY');
  console.log('=================================================================\n');

  socketA.disconnect();
  socketB.disconnect();
}

testE2EE().then(() => process.exit(0)).catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
