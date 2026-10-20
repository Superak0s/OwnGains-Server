---
title: Document Return Semantics with @returns
impact: HIGH
impactDescription: clarifies output guarantees and expectations
tags: tsdoc, returns, output, contracts
---

## Document Return Semantics with @returns

Use `@returns` to describe return meaning, guarantees, and ordering.

**Use this when:** function returns non-void values (including Promise payloads).  
**Avoid this when:** output is `void` and no return contract exists.

**Incorrect (type-only restatement):**

```ts
/**
 * @returns A string.
 */
export function getCacheKey(): string {}
```

**Correct (semantic output contract):**

```ts
/**
 * @returns A deterministic cache key that is stable for equivalent inputs.
 */
export function getCacheKey(): string {}
```
