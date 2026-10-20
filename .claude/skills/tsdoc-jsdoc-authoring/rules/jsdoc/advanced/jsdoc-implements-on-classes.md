---
title: Restrict @implements to Classes or Constructors
impact: HIGH
impactDescription: prevents invalid interface implementation annotations on non-constructors
tags: jsdoc, implements, classes, constructors, lint
---

## Restrict `@implements` to Classes or Constructors

Use `@implements` only on class constructors or constructor-style functions.

**Use this when:** documenting classes, constructors, or constructor functions.  
**Avoid this when:** annotating regular functions, callbacks, or `@function` docs.

**Incorrect (non-constructor function):**

```js
/**
 * @implements {SomeClass}
 */
function quux() {}
```

**Correct (class constructor):**

```js
class Foo {
	/**
	 * @implements {SomeClass}
	 */
	constructor() {}
}
```

**Correct (constructor-style function):**

```js
/**
 * @implements {SomeClass}
 * @class
 */
function quux() {}
```
