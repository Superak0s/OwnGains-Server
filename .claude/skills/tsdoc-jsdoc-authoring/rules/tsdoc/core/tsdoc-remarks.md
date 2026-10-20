---
title: Use @remarks for Long-Form Context
impact: HIGH
impactDescription: prevents overloaded summaries and preserves detail
tags: tsdoc, remarks, context, contracts
---

## Use @remarks for Long-Form Context

Use `@remarks` for deeper context, caveats, and non-trivial behavior.

**Use this when:** summary alone cannot express constraints or trade-offs.  
**Avoid this when:** a one-line summary is sufficient.

**Incorrect (long narrative in summary):**

```ts
/**
 * Generates cache keys and also normalizes locale and strips unsupported
 * fields and retries once if key generation collides.
 */
export function buildCacheKey(input: Input): string {}
```

**Correct (summary + remarks):**

```ts
/**
 * Builds a deterministic cache key for request inputs.
 *
 * @remarks
 * Normalizes locale casing, removes unsupported fields, and retries once on
 * hash collisions to preserve key uniqueness guarantees.
 */
export function buildCacheKey(input: Input): string {}
```
