---
title: Document Defaults with @defaultValue
impact: MEDIUM
impactDescription: prevents ambiguity in option and property behavior
tags: tsdoc, defaultValue, options, configuration
---

## Document Defaults with `@defaultValue`

Use `@defaultValue` to document meaningful default behavior.

**Use this when:** options/properties have user-visible defaults.  
**Avoid this when:** defaults are unstable, implicit, or undocumented in implementation.

**Incorrect (default hidden from docs):**

```ts
/**
 * Maximum retry attempts.
 */
export const DEFAULT_RETRY_ATTEMPTS = 3;
```

**Correct (explicit default):**

```ts
/**
 * Maximum retry attempts.
 * @defaultValue 3
 */
export const DEFAULT_RETRY_ATTEMPTS = 3;
```
