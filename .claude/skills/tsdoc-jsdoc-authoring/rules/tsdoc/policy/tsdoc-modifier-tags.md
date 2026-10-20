---
title: Use Modifier Tags Only When Semantically True
impact: HIGH
impactDescription: prevents misleading API semantics in generated docs
tags: tsdoc, modifier-tags, readonly, override, virtual, sealed, decorator, eventProperty
---

## Use Modifier Tags Only When Semantically True

Use modifier tags only when they match real API semantics.

Common modifier tags: `@readonly`, `@override`, `@virtual`, `@sealed`, `@decorator`, `@eventProperty`.

**Use this when:** code behavior and design contract actually match the tag.  
**Avoid this when:** tags are decorative or used for emphasis.

**Incorrect (tag conflicts with implementation):**

```ts
/**
 * Tracks current request count.
 * @readonly
 */
export let requestCount = 0;
```

**Correct (tag matches behavior):**

```ts
/**
 * Current build version.
 * @readonly
 */
export const BUILD_VERSION = "1.0.0";
```
