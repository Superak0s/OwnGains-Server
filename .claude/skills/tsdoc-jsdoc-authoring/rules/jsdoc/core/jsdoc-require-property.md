---
title: Require @property for Object Typedefs and Namespaces
impact: HIGH
impactDescription: prevents incomplete object-shape documentation for typedefs and namespaces
tags: jsdoc, typedef, namespace, property, lint
---

## Require `@property` for Object Typedefs and Namespaces

When using `@typedef` or `@namespace` with plain object types, include one or more `@property` tags.

**Use this when:** documenting object-based typedefs or namespaces.  
**Avoid this when:** leaving object typedefs/namespaces without property definitions.

Object shapes should have properties defined so consumers can understand the contract.

**Incorrect (missing `@property`):**

```js
/**
 * @typedef {Object} SomeTypedef
 */

/**
 * @namespace {Object} SomeNamespace
 */
```

**Correct (object typedef with properties):**

```js
/**
 * @typedef {Object} SomeTypedef
 * @property {SomeType} propName Prop description
 */
```

**Correct (object typedef with shorthand property):**

```js
/**
 * @typedef {object} Foo
 * @property someProp
 */
```
