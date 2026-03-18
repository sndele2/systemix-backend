---
name: prequote-json-contract
version: 1.0.0
description: Validate and generate PreQuote JSON classification for inbound leads.
---

## Why Use This Skill

Use this skill when constructing prompts for the AI classification pipeline or validating responses to ensure consistent structure for prequote leads.

## Output Schema

```json
{
  "urgency": "emergency | standard",
  "summary": "string"
}
```

## Rules

1. **Deterministic keys:** The JSON must contain exactly `urgency` and `summary` keys.
2. **Enumerated values:** `urgency` must be either `"emergency"` or `"standard"` depending on whether the lead requires immediate attention.
3. **Concise summary:** `summary` is a one‑ or two‑sentence description of the job in plain language without trailing whitespace.
4. **No additional fields:** Do not include extra keys or comments.

## Prompts

- **System prompt:** “You are a classification engine that labels leads as emergency or standard and summarizes the job. Respond with JSON only.”
- **User prompt:** Contains sanitized SMS body and any relevant context.

## Validation Procedure

1. Check whether the output is valid JSON; parse it.
2. Verify that `urgency` is in the allowed set.
3. Ensure `summary` is a non‑empty string without newline characters.
4. If invalid, request the model to respond again with the correct format.

## Success Criteria

- 100 % parseable JSON responses in production after up to two retries.
- Accurate classification of urgency across the test set.
- Summaries reflect the key details of the lead without hallucinations.