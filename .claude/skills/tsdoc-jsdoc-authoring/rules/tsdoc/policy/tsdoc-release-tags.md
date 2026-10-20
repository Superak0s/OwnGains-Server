---
title: Apply Release Tags Consistently
impact: CRITICAL
impactDescription: ensures stable public API lifecycle communication
tags: tsdoc, release-tags, public, internal, alpha, beta, experimental
---

## Apply Release Tags Consistently

Apply one clear release/visibility policy and keep it consistent across related APIs.

Supported policy tags include `@public`, `@internal`, `@alpha`, `@beta`, and `@experimental`.

**Use this when:** API lifecycle and visibility matter to consumers.  
**Avoid this when:** tags are mixed arbitrarily or conflict with actual support policy.

**Incorrect (conflicting policy):**

```ts
/**
 * Creates session tokens.
 * @public
 * @internal
 */
export function createSessionToken(userId: string): string {}
```

**Correct (single clear policy):**

```ts
/**
 * Creates session tokens.
 * @beta
 */
export function createSessionToken(userId: string): string {}
```
