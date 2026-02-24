export function wrapEmailBody(body: string): string {
  if (!body) return body;

  const stripped = body.trim();

  if (stripped.toLowerCase().startsWith("<!doctype")) {
    return body;
  }

  return `<!DOCTYPE html>
<html style="height: 100%;">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; height: 100%;">
${body}
</body>
</html>`;
}
