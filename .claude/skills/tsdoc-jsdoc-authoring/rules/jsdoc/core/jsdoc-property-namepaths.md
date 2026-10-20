---
title: Use Nested Property Namepaths for Object Inputs
impact: HIGH
impactDescription: makes object parameter contracts explicit
tags: jsdoc, param, property, namepath, objects
---

## Use Nested Property Namepaths for Object Inputs

When a parameter is an object, document its fields using namepaths.
Each object property needs its own comment that explains what it does.

**Use this when:** function expects structured objects or arrays of objects.  
**Avoid this when:** you are only documenting a single top-level object parameter and none of its nested properties need separate documentation.

**Incorrect (missing nested fields):**

```js
/**
 * @param {Object} options - Query options.
 */
function search(options) {}
```

**Correct (nested property paths):**

```js
/**
 * @param {Object} options - Query options.
 * @param {string} options.query - Search query string.
 * @param {number} [options.limit=20] - Maximum number of results.
 */
function search(options) {}
```
