---
title: Use @see for Related APIs
impact: MEDIUM
impactDescription: connects related APIs and reduces duplicated docs
tags: tsdoc, see, references, api-navigation
---

## Use @see for Related APIs

Use `@see` to point readers to related entry points, alternatives, or companion APIs.

**Use this when:** relationship is important for correct API selection.  
**Avoid this when:** references are irrelevant or redundant.

**Incorrect (no relationship guidance):**

```ts
/**
 * Verifies token signatures.
 */
export function verifyToken(token: string): boolean {}
```

**Correct (points to related APIs):**

```ts
/**
 * Verifies token signatures.
 * @see {@link decodeToken}
 * @see {@link parseSignedToken}
 */
export function verifyToken(token: string): boolean {}
```
