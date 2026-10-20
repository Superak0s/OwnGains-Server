---
title: Avoid Defaults in JSDoc Param Tags
impact: MEDIUM
impactDescription: keeps parameter documentation aligned with modern JavaScript defaults
tags: jsdoc, param, defaults, lint
---

## Avoid Defaults in JSDoc Param Tags

Do not include default values inside `@param` or `@default` tag syntax when documenting function parameters.

**Use this when:** documenting JavaScript function parameters where defaults/optionality are represented in code.  
**Avoid this when:** writing bracketed defaults like `[name="value"]` in JSDoc.

This prevents redundant default notation in docs where ES2015+ default parameters already express runtime behavior.

**Incorrect (default value in `@param`):**

```js
/**
 * @param {number} [foo="7"]
 */
function quux(foo) {}
```

**Correct (required param notation):**

```js
/**
 * @param {number} foo
 */
function quux(foo) {}
```

**Correct (optional param without default value):**

```js
/**
 * @param {number} [foo]
 */
function quux(foo) {}
```

**Correct (untyped required param notation):**

```js
/**
 * @param foo
 */
function quux(foo) {}
```

Configuration option:

- `noOptionalParamNames` (`boolean`, default `false`): when `true`, also report square-bracket optional names on `@param` tags.
