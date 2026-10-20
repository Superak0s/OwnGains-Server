---
title: Require Types in @property Tags
impact: HIGH
impactDescription: ensures property contracts include explicit type information
tags: jsdoc, property, types, lint
---

## Require Types in `@property` Tags

Ensure each `@property` tag includes a type expression in curly braces.

**Use this when:** documenting typedef, namespace, or class properties with JSDoc.  
**Avoid this when:** writing untyped `@property` tags like `@property foo`.

Property types should be documented so consumers and tooling can infer expected data shapes.

**Incorrect (missing property type):**

```js
/**
 * @typedef {SomeType} SomeTypedef
 * @property foo
 */
```

**Correct (typed property):**

```js
/**
 * @typedef {SomeType} SomeTypedef
 * @property {number} foo
 */
```
