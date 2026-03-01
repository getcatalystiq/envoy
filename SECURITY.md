# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly. **Do not open a public issue.**

Email security concerns to the maintainers with:
- A description of the vulnerability
- Steps to reproduce
- Potential impact

We will respond within 48 hours and work with you to address the issue.

## Security Practices

- All credentials are loaded from environment variables, never hardcoded
- Tenant isolation is enforced at the query level (`WHERE organization_id = ...`)
- OAuth 2.1 with PKCE for authentication
- Webhook secrets use timing-safe comparison
- SNS signatures are verified for SES event webhooks
