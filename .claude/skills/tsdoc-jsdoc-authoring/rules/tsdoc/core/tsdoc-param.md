---
title: Document Parameters with @param
impact: CRITICAL
impactDescription: clarifies caller obligations and input semantics
tags: tsdoc, param, function-contract, api-docs
---

## Document Parameters with @param

Use one `@param` line per parameter: `@param name - Description`.

**Use this when:** documenting any function or method parameters.  
**Avoid this when:** repeating type annotations already in the signature.

Each parameter comment must explain what that specific parameter does.
If a parameter is an object, document each relevant property and what each property does.
For TypeScript object params, prefer a named object type/interface with `/** ... */` comments on each property.

**Incorrect (missing semantics):**

```ts
/**
 * @param timeoutMs - number
 */
export function waitForReady(timeoutMs: number): Promise<void> {}
```

**Correct (caller-relevant semantics):**

```ts
/**
 * @param timeoutMs - Maximum wait time in milliseconds before timing out.
 */
export function waitForReady(timeoutMs: number): Promise<void> {}
```

**Incorrect (object parameter properties undocumented):**

```ts
/**
 * @param options - Search configuration.
 */
export function search(options: { query: string; limit?: number }): Result[] {}
```

**Correct (object parameter properties documented):**

```ts
/**
 * @param options - Search configuration.
 * @param options.query - Query string used to match results.
 * @param options.limit - Maximum number of results to return.
 */
export function search(options: { query: string; limit?: number }): Result[] {}
```

**Preferred (VS Code hover/autocomplete-friendly pattern):**

```ts
type SearchOptions = {
	/** Query string used to match results. */
	query: string;
	/** Maximum number of results to return. */
	limit?: number;
};

/**
 * @param options - Search configuration.
 */
export function search(options: SearchOptions): Result[] {}
```
