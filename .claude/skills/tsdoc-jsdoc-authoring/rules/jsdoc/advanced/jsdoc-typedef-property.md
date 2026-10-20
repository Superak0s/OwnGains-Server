---
title: Define Reusable Shapes with @typedef and @property
impact: HIGH
impactDescription: centralizes object contracts and improves consistency
tags: jsdoc, typedef, property, object-shapes
---

## Define Reusable Shapes with `@typedef` and `@property`

Use `@typedef` and `@property` for repeated object shapes.

**Use this when:** multiple APIs share the same object structure.  
**Avoid inline shapes when:** the same structure appears in multiple places.

**Incorrect (duplicated inline shape):**

```js
/**
 * @param {{ id: string, active: boolean }} user - User object.
 */
function saveUser(user) {}
```

**Correct (reusable typedef):**

```js
/**
 * @typedef {Object} UserRecord
 * @property {string} id - Stable user identifier.
 * @property {boolean} active - Whether the user is active.
 */

/**
 * @param {UserRecord} user - User object.
 */
function saveUser(user) {}
```
