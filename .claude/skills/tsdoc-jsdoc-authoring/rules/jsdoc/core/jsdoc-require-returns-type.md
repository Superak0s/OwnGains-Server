---
title: Require Types in @returns Tags
impact: HIGH
impactDescription: ensures return contracts include explicit type information
tags: jsdoc, returns, types, lint
---

## Require Types in `@returns` Tags

Ensure each `@returns` tag includes a type expression in curly braces.

**Use this when:** documenting return values in JavaScript JSDoc blocks.  
**Avoid this when:** writing untyped `@returns` tags like `@returns`.

A `@returns` tag should include a type value to clearly define return shape expectations.

**Incorrect (missing return type):**

```js
/** @returns */
function quux(foo) {}
```

**Correct (typed return):**

```js
/** @returns {string} */
function quux(foo) {}
```
