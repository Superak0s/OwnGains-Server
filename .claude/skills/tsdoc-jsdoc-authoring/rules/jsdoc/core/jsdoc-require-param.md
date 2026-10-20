---
title: Require @param for Function Parameters
impact: HIGH
impactDescription: ensures complete input contracts for documented functions
tags: jsdoc, param, completeness, lint
---

## Require `@param` for Function Parameters

Document all function parameters with JSDoc `@param` tags.

**Use this when:** writing JSDoc for functions, methods, and callable APIs.  
**Avoid this when:** TypeScript types already provide complete parameter documentation.

This improves code quality and maintainability by making function inputs explicit.

**Incorrect (missing a parameter tag):**

```js
/** @param foo */
function quux(foo, bar) {}
```

**Correct (all parameters documented):**

```js
/** @param foo */
function quux(foo) {}
```

Configuration options:

- `checkConstructors` (`boolean`, default `false`): whether to check constructor methods.
- `checkDestructured` (`boolean`, default `true`): whether to check destructured parameters.
- `checkDestructuredRoots` (`boolean`, default `true`): whether to require a root `@param` tag for root destructured parameters like `function f({a, b}) {}`.
- `checkGetters` (`boolean`, default `true`): whether to check getter methods.
- `checkRestProperty` (`boolean`, default `false`): whether to check rest properties.
- `checkSetters` (`boolean`, default `true`): whether to check setter methods.
- `checkTypesPattern` (`string`, default `"^(?:[oO]bject|[aA]rray|PlainObject|Generic(?:Object|Array))$"`): regex pattern for types exempted from checking.
- `exemptedBy` (`string[]`, default `["inheritdoc"]`): JSDoc tags that exempt functions from `@param` checking.
