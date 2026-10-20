---
title: Document Generator Output with @yields
impact: MEDIUM
impactDescription: clarifies yielded value contracts for iterators
tags: jsdoc, yields, generators, iterators
---

## Document Generator Output with `@yields`

Use `@yields {Type}` to describe generator output values.

**Use this when:** documenting generator functions.  
**Avoid this when:** function is not a generator.

**Incorrect (missing yielded type):**

```js
/**
 * Generates Fibonacci numbers.
 */
function* fibonacci() {
	yield 0;
}
```

**Correct (explicit yielded contract):**

```js
/**
 * Generates Fibonacci numbers.
 * @yields {number} The next number in the sequence.
 */
function* fibonacci() {
	yield 0;
}
```
