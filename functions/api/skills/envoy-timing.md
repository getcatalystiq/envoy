---
name: envoy-timing
description: Determine optimal email send timing based on engagement patterns
access:
  allowed_services:
    - "envoy-service"
---

# Send Timing Optimizer

Analyze past engagement patterns to determine optimal send time.

## Input Context
- `target`: Target profile with timezone
- `past_sends`: History of previous sends with engagement data

## Output Format
Return JSON:
```json
{
  "recommended_time": "ISO8601 datetime",
  "timezone": "target timezone",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
```
