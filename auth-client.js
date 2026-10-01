/**
 * NexusMeet Client Authentication Helper: Token Storage & Resilient REST API Interfacing
 */

const AUTH_TOKEN_KEY = 'nexus_auth_token';
const AUTH_USER_KEY = 'nexus_auth_user';

// Get Stored JWT Token
function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch (_) {
    return null;
  }
}

// Get Stored User Object
function getAuthUser() {
  try {
    const userJson = localStorage.getItem(AUTH_USER_KEY);
    return userJson ? JSON.parse(userJson) : null;
  } catch (err) {
    return null;
  }
}

// Store Session Credentials
function setAuthSession(token, user) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  } catch (err) {
    console.warn('[Auth] Failed to persist session to localStorage:', err);
  }
}

// Clear Session on Logout
function clearAuthSession() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  } catch (_) {}
}

// Resilient API Fetch Helper (uses NexusErrorManager if available)
async function doFetch(url, options = {}, config = {}) {
  if (typeof NexusErrorManager !== 'undefined' && typeof NexusErrorManager.apiFetch === 'function') {
    return await NexusErrorManager.apiFetch(url, options, config);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs || 5000);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Register API Call
async function apiRegister(username, email, password, avatarImage = null) {
  const data = await doFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password, avatarImage })
  }, {
    category: 'AUTH',
    operation: 'apiRegister',
    maxRetries: 0 // Non-idempotent mutation: do not retry automatically
  });

  if (!data || !data.success) {
    throw new Error(data?.error || 'Registration failed.');
  }

  setAuthSession(data.token, data.user);
  return data;
}

// Upload/Update Avatar API Call
async function apiUploadAvatar(avatarBase64OrUrl) {
  const token = getAuthToken();
  if (!token) throw new Error('Authentication required to upload profile photo.');

  const data = await doFetch('/api/auth/upload-avatar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ avatarImage: avatarBase64OrUrl })
  }, {
    category: 'AUTH',
    operation: 'apiUploadAvatar',
    maxRetries: 0
  });

  if (!data || !data.success) {
    throw new Error(data?.error || 'Avatar upload failed.');
  }

  // Update cached user session in localStorage
  const existingUser = getAuthUser() || {};
  const updatedUser = {
    ...existingUser,
    avatarUrl: data.avatarUrl
  };
  setAuthSession(token, updatedUser);
  return data;
}

// Login API Call
async function apiLogin(emailOrUsername, password) {
  const data = await doFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername, password })
  }, {
    category: 'AUTH',
    operation: 'apiLogin',
    maxRetries: 0
  });

  if (!data || !data.success) {
    throw new Error(data?.error || 'Login failed.');
  }

  setAuthSession(data.token, data.user);
  return data;
}

// Verify Session Profile with Retry
async function apiFetchProfile() {
  const token = getAuthToken();
  if (!token) return null;

  try {
    const data = await doFetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    }, {
      category: 'AUTH',
      operation: 'apiFetchProfile',
      maxRetries: 2,
      timeoutMs: 4000
    });

    if (data && data.success && data.user) {
      // Update cached session
      setAuthSession(token, data.user);
      return data.user;
    } else {
      clearAuthSession();
      return null;
    }
  } catch (err) {
    if (err.status === 401) {
      clearAuthSession();
    }
    return null;
  }
}

// Auth Guard Check: Redirect to login.html if not authenticated
async function requireAuth() {
  const user = await apiFetchProfile();
  if (!user) {
    if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
      window.location.href = '/login';
    }
    return null;
  }
  return user;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getAuthToken,
    getAuthUser,
    setAuthSession,
    clearAuthSession,
    apiRegister,
    apiLogin,
    apiFetchProfile,
    apiUploadAvatar,
    requireAuth
  };
}
