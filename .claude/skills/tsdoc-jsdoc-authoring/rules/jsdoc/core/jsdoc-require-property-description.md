---
title: Require Descriptions for @property Tags
impact: HIGH
impactDescription: improves object-shape clarity by documenting property intent
tags: jsdoc, property, descriptions, lint
---

## Require Descriptions for `@property` Tags

Ensure all `@property` tags include a description.

**Use this when:** documenting typedef or namespace properties.  
**Avoid this when:** the property tag already includes an explanatory description.

Property descriptions should be documented so consumers understand each field's purpose.

**Incorrect (missing property description):**

```js
/**
 * @typedef {SomeType} SomeTypedef
 * @property {number} foo
 */
```

**Correct (property description present):**

```js
/**
 * @typedef {SomeType} SomeTypedef
 * @property {number} foo Foo.
 */
```
