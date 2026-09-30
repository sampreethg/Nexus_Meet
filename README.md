# NexusMeet 🚀

**Stateless, Production-Ready WebRTC Video Conferencing & Real-Time Collaborative Whiteboard Platform**

NexusMeet is a modern, high-performance real-time WebRTC conferencing system refactored for serverless environments (e.g. Vercel). It features zero-knowledge End-to-End Encryption (AES-256-GCM), database persistence via Prisma & PostgreSQL, multi-instance pub/sub synchronization via Socket.io Redis Adapter, and dynamic STUN/TURN server credential management.

---

## 🏗️ Architecture Overview

- **Stateless Backend:** Completely decoupled from single-server in-memory state. Powered by Express, Socket.io, and Prisma.
- **Database Persistence:** PostgreSQL schema managed via Prisma for `User`, `Room`, and `WhiteboardStroke`.
- **Pub/Sub Coordination:** Integrated `@socket.io/redis-adapter` with `ioredis` to route messages and synchronize room presence across serverless instances using `io.in(roomId).fetchSockets()`.
- **WebRTC Mesh & Dynamic STUN/TURN:** Dynamically fetches time-limited STUN/TURN server credentials via `/api/webrtc/turn-credentials` to ensure reliable WebRTC P2P traversal even on strict NAT networks.
- **Serverless Adaptation:** Formatted for Vercel Serverless Functions with `experimental_upgradeWebSocket` binding and forced WebSocket transport (`['websocket']`) on the client.

---

## 🛠️ Getting Started

### 1. Installation

```bash
npm install
```

### 2. Database & Environment Setup

Set your PostgreSQL and Redis environment variables in `.env`:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/nexusmeet?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="your-secure-jwt-secret-key"
TURN_USERNAME="nexus_user"
TURN_CREDENTIAL="nexus_secure_turn_pass"
TURN_URL="turn:turn.nexusmeet.com:3478"
```

Generate the Prisma client:

```bash
npx prisma generate
npx prisma db push
```

### 3. Run Locally

```bash
node server.js
```

The application will be live at `http://localhost:3000`.

---

## 🧪 Running Tests

The test suite validates authentication security, multi-client signaling, collaborative whiteboard synchronization, and dynamic TURN credentials:

```bash
# Test Authentication & Socket Security
node test-auth-and-socket.js

# Test Multi-Client WebRTC Signaling
node test-signaling.js

# Test Whiteboard Collaboration & PostgreSQL History
node test-whiteboard.js

# Test Dynamic WebRTC STUN/TURN Credentials Endpoint
node test-turn-endpoint.js
```

---

## 📜 License

ISC License
