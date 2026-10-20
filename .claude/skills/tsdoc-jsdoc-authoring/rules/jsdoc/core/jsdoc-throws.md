---
title: Document Error Contracts with @throws
impact: HIGH
impactDescription: enables predictable caller error handling
tags: jsdoc, throws, errors, reliability
---

## Document Error Contracts with @throws

Use `@throws {Type} ...` for expected, caller-relevant failures.

**Use this when:** function may throw known errors callers should handle.  
**Avoid this when:** listing incidental internal errors with no contract value.

**Incorrect (no-throws-contract):**

```js
/**
 * Parses a signed token.
 */
function parseSignedToken(token) {}
```

**Correct (typed throws contract):**

```js
/**
 * Parses a signed token.
 * @throws {Error} If the token signature is invalid.
 */
function parseSignedToken(token) {}
```
