---
title: Require @yields for Generator Output
impact: HIGH
impactDescription: ensures generator output contracts are documented and unambiguous
tags: jsdoc, yields, generators, lint
---

## Require `@yields` for Generator Output

Document generator yields with `@yields` and avoid multiple `@yields` tags in a single doc block.

**Use this when:** documenting generator functions that yield values.  
**Avoid this when:** omitting `@yields` on yielding generators or adding duplicate `@yields` tags.

This prevents missing yield contracts and inconsistent generator documentation.

**Incorrect (missing `@yields`):**

```js
function* quux(foo) {
	yield foo;
}
```

**Incorrect (duplicate `@yields` tags):**

```js
/**
 * @yields {undefined}
 * @yields {void}
 */
function* quux(foo) {}
```

**Correct (single `@yields`):**

```js
/**
 * @yields {Foo}
 */
function* quux(foo) {
	yield foo;
}
```

Configuration options:

- `exemptedBy` (`string[]`, default `["inheritdoc"]`): functions with these tags are exempt.
- `forceRequireYields` (`boolean`, default `false`): require `@yields` on all generators, even empty/non-yielding ones.
- `withGeneratorTag` (`boolean`, default `false`): require `@yields` when a `@generator` tag is present.
