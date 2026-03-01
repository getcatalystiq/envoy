import { sql, withTransaction } from "@/lib/db";
import { randomBytes, createHash } from "crypto";
import bcrypt from "bcryptjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function generateToken(length: number): string {
  return randomBytes(length).toString("base64url");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// =========================================================================
// OAUTH CLIENTS
// =========================================================================

export async function createClient(
  clientName: string,
  redirectUris: string[],
  opts: {
    grantTypes?: string[];
    responseTypes?: string[];
    tokenEndpointAuthMethod?: string;
    clientUri?: string;
    scope?: string;
    orgId?: string;
    clientId?: string;
  } = {}
): Promise<Row> {
  const {
    grantTypes = ["authorization_code", "refresh_token"],
    responseTypes = ["code"],
    tokenEndpointAuthMethod = "client_secret_basic",
    clientUri = null,
    scope = "read write",
    orgId = null,
    clientId: providedClientId,
  } = opts;

  if (!clientName) throw new Error("client_name is required");
  if (!redirectUris || redirectUris.length === 0)
    throw new Error("redirect_uris is required");

  for (const uri of redirectUris) {
    if (
      !uri.startsWith("https://") &&
      !uri.startsWith("http://localhost") &&
      !uri.startsWith("http://127.0.0.1")
    ) {
      throw new Error(
        `Invalid redirect_uri: ${uri}. Must use HTTPS or localhost.`
      );
    }
  }

  const supportedGrantTypes = ["authorization_code", "refresh_token"];
  const supportedResponseTypes = ["code"];
  const supportedAuthMethods = [
    "client_secret_basic",
    "client_secret_post",
    "none",
  ];

  for (const gt of grantTypes) {
    if (!supportedGrantTypes.includes(gt))
      throw new Error(`Unsupported grant_type: ${gt}`);
  }
  for (const rt of responseTypes) {
    if (!supportedResponseTypes.includes(rt))
      throw new Error(`Unsupported response_type: ${rt}`);
  }
  if (!supportedAuthMethods.includes(tokenEndpointAuthMethod))
    throw new Error(
      `Unsupported token_endpoint_auth_method: ${tokenEndpointAuthMethod}`
    );

  const clientId = providedClientId || `envoy_${generateToken(16)}`;

  let clientSecret: string | null = null;
  let clientSecretHash: string | null = null;
  if (tokenEndpointAuthMethod !== "none") {
    clientSecret = generateToken(32);
    clientSecretHash = await bcrypt.hash(clientSecret, 10);
  }

  await sql`
    INSERT INTO oauth_clients
      (client_id, client_secret_hash, client_name, client_uri,
       redirect_uris, grant_types, response_types,
       token_endpoint_auth_method, scope, organization_id)
    VALUES
      (${clientId}, ${clientSecretHash}, ${clientName}, ${clientUri},
       ${redirectUris}, ${grantTypes}, ${responseTypes},
       ${tokenEndpointAuthMethod}, ${scope}, ${orgId}::uuid)
  `;

  const response: Row = {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    scope,
  };

  if (clientSecret) {
    response.client_secret = clientSecret;
    response.client_secret_expires_at = 0;
  }
  if (clientUri) {
    response.client_uri = clientUri;
  }

  return response;
}

export async function getClient(clientId: string): Promise<Row | null> {
  const rows = await sql`
    SELECT client_id, client_secret_hash, client_name, client_uri,
           redirect_uris, grant_types, response_types,
           token_endpoint_auth_method, scope, organization_id, is_active
    FROM oauth_clients
    WHERE client_id = ${clientId}
  `;
  return rows[0] ?? null;
}

export async function verifyClientSecret(
  clientId: string,
  clientSecret: string
): Promise<boolean> {
  const client = await getClient(clientId);
  if (!client) return false;
  if (!client.is_active) return false;
  if (!client.client_secret_hash) return false;

  try {
    return await bcrypt.compare(clientSecret, client.client_secret_hash);
  } catch {
    return false;
  }
}

export async function validateRedirectUri(
  clientId: string,
  redirectUri: string
): Promise<boolean> {
  const client = await getClient(clientId);
  if (!client) return false;
  return (client.redirect_uris || []).includes(redirectUri);
}

// =========================================================================
// AUTHORIZATION CODES
// =========================================================================

export async function createAuthorizationCode(
  code: string,
  clientId: string,
  userId: string,
  redirectUri: string,
  scope: string,
  codeChallenge: string,
  codeChallengeMethod: string,
  expiresMinutes: number = 10
): Promise<void> {
  const codeHash = sha256(code);
  await sql`
    INSERT INTO oauth_authorization_codes
      (code, client_id, user_id, redirect_uri, scope,
       code_challenge, code_challenge_method, expires_at)
    VALUES
      (${codeHash}, ${clientId}, ${userId}::uuid, ${redirectUri}, ${scope},
       ${codeChallenge}, ${codeChallengeMethod},
       NOW() + make_interval(mins => ${expiresMinutes}))
  `;
}

export async function getAndValidateCode(
  code: string
): Promise<Row | null> {
  const codeHash = sha256(code);
  const rows = await sql`
    SELECT code, client_id, user_id, redirect_uri, scope,
           code_challenge, code_challenge_method, expires_at, used_at
    FROM oauth_authorization_codes
    WHERE code = ${codeHash}
  `;
  if (rows.length === 0) return null;

  const authCode = rows[0];
  if (new Date(authCode.expires_at) < new Date()) return null;
  if (authCode.used_at) return null;

  return authCode;
}

export async function markCodeUsed(code: string): Promise<void> {
  const codeHash = sha256(code);
  await sql`
    UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code = ${codeHash}
  `;
}

/**
 * Exchange an authorization code for tokens.
 * Uses a transaction with FOR UPDATE to prevent race conditions.
 */
export async function exchangeCode(code: string): Promise<Row | null> {
  const codeHash = sha256(code);
  return withTransaction(async (client) => {
    // Lock the row to prevent concurrent exchange
    const result = await client.query(
      `SELECT code, client_id, user_id, redirect_uri, scope,
              code_challenge, code_challenge_method, expires_at, used_at
       FROM oauth_authorization_codes
       WHERE code = $1
       FOR UPDATE`,
      [codeHash]
    );

    if (result.rows.length === 0) return null;

    const authCode = result.rows[0];
    if (new Date(authCode.expires_at) < new Date()) return null;
    if (authCode.used_at) return null;

    // Mark as used
    await client.query(
      `UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code = $1`,
      [codeHash]
    );

    return authCode;
  });
}

export async function cleanupExpiredCodes(): Promise<number> {
  const rows = await sql`
    DELETE FROM oauth_authorization_codes
    WHERE expires_at < NOW()
    RETURNING id
  `;
  return rows.length;
}

// =========================================================================
// REFRESH TOKENS
// =========================================================================

export async function createRefreshToken(
  clientId: string,
  userId: string,
  scope: string,
  expiresDays: number = 30
): Promise<{ token: string; tokenHash: string }> {
  const token = generateToken(64);
  const tokenHash = sha256(token);

  await sql`
    INSERT INTO oauth_refresh_tokens
      (token_hash, client_id, user_id, scope, expires_at)
    VALUES
      (${tokenHash}, ${clientId}, ${userId}::uuid, ${scope},
       NOW() + make_interval(days => ${expiresDays}))
  `;

  return { token, tokenHash };
}

export async function verifyRefreshToken(
  token: string
): Promise<Row | null> {
  const tokenHash = sha256(token);

  const rows = await sql`
    SELECT rt.user_id, rt.client_id, rt.scope, u.organization_id as org_id, u.role
    FROM oauth_refresh_tokens rt
    JOIN users u ON rt.user_id = u.id
    WHERE rt.token_hash = ${tokenHash}
      AND rt.expires_at > NOW()
      AND rt.revoked_at IS NULL
  `;

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    user_id: String(row.user_id),
    org_id: String(row.org_id),
    scopes: (row.scope || "").split(" "),
    client_id: row.client_id,
    role: row.role,
  };
}

export async function revokeRefreshToken(token: string): Promise<boolean> {
  const tokenHash = sha256(token);
  await sql`
    UPDATE oauth_refresh_tokens
    SET revoked_at = NOW()
    WHERE token_hash = ${tokenHash}
  `;
  return true;
}

export async function revokeAllUserTokens(userId: string): Promise<number> {
  const rows = await sql`
    UPDATE oauth_refresh_tokens
    SET revoked_at = NOW()
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

// =========================================================================
// USERS
// =========================================================================

export async function getUserById(userId: string): Promise<Row | null> {
  const rows = await sql`
    SELECT u.id, u.organization_id, u.email, u.first_name, u.last_name,
           u.role, u.scopes, u.status, u.created_at, o.name as org_name
    FROM users u
    JOIN organizations o ON u.organization_id = o.id
    WHERE u.id = ${userId}::uuid
  `;

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    scopes: row.scopes || ["read", "write"],
    status: row.status,
    created_at: row.created_at,
    org_name: row.org_name,
  };
}

export async function authenticateUser(
  email: string,
  password: string
): Promise<Row | null> {
  const rows = await sql`
    SELECT u.id, u.organization_id, u.email, u.password_hash, u.first_name,
           u.last_name, u.role, u.scopes, u.status, o.name as org_name
    FROM users u
    JOIN organizations o ON u.organization_id = o.id
    WHERE u.email = ${email}
  `;

  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.status !== "active") return null;

  try {
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) return null;
  } catch {
    return null;
  }

  // Update last login
  await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${row.id}::uuid`;

  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    scopes: row.scopes || ["read", "write"],
    org_name: row.org_name,
  };
}

export async function createOrganization(name: string): Promise<Row> {
  if (!name) throw new Error("name is required");

  const existing = await sql`
    SELECT id FROM organizations WHERE name = ${name}
  `;
  if (existing.length > 0) {
    throw new Error(`Organization with name '${name}' already exists`);
  }

  const rows = await sql`
    INSERT INTO organizations (name)
    VALUES (${name})
    RETURNING id, name, created_at
  `;
  const row = rows[0];
  return {
    id: String(row.id),
    name: row.name,
    created_at: row.created_at,
  };
}

export async function createUser(
  orgId: string,
  email: string,
  password: string,
  opts: {
    firstName?: string;
    lastName?: string;
    role?: string;
    scopes?: string[];
  } = {}
): Promise<Row> {
  const {
    firstName = null,
    lastName = null,
    role = "member",
    scopes = ["read", "write"],
  } = opts;

  if (!email) throw new Error("email is required");
  if (!password || password.length < 8)
    throw new Error("password must be at least 8 characters");

  const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length > 0) {
    throw new Error(`User with email '${email}' already exists`);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const rows = await sql`
    INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, scopes)
    VALUES (${orgId}::uuid, ${email}, ${passwordHash}, ${firstName}, ${lastName}, ${role}, ${scopes})
    RETURNING id, organization_id, email, first_name, last_name, role, scopes, created_at
  `;

  const row = rows[0];
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    scopes: row.scopes,
    created_at: row.created_at,
  };
}

/**
 * Self-service signup: create organization and admin user atomically.
 */
export async function signup(
  orgName: string,
  email: string,
  password: string,
  opts: { firstName?: string; lastName?: string } = {}
): Promise<{ organization: Row; user: Row }> {
  return withTransaction(async (client) => {
    // Create organization
    if (!orgName) throw new Error("name is required");
    const existingOrg = await client.query(
      `SELECT id FROM organizations WHERE name = $1`,
      [orgName]
    );
    if (existingOrg.rows.length > 0) {
      throw new Error(`Organization with name '${orgName}' already exists`);
    }

    const orgResult = await client.query(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id, name, created_at`,
      [orgName]
    );
    const org = orgResult.rows[0];

    // Create admin user
    if (!email) throw new Error("email is required");
    if (!password || password.length < 8)
      throw new Error("password must be at least 8 characters");

    const existingUser = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [email]
    );
    if (existingUser.rows.length > 0) {
      throw new Error(`User with email '${email}' already exists`);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const scopes = ["read", "write", "admin"];

    const userResult = await client.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, scopes)
       VALUES ($1::uuid, $2, $3, $4, $5, 'admin', $6)
       RETURNING id, organization_id, email, first_name, last_name, role, scopes, created_at`,
      [String(org.id), email, passwordHash, opts.firstName ?? null, opts.lastName ?? null, scopes]
    );
    const user = userResult.rows[0];

    return {
      organization: {
        id: String(org.id),
        name: org.name,
        created_at: org.created_at,
      },
      user: {
        id: String(user.id),
        organization_id: String(user.organization_id),
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        scopes: user.scopes,
        created_at: user.created_at,
      },
    };
  });
}
