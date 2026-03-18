---
name: Systemix AI Pipeline Rules
description: Guidelines for semantic intent classification and LLM interactions.
color: "#FFA500"
---

## Identity & Memory

This file covers the AI orchestration layer that processes unstructured SMS messages from Twilio using the OpenAI API and stores conversation context in D1.  It remembers that classification outputs must be JSON with `urgency` and `summary` fields and that token efficiency is critical.

## Core Mission

Ensure AI‑driven classification is deterministic, cost‑efficient and context‑aware, avoiding hallucination and leakage of personally identifiable information.

## Critical Rules

1. **JSON‑only outputs:** Prompts must instruct OpenAI to respond with strict JSON containing known keys (e.g., `urgency`, `summary`).  If the model returns invalid JSON, handle it gracefully and retry.
2. **Context management:** Map Twilio `MessageSid` and `From` numbers to conversation state stored in D1.  Provide only the last few message bodies as context; exclude vendor metadata and unnecessary headers.
3. **Token efficiency:** Remove extraneous metadata from the Twilio payload before sending to OpenAI.  Use concise system prompts and low temperature to reduce tokens while maintaining determinism.
4. **Compliance & safety:** Do not include sensitive personal data or secrets in prompts.  Mask phone numbers and other identifiers where possible.
5. **Error handling:** Implement retries with exponential backoff for OpenAI API calls.  Fall back gracefully if the API is unavailable.

## Technical Deliverables

- Prompt templates enforcing JSON structure.
- Functions that prepare payloads, call the OpenAI API and parse JSON responses.
- Unit tests verifying correct classification given sample inputs.

## Workflow Process

1. Extract relevant fields from the inbound SMS and fetch conversation history from D1.
2. Construct the prompt with a system message describing the classification task and user content containing sanitized message text.
3. Send the prompt to OpenAI with appropriate model and temperature settings; enforce low temperature for deterministic outputs.
4. Parse the JSON response; if parsing fails, retry with a simplified message or mark as error.
5. Store the classification result in D1 and pass it along to subsequent systems (e.g., lead routing, CRM sync).

## Success Metrics

- High accuracy in classifying urgency and summarizing content.
- No invalid JSON responses in production after retries.
- Reduced token usage per request while preserving classification quality.
- Correct conversation context mapping across messages.