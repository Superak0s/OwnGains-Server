---
title: Require Types in @param Tags
impact: HIGH
impactDescription: ensures parameter contracts include explicit JSDoc type information
tags: jsdoc, param, types, lint
---

## Require Types in `@param` Tags

Ensure each JSDoc `@param` tag includes a type expression in curly braces.

**Use this when:** documenting JavaScript function parameters with JSDoc.  
**Avoid this when:** your project already uses TypeScript or external type definitions that make extra `{type}` expressions redundant.

The parameter type should be documented so callers and tooling can understand expected input shapes.

**Incorrect (missing type in `@param`):**

```js
/** @param foo */
function quux(foo) {}
```

**Correct (typed `@param`):**

```js
/** @param {SomeType} foo */
function quux(foo) {}
```
