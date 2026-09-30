const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const { registerUser, loginUser, verifyToken, prisma } = require('./auth');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// =========================================================================
// Pub/Sub Coordination: Socket.io Redis Adapter Integration
// =========================================================================
const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL) {
  try {
    const pubClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true
    });
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => console.warn('[Redis PubClient Warning]', err.message));
    subClient.on('error', (err) => console.warn('[Redis SubClient Warning]', err.message));

    Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        console.log('[Redis Adapter] Socket.io Redis adapter initialized successfully.');
      })
      .catch((err) => {
        console.warn('[Redis Adapter Warning] Redis cluster unavailable:', err.message);
      });
  } catch (err) {
    console.warn('[Redis Adapter Warning] Redis client initialization failed:', err.message);
  }
} else {
  console.log('[Redis Adapter] REDIS_URL env variable not set. Ready for Redis cluster configuration.');
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// =========================================================================
// REST Authentication Endpoints
// =========================================================================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const result = await registerUser({ username, email, password });
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    const result = await loginUser({ emailOrUsername, password });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return res.status(401).json({ success: false, error: err.message });
  }
});

// GET /api/auth/me (Protected Profile Route)
app.get('/api/auth/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Missing token' });
    }
    const token = authHeader.split(' ')[1];
    const user = verifyToken(token);
    return res.status(200).json({ success: true, user });
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
});

// =========================================================================
// WebRTC TURN Credentials Endpoint (Protected REST Route)
// =========================================================================
app.get(['/api/webrtc/turn-credentials', '/api/webrtc/ice-servers'], (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Missing auth token' });
    }
    const token = authHeader.split(' ')[1];
    verifyToken(token);

    const turnUsername = process.env.TURN_USERNAME || 'nexus_user';
    const turnCredential = process.env.TURN_CREDENTIAL || process.env.TURN_PASSWORD || 'nexus_secure_turn_pass_2026';
    const turnUrl = process.env.TURN_URL || 'turn:turn.nexusmeet.com:3478';
    const turnUrlSecure = process.env.TURNS_URL || 'turns:turn.nexusmeet.com:5349';

    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      {
        urls: [turnUrl, turnUrlSecure],
        username: turnUsername,
        credential: turnCredential
      }
    ];

    return res.status(200).json({ success: true, iceServers });
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
});

// Navigation Route Handlers
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'lobby.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/lobby', (req, res) => res.sendFile(path.join(__dirname, 'lobby.html')));
app.get('/room', (req, res) => res.sendFile(path.join(__dirname, 'room.html')));

// Fallback in-memory stroke history for offline dev testing without PostgreSQL connection
const fallbackStrokesMap = new Map();

// =========================================================================
// Secure Socket.io JWT Authentication Middleware
// =========================================================================
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    console.warn(`[Socket.io Auth] Blocked connection attempt without token (${socket.id})`);
    return next(new Error('AUTHENTICATION_ERROR: Missing auth token'));
  }

  try {
    const user = verifyToken(token);
    socket.user = user;
    console.log(`[Socket.io Auth] Verified user: ${user.username} (${user.id}) on socket ${socket.id}`);
    next();
  } catch (err) {
    console.warn(`[Socket.io Auth] Token verification failed for socket ${socket.id}: ${err.message}`);
    return next(new Error('AUTHENTICATION_ERROR: Invalid or expired token'));
  }
});

// =========================================================================
// Real-Time Signaling & Room Management (Stateless & Database-Backed)
// =========================================================================
io.on('connection', (socket) => {
  const verifiedUser = socket.user || { id: 'anon', username: 'Anonymous', email: 'anon@meet.local' };
  console.log(`[Socket] Authenticated connection: ${verifiedUser.username} (${socket.id})`);

  // 1. Join Room
  socket.on('join-room', async ({ roomId, micOn = true, videoOn = true }) => {
    if (!roomId) roomId = 'nexus-alpha';
    const username = verifiedUser.username;

    socket.roomId = roomId;
    socket.username = username;
    socket.userId = verifiedUser.id;
    socket.micOn = micOn;
    socket.videoOn = videoOn;
    socket.handRaised = false;

    const userInfo = {
      socketId: socket.id,
      userId: verifiedUser.id,
      username: username,
      email: verifiedUser.email,
      micOn: socket.micOn,
      videoOn: socket.videoOn,
      handRaised: socket.handRaised,
      joinedAt: new Date().toISOString()
    };

    socket.data.userInfo = userInfo;
    socket.join(roomId);

    // Upsert Room session in PostgreSQL DB via Prisma
    if (prisma && process.env.DATABASE_URL) {
      try {
        await prisma.room.upsert({
          where: { id: roomId },
          update: {},
          create: { id: roomId, name: roomId }
        });
      } catch (err) {
        console.warn(`[Prisma Room Upsert Fallback] ${err.message}`);
      }
    }

    // Retrieve active room participants across serverless instances via Redis adapter
    let existingUsers = [];
    try {
      const sockets = await io.in(roomId).fetchSockets();
      existingUsers = sockets
        .filter(s => s.id !== socket.id && s.data && s.data.userInfo)
        .map(s => s.data.userInfo);
    } catch (err) {
      console.warn(`[Redis fetchSockets Fallback] ${err.message}`);
    }

    // Send room users to joining socket
    socket.emit('room-users', {
      self: userInfo,
      users: existingUsers,
      roomId: roomId
    });

    // Retrieve persistent whiteboard history from PostgreSQL database
    let history = [];
    if (prisma && process.env.DATABASE_URL) {
      try {
        const strokes = await prisma.whiteboardStroke.findMany({
          where: { roomId: roomId },
          orderBy: { createdAt: 'asc' }
        });
        history = strokes.map(s => (typeof s.strokeData === 'string' ? JSON.parse(s.strokeData) : s.strokeData));
      } catch (err) {
        console.warn(`[Prisma History Fallback] ${err.message}`);
      }
    }
    if (history.length === 0 && fallbackStrokesMap.has(roomId)) {
      history = fallbackStrokesMap.get(roomId);
    }

    if (history.length > 0) {
      socket.emit('whiteboard-history', history);
    }

    socket.to(roomId).emit('user-connected', userInfo);

    io.in(roomId).emit('chat-message', {
      id: `sys-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      senderId: 'system',
      username: 'System',
      message: `${username} joined the conference.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isSystem: true
    });
  });

  // 2. WebRTC Mesh Signaling Relays
  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer: offer,
      username: socket.username
    });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer: answer
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice-candidate', {
      senderSocketId: socket.id,
      candidate: candidate
    });
  });

  // 3. Collaborative Whiteboard Relays (Persistent PostgreSQL Storage)
  socket.on('whiteboard-draw', async (strokeData) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    // Save stroke directly to PostgreSQL via Prisma
    if (prisma && process.env.DATABASE_URL) {
      try {
        await prisma.whiteboardStroke.create({
          data: {
            roomId: roomId,
            strokeData: typeof strokeData === 'object' ? strokeData : JSON.parse(strokeData)
          }
        });
      } catch (err) {
        console.warn(`[Prisma Save Stroke Fallback] ${err.message}`);
      }
    }

    if (!fallbackStrokesMap.has(roomId)) {
      fallbackStrokesMap.set(roomId, []);
    }
    const memStrokes = fallbackStrokesMap.get(roomId);
    memStrokes.push(strokeData);
    if (memStrokes.length > 5000) memStrokes.shift();

    socket.to(roomId).emit('whiteboard-draw', strokeData);
  });

  socket.on('whiteboard-clear', async () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    // Clear strokes from PostgreSQL database
    if (prisma && process.env.DATABASE_URL) {
      try {
        await prisma.whiteboardStroke.deleteMany({
          where: { roomId: roomId }
        });
      } catch (err) {
        console.warn(`[Prisma Clear Strokes Fallback] ${err.message}`);
      }
    }
    fallbackStrokesMap.set(roomId, []);

    io.in(roomId).emit('whiteboard-clear');
  });

  // 4. Media & Hand Raise & Chat
  socket.on('toggle-media-state', ({ micOn, videoOn }) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    if (socket.data && socket.data.userInfo) {
      if (typeof micOn === 'boolean') socket.data.userInfo.micOn = micOn;
      if (typeof videoOn === 'boolean') socket.data.userInfo.videoOn = videoOn;
    }
    if (typeof micOn === 'boolean') socket.micOn = micOn;
    if (typeof videoOn === 'boolean') socket.videoOn = videoOn;

    socket.to(roomId).emit('user-media-toggled', {
      socketId: socket.id,
      micOn: typeof micOn === 'boolean' ? micOn : socket.micOn,
      videoOn: typeof videoOn === 'boolean' ? videoOn : socket.videoOn
    });
  });

  socket.on('toggle-hand-raise', ({ handRaised }) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    if (socket.data && socket.data.userInfo) {
      socket.data.userInfo.handRaised = handRaised;
    }
    socket.handRaised = handRaised;

    io.in(roomId).emit('user-hand-toggled', {
      socketId: socket.id,
      username: socket.username,
      handRaised: handRaised
    });
  });

  socket.on('send-chat-message', (data) => {
    const roomId = socket.roomId;
    if (!roomId || !data) return;

    const chatData = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      senderId: socket.id,
      username: socket.username || 'Anonymous',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isSystem: false,
      encrypted: !!data.encrypted,
      encryptedPayload: data.encryptedPayload || null,
      iv: data.iv || null,
      message: data.message ? data.message.trim() : null
    };

    io.in(roomId).emit('chat-message', chatData);
  });

  // 5. Disconnect Cleanup (Removes WebRTC connections; preserves PostgreSQL room history)
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const roomId = socket.roomId;
    if (roomId) {
      const username = socket.username || 'A user';

      socket.to(roomId).emit('user-disconnected', {
        socketId: socket.id,
        username: username
      });

      socket.to(roomId).emit('chat-message', {
        id: `sys-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        senderId: 'system',
        username: 'System',
        message: `${username} left the conference.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSystem: true
      });
    }
  });
});

// Vercel Serverless Function & WebSocket Upgrade Adaptation
module.exports = app;
module.exports.experimental_upgradeWebSocket = (serverInstance) => {
  io.attach(serverInstance);
};

if (require.main === module || !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`🔒 NexusMeet Secure Auth & WebRTC Server live on port ${PORT}`);
    console.log(`🔗 Local URL: http://localhost:${PORT}`);
    console.log(`===================================================`);
  });
}
