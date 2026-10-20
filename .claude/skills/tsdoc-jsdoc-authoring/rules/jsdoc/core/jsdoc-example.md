---
title: Add Practical @example Snippets
impact: MEDIUM
impactDescription: reduces misuse by showing expected call patterns
tags: jsdoc, example, usage, snippets
---

## Add Practical `@example` Snippets

Use `@example` for behavior that is not obvious from signature alone.

**Use this when:** API behavior or output format may be misunderstood.  
**Avoid this when:** examples are trivial, stale, or verbose.

**Incorrect (no concrete usage):**

```js
/**
 * Formats a currency value.
 */
function formatCurrency(amount, currency) {}
```

**Correct (practical usage):**

```js
/**
 * Formats a currency value.
 * @example
 * // "$12.50"
 * formatCurrency(12.5, "USD")
 */
function formatCurrency(amount, currency) {}
```
