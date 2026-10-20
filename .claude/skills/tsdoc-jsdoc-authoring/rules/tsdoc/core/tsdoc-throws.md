---
title: Document Expected Failures with @throws
impact: HIGH
impactDescription: defines caller-facing error-handling contracts
tags: tsdoc, throws, errors, reliability
---

## Document Expected Failures with @throws

Use `@throws` for expected, contract-relevant failures.

**Use this when:** callers should handle known failure modes.  
**Avoid this when:** documenting incidental low-level errors with no API contract value.

**Incorrect (no-throw-contract):**

```ts
/**
 * Parses a signed token.
 */
export function parseToken(token: string): Payload {}
```

**Correct (caller-relevant error path):**

```ts
/**
 * Parses a signed token.
 * @throws Error if token signature verification fails.
 */
export function parseToken(token: string): Payload {}
```
