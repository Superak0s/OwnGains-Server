---
title: Write Clear Summary Sentences
impact: HIGH
impactDescription: improves API discoverability and comprehension
tags: tsdoc, summary, readability, api-docs
---

## Write Clear Summary Sentences

Write a short summary that explains behavior and intent in plain language.

**Use this when:** every documented symbol.  
**Avoid this when:** copying symbol names or implementation trivia.

**Incorrect (name restatement, no meaning):**

```ts
/**
 * Gets user.
 */
export function getUser(id: string): Promise<User> {}
```

**Correct (behavior and outcome):**

```ts
/**
 * Fetches a user by ID from the primary data source.
 */
export function getUser(id: string): Promise<User> {}
```
