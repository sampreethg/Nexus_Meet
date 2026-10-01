/**
 * Authentication Module: Secure Password Hashing (bcryptjs), JWT Issuance/Verification,
 * Persistent Multi-Tier Storage (Prisma PostgreSQL + Disk-Backed Atomic JSON Store),
 * and Profile Image / Avatar Management
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

let prisma;
try {
  prisma = new PrismaClient();
} catch (e) {
  console.warn('[Prisma] Could not initialize PrismaClient:', e.message);
}

const JWT_SECRET = process.env.JWT_SECRET || 'nexus-meet-jwt-secret-secure-key-2026';
const USERS_FILE = path.join(__dirname, 'users.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'avatars');

// Ensure upload directory exists
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (err) {
  console.warn('[Uploads] Could not create uploads/avatars directory:', err.message);
}

// Custom Authentication Error with explicit HTTP status and error codes
class AuthError extends Error {
  constructor(message, statusCode = 400, code = 'AUTH_ERROR') {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// In-Memory map kept strictly synchronized with disk storage (users.json)
const persistentUsersMap = new Map();

/**
 * Load persistent user accounts from users.json on server startup
 */
function loadUsersFromDisk() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const user of list) {
          if (user && user.id) {
            persistentUsersMap.set(user.id, {
              ...user,
              avatarUrl: user.avatarUrl || null
            });
          }
        }
        console.log(`[Auth/Disk] Successfully loaded ${persistentUsersMap.size} persistent accounts from ${USERS_FILE}`);
      }
    } else {
      fs.writeFileSync(USERS_FILE, '[]', 'utf8');
      console.log(`[Auth/Disk] Created new persistent storage file: ${USERS_FILE}`);
    }
  } catch (err) {
    console.warn('[Auth/Disk] Error reading users.json:', err.message);
  }
}

/**
 * Atomically save current users to users.json on disk
 */
function saveUsersToDisk() {
  try {
    const list = Array.from(persistentUsersMap.values());
    const tempFile = `${USERS_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tempFile, USERS_FILE);
  } catch (err) {
    console.error('[Auth/Disk] Failed to write users.json:', err.message);
  }
}

// Initialize persistent accounts on module load
loadUsersFromDisk();

/**
 * Save Base64 or Data URI avatar image to disk
 */
function saveBase64Avatar(userId, base64Data, originalName = 'avatar.png') {
  if (!base64Data || typeof base64Data !== 'string') return null;

  try {
    let cleanBase64 = base64Data;
    let ext = 'png';

    const match = base64Data.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (match) {
      ext = match[1] === 'jpeg' ? 'jpg' : match[1].replace('svg+xml', 'svg');
      cleanBase64 = match[2];
    } else if (originalName) {
      const parsedExt = path.extname(originalName).replace('.', '').toLowerCase();
      if (parsedExt && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(parsedExt)) {
        ext = parsedExt === 'jpeg' ? 'jpg' : parsedExt;
      }
    }

    const buffer = Buffer.from(cleanBase64, 'base64');
    // Limit avatar to 5MB max
    if (buffer.length > 5 * 1024 * 1024) {
      throw new Error('Avatar image file size exceeds 5MB limit.');
    }

    const filename = `avatar-${userId}-${Date.now()}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    const relativeUrl = `/uploads/avatars/${filename}`;
    console.log(`[Auth/Avatar] Saved avatar for user ${userId} to ${relativeUrl}`);
    return relativeUrl;
  } catch (err) {
    console.warn('[Auth/Avatar] Failed to save avatar image:', err.message);
    return null;
  }
}

/**
 * Register a new user with password hashing, persistent storage, and optional avatar image
 */
async function registerUser({ username, email, password, avatarImage, avatarUrl }) {
  if (!username || username.trim().length < 3) {
    throw new AuthError('Username must be at least 3 characters long.', 400, 'VALIDATION_ERROR');
  }
  if (!email || !email.includes('@')) {
    throw new AuthError('Please provide a valid email address.', 400, 'VALIDATION_ERROR');
  }
  if (!password || password.length < 6) {
    throw new AuthError('Password must be at least 6 characters long.', 400, 'VALIDATION_ERROR');
  }

  const cleanUsername = username.trim();
  const cleanEmail = email.trim().toLowerCase();

  // 1. Check duplicate username or email in persistent disk store
  for (const existing of persistentUsersMap.values()) {
    if (existing.username.toLowerCase() === cleanUsername.toLowerCase()) {
      throw new AuthError('Username is already taken.', 409, 'DUPLICATE_USERNAME');
    }
    if (existing.email.toLowerCase() === cleanEmail) {
      throw new AuthError('Email is already registered.', 409, 'DUPLICATE_EMAIL');
    }
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);
  const userId = `usr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  // Process avatar image if supplied
  let finalAvatarUrl = avatarUrl || null;
  if (avatarImage) {
    finalAvatarUrl = saveBase64Avatar(userId, avatarImage) || finalAvatarUrl;
  }

  let prismaUser = null;
  // 2. Attempt PostgreSQL insertion via Prisma if available
  if (prisma && process.env.DATABASE_URL) {
    try {
      const existingInDb = await prisma.user.findFirst({
        where: {
          OR: [
            { username: { equals: cleanUsername, mode: 'insensitive' } },
            { email: { equals: cleanEmail, mode: 'insensitive' } }
          ]
        }
      });

      if (existingInDb) {
        if (existingInDb.username.toLowerCase() === cleanUsername.toLowerCase()) {
          throw new AuthError('Username is already taken.', 409, 'DUPLICATE_USERNAME');
        }
        if (existingInDb.email.toLowerCase() === cleanEmail) {
          throw new AuthError('Email is already registered.', 409, 'DUPLICATE_EMAIL');
        }
      }

      prismaUser = await prisma.user.create({
        data: {
          id: userId,
          username: cleanUsername,
          email: cleanEmail,
          passwordHash: passwordHash,
          avatarUrl: finalAvatarUrl
        }
      });
      console.log(`[Auth/Prisma] Created user in PostgreSQL: ${cleanUsername} (${prismaUser.id})`);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      console.warn('[Prisma Auth Fallback] PostgreSQL database unavailable, persisting to disk store:', err.message);
    }
  }

  // 3. Atomically persist to local disk storage
  const finalUserId = prismaUser ? prismaUser.id : userId;
  const newUser = {
    id: finalUserId,
    username: cleanUsername,
    email: cleanEmail,
    passwordHash: passwordHash,
    avatarUrl: finalAvatarUrl,
    createdAt: new Date().toISOString()
  };

  persistentUsersMap.set(finalUserId, newUser);
  saveUsersToDisk();

  console.log(`[Auth/Disk] Persisted user account: ${cleanUsername} (${finalUserId}) [Avatar: ${finalAvatarUrl ? 'Yes' : 'No'}]`);

  const token = jwt.sign(
    {
      id: newUser.id,
      username: newUser.username,
      email: newUser.email,
      avatarUrl: newUser.avatarUrl
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    token,
    user: {
      id: newUser.id,
      username: newUser.username,
      email: newUser.email,
      avatarUrl: newUser.avatarUrl
    }
  };
}

/**
 * Authenticate existing user with exact error categorization
 */
async function loginUser({ emailOrUsername, identifier, email, username, password }) {
  const queryParam = emailOrUsername || identifier || email || username;
  if (!queryParam || !password) {
    throw new AuthError('Please enter both your email/username and password.', 400, 'VALIDATION_ERROR');
  }

  const query = queryParam.trim().toLowerCase();
  let foundUser = null;

  // 1. Check PostgreSQL via Prisma if connected
  if (prisma && process.env.DATABASE_URL) {
    try {
      foundUser = await prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: query, mode: 'insensitive' } },
            { username: { equals: query, mode: 'insensitive' } }
          ]
        }
      });
    } catch (err) {
      console.warn('[Prisma Auth Fallback] PostgreSQL query failed, checking disk store:', err.message);
    }
  }

  // 2. Query persistent disk store
  if (!foundUser) {
    for (const user of persistentUsersMap.values()) {
      if (user.email.toLowerCase() === query || user.username.toLowerCase() === query) {
        foundUser = user;
        break;
      }
    }
  }

  // 3. Handle non-existent account with specific message and 404 code
  if (!foundUser) {
    throw new AuthError('Account not found. Please check your email or create an account.', 404, 'ACCOUNT_NOT_FOUND');
  }

  // 4. Verify password with bcrypt
  const isMatch = await bcrypt.compare(password, foundUser.passwordHash);
  if (!isMatch) {
    throw new AuthError('Incorrect password.', 401, 'INVALID_PASSWORD');
  }

  const token = jwt.sign(
    {
      id: foundUser.id,
      username: foundUser.username,
      email: foundUser.email,
      avatarUrl: foundUser.avatarUrl || null
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  console.log(`[Auth] Authenticated user: ${foundUser.username} (${foundUser.id})`);

  return {
    token,
    user: {
      id: foundUser.id,
      username: foundUser.username,
      email: foundUser.email,
      avatarUrl: foundUser.avatarUrl || null
    }
  };
}

/**
 * Retrieve user profile by ID
 */
async function getUserById(userId) {
  if (!userId) return null;

  if (prisma && process.env.DATABASE_URL) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user) return user;
    } catch (_) {}
  }

  return persistentUsersMap.get(userId) || null;
}

/**
 * Update user avatar image and persist across storage tiers
 */
async function updateUserAvatar(userId, base64OrUrl) {
  const user = await getUserById(userId);
  if (!user) {
    throw new AuthError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
  }

  let finalUrl = base64OrUrl;
  if (base64OrUrl && base64OrUrl.startsWith('data:image/')) {
    finalUrl = saveBase64Avatar(userId, base64OrUrl);
  }

  // Update in memory map
  const updatedUser = {
    ...user,
    avatarUrl: finalUrl
  };
  persistentUsersMap.set(userId, updatedUser);
  saveUsersToDisk();

  // Update in Prisma DB if available
  if (prisma && process.env.DATABASE_URL) {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { avatarUrl: finalUrl }
      });
    } catch (err) {
      console.warn('[Prisma Avatar Fallback] Could not update avatar in DB:', err.message);
    }
  }

  console.log(`[Auth/Avatar] Updated avatar for ${updatedUser.username} (${userId}): ${finalUrl}`);
  return {
    id: updatedUser.id,
    username: updatedUser.username,
    email: updatedUser.email,
    avatarUrl: updatedUser.avatarUrl
  };
}

/**
 * Verify JWT Token
 */
function verifyToken(token) {
  if (!token) throw new AuthError('No token provided.', 401, 'MISSING_TOKEN');
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  AuthError,
  registerUser,
  loginUser,
  getUserById,
  updateUserAvatar,
  saveBase64Avatar,
  verifyToken,
  persistentUsersMap,
  prisma
};
