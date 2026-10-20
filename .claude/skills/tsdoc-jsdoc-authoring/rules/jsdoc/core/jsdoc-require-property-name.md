---
title: Require Names in @property Tags
impact: HIGH
impactDescription: ensures each documented property is identifiable by name
tags: jsdoc, property, names, lint
---

## Require Names in `@property` Tags

Ensure all `@property` tags include a property name.

**Use this when:** documenting typedef or namespace object properties.  
**Avoid this when:** writing `@property` tags without an identifier.

Property names should be documented so object fields can be referenced unambiguously.

**Incorrect (missing property name):**

```js
/**
 * @typedef {SomeType} SomeTypedef
 * @property {number}
 */
```

**Correct (property name present):**

```js
/**
 * @typedef {SomeType} SomeTypedef
 * @property {number} foo
 */
```
