---
title: Use @inheritDoc Only for Equivalent Contracts
impact: HIGH
impactDescription: prevents inherited docs from drifting from real behavior
tags: tsdoc, inheritdoc, inheritance, contracts
---

## Use @inheritDoc Only for Equivalent Contracts

Use `@inheritDoc` only when behavior is truly equivalent to the referenced declaration.

**Use this when:** override/wrapper keeps the same contract.  
**Avoid this when:** behavior, defaults, errors, or side effects differ.

**Incorrect (inherits despite changed behavior):**

```ts
/**
 * @inheritDoc BaseClient.fetch
 */
export class CachedClient extends BaseClient {
	public override fetch(id: string): Promise<Item> {}
}
```

**Correct (document differences explicitly):**

```ts
/**
 * Fetches an item by ID, serving stale-while-revalidate responses from cache.
 *
 * @remarks
 * Unlike `BaseClient.fetch`, this method may return cached data immediately
 * and refresh the cache asynchronously.
 */
export class CachedClient extends BaseClient {
	public override fetch(id: string): Promise<Item> {}
}
```
