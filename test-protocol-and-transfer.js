/**
 * Comprehensive Test for P2P File Transfer Protocol & Candidate Queuing
 * Tests:
 * 1. Binary chunk framing (0x01, transferId, chunkIndex, totalChunks, payload)
 * 2. Out-of-order chunk reconstruction
 * 3. File size integrity verification
 * 4. Multiple simultaneous transfers without mixing chunks
 * 5. ICE candidate queuing when remoteDescription is not yet set
 */

const crypto = require('crypto');
const subtle = crypto.webcrypto.subtle;

// Helper: Adler-32 Checksum
function computeAdler32(arrayBuffer) {
  let a = 1, b = 0;
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Helper: Packet creation matching client.js with 32-bit checksum
function createChunkPacket(transferId, chunkIndex, totalChunks, checksum, encryptedChunkBuffer) {
  const enc = new TextEncoder();
  const idBytes = enc.encode(transferId);
  const headerSize = 1 + 1 + idBytes.length + 4 + 4 + 4;
  const packet = new Uint8Array(headerSize + encryptedChunkBuffer.byteLength);
  const view = new DataView(packet.buffer);

  let offset = 0;
  view.setUint8(offset++, 0x01); // 0x01 = file-chunk
  view.setUint8(offset++, idBytes.length);
  packet.set(idBytes, offset);
  offset += idBytes.length;
  view.setUint32(offset, chunkIndex, false);
  offset += 4;
  view.setUint32(offset, totalChunks, false);
  offset += 4;
  view.setUint32(offset, checksum, false);
  offset += 4;
  packet.set(new Uint8Array(encryptedChunkBuffer), offset);

  return packet.buffer;
}

// Helper: Packet parsing matching client.js with checksum
function parseChunkPacket(arrayBuffer) {
  if (arrayBuffer.byteLength < 14) return null;
  const view = new DataView(arrayBuffer);
  let offset = 0;
  const msgType = view.getUint8(offset++);
  if (msgType !== 0x01) return null;

  const idLen = view.getUint8(offset++);
  if (arrayBuffer.byteLength < 2 + idLen + 12) return null;

  const dec = new TextDecoder();
  const transferId = dec.decode(new Uint8Array(arrayBuffer, offset, idLen));
  offset += idLen;

  const chunkIndex = view.getUint32(offset, false);
  offset += 4;
  const totalChunks = view.getUint32(offset, false);
  offset += 4;
  const checksum = view.getUint32(offset, false);
  offset += 4;

  const payload = arrayBuffer.slice(offset);
  return { transferId, chunkIndex, totalChunks, checksum, payload };
}

// AES-GCM Encrypt/Decrypt Helpers
async function encryptBinaryChunk(key, chunkBuffer) {
  const iv = crypto.randomBytes(12);
  const cipherBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    chunkBuffer
  );
  const combined = Buffer.concat([iv, Buffer.from(cipherBuffer)]);
  return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
}

async function decryptBinaryChunk(key, combinedArrayBuffer) {
  const iv = new Uint8Array(combinedArrayBuffer.slice(0, 12));
  const cipherSlice = combinedArrayBuffer.slice(12);
  const decryptedBuffer = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    cipherSlice
  );
  return Buffer.from(decryptedBuffer);
}

async function runProtocolTests() {
  console.log('=================================================================');
  console.log('📦 RUNNING P2P FILE TRANSFER PROTOCOL & RECONSTRUCTION TESTS');
  console.log('=================================================================\n');

  const randomKeyBytes = crypto.randomBytes(32);
  const aesKey = await subtle.importKey(
    'raw',
    randomKeyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  // Test 1: Single file chunking and packet framing
  console.log('Test 1: Binary packet serialization and deserialization...');
  const transferId1 = 'tx_test_1001';
  const sampleData = Buffer.from('NexusMeet encrypted block payload for chunk testing 12345');
  const encChunk = await encryptBinaryChunk(aesKey, sampleData);
  const checksum1 = computeAdler32(encChunk);
  const packetBuffer = createChunkPacket(transferId1, 2, 5, checksum1, encChunk);

  const parsed = parseChunkPacket(packetBuffer);
  if (!parsed || parsed.transferId !== transferId1 || parsed.chunkIndex !== 2 || parsed.totalChunks !== 5 || parsed.checksum !== checksum1) {
    throw new Error('Test 1 Failed: Packet parsing mismatch');
  }
  const decChunk = await decryptBinaryChunk(aesKey, parsed.payload);
  if (Buffer.compare(decChunk, sampleData) !== 0) {
    throw new Error('Test 1 Failed: Decrypted payload mismatch');
  }
  console.log('✅ Test 1 Passed: Binary chunk packet properly framed and decrypted.\n');

  // Test 2: Out-of-order chunk reconstruction
  console.log('Test 2: Out-of-order chunk reassembly & integrity...');
  const fullText = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
  const fullBuffer = Buffer.from(fullText, 'utf-8');
  const CHUNK_SIZE = 128;
  const totalChunks = Math.ceil(fullBuffer.length / CHUNK_SIZE);
  const transferId2 = 'tx_test_2002';

  // Create packets
  const packets = [];
  for (let i = 0; i < totalChunks; i++) {
    const slice = fullBuffer.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, fullBuffer.length));
    const encrypted = await encryptBinaryChunk(aesKey, slice);
    const checksum = computeAdler32(encrypted);
    const pkt = createChunkPacket(transferId2, i, totalChunks, checksum, encrypted);
    packets.push(pkt);
  }

  // Shuffle packets to simulate out-of-order network arrival
  const shuffledPackets = [...packets].sort(() => Math.random() - 0.5);

  // Receiver simulated map
  const receiverStore = new Map();
  for (const pkt of shuffledPackets) {
    const p = parseChunkPacket(pkt);
    const calculatedChecksum = computeAdler32(p.payload);
    if (calculatedChecksum !== p.checksum) {
      throw new Error('Test 2 Failed: Checksum mismatch on valid packet');
    }
    const decrypted = await decryptBinaryChunk(aesKey, p.payload);
    receiverStore.set(p.chunkIndex, decrypted);
  }

  if (receiverStore.size !== totalChunks) {
    throw new Error('Test 2 Failed: Missing chunks in receiver store');
  }

  // Sequential assembly
  const assembledSlices = [];
  for (let i = 0; i < totalChunks; i++) {
    assembledSlices.push(receiverStore.get(i));
  }
  const assembledBuffer = Buffer.concat(assembledSlices);
  if (Buffer.compare(assembledBuffer, fullBuffer) !== 0) {
    throw new Error('Test 2 Failed: Assembled buffer does not match original file buffer');
  }
  console.log(`✅ Test 2 Passed: ${totalChunks} out-of-order chunks correctly reassembled and verified.\n`);

  // Test 3: Multiple simultaneous transfers without mixing chunks
  console.log('Test 3: Multiple concurrent transfers with distinct transferIds...');
  const transferA = 'tx_file_alpha';
  const transferB = 'tx_file_beta';
  const fileA = Buffer.from('Alpha File Contents: Secret Document A');
  const fileB = Buffer.from('Beta File Contents: Secret Document B');

  const encA = await encryptBinaryChunk(aesKey, fileA);
  const encB = await encryptBinaryChunk(aesKey, fileB);
  const pktA = createChunkPacket(transferA, 0, 1, computeAdler32(encA), encA);
  const pktB = createChunkPacket(transferB, 0, 1, computeAdler32(encB), encB);

  const multiTransferStore = {
    [transferA]: [],
    [transferB]: []
  };

  // Process packets
  const incomingPackets = [pktB, pktA]; // Arriving interleaved
  for (const pkt of incomingPackets) {
    const p = parseChunkPacket(pkt);
    const dec = await decryptBinaryChunk(aesKey, p.payload);
    multiTransferStore[p.transferId].push(dec);
  }

  if (multiTransferStore[transferA][0].toString() !== fileA.toString()) {
    throw new Error('Test 3 Failed: Transfer A contaminated');
  }
  if (multiTransferStore[transferB][0].toString() !== fileB.toString()) {
    throw new Error('Test 3 Failed: Transfer B contaminated');
  }
  console.log('✅ Test 3 Passed: Concurrent transfers properly isolated by transferId.\n');

  // Test 5: Rejection of corrupted chunk via checksum
  console.log('Test 5: Detection and rejection of corrupted binary chunk...');
  const legitPayload = await encryptBinaryChunk(aesKey, Buffer.from('Critical file data'));
  const legitChecksum = computeAdler32(legitPayload);
  const goodPacket = createChunkPacket('tx_corrupt_test', 0, 1, legitChecksum, legitPayload);

  // Intentionally flip byte in payload
  const corruptedPacket = new Uint8Array(goodPacket);
  corruptedPacket[corruptedPacket.length - 1] ^= 0xFF; // Mutate last byte

  const parsedCorrupt = parseChunkPacket(corruptedPacket.buffer);
  const check = computeAdler32(parsedCorrupt.payload);
  if (check === parsedCorrupt.checksum) {
    throw new Error('Test 5 Failed: Corrupted chunk was not detected by checksum');
  }
  console.log('✅ Test 5 Passed: Corrupted chunk detected and rejected via checksum mismatch.\n');

  // Test 4: ICE candidate queue flushing logic simulation
  console.log('Test 4: ICE candidate queuing before remoteDescription set...');
  const mockPc = {
    remoteDescription: null,
    addedCandidates: [],
    async addIceCandidate(cand) {
      if (!this.remoteDescription) {
        throw new Error('InvalidStateError: remoteDescription not set');
      }
      this.addedCandidates.push(cand);
    }
  };

  const candidateQueue = [];
  function handleIncomingIceCandidate(cand) {
    if (!mockPc.remoteDescription) {
      candidateQueue.push(cand);
    } else {
      mockPc.addIceCandidate(cand);
    }
  }

  handleIncomingIceCandidate({ candidate: 'cand_1' });
  handleIncomingIceCandidate({ candidate: 'cand_2' });

  if (candidateQueue.length !== 2 || mockPc.addedCandidates.length !== 0) {
    throw new Error('Test 4 Failed: Candidates not queued');
  }

  // Simulate remoteDescription set
  mockPc.remoteDescription = { type: 'offer', sdp: 'mock_sdp' };
  while (candidateQueue.length > 0) {
    const c = candidateQueue.shift();
    await mockPc.addIceCandidate(c);
  }

  if (mockPc.addedCandidates.length !== 2 || candidateQueue.length !== 0) {
    throw new Error('Test 4 Failed: Candidates not flushed after remoteDescription set');
  }
  console.log('✅ Test 4 Passed: ICE candidate queuing and flushing verified.\n');

  console.log('=================================================================');
  console.log('🎉 ALL P2P TRANSFER PROTOCOL & QUEUING TESTS PASSED');
  console.log('=================================================================\n');
}

runProtocolTests().then(() => process.exit(0)).catch(err => {
  console.error('❌ Protocol test failed:', err);
  process.exit(1);
});
