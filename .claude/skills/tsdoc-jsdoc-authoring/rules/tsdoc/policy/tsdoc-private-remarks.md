---
title: Use @privateRemarks for Maintainer-Only Notes
impact: MEDIUM
impactDescription: separates internal guidance from public API docs
tags: tsdoc, privateRemarks, maintainers, internals
---

## Use `@privateRemarks` for Maintainer-Only Notes

Use `@privateRemarks` for internal notes that should not appear in public docs.

**Use this when:** maintainers need migration or implementation caveats.  
**Avoid this when:** information is essential for API consumers.

**Incorrect (internal rollout note in public remarks):**

```ts
/**
 * @remarks
 * Keep legacy payload shape until mobile v4 rollout finishes.
 */
export function serializeUser(user: User): Payload {}
```

**Correct (internal detail isolated):**

```ts
/**
 * Serializes user data for API responses.
 * @privateRemarks
 * Keep legacy payload shape until mobile v4 rollout finishes.
 */
export function serializeUser(user: User): Payload {}
```
