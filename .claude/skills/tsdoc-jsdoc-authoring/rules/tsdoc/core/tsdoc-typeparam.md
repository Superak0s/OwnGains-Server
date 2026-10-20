---
title: Document Generics with @typeParam
impact: CRITICAL
impactDescription: preserves generic API intent for consumers
tags: tsdoc, typeparam, generics, api-contract
---

## Document Generics with @typeParam

Use `@typeParam` for each public generic parameter.

**Use this when:** function/class/interface/type alias has generic type params.  
**Avoid this when:** symbol has no generic parameters.

**Incorrect (undocumented generic intent):**

```ts
/**
 * Builds an index from items.
 */
export function toIndex<T>(items: T[]): Map<string, T> {}
```

**Correct (clear generic role):**

```ts
/**
 * Builds an index from items.
 * @typeParam T - Source item type stored in the resulting map.
 */
export function toIndex<T>(items: T[]): Map<string, T> {}
```
