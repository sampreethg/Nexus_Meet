/**
 * NexusMeet Centralized Error & Reliability Manager
 *
 * Core Principle: DETECT → EXPLAIN → RECOVER → RETRY → FAIL SAFELY → LOG
 *
 * Provides:
 * - Error Categories (AUTH, API, MEDIA, SOCKET, WEBRTC, DATACHANNEL, FILE_TRANSFER, ENCRYPTION, WHITEBOARD, SCREEN_SHARE, VALIDATION, UNKNOWN)
 * - Safe Structured Logging with secret redaction (no tokens, passwords, keys)
 * - Global Uncaught Error & Unhandled Promise Rejection guards
 * - Centralized resilient API wrapper with timeout, exponential backoff, and 401 loop prevention
 * - User-friendly error messaging & toast notification system
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexusErrorManager = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ---------------------------------------------------------------------------
  // 1. Error Categories & Log Levels
  // ---------------------------------------------------------------------------
  const CATEGORIES = {
    AUTH: 'AUTH',
    API: 'API',
    MEDIA: 'MEDIA',
    SOCKET: 'SOCKET',
    WEBRTC: 'WEBRTC',
    DATACHANNEL: 'DATACHANNEL',
    FILE_TRANSFER: 'FILE_TRANSFER',
    ENCRYPTION: 'ENCRYPTION',
    WHITEBOARD: 'WHITEBOARD',
    SCREEN_SHARE: 'SCREEN_SHARE',
    VALIDATION: 'VALIDATION',
    UNKNOWN: 'UNKNOWN'
  };

  const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };

  let currentLogLevel = LOG_LEVELS.INFO;

  // Sensitive keys that must NEVER be printed in console logs
  const REDACTED_KEYS = new Set([
    'token',
    'jwt',
    'password',
    'passwordhash',
    'credential',
    'key',
    'secret',
    'authorization',
    'privatekey',
    'rawsecret',
    'turncredential'
  ]);

  /**
   * Deep clone and sanitize objects to redact credentials, tokens, and encryption keys.
   */
  function sanitizeForLog(data, depth = 0) {
    if (depth > 3 || data === null || data === undefined) return data;
    if (typeof data !== 'object') return data;

    if (Array.isArray(data)) {
      return data.slice(0, 10).map(item => sanitizeForLog(item, depth + 1));
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (REDACTED_KEYS.has(lowerKey) || lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('password')) {
        sanitized[key] = '[REDACTED]';
      } else if (value instanceof ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value))) {
        sanitized[key] = `[BinaryBuffer: ${value.byteLength} bytes]`;
      } else if (typeof value === 'object') {
        sanitized[key] = sanitizeForLog(value, depth + 1);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  // ---------------------------------------------------------------------------
  // 2. Structured Logger
  // ---------------------------------------------------------------------------
  function log(level, category, operation, message, context = null) {
    if (LOG_LEVELS[level] < currentLogLevel) return;

    const timestamp = new Date().toISOString();
    const prefix = `[NexusMeet] [${level}] [${category}] [${operation}]`;

    if (context) {
      const cleanContext = sanitizeForLog(context);
      if (level === 'ERROR') {
        console.error(prefix, message, cleanContext);
      } else if (level === 'WARN') {
        console.warn(prefix, message, cleanContext);
      } else if (level === 'INFO') {
        console.log(prefix, message, cleanContext);
      } else {
        console.debug(prefix, message, cleanContext);
      }
    } else {
      if (level === 'ERROR') {
        console.error(prefix, message);
      } else if (level === 'WARN') {
        console.warn(prefix, message);
      } else if (level === 'INFO') {
        console.log(prefix, message);
      } else {
        console.debug(prefix, message);
      }
    }
  }

  const logger = {
    debug: (cat, op, msg, ctx) => log('DEBUG', cat, op, msg, ctx),
    info: (cat, op, msg, ctx) => log('INFO', cat, op, msg, ctx),
    warn: (cat, op, msg, ctx) => log('WARN', cat, op, msg, ctx),
    error: (cat, op, msg, ctx) => log('ERROR', cat, op, msg, ctx),
    setLevel: (lvl) => {
      if (LOG_LEVELS[lvl] !== undefined) currentLogLevel = LOG_LEVELS[lvl];
    }
  };

  // ---------------------------------------------------------------------------
  // 3. User-Friendly Error Mapper (EXPLAIN)
  // ---------------------------------------------------------------------------
  function getUserFriendlyMessage(category, err, context = {}) {
    const rawMsg = err?.message || (typeof err === 'string' ? err : '');
    const errName = err?.name || '';

    switch (category) {
      case CATEGORIES.MEDIA:
        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError' || rawMsg.includes('denied')) {
          if (context.kind === 'video') return 'Camera access was denied. You can continue without video.';
          if (context.kind === 'audio') return 'Microphone access was denied. You can continue without audio.';
          return 'Camera or microphone permission was denied. You can continue with synthetic fallback.';
        }
        if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
          return 'No camera or microphone found on this device.';
        }
        if (errName === 'NotReadableError' || errName === 'TrackStartError') {
          return 'Your camera or microphone is already in use by another application.';
        }
        if (errName === 'OverconstrainedError') {
          return 'Your camera does not support the requested video resolution.';
        }
        if (rawMsg.includes('timeout') || errName === 'TimeoutError') {
          return 'Media acquisition timed out. Continuing with synthetic fallback.';
        }
        return 'Camera or microphone unavailable. Continuing with audio/video fallback.';

      case CATEGORIES.SCREEN_SHARE:
        if (errName === 'NotAllowedError' || rawMsg.includes('Permission denied') || rawMsg.includes('cancelled')) {
          return 'Screen sharing was cancelled or permission was denied.';
        }
        if (errName === 'NotSupportedError') {
          return 'Screen sharing is not supported by your current browser.';
        }
        return 'Unable to share screen. Please try again.';

      case CATEGORIES.AUTH:
        return 'Your session has expired or is invalid. Please sign in again.';

      case CATEGORIES.SOCKET:
        if (rawMsg.includes('AUTHENTICATION_ERROR')) {
          return 'Your session has expired. Please sign in again.';
        }
        return 'Connection to the meeting server was lost. Reconnecting...';

      case CATEGORIES.WEBRTC:
        return 'Unable to connect to this participant. Retrying...';

      case CATEGORIES.DATACHANNEL:
        return 'Data channel connection failed. File transfers may be unavailable.';

      case CATEGORIES.FILE_TRANSFER:
        if (context.reason) return `File transfer failed: ${context.reason}`;
        return 'File transfer failed because the connection was interrupted.';

      case CATEGORIES.ENCRYPTION:
        return 'Unable to decrypt this message.';

      case CATEGORIES.API:
        if (context.status === 401) return 'Session expired. Please log in again.';
        if (context.status === 403) return 'You do not have permission to perform this action.';
        if (context.status === 404) return 'The requested resource was not found.';
        if (context.status === 429) return 'Too many requests. Please wait a moment.';
        if (context.status >= 500) return 'The meeting service is temporarily unavailable. Please try again.';
        return 'Service request failed. Please check your internet connection.';

      case CATEGORIES.WHITEBOARD:
        return 'Collaborative canvas synchronization issue.';

      default:
        return 'An unexpected issue occurred. Please retry your action.';
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Centralized User Notification UI (Toasts & Status Banners)
  // ---------------------------------------------------------------------------
  function showNotification(message, type = 'info', duration = 3500) {
    if (typeof document === 'undefined') return;

    let toast = document.getElementById('toast');
    let msgEl = document.getElementById('toast-message');

    // Dynamically create toast container if absent in DOM
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast-notification';
      toast.innerHTML = '<i class="toast-icon fa-solid fa-circle-info"></i><span id="toast-message"></span>';
      document.body.appendChild(toast);
      msgEl = document.getElementById('toast-message');
    }

    if (!toast || !msgEl) return;

    msgEl.textContent = message;

    // Reset modifier classes
    toast.className = 'toast-notification show';
    const icon = toast.querySelector('i') || toast.querySelector('.toast-icon');

    if (type === 'danger' || type === 'error') {
      toast.classList.add('toast-danger');
      if (icon) {
        icon.className = 'toast-icon fa-solid fa-triangle-exclamation';
        icon.style.color = 'var(--status-danger, #ef4444)';
      }
    } else if (type === 'warning') {
      toast.classList.add('toast-warning');
      if (icon) {
        icon.className = 'toast-icon fa-solid fa-circle-exclamation';
        icon.style.color = '#f59e0b';
      }
    } else if (type === 'success') {
      toast.classList.add('toast-success');
      if (icon) {
        icon.className = 'toast-icon fa-solid fa-circle-check';
        icon.style.color = 'var(--status-live, #10b981)';
      }
    } else {
      toast.classList.add('toast-info');
      if (icon) {
        icon.className = 'toast-icon fa-solid fa-circle-info';
        icon.style.color = 'var(--status-live, #3b82f6)';
      }
    }

    if (toast._hideTimeout) clearTimeout(toast._hideTimeout);
    toast._hideTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  // ---------------------------------------------------------------------------
  // 5. Centralized Resilient API Wrapper (RETRY + EXPONENTIAL BACKOFF)
  // ---------------------------------------------------------------------------
  async function apiFetch(url, options = {}, config = {}) {
    const {
      timeoutMs = 6000,
      maxRetries = 2,
      backoffBaseMs = 500,
      category = CATEGORIES.API,
      operation = 'apiFetch'
    } = config;

    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const fetchOptions = {
          ...options,
          signal: controller.signal
        };

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        // 401 Unauthorized handling with infinite loop prevention
        if (response.status === 401) {
          logger.warn(CATEGORIES.AUTH, operation, 'Received 401 Unauthorized', { url });

          const redirecting = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('nexus_auth_redirecting');
          if (!redirecting) {
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.removeItem('nexus_auth_token');
                localStorage.removeItem('nexus_auth_user');
              }
              if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('nexus_auth_redirecting', 'true');
              }
            } catch (_) {}

            showNotification('Your session has expired. Redirecting to sign in...', 'warning');
            setTimeout(() => {
              try { sessionStorage.removeItem('nexus_auth_redirecting'); } catch (_) {}
              if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
                window.location.href = '/login';
              }
            }, 1200);
          }

          const err = new Error('AUTHENTICATION_ERROR: Session expired');
          err.status = 401;
          throw err;
        }

        // Retry on transient server errors (502, 503, 504, 408) for safe requests
        const isTransientServerErr = [408, 502, 503, 504].includes(response.status);
        const isSafeMethod = !options.method || ['GET', 'HEAD'].includes(options.method.toUpperCase());

        if (isTransientServerErr && isSafeMethod && attempt <= maxRetries) {
          const delay = backoffBaseMs * Math.pow(2, attempt - 1);
          logger.warn(category, operation, `HTTP ${response.status} on attempt ${attempt}. Retrying in ${delay}ms...`, { url });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        let data = null;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            data = await response.json();
          } catch (jsonErr) {
            logger.error(category, operation, 'Failed to parse JSON response body', { status: response.status });
            throw new Error(`Invalid JSON response from server (HTTP ${response.status})`);
          }
        } else {
          data = await response.text();
        }

        if (!response.ok) {
          const errorMsg = (typeof data === 'object' && data?.error) ? data.error : `HTTP ${response.status}`;
          const httpErr = new Error(errorMsg);
          httpErr.status = response.status;
          httpErr.data = data;
          throw httpErr;
        }

        return data;

      } catch (err) {
        clearTimeout(timeoutId);

        // Don't retry 401 or client aborts
        if (err.status === 401) throw err;

        const isNetworkOrTimeout = err.name === 'AbortError' || err.name === 'TypeError' || err.message.includes('fetch');
        const isSafeMethod = !options.method || ['GET', 'HEAD'].includes(options.method.toUpperCase());

        if (isNetworkOrTimeout && isSafeMethod && attempt <= maxRetries) {
          const delay = backoffBaseMs * Math.pow(2, attempt - 1);
          logger.warn(category, operation, `Network/Timeout on attempt ${attempt}. Retrying in ${delay}ms...`, { error: err.message, url });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        logger.error(category, operation, `Request failed permanently on attempt ${attempt}: ${err.message}`, { url, status: err.status });
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Global Uncaught Error & Promise Rejection Safety Net
  // ---------------------------------------------------------------------------
  function initGlobalHandlers() {
    if (typeof window === 'undefined') return;

    window.addEventListener('error', (event) => {
      // Prevent recursive handlers
      try {
        const error = event.error || {};
        logger.error(CATEGORIES.UNKNOWN, 'window.onerror', event.message || 'Uncaught error', {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          name: error.name
        });

        // Don't spam notifications on minor resize or font errors
        if (event.message && !event.message.includes('ResizeObserver') && !event.message.includes('Script error')) {
          showNotification('A temporary interface issue occurred.', 'warning', 2500);
        }
      } catch (_) {}
    });

    window.addEventListener('unhandledrejection', (event) => {
      try {
        const reason = event.reason;
        const msg = reason?.message || String(reason || 'Unhandled promise rejection');
        logger.error(CATEGORIES.UNKNOWN, 'unhandledrejection', msg, {
          name: reason?.name,
          status: reason?.status
        });

        if (msg.includes('AUTHENTICATION_ERROR')) {
          showNotification('Session expired. Please sign in again.', 'warning');
        } else if (!msg.includes('ResizeObserver')) {
          showNotification('A background task experienced a temporary interruption.', 'warning', 2500);
        }
      } catch (_) {}
    });

    logger.info(CATEGORIES.UNKNOWN, 'initGlobalHandlers', 'Global safety net event listeners initialized.');
  }

  // Auto-init global handlers in browser
  if (typeof window !== 'undefined') {
    initGlobalHandlers();
  }

  // ---------------------------------------------------------------------------
  // 7. Public API Export
  // ---------------------------------------------------------------------------
  return {
    CATEGORIES,
    LOG_LEVELS,
    logger,
    getUserFriendlyMessage,
    showNotification,
    apiFetch,
    sanitizeForLog
  };
});
