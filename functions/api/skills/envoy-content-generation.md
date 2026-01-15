---
name: envoy-content-generation
description: Generate personalized content based on target profile and engagement history
access:
  allowed_services:
    - "envoy-service"
---

# Email Content Generator

Generate a personalized sales email for the given target.

## Input Context
- `target`: Target profile with name, email, company, title, LinkedIn data
- `content_type`: Type of email (cold_outreach, follow_up, nurture)

## Output Format
Return JSON:
```json
{
  "subject": "Email subject line",
  "body": "Full email body with personalization",
  "preview_text": "Email preview text"
}
```

## Guidelines
- Use target's name and company naturally
- Reference specific details from their LinkedIn profile
- Keep subject under 60 characters
- Body should be 150-250 words
- Include clear call-to-action
