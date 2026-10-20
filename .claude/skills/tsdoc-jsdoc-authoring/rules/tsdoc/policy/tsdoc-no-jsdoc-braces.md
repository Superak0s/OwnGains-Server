---
title: Do Not Mix JSDoc Type Syntax into TSDoc
impact: CRITICAL
impactDescription: avoids parser/tooling incompatibilities and inconsistent style
tags: tsdoc, jsdoc, syntax, consistency
---

## Do Not Mix JSDoc Type Syntax into TSDoc

In TSDoc, avoid JSDoc-style type braces in tag lines.

**Use this when:** writing TSDoc in TypeScript codebases.  
**Avoid this when:** authoring JavaScript files that intentionally use JSDoc tooling.

**Incorrect (JSDoc-style braces in TSDoc):**

```ts
/**
 * @param {string} id - User identifier.
 * @returns {Promise<User>} User record.
 */
export async function getUser(id: string): Promise<User> {}
```

**Correct (TSDoc syntax):**

```ts
/**
 * @param id - User identifier.
 * @returns User record.
 */
export async function getUser(id: string): Promise<User> {}
```
