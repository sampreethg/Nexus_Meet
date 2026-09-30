/**
 * Authentication Module: Secure Password Hashing (bcryptjs), JWT Issuance/Verification,
 * and PostgreSQL Database Storage via Prisma ORM
 */

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

// Fallback user store for local offline testing when PostgreSQL server is not connected
const memoryUsersMap = new Map();

/**
 * Register a new user in PostgreSQL database via Prisma
 */
async function registerUser({ username, email, password }) {
  if (!username || username.trim().length < 3) {
    throw new Error('Username must be at least 3 characters long.');
  }
  if (!email || !email.includes('@')) {
    throw new Error('Please provide a valid email address.');
  }
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  const cleanUsername = username.trim();
  const cleanEmail = email.trim().toLowerCase();

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  let newUser = null;

  if (prisma && process.env.DATABASE_URL) {
    try {
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { username: { equals: cleanUsername, mode: 'insensitive' } },
            { email: { equals: cleanEmail, mode: 'insensitive' } }
          ]
        }
      });

      if (existingUser) {
        if (existingUser.username.toLowerCase() === cleanUsername.toLowerCase()) {
          throw new Error('Username is already taken.');
        }
        if (existingUser.email.toLowerCase() === cleanEmail) {
          throw new Error('Email is already registered.');
        }
      }

      newUser = await prisma.user.create({
        data: {
          username: cleanUsername,
          email: cleanEmail,
          passwordHash: passwordHash
        }
      });
      console.log(`[Auth/Prisma] Registered user in PostgreSQL DB: ${cleanUsername} (${newUser.id})`);
    } catch (err) {
      if (err.message.includes('Username is already taken') || err.message.includes('Email is already registered')) {
        throw err;
      }
      console.warn('[Prisma Auth Fallback] PostgreSQL database unavailable, using fallback store:', err.message);
    }
  }

  if (!newUser) {
    for (const u of memoryUsersMap.values()) {
      if (u.username.toLowerCase() === cleanUsername.toLowerCase()) {
        throw new Error('Username is already taken.');
      }
      if (u.email.toLowerCase() === cleanEmail) {
        throw new Error('Email is already registered.');
      }
    }
    const userId = `usr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    newUser = {
      id: userId,
      username: cleanUsername,
      email: cleanEmail,
      passwordHash: passwordHash,
      createdAt: new Date().toISOString()
    };
    memoryUsersMap.set(userId, newUser);
    console.log(`[Auth/Memory] Registered user in fallback cache: ${cleanUsername} (${userId})`);
  }

  const token = jwt.sign(
    { id: newUser.id, username: newUser.username, email: newUser.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    token,
    user: {
      id: newUser.id,
      username: newUser.username,
      email: newUser.email
    }
  };
}

/**
 * Authenticate existing user via PostgreSQL database lookup & bcrypt check
 */
async function loginUser({ emailOrUsername, password }) {
  if (!emailOrUsername || !password) {
    throw new Error('Please enter both your email/username and password.');
  }

  const query = emailOrUsername.trim().toLowerCase();
  let foundUser = null;

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
      console.warn('[Prisma Auth Fallback] PostgreSQL query failed, checking fallback cache:', err.message);
    }
  }

  if (!foundUser) {
    for (const user of memoryUsersMap.values()) {
      if (user.email.toLowerCase() === query || user.username.toLowerCase() === query) {
        foundUser = user;
        break;
      }
    }
  }

  if (!foundUser) {
    throw new Error('Invalid credentials. User not found.');
  }

  const isMatch = await bcrypt.compare(password, foundUser.passwordHash);
  if (!isMatch) {
    throw new Error('Invalid credentials. Incorrect password.');
  }

  const token = jwt.sign(
    { id: foundUser.id, username: foundUser.username, email: foundUser.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  console.log(`[Auth] Authenticated user: ${foundUser.username} (${foundUser.id})`);

  return {
    token,
    user: {
      id: foundUser.id,
      username: foundUser.username,
      email: foundUser.email
    }
  };
}

/**
 * Verify JWT Token
 */
function verifyToken(token) {
  if (!token) throw new Error('No token provided.');
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  registerUser,
  loginUser,
  verifyToken,
  prisma
};
