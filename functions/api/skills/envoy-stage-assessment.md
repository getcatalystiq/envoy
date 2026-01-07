---
name: envoy-stage-assessment
description: Assess sales lifecycle stage for a target based on engagement signals
access:
  allowed_services:
    - "envoy-service"
---

# Stage Assessment

Analyze target engagement history and determine their current sales stage.

## Input Context
- `target`: Target profile
- `engagements`: List of engagement events (opens, clicks, replies)

## Output Format
Return JSON:
```json
{
  "stage": "awareness|interest|consideration|decision",
  "confidence": 0.0-1.0,
  "signals": ["list of key signals"],
  "recommended_action": "next best action"
}
```
