---
title: Prefer {@link ...} for Symbol References
impact: MEDIUM
impactDescription: improves navigation and reference accuracy
tags: tsdoc, link, cross-reference, discoverability
---

## Prefer `{@link ...}` for Symbol References

Use inline `{@link ...}` when referring to symbols or canonical URLs.

**Use this when:** references should be navigable and unambiguous.  
**Avoid this when:** plain text names could be confused or drift over time.

**Incorrect (non-linking text reference):**

```ts
/**
 * Works with TokenVerifier.verify for signature validation.
 */
export function parseSignedToken(token: string): Payload {}
```

**Correct (navigable reference):**

```ts
/**
 * Works with {@link TokenVerifier.verify} for signature validation.
 */
export function parseSignedToken(token: string): Payload {}
```
