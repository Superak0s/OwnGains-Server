---
title: Document Constructors and Classes Clearly
impact: HIGH
impactDescription: improves class API onboarding and usage clarity
tags: jsdoc, class, constructor, oop
---

## Document Constructors and Classes Clearly

Document constructor arguments and class purpose clearly.

**Use this when:** documenting class-based JavaScript APIs.  
**Avoid this when:** constructor parameters are undocumented.

**Incorrect (class intent unclear):**

```js
/**
 * @constructor
 */
function Book(title, author) {}
```

**Correct (constructor contract documented):**

```js
/**
 * Represents a book in the catalog.
 * @constructor
 * @param {string} title - Book title.
 * @param {string} author - Book author.
 */
function Book(title, author) {}
```
