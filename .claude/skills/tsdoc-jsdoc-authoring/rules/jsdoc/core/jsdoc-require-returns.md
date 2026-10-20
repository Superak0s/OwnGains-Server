---
title: Require @returns for Return Statements
impact: HIGH
impactDescription: prevents missing or ambiguous return-value documentation
tags: jsdoc, returns, completeness, lint
---

## Require `@returns` for Return Statements

Document return statements with `@returns` and avoid multiple `@returns` tags in a single doc block.

**Use this when:** documenting functions or methods that return values.  
**Avoid this when:** the function truly has no return value or return information is inherited from external type declarations.

This prevents missing return contracts and inconsistent return documentation.

**Incorrect (missing `@returns`):**

```js
/** Foo. */
function quux() {
	return foo;
}
```

**Incorrect (duplicate `@returns` tags):**

```js
/**
 * @returns Foo!
 * @returns Foo?
 */
function quux() {
	return foo;
}
```

**Correct (single `@returns`):**

```js
/** @returns Foo. */
function quux() {
	return foo;
}
```

Configuration options:

- `checkConstructors` (`boolean`, default `false`): whether to check constructor methods.
- `checkGetters` (`boolean`, default `true`): whether to check getter methods.
- `exemptedBy` (`string[]`, default `["inheritdoc"]`): tags that exempt functions from requiring `@returns`.
- `forceRequireReturn` (`boolean`, default `false`): whether to require `@returns` even if no value is returned.
- `forceReturnsWithAsync` (`boolean`, default `false`): whether to require `@returns` on async functions.
