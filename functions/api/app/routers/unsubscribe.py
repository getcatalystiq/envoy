"""Public unsubscribe endpoint for email recipients."""

from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from shared.database import get_pool
from shared.queries import TargetQueries

router = APIRouter()

UNSUBSCRIBE_SUCCESS_HTML = """
<!DOCTYPE html>
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
</html>
"""

UNSUBSCRIBE_ERROR_HTML = """
<!DOCTYPE html>
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
</html>
"""


@router.get("/{target_id}", response_class=HTMLResponse)
async def unsubscribe(target_id: UUID) -> HTMLResponse:
    """Unsubscribe a target from all emails.

    This is a public endpoint (no auth required) accessed via unsubscribe links in emails.
    """
    pool = await get_pool()

    async with pool.acquire() as conn:
        # Get target to verify it exists
        target = await TargetQueries.get_by_id(conn, target_id)

        if not target:
            return HTMLResponse(content=UNSUBSCRIBE_ERROR_HTML, status_code=404)

        # Update status to unsubscribed
        await TargetQueries.update(conn, target_id, status="unsubscribed")

    return HTMLResponse(content=UNSUBSCRIBE_SUCCESS_HTML)


@router.post("/{target_id}", response_class=HTMLResponse)
async def unsubscribe_one_click(target_id: UUID) -> HTMLResponse:
    """One-click unsubscribe (POST) for List-Unsubscribe-Post header compliance.

    Gmail and other email clients use POST for one-click unsubscribe.
    """
    return await unsubscribe(target_id)
