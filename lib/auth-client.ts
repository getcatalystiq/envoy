'use client';

/**
 * First-party auth for the Envoy Admin UI.
 *
 * Security model (httpOnly-cookie session):
 *  - PUBLIC PKCE client (no client_secret stored in the browser).
 *  - The 30-day refresh token lives ONLY in an httpOnly cookie set by the server
 *    (/api/session/*) — never in JS-readable storage, so XSS can't steal it.
 *  - The access token is held in MEMORY (this module) and sent as a Bearer
 *    header on API calls. It is re-obtained from the cookie on page load.
 *  - Only the public client_id (and the transient PKCE verifier/state) touch
 *    web storage.
 */

const OAUTH_METADATA_BASE = `/.well-known/oauth-authorization-server`;

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

interface SessionTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
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
  CLIENT_ID: 'envoy_client_id',
  CODE_VERIFIER: 'envoy_code_verifier',
  OAUTH_STATE: 'oauth_state',
};

// Legacy localStorage keys from the pre-cookie token model — cleared on logout
// and on first login so old tokens don't linger.
const LEGACY_KEYS = [
  'envoy_access_token',
  'envoy_refresh_token',
  'envoy_token_expiry',
  'envoy_user_info',
  'envoy_client_secret',
];

// --- In-memory session state (per tab) ---
let accessToken: string | null = null;
let accessTokenExpiry: number | null = null; // epoch ms
let externalToken: string | null = null; // embed mode
let cachedUser: UserInfo | null = null;
let refreshPromise: Promise<string> | null = null;
let tokenRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null;

function authLog(message: string, data?: unknown) {
  if (process.env.NODE_ENV === 'production') return;
  if (data !== undefined) console.log(`[Auth] ${message}`, data);
  else console.log(`[Auth] ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  if (!response.ok) throw new Error('Failed to fetch OAuth metadata');
  return response.json();
}

// Register a PUBLIC (PKCE, no secret) client and remember only its client_id.
export async function registerClient(): Promise<{ client_id: string }> {
  const metadata = await fetchOAuthMetadata();
  const response = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Envoy Admin UI',
      redirect_uris: [window.location.origin + '/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!response.ok) throw new Error('Failed to register OAuth client');
  const data = await response.json();
  localStorage.setItem(STORAGE_KEYS.CLIENT_ID, data.client_id);
  return { client_id: data.client_id };
}

async function getClientId(): Promise<string> {
  // A leftover client_secret marks an OLD confidential client; the cookie flow
  // needs a PUBLIC client, so re-register and drop the legacy secret.
  const hadLegacySecret = localStorage.getItem('envoy_client_secret');
  const existing = localStorage.getItem(STORAGE_KEYS.CLIENT_ID);
  if (existing && !hadLegacySecret) return existing;
  LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
  const { client_id } = await registerClient();
  return client_id;
}

function setAccessToken(token: string, expiresIn: number) {
  accessToken = token;
  accessTokenExpiry = Date.now() + expiresIn * 1000;
}

function clearMemory() {
  accessToken = null;
  accessTokenExpiry = null;
  cachedUser = null;
  stopTokenRefreshTimer();
}

export async function startAuthFlow(): Promise<void> {
  const metadata = await fetchOAuthMetadata();
  const client_id = await getClientId();

  const codeVerifier = generateCodeVerifier();
  sessionStorage.setItem(STORAGE_KEYS.CODE_VERIFIER, codeVerifier);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(16);
  sessionStorage.setItem(STORAGE_KEYS.OAUTH_STATE, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: window.location.origin + '/callback',
    scope: 'read write admin',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  window.location.href = `${metadata.authorization_endpoint}?${params}`;
}

export async function handleCallback(): Promise<UserInfo> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (error) throw new Error(params.get('error_description') || error);
  if (!code) throw new Error('No authorization code received');
  if (state !== sessionStorage.getItem(STORAGE_KEYS.OAUTH_STATE)) {
    throw new Error('Invalid state parameter');
  }
  const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.CODE_VERIFIER);
  if (!codeVerifier) throw new Error('No code verifier found');

  const client_id = await getClientId();

  // Exchange SERVER-SIDE: the server sets the refresh token as an httpOnly
  // cookie and returns only the access token to us.
  const response = await fetch('/api/session/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      client_id,
      code,
      code_verifier: codeVerifier,
      redirect_uri: window.location.origin + '/callback',
    }),
  });

  if (!response.ok) {
    const e = await response.json().catch(() => ({}));
    throw new Error(e.error_description || e.error || 'Token exchange failed');
  }

  const tokens: SessionTokenResponse = await response.json();
  setAccessToken(tokens.access_token, tokens.expires_in);
  LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
  sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);
  sessionStorage.removeItem(STORAGE_KEYS.OAUTH_STATE);

  const userInfo = await fetchUserInfo();
  startTokenRefreshTimer();
  authLog('Login complete', { email: userInfo.email });
  return userInfo;
}

export async function fetchUserInfo(): Promise<UserInfo> {
  const token = externalToken || accessToken;
  if (!token) throw new Error('No access token');
  const metadata = await fetchOAuthMetadata();
  const response = await fetch(metadata.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error('Failed to fetch user info');
  const userInfo: UserInfo = await response.json();
  cachedUser = userInfo;
  return userInfo;
}

export async function refreshToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doRefresh(): Promise<string> {
  const maxAttempts = 2;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch('/api/session/refresh', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await delay(attempt * 500);
        continue;
      }
      clearMemory();
      throw err instanceof Error ? err : new Error('Refresh network error');
    }

    lastStatus = response.status;

    if (response.ok) {
      const tokens: SessionTokenResponse = await response.json();
      setAccessToken(tokens.access_token, tokens.expires_in);
      return tokens.access_token;
    }

    // 401 = no/invalid session. A concurrent tab may have rotated the cookie
    // between our request and the server's read — retry once with the (now
    // updated) shared cookie before giving up.
    if (response.status === 401) {
      if (attempt < maxAttempts) {
        await delay(300);
        continue;
      }
      break;
    }

    if (attempt < maxAttempts) await delay(attempt * 500);
  }

  clearMemory();
  throw new Error(`Session refresh failed (status: ${lastStatus})`);
}

export async function getAccessToken(): Promise<string | null> {
  if (externalToken) return externalToken;

  const refreshThreshold = 5 * 60 * 1000;
  if (
    accessToken &&
    accessTokenExpiry &&
    Date.now() < accessTokenExpiry - refreshThreshold
  ) {
    return accessToken;
  }

  try {
    return await refreshToken();
  } catch {
    return null;
  }
}

/**
 * Bootstrap the session on app load: the access token is in memory (gone after
 * a reload), so attempt a silent refresh using the httpOnly cookie. Returns the
 * user if a session exists, else null.
 */
export async function bootstrapSession(): Promise<UserInfo | null> {
  try {
    await refreshToken();
    const user = await fetchUserInfo();
    startTokenRefreshTimer();
    return user;
  } catch {
    clearMemory();
    return null;
  }
}

export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;
  return !!accessToken || !!externalToken;
}

export function getStoredUserInfo(): UserInfo | null {
  return cachedUser;
}

export async function logout(): Promise<void> {
  clearMemory();
  try {
    await fetch('/api/session/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // best-effort; cookie also expires on its own
  }
  if (typeof window !== 'undefined') {
    LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
    sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);
    sessionStorage.removeItem(STORAGE_KEYS.OAUTH_STATE);
  }
}

export function startTokenRefreshTimer(): void {
  stopTokenRefreshTimer();
  if (!accessTokenExpiry) return;
  const refreshThreshold = 5 * 60 * 1000;
  const timeUntilRefresh = accessTokenExpiry - Date.now() - refreshThreshold;

  if (timeUntilRefresh <= 0) {
    refreshToken()
      .then(() => startTokenRefreshTimer())
      .catch(() => {});
    return;
  }

  tokenRefreshTimeoutId = setTimeout(() => {
    refreshToken()
      .then(() => startTokenRefreshTimer())
      .catch(() => {});
  }, timeUntilRefresh);
}

export function stopTokenRefreshTimer(): void {
  if (tokenRefreshTimeoutId) {
    clearTimeout(tokenRefreshTimeoutId);
    tokenRefreshTimeoutId = null;
  }
}

/**
 * Set an access token from an external source (widget/embed mode). Held in
 * memory; the embedding app is responsible for its lifecycle.
 */
export function setExternalToken(token: string, expiresIn: number = 3600): void {
  externalToken = token;
  accessTokenExpiry = Date.now() + expiresIn * 1000;
}

export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin iframe
  }
}
