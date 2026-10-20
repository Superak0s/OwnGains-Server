---
title: Document Return Value Semantics with @returns
impact: HIGH
impactDescription: clarifies output behavior and expected shape
tags: jsdoc, returns, output, contracts
---

## Document Return Value Semantics with @returns

Use `@returns {Type}` with semantic description.

**Use this when:** functions return a value or Promise payload.  
**Avoid this when:** only stating raw type without meaning.

**Incorrect (type-only):**

```js
/**
 * @returns {Object}
 */
function parseConfig() {}
```

**Correct (semantics included):**

```js
/**
 * @returns {{ retries: number, timeoutMs: number }} Normalized runtime configuration.
 */
function parseConfig() {}
```
