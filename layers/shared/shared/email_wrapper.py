"""Email HTML wrapper utility."""


def wrap_email_body(body: str) -> str:
    """Wrap email body in HTML document structure.

    Handles content from the email-builder (render_email_layout output)
    by wrapping in a minimal HTML document without double-nesting.

    If body is already a full HTML document, returns as-is.
    """
    if not body:
        return body

    stripped = body.strip()

    # Already a full HTML document
    if stripped.lower().startswith('<!doctype'):
        return body

    # Wrap in HTML document structure
    return f'''<!DOCTYPE html>
<html style="height: 100%;">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; height: 100%;">
{body}
</body>
</html>'''
