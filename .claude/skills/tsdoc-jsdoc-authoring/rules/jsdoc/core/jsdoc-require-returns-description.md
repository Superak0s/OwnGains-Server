---
title: Require Descriptions in @returns Tags
impact: HIGH
impactDescription: clarifies return-value semantics beyond raw type information
tags: jsdoc, returns, descriptions, lint
---

## Require Descriptions in `@returns` Tags

Ensure `@returns` tags include a description value.

**Use this when:** documenting return behavior for functions and methods.  
**Avoid this when:** leaving `@returns` empty or type-only without meaning.

A `@returns` tag should explain what is returned, not just indicate that a return exists.

The error is not reported when the return type is:

- `void`
- `undefined`
- `Promise<void>`
- `Promise<undefined>`

**Incorrect (missing return description):**

```js
/** @returns */
function quux(foo) {}
```

**Correct (return description present):**

```js
/** @returns Foo. */
function quux(foo) {}
```
