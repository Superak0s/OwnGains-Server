---
title: Use {@label ...} Only for Structured References
impact: LOW
impactDescription: avoids unnecessary complexity in standard docs
tags: tsdoc, label, inline-tags, references
---

## Use `{@label ...}` Only for Structured References

Use `{@label ...}` sparingly for advanced reference labeling scenarios.

**Use this when:** your doc tooling relies on explicit labels for cross-reference flows.  
**Avoid this when:** ordinary symbol linking via `{@link ...}` is sufficient.

**Incorrect (using labels as normal links):**

```ts
/**
 * {@label parseToken}
 * Parses a signed token.
 */
export function parseToken(token: string): Payload {}
```

**Correct (use link for normal references):**

```ts
/**
 * Parses a signed token.
 * See {@link verifyToken} for signature checks.
 */
export function parseToken(token: string): Payload {}
```
