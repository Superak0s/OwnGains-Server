---
title: Use @deprecated with Migration Guidance
impact: HIGH
impactDescription: prevents dead-end API usage and migration confusion
tags: tsdoc, deprecated, migration, lifecycle
---

## Use @deprecated with Migration Guidance

Use `@deprecated` only with explicit replacement guidance.

**Use this when:** a symbol should no longer be used.  
**Avoid this when:** deprecation is unclear or no replacement exists.

**Incorrect (no migration path):**

```ts
/**
 * @deprecated
 */
export function oldHash(input: string): string {}
```

**Correct (clear migration path):**

```ts
/**
 * @deprecated Use `hashSha256()` for stable cross-platform output.
 */
export function oldHash(input: string): string {}
```
