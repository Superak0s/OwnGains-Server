---
title: Document Async Behavior with @async
impact: MEDIUM
impactDescription: clarifies asynchronous control flow in generated docs
tags: jsdoc, async, promises, functions
---

## Document Async Behavior with `@async`

Use `@async` where tooling or virtual comments need explicit async annotation.

**Use this when:** async behavior is not obvious from implementation context.  
**Avoid this when:** async is already clear and the project style avoids redundant tags.

**Incorrect (no async contract in virtual docs):**

```js
/**
 * Downloads data from a URL.
 * @param {string} url - Source URL.
 * @returns {Promise<string>} Downloaded content.
 */
```

**Correct (explicit async behavior):**

```js
/**
 * Downloads data from a URL.
 * @async
 * @param {string} url - Source URL.
 * @returns {Promise<string>} Downloaded content.
 */
```
