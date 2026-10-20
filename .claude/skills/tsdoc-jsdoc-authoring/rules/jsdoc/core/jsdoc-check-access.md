---
title: Validate Access Tags with check-access
impact: HIGH
impactDescription: prevents ambiguous visibility semantics in JSDoc comments
tags: jsdoc, access, lint, visibility
---

## Validate Access Tags with `check-access`

When documenting visibility in JSDoc, use exactly one access style per doc block:

- `@access package|private|protected|public`, or
- one shorthand tag: `@package`, `@private`, `@protected`, or `@public`

**Use this when:** documenting API/member visibility in JavaScript files.  
**Avoid this when:** mixing access styles or using unsupported access values.

**Incorrect (mixed access styles):**

```js
/**
 * @access private
 * @public
 */
function normalizeUser(input) {}
```

**Incorrect (invalid access value):**

```js
/**
 * @access internal-only
 */
function normalizeUser(input) {}
```

**Correct (single valid access tag):**

```js
/**
 * @access private
 */
function normalizeUser(input) {}
```

**Correct (single shorthand access tag):**

```js
/**
 * @private
 */
function normalizeUser(input) {}
```
