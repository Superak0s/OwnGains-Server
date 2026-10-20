---
title: Write JSDoc Summaries with Intent
impact: HIGH
impactDescription: improves API readability for JavaScript consumers
tags: jsdoc, summary, readability
---

## Write JSDoc Summaries with Intent

Write concise summaries that explain behavior and purpose.

**Use this when:** documenting JavaScript functions, classes, and modules.  
**Avoid this when:** repeating symbol names without useful meaning.

**Incorrect (name restatement):**

```js
/**
 * Gets data.
 */
function getData() {}
```

**Correct (behavior-focused):**

```js
/**
 * Fetches and parses JSON data from the configured endpoint.
 */
function getData() {}
```
