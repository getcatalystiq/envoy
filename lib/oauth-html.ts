import { generateCsrfToken } from "@/lib/oauth";

export function renderLoginForm(opts: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error?: string;
  csrfToken?: string;
}): string {
  const errorHtml = opts.error
    ? `<div class="error">${escapeHtml(opts.error)}</div>`
    : "";
  const csrfToken = opts.csrfToken || generateCsrfToken();

  return `<!DOCTYPE html>
<html>
<head>
    <title>Envoy - Sign In</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
        }
        .container {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 400px;
        }
        h1 {
            margin: 0 0 1.5rem;
            font-size: 1.5rem;
            text-align: center;
            color: #059669;
        }
        .error {
            background: #fee;
            color: #c00;
            padding: 0.75rem;
            border-radius: 4px;
            margin-bottom: 1rem;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
        }
        input {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 1rem;
            margin-bottom: 1rem;
            box-sizing: border-box;
        }
        button {
            width: 100%;
            padding: 0.75rem;
            background: #059669;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 1rem;
            cursor: pointer;
        }
        button:hover {
            background: #047857;
        }
        .scope-info {
            font-size: 0.875rem;
            color: #666;
            margin-bottom: 1rem;
        }
        .signup-link {
            text-align: center;
            margin-top: 1rem;
            font-size: 0.875rem;
        }
        .signup-link a {
            color: #059669;
            text-decoration: none;
        }
        .signup-link a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Sign in to Envoy</h1>
        ${errorHtml}
        <div class="scope-info">
            Requested access: <strong>${escapeHtml(opts.scope)}</strong>
        </div>
        <form method="POST">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="client_id" value="${escapeHtml(opts.clientId)}">
            <input type="hidden" name="redirect_uri" value="${escapeHtml(opts.redirectUri)}">
            <input type="hidden" name="scope" value="${escapeHtml(opts.scope)}">
            <input type="hidden" name="state" value="${escapeHtml(opts.state)}">
            <input type="hidden" name="code_challenge" value="${escapeHtml(opts.codeChallenge)}">
            <input type="hidden" name="code_challenge_method" value="${escapeHtml(opts.codeChallengeMethod)}">

            <label for="email">Email</label>
            <input type="email" id="email" name="email" required autofocus>

            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>

            <button type="submit">Sign In</button>
        </form>
        <div class="signup-link">
            Don't have an account? <a href="/signup">Sign up</a>
        </div>
    </div>
</body>
</html>`;
}

export function renderSignupForm(error?: string): string {
  const errorHtml = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
    <title>Envoy - Sign Up</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f3f4f6;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
        }
        .container {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 400px;
        }
        h1 {
            margin: 0 0 1.5rem 0;
            font-size: 1.5rem;
            text-align: center;
            color: #059669;
        }
        .error {
            background: #fee;
            color: #c00;
            padding: 0.75rem;
            border-radius: 4px;
            margin-bottom: 1rem;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
        }
        input {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 1rem;
            margin-bottom: 1rem;
            box-sizing: border-box;
        }
        button {
            width: 100%;
            padding: 0.75rem;
            background: #059669;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 1rem;
            cursor: pointer;
        }
        button:hover {
            background: #047857;
        }
        .login-link {
            text-align: center;
            margin-top: 1rem;
            font-size: 0.875rem;
        }
        .login-link a {
            color: #059669;
            text-decoration: none;
        }
        .login-link a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Create your Envoy account</h1>
        ${errorHtml}
        <form method="POST">
            <label for="org_name">Organization Name</label>
            <input type="text" id="org_name" name="org_name" required autofocus placeholder="Your company name">

            <label for="email">Email</label>
            <input type="email" id="email" name="email" required placeholder="you@company.com">

            <label for="first_name">First Name</label>
            <input type="text" id="first_name" name="first_name" placeholder="Optional">

            <label for="last_name">Last Name</label>
            <input type="text" id="last_name" name="last_name" placeholder="Optional">

            <label for="password">Password</label>
            <input type="password" id="password" name="password" required minlength="8" placeholder="At least 8 characters">

            <button type="submit">Create Account</button>
        </form>
        <div class="login-link">
            Already have an account? <a href="javascript:history.back()">Sign in</a>
        </div>
    </div>
</body>
</html>`;
}

export function renderSignupSuccess(email: string, orgName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
    <title>Envoy - Account Created</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f3f4f6;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
        }
        .container {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 400px;
            text-align: center;
        }
        h1 { color: #059669; margin-bottom: 1rem; }
        p { color: #666; margin-bottom: 1.5rem; }
        a {
            display: inline-block;
            padding: 0.75rem 1.5rem;
            background: #059669;
            color: white;
            text-decoration: none;
            border-radius: 4px;
        }
        a:hover { background: #047857; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Account Created!</h1>
        <p>Welcome to Envoy, ${escapeHtml(email)}! Your organization &quot;${escapeHtml(orgName)}&quot; has been set up.</p>
        <a href="javascript:history.go(-2)">Sign In</a>
    </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
