/**
 * NexusMeet Client Authentication Helper: Token Storage & REST API Interfacing
 */

const AUTH_TOKEN_KEY = 'nexus_auth_token';
const AUTH_USER_KEY = 'nexus_auth_user';

// Get Stored JWT Token
function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

// Get Stored User Object
function getAuthUser() {
  const userJson = localStorage.getItem(AUTH_USER_KEY);
  try {
    return userJson ? JSON.parse(userJson) : null;
  } catch (err) {
    return null;
  }
}

// Store Session Credentials
function setAuthSession(token, user) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

// Clear Session on Logout
function clearAuthSession() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

// Register API Call
async function apiRegister(username, email, password) {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password })
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Registration failed.');
  }

  setAuthSession(data.token, data.user);
  return data;
}

// Login API Call
async function apiLogin(emailOrUsername, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername, password })
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Login failed.');
  }

  setAuthSession(data.token, data.user);
  return data;
}

// Verify Session Profile
async function apiFetchProfile() {
  const token = getAuthToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return data.user;
    } else {
      clearAuthSession();
      return null;
    }
  } catch (err) {
    return null;
  }
}

// Auth Guard Check: Redirect to login.html if not authenticated
async function requireAuth() {
  const user = await apiFetchProfile();
  if (!user) {
    window.location.href = '/login';
    return null;
  }
  return user;
}
