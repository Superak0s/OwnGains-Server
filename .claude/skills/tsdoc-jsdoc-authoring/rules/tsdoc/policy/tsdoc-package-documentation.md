---
title: Use @packageDocumentation for Entrypoint Docs
impact: MEDIUM
impactDescription: improves package-level discoverability and onboarding
tags: tsdoc, packageDocumentation, modules, entrypoints
---

## Use `@packageDocumentation` for Entrypoint Docs

Use `@packageDocumentation` on module/entrypoint docs, not regular members.

**Use this when:** documenting package/module purpose and usage at top level.  
**Avoid this when:** documenting individual functions, classes, or fields.

**Incorrect (tag on a normal function):**

```ts
/**
 * @packageDocumentation
 * Creates a token.
 */
export function createToken(userId: string): string {}
```

**Correct (tag on entrypoint-level docs):**

```ts
/**
 * @packageDocumentation
 * Authentication helpers for issuing, parsing, and validating signed tokens.
 */
```
