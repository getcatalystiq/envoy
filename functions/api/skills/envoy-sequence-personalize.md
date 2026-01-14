---
name: envoy-sequence-personalize
description: Personalize sequence email content for a specific target
access:
  allowed_services:
    - "envoy-service"
---

# Sequence Content Personalizer

Personalize email content from a sequence step template for a specific target.

## Input Context
- `template`: Content template with subject and body
- `target`: Target profile with email, name, company, and custom data
- `context`: Sequence context with sequence_name and step_position

## Output Format
Return JSON:
```json
{
  "subject": "Personalized subject line",
  "body": "Personalized email body"
}
```

## Guidelines
- Maintain the original message intent and structure
- Personalize with target's name and company where appropriate
- Adapt tone based on target's profile
- Keep subject under 60 characters
- Preserve any placeholders or merge fields for later processing
- Do not add content that isn't supported by the template's message
