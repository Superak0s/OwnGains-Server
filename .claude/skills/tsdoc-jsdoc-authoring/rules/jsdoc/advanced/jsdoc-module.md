---
title: Use @module for Module-Level Docs
impact: MEDIUM
impactDescription: clarifies module boundaries and exported responsibilities
tags: jsdoc, module, entrypoint, organization
---

## Use `@module` for Module-Level Docs

Use `@module` at file/module scope for package organization and generated docs.

**Apply it when:** documenting JavaScript module entrypoints or grouped exports.  
**Avoid this when:** annotating individual functions with module-level semantics.

**Incorrect (module tag on member doc):**

```js
/**
 * @module auth
 * Issues access tokens.
 */
function issueToken(userId) {}
```

**Correct (module-level declaration):**

```js
/**
 * Authentication helpers.
 * @module auth
 */
```
