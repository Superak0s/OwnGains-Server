---
title: Use Optional and Default Parameter Strings Correctly
impact: CRITICAL
impactDescription: prevents caller confusion around optional inputs
tags: jsdoc, param, optional, defaults, syntax
---

## Use Optional and Default Parameter Strings Correctly

Use JSDoc optional/default syntax strings consistently:

- Optional: `@param {string} [name]`
- Optional with default: `@param {string} [name=John Doe]`

**Use this when:** documenting optional JavaScript parameters.  
**Avoid this when:** optionality is described only in prose and not in tag syntax.

**Incorrect (optionality hidden):**

```js
/**
 * @param {string} name - Optional display name.
 */
function greet(name) {}
```

**Correct (explicit optional/default string syntax):**

```js
/**
 * @param {string} [name=John Doe] - Optional display name.
 */
function greet(name) {}
```
