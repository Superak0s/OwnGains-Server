---
title: Use @example for Non-Obvious Usage
impact: MEDIUM
impactDescription: reduces misuse and clarifies edge cases
tags: tsdoc, example, usage, snippets
---

## Use @example for Non-Obvious Usage

Use `@example` for tricky, non-obvious, or high-value usage patterns.

**When to use:** behavior is subtle or edge-case driven.  
**When to avoid:** examples are trivial, stale, or excessively long.

**Incorrect (no usage guidance for tricky API):**

```ts
/**
 * Retries an operation with backoff.
 */
export async function retry<T>(fn: () => Promise<T>): Promise<T> {}
```

**Correct (clear example):**

````ts
/**
 * Retries an operation with backoff.
 * @example
 * ```ts
 * const result = await retry(() => fetchJson("/api/data"))
 * ```
 */
export async function retry<T>(fn: () => Promise<T>): Promise<T> {}
````
