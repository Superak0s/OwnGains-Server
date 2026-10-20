# TSDoc Deep Reference

This file is the detailed TSDoc authoring spec for this skill. Use it when generating or reviewing TypeScript API documentation comments.

## 1) TSDoc Comment Structure

Standard order for a high-quality TSDoc block:

1. Summary sentence(s)
2. Optional `@remarks` (long-form details)
3. Parameter docs (`@typeParam`, then `@param`)
4. Return docs (`@returns`) when applicable
5. Error docs (`@throws`) when behavior depends on error handling
6. Optional `@example`
7. Optional policy tags (`@deprecated`, release tags, modifiers)
8. Optional `@see`

Template:

````ts
/**
 * One-sentence summary in plain language.
 *
 * @remarks
 * Long-form context, constraints, caveats, and behavior notes.
 *
 * @typeParam T - Meaning of generic type.
 * @param input - What this value represents and constraints.
 * @returns What is returned and key semantics.
 * @throws ErrorType when and why this fails.
 * @example
 * ```ts
 * const value = fn(input)
 * ```
 * @deprecated Use `newFn()` instead.
 */
````

## 2) TSDoc Tag Kinds (Syntax Types)

TSDoc tags are grouped into three syntax kinds:

- `InlineTag`: used inside prose (example: `{@link Foo}`)
- `BlockTag`: starts a new section block (example: `@remarks`)
- `ModifierTag`: marker-style tags with no body (example: `@public`)

Use the right syntax kind for the right purpose. Do not write modifier tags as prose blocks.

## 3) Routing to Focused Rule Sets

Use focused indexes instead of loading full rule catalogs into context:

- TSDoc work: `indexes/tsdoc-index.md`
- JSDoc authoring work: `indexes/jsdoc-authoring-index.md`
- JSDoc consistency and lint-safe output: `indexes/jsdoc-consistency-index.md`

Load only the minimum rule files needed for the current edit/review task.

## 4) High-Quality TSDoc Patterns

### Document async behavior precisely

```ts
/**
 * Fetches the current profile.
 * @returns The active user profile.
 * @throws Error when the auth token is invalid.
 */
export async function getProfile(): Promise<UserProfile> {}
```

### Document generics meaningfully

```ts
/**
 * Creates a dictionary from items.
 * @typeParam T - Source item type.
 * @param items - Source collection.
 * @param getKey - Derives a stable key from each item.
 * @returns A map from key to item.
 */
export function toMap<T>(
	items: T[],
	getKey: (item: T) => string
): Map<string, T> {}
```

### Document thrown contract only

```ts
/**
 * Parses a signed payload.
 * @param token - Signed token string.
 * @returns Decoded payload.
 * @throws Error when signature validation fails.
 */
export function parseSignedToken(token: string): Payload {}
```

## 5) TSDoc Mistakes To Avoid

- Using JSDoc type braces in TSDoc `@param` lines.
- Missing `@typeParam` for public generic APIs.
- Writing verbose summaries that hide key behavior.
- Adding `@example` blocks that are stale or too long.
- Documenting implementation trivia instead of API contract.
- Tagging release level (`@alpha`, `@beta`, etc.) inconsistently across related APIs.

## 6) TSDoc Review Checklist

Use this checklist when reviewing generated comments:

- Summary accurately states what the API does.
- Every parameter has a meaningful `@param`.
- All generics have `@typeParam` when public.
- `@returns` describes semantics, not just type.
- `@throws` documents expected caller-relevant failures.
- `@remarks` is used only when needed.
- Links use `{@link ...}` where appropriate.
- Release/visibility/modifier tags match project policy.
- Comment behavior matches implementation exactly.

## 7) JSDoc Quick Appendix (Cross-Standard Projects)

Use this only for JavaScript files or JSDoc-based tooling.

### JSDoc function template

```js
/**
 * Normalizes a user profile for rendering.
 * @param {Object} input - Raw user profile.
 * @param {string} input.id - Stable identifier.
 * @param {string} [input.displayName] - Optional display name.
 * @returns {Object} Normalized profile object.
 * @throws {Error} If required fields are missing.
 */
```

### JSDoc typedef template

```js
/**
 * @typedef {Object} UserProfile
 * @property {string} id - Stable user identifier.
 * @property {string} [displayName] - Optional display name.
 * @property {boolean} active - Whether the user is active.
 */
```

### JSDoc String Syntax Cheatsheet

Use these exact JSDoc "strings" for common cases:

- Required param: `@param {string} name - Description`
- Optional param: `@param {string} [name] - Description`
- Optional with default: `@param {string} [name=John Doe] - Description`
- Object param: `@param {Object} options - Description`
- Nested object field: `@param {string} options.mode - Description`
- Array object field: `@param {string} items[].id - Description`
- Return type: `@returns {Promise<Result>} Description`
- Throws type: `@throws {Error} Description`
- Access style (pick one): `@access private` or `@private` (do not mix on one doc block)
- `@implements` placement: use only on classes/constructors (not regular functions)

### TypeScript Object Param Hover Pattern (Recommended)

For best VS Code hover and autocomplete docs on object properties, use a named type/interface and `/** ... */` on each property:

```ts
type SearchOptions = {
	/** Query string used to match results. */
	query: string;
	/** Maximum number of results to return. */
	limit?: number;
};

/**
 * @param options - Search configuration.
 */
export function search(options: SearchOptions) {}
```

## 8) JSDoc Consistency Checklist

Use this quick pass before finalizing JSDoc blocks in any project:

- Access tags: use one access style per block; valid `@access` values are `package|private|protected|public`.
- `@implements` placement: use it only on class constructors or constructor-style functions.

## 9) Sources Used For This Skill

- TSDoc: `/microsoft/tsdoc` (Context7 internal context identifier for source mapping)
- JSDoc: `/jsdoc/jsdoc.github.io` (Context7 internal context identifier for source mapping)
