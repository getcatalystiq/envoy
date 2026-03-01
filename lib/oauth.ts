import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { getEnv } from "@/lib/env";

// --- Environment (lazy-initialized to avoid build-time errors) ---

let _jwtSecret: Uint8Array | null = null;
function getJwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    const secret = getEnv().JWT_SECRET;
    _jwtSecret = new TextEncoder().encode(secret);
  }
  return _jwtSecret;
}

function getIssuer(): string {
  return getEnv().NEXT_PUBLIC_URL;
}

function getAllowedDcrDomains(): string[] {
  return getEnv().ALLOWED_DCR_DOMAINS;
}

const ACCESS_TOKEN_EXPIRE_SECONDS = 86400; // 24 hours
const REFRESH_TOKEN_EXPIRE_DAYS = 30;
const AUTH_CODE_EXPIRE_MINUTES = 10;
const CSRF_TOKEN_EXPIRY_SECONDS = 300;

// --- PKCE (S256 only per OAuth 2.1) ---

export function generateCodeVerifier(): string {
  return crypto.randomBytes(96).toString("base64url").slice(0, 128);
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function verifyCodeChallenge(
  verifier: string,
  challenge: string
): boolean {
  const computed = generateCodeChallenge(verifier);
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- JWT ---

const AccessTokenPayload = z.object({
  sub: z.string(),
  tenant_id: z.string(),
  scope: z.string(),
  client_id: z.string(),
  token_type: z.literal("access_token"),
});
export type AccessTokenPayload = z.infer<typeof AccessTokenPayload>;

export async function signAccessToken(opts: {
  userId: string;
  tenantId: string;
  scope: string;
  clientId: string;
}): Promise<string> {
  return new SignJWT({
    sub: opts.userId,
    tenant_id: opts.tenantId,
    scope: opts.scope,
    client_id: opts.clientId,
    token_type: "access_token" as const,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(getIssuer())
    .setAudience(getIssuer())
    .setExpirationTime(`${ACCESS_TOKEN_EXPIRE_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function verifyAccessToken(
  token: string
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getJwtSecret(), {
    issuer: getIssuer(),
    audience: getIssuer(),
  });
  return AccessTokenPayload.parse(payload);
}

export function createRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

// --- Password Hashing (crypto.scrypt) ---

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, derived) => {
        if (err) return reject(err);
        resolve(`${salt}:${derived.toString("hex")}`);
      }
    );
  });
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, derived) => {
        if (err) return reject(err);
        const a = Buffer.from(key, "hex");
        const b = derived;
        if (a.length !== b.length) return resolve(false);
        resolve(crypto.timingSafeEqual(a, b));
      }
    );
  });
}

// --- Bearer Token Extraction ---

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

// --- CSRF Token ---

export function generateCsrfToken(): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const randomPart = crypto.randomBytes(16).toString("base64url");
  const data = `${timestamp}:${randomPart}`;
  const signature = crypto
    .createHmac("sha256", getEnv().JWT_SECRET)
    .update(data)
    .digest("hex");
  return `${data}:${signature}`;
}

export function verifyCsrfToken(token: string): boolean {
  if (!token) return false;

  const parts = token.split(":");
  if (parts.length !== 3) return false;

  const [timestampStr, randomPart, signature] = parts;
  const data = `${timestampStr}:${randomPart}`;
  const expected = crypto
    .createHmac("sha256", getEnv().JWT_SECRET)
    .update(data)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return false;
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > CSRF_TOKEN_EXPIRY_SECONDS) return false;

  return true;
}

// --- Client Validation ---

export function isAllowedRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return getAllowedDcrDomains().some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

// --- Helpers ---

export function extractClientCredentials(
  request: Request,
  body: Record<string, string>
): { clientId: string | null; clientSecret: string | null } {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const [clientId, clientSecret] = decoded.split(":");
    return { clientId: clientId ?? null, clientSecret: clientSecret ?? null };
  }
  return {
    clientId: body.client_id ?? null,
    clientSecret: body.client_secret ?? null,
  };
}

export function oauthError(
  error: string,
  description: string,
  status: number = 400
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export {
  getIssuer as ISSUER,
  getAllowedDcrDomains as ALLOWED_DCR_DOMAINS,
  ACCESS_TOKEN_EXPIRE_SECONDS,
  REFRESH_TOKEN_EXPIRE_DAYS,
  AUTH_CODE_EXPIRE_MINUTES,
};
