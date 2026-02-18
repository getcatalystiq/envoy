/**
 * OAuth 2.1 with PKCE implementation for Envoy Admin UI
 */

const API_BASE = import.meta.env.VITE_API_URL || '';
const OAUTH_BASE = import.meta.env.VITE_OAUTH_URL || API_BASE;

const OAUTH_METADATA_BASE = `${OAUTH_BASE}/.well-known/oauth-authorization-server`;

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  userinfo_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface UserInfo {
  sub: string;
  email: string;
  first_name?: string;
  last_name?: string;
  org_id: string;
  org_name?: string;
  role: string;
  scopes: string[];
}

const STORAGE_KEYS = {
  ACCESS_TOKEN: 'envoy_access_token',
  REFRESH_TOKEN: 'envoy_refresh_token',
  TOKEN_EXPIRY: 'envoy_token_expiry',
  CODE_VERIFIER: 'envoy_code_verifier',
  CLIENT_ID: 'envoy_client_id',
  CLIENT_SECRET: 'envoy_client_secret',
  USER_INFO: 'envoy_user_info',
};

// Auth debugging - logs to console with timestamp
function authLog(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[Auth ${timestamp}] ${message}`, data);
  } else {
    console.log(`[Auth ${timestamp}] ${message}`);
  }
}

function authError(message: string, error?: unknown) {
  const timestamp = new Date().toISOString();
  console.error(`[Auth ${timestamp}] ${message}`, error);
}

function generateRandomString(length: number): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => charset[byte % charset.length]).join('');
}

export function generateCodeVerifier(): string {
  return generateRandomString(64);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function fetchOAuthMetadata(): Promise<OAuthMetadata> {
  const response = await fetch(OAUTH_METADATA_BASE, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Failed to fetch OAuth metadata');
  }
  return response.json();
}

export async function registerClient(): Promise<{ client_id: string; client_secret: string }> {
  const metadata = await fetchOAuthMetadata();

  const response = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Envoy Admin UI',
      redirect_uris: [window.location.origin + '/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to register OAuth client');
  }

  const data = await response.json();

  localStorage.setItem(STORAGE_KEYS.CLIENT_ID, data.client_id);
  localStorage.setItem(STORAGE_KEYS.CLIENT_SECRET, data.client_secret);

  return { client_id: data.client_id, client_secret: data.client_secret };
}

async function getClientCredentials(): Promise<{ client_id: string; client_secret: string }> {
  const clientId = localStorage.getItem(STORAGE_KEYS.CLIENT_ID);
  const clientSecret = localStorage.getItem(STORAGE_KEYS.CLIENT_SECRET);

  if (clientId && clientSecret) {
    return { client_id: clientId, client_secret: clientSecret };
  }

  return registerClient();
}

export async function startAuthFlow(): Promise<void> {
  const metadata = await fetchOAuthMetadata();
  const { client_id } = await getClientCredentials();

  const codeVerifier = generateCodeVerifier();
  sessionStorage.setItem(STORAGE_KEYS.CODE_VERIFIER, codeVerifier);

  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client_id,
    redirect_uri: window.location.origin + '/callback',
    scope: 'read write admin',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: generateRandomString(16),
  });

  sessionStorage.setItem('oauth_state', params.get('state')!);

  window.location.href = `${metadata.authorization_endpoint}?${params}`;
}

export async function handleCallback(): Promise<UserInfo> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (error) {
    throw new Error(params.get('error_description') || error);
  }

  if (!code) {
    throw new Error('No authorization code received');
  }

  const savedState = sessionStorage.getItem('oauth_state');
  if (state !== savedState) {
    throw new Error('Invalid state parameter');
  }

  const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.CODE_VERIFIER);
  if (!codeVerifier) {
    throw new Error('No code verifier found');
  }

  const metadata = await fetchOAuthMetadata();
  const { client_id, client_secret } = await getClientCredentials();

  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${client_id}:${client_secret}`),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: window.location.origin + '/callback',
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error_description || 'Token exchange failed');
  }

  const tokens: TokenResponse = await response.json();

  authLog('handleCallback: Received tokens', {
    hasAccessToken: !!tokens.access_token,
    hasRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
  });

  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, tokens.access_token);
  if (tokens.refresh_token) {
    localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, tokens.refresh_token);
    authLog('handleCallback: Stored refresh token', { length: tokens.refresh_token.length });
  } else {
    authError('handleCallback: No refresh token received from server!');
  }
  localStorage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, String(Date.now() + tokens.expires_in * 1000));

  sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);
  sessionStorage.removeItem('oauth_state');

  const userInfo = await fetchUserInfo();

  // Start proactive token refresh timer after successful login
  startTokenRefreshTimer();

  authLog('handleCallback: Auth complete', { email: userInfo.email });
  return userInfo;
}

export async function fetchUserInfo(): Promise<UserInfo> {
  const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
  if (!accessToken) {
    throw new Error('No access token');
  }

  const metadata = await fetchOAuthMetadata();

  const response = await fetch(metadata.userinfo_endpoint, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch user info');
  }

  const userInfo: UserInfo = await response.json();
  localStorage.setItem(STORAGE_KEYS.USER_INFO, JSON.stringify(userInfo));

  return userInfo;
}

export async function refreshToken(): Promise<string> {
  // If a refresh is already in progress, wait for it instead of starting a new one
  // This prevents race conditions where concurrent refreshes revoke each other's tokens
  if (refreshPromise) {
    authLog('Refresh already in progress, waiting for existing refresh');
    return refreshPromise;
  }

  const storedRefreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
  const storedClientId = localStorage.getItem(STORAGE_KEYS.CLIENT_ID);

  authLog('Attempting token refresh', {
    hasRefreshToken: !!storedRefreshToken,
    refreshTokenLength: storedRefreshToken?.length,
    hasClientId: !!storedClientId,
    clientId: storedClientId,
  });

  if (!storedRefreshToken) {
    authError('No refresh token found in localStorage');
    throw new Error('No refresh token');
  }

  // Set up the refresh promise so concurrent callers can wait on it
  // Pass the initial refresh token to detect cross-tab updates
  refreshPromise = doRefresh(storedRefreshToken);

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doRefresh(initialRefreshToken: string): Promise<string> {
  let metadata: OAuthMetadata;
  let client_id: string;
  let client_secret: string;

  try {
    metadata = await fetchOAuthMetadata();
    const creds = await getClientCredentials();
    client_id = creds.client_id;
    client_secret = creds.client_secret;
    authLog('Got metadata and credentials', { tokenEndpoint: metadata.token_endpoint, client_id });
  } catch (err) {
    authError('Failed to get metadata or credentials', err);
    throw err;
  }

  const maxRetries = 3;
  let lastError: Error | null = null;
  let lastResponseStatus: number | null = null;
  let lastResponseBody: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Re-read refresh token before each attempt - another tab may have updated it
    const currentRefreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    if (!currentRefreshToken) {
      authError('Refresh token disappeared from storage');
      break;
    }

    // If token changed, another tab refreshed successfully - use the new access token directly
    if (currentRefreshToken !== initialRefreshToken) {
      authLog('Refresh token changed by another tab, using updated tokens');
      const newAccessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
      if (newAccessToken) {
        // Restart our refresh timer to sync with the new expiry
        startTokenRefreshTimer();
        return newAccessToken;
      }
      // Token changed but no access token? Continue with refresh using new token
      authLog('Token changed but no access token found, continuing with new refresh token');
    }

    authLog(`Refresh attempt ${attempt}/${maxRetries}`);

    try {
      const response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(`${client_id}:${client_secret}`),
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: currentRefreshToken,
        }),
      });

      lastResponseStatus = response.status;

      if (response.ok) {
        const tokens: TokenResponse = await response.json();
        authLog('Token refresh successful', {
          hasNewAccessToken: !!tokens.access_token,
          hasNewRefreshToken: !!tokens.refresh_token,
          expiresIn: tokens.expires_in,
        });

        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, tokens.access_token);
        if (tokens.refresh_token) {
          localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, tokens.refresh_token);
        }
        localStorage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, String(Date.now() + tokens.expires_in * 1000));

        return tokens.access_token;
      }

      // Response not OK - parse error details
      try {
        lastResponseBody = await response.json();
      } catch {
        lastResponseBody = await response.text().catch(() => 'Could not read response body');
      }

      authError(`Refresh attempt ${attempt} failed`, {
        status: response.status,
        statusText: response.statusText,
        body: lastResponseBody,
      });

      // Don't retry on 400/401 - these are definitive failures
      if (response.status === 400 || response.status === 401) {
        authLog('Got 400/401, not retrying - token is invalid or expired');
        break;
      }

      // For other errors (500, network issues), wait and retry
      if (attempt < maxRetries) {
        const delay = attempt * 1000; // 1s, 2s, 3s
        authLog(`Waiting ${delay}ms before retry`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      authError(`Refresh attempt ${attempt} threw exception`, err);

      if (attempt < maxRetries) {
        const delay = attempt * 1000;
        authLog(`Waiting ${delay}ms before retry`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  authError('All refresh attempts failed', {
    lastStatus: lastResponseStatus,
    lastBody: lastResponseBody,
    lastError: lastError?.message,
  });

  logout();
  throw new Error(`Session expired (status: ${lastResponseStatus})`);
}

export async function getAccessToken(): Promise<string | null> {
  const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
  const expiry = localStorage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
  const refreshTokenExists = !!localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);

  if (!accessToken) {
    authLog('getAccessToken: No access token in storage');
    return null;
  }

  if (expiry) {
    const expiryTime = parseInt(expiry);
    const now = Date.now();
    const timeUntilExpiry = expiryTime - now;
    const refreshThreshold = 5 * 60 * 1000; // 5 minutes
    const needsRefresh = now > expiryTime - refreshThreshold;

    if (needsRefresh) {
      const isExpired = now > expiryTime;
      authLog('getAccessToken: Token needs refresh', {
        isExpired,
        expiredAgo: isExpired ? `${Math.round((now - expiryTime) / 1000)}s ago` : null,
        expiresIn: !isExpired ? `${Math.round(timeUntilExpiry / 1000)}s` : null,
        hasRefreshToken: refreshTokenExists,
      });

      try {
        return await refreshToken();
      } catch (err) {
        authError('getAccessToken: Refresh failed', err);
        return null;
      }
    }
  }

  return accessToken;
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
}

export function getStoredUserInfo(): UserInfo | null {
  const stored = localStorage.getItem(STORAGE_KEYS.USER_INFO);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function logout(): void {
  // Log the call stack to see what triggered logout
  const stack = new Error().stack;
  authLog('logout() called', { stack: stack?.split('\n').slice(1, 4).join('\n') });

  // Stop any running token refresh timer
  stopTokenRefreshTimer();

  localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.TOKEN_EXPIRY);
  localStorage.removeItem(STORAGE_KEYS.USER_INFO);
  sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);
  sessionStorage.removeItem('oauth_state');
}

// Token refresh timer management
let tokenRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null;

// Refresh mutex - prevents concurrent refresh attempts from racing
let refreshPromise: Promise<string> | null = null;

/**
 * Start a proactive token refresh timer.
 * This ensures tokens are refreshed before they expire, even if the user is idle.
 */
export function startTokenRefreshTimer(): void {
  // Clear any existing timer
  stopTokenRefreshTimer();

  const expiry = localStorage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
  if (!expiry) {
    authLog('startTokenRefreshTimer: No token expiry found');
    return;
  }

  const expiryTime = parseInt(expiry);
  const now = Date.now();
  const refreshThreshold = 5 * 60 * 1000; // 5 minutes before expiry
  const timeUntilRefresh = expiryTime - now - refreshThreshold;

  if (timeUntilRefresh <= 0) {
    // Token already needs refresh
    authLog('startTokenRefreshTimer: Token needs immediate refresh');
    refreshToken()
      .then(() => startTokenRefreshTimer())
      .catch((err) => authError('Proactive token refresh failed', err));
    return;
  }

  authLog('startTokenRefreshTimer: Scheduling refresh', {
    refreshIn: `${Math.round(timeUntilRefresh / 1000 / 60)} minutes`,
  });

  tokenRefreshTimeoutId = setTimeout(async () => {
    authLog('Proactive token refresh triggered');
    try {
      await refreshToken();
      // Schedule the next refresh
      startTokenRefreshTimer();
    } catch (err) {
      authError('Proactive token refresh failed', err);
    }
  }, timeUntilRefresh);
}

/**
 * Stop the token refresh timer.
 */
export function stopTokenRefreshTimer(): void {
  if (tokenRefreshTimeoutId) {
    clearTimeout(tokenRefreshTimeoutId);
    tokenRefreshTimeoutId = null;
    authLog('Token refresh timer stopped');
  }
}

/**
 * Listen for storage changes from other tabs.
 * This handles cross-tab token synchronization to prevent logout race conditions.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEYS.ACCESS_TOKEN && event.newValue) {
      authLog('Access token updated by another tab');
      // Restart the refresh timer with the new expiry
      startTokenRefreshTimer();
    }
    if (event.key === STORAGE_KEYS.ACCESS_TOKEN && !event.newValue) {
      authLog('Access token cleared by another tab - logging out');
      // Another tab logged out, sync this tab
      stopTokenRefreshTimer();
      window.location.href = '/login';
    }
  });
}

/**
 * Set token from external source (e.g., widget embedding)
 * Used when Envoy is embedded in another app that provides auth
 */
export function setExternalToken(token: string, expiresIn: number = 3600): void {
  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token);
  localStorage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, String(Date.now() + expiresIn * 1000));
}

/**
 * Check if we're running in embedded mode (iframe)
 */
export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // Cross-origin iframe
  }
}
