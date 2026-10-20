---
title: Document Parameters with JSDoc Type Expressions
impact: CRITICAL
impactDescription: defines input contract for JavaScript APIs
tags: jsdoc, param, types, contracts
---

## Document Parameters with JSDoc Type Expressions

Use `@param {Type} name - Description` for each parameter.

**Use this when:** documenting JavaScript API parameters.  
**Avoid this when:** using TypeScript with explicit parameter types or when types are reliably inferred from existing annotations/tooling.

Each parameter comment must explain what that specific parameter does.

**Incorrect (missing type expression):**

```js
/**
 * @param timeoutMs - Wait time.
 */
function waitForReady(timeoutMs) {}
```

**Correct (typed parameter contract):**

```js
/**
 * @param {number} timeoutMs - Maximum wait time in milliseconds.
 */
function waitForReady(timeoutMs) {}
```
