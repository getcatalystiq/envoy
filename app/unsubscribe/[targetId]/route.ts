import { sql } from "@/lib/db";

const UNSUBSCRIBE_SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Unsubscribed</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: #f5f5f5;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 400px;
        }
        h1 { color: #333; margin-bottom: 16px; }
        p { color: #666; line-height: 1.6; }
        .checkmark {
            width: 60px;
            height: 60px;
            margin: 0 auto 20px;
            background: #4CAF50;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .checkmark svg { width: 30px; height: 30px; fill: white; }
    </style>
</head>
<body>
    <div class="container">
        <div class="checkmark">
            <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </div>
        <h1>You've been unsubscribed</h1>
        <p>You will no longer receive emails from us. If this was a mistake, please contact the sender directly.</p>
    </div>
</body>
</html>`;

const UNSUBSCRIBE_ERROR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Unsubscribe Error</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: #f5f5f5;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 400px;
        }
        h1 { color: #333; margin-bottom: 16px; }
        p { color: #666; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Unable to unsubscribe</h1>
        <p>We couldn't process your unsubscribe request. The link may be invalid or expired. Please contact the sender directly if you continue to receive unwanted emails.</p>
    </div>
</body>
</html>`;

// targetId is a validated UUID before it is ever interpolated into HTML.
function unsubscribeConfirmHtml(targetId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Unsubscribe</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .container { text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; }
        h1 { color: #333; margin-bottom: 16px; }
        p { color: #666; line-height: 1.6; }
        button { margin-top: 20px; padding: 12px 24px; font-size: 16px; color: white; background: #333; border: none; border-radius: 6px; cursor: pointer; }
        button:hover { background: #555; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Unsubscribe from emails?</h1>
        <p>Click the button below to confirm you no longer want to receive emails from us.</p>
        <form method="POST" action="/unsubscribe/${targetId}">
            <button type="submit">Confirm unsubscribe</button>
        </form>
    </div>
</body>
</html>`;
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// UUID regex for raw format
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function targetExists(targetId: string): Promise<boolean> {
  if (!UUID_RE.test(targetId)) return false;
  const targets = await sql`SELECT id FROM targets WHERE id = ${targetId}`;
  return targets.length > 0;
}

/**
 * GET /unsubscribe/:targetId — show a confirmation page. GET must be
 * side-effect-free: email clients, link prefetchers, and security scanners
 * follow links, so the actual unsubscribe happens on POST.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ targetId: string }> },
) {
  const { targetId } = await params;
  if (!(await targetExists(targetId))) {
    return htmlResponse(UNSUBSCRIBE_ERROR_HTML, 404);
  }
  return htmlResponse(unsubscribeConfirmHtml(targetId));
}

/**
 * POST /unsubscribe/:targetId — perform the unsubscribe. Serves both the
 * confirmation form above and RFC 8058 List-Unsubscribe-Post one-click.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ targetId: string }> },
) {
  const { targetId } = await params;
  if (!UUID_RE.test(targetId)) {
    return htmlResponse(UNSUBSCRIBE_ERROR_HTML, 404);
  }

  const updated = await sql`
    UPDATE targets SET status = 'unsubscribed', updated_at = NOW()
    WHERE id = ${targetId}
    RETURNING id
  `;
  if (updated.length === 0) {
    return htmlResponse(UNSUBSCRIBE_ERROR_HTML, 404);
  }

  return htmlResponse(UNSUBSCRIBE_SUCCESS_HTML);
}
