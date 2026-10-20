# TSDoc and JSDoc Best Practices

**Version 1.0.0**  
Custom Authoring Guide  
February 2026

> **Note:**  
> This document is designed for agents and LLMs writing or reviewing TypeScript
> and JavaScript documentation comments using TSDoc and JSDoc. It mirrors a
> rule-driven format where each rule has clear "use" and "avoid" guidance with
> incorrect and correct examples.

---

## Abstract

Comprehensive TSDoc and JSDoc authoring guide for automated documentation generation and review. Contains focused rules across core contract tags, linking/reuse tags, package/internal docs, policy tags, and JavaScript-focused docstring patterns. Each rule explains when to use the tag, when not to use it, and includes concrete incorrect/correct examples.

## Read Order (Context-Safe)

Before using this catalog, route through one focused index:

- `indexes/tsdoc-index.md`
- `indexes/jsdoc-authoring-index.md`
- `indexes/jsdoc-consistency-index.md`

This file is a reference catalog. Load only the relevant subsection after choosing an index.

---

## Rule Index

### 1. Core API Contract Rules

1.1 [Write Clear Summary Sentences](#11-write-clear-summary-sentences)  
1.2 [Use `@remarks` for Long-Form Context](#12-use-remarks-for-long-form-context)  
1.3 [Document Parameters with `@param`](#13-document-parameters-with-param)  
1.4 [Document Generics with `@typeParam`](#14-document-generics-with-typeparam)  
1.5 [Document Return Semantics with `@returns`](#15-document-return-semantics-with-returns)  
1.6 [Document Expected Failures with `@throws`](#16-document-expected-failures-with-throws)  
1.7 [Use `@example` for Non-Obvious Usage](#17-use-example-for-non-obvious-usage)  
1.8 [Use `@deprecated` with Migration Guidance](#18-use-deprecated-with-migration-guidance)

### 2. Cross-Reference and Reuse Rules

2.1 [Prefer `{@link ...}` for Symbol References](#21-prefer-link--for-symbol-references)  
2.2 [Use `@see` for Related APIs](#22-use-see-for-related-apis)  
2.3 [Use `@inheritDoc` Only for Equivalent Contracts](#23-use-inheritdoc-only-for-equivalent-contracts)  
2.4 [Use `{@label ...}` Only for Structured References](#24-use-label--only-for-structured-references)

### 3. Package and Internal Notes

3.1 [Use `@packageDocumentation` for Entrypoint Docs](#31-use-packagedocumentation-for-entrypoint-docs)  
3.2 [Use `@privateRemarks` for Maintainer-Only Notes](#32-use-privateremarks-for-maintainer-only-notes)  
3.3 [Document Defaults with `@defaultValue`](#33-document-defaults-with-defaultvalue)

### 4. Stability and Modifier Policy

4.1 [Apply Release Tags Consistently](#41-apply-release-tags-consistently)  
4.2 [Use Modifier Tags Only When Semantically True](#42-use-modifier-tags-only-when-semantically-true)  
4.3 [Do Not Mix JSDoc Type Syntax into TSDoc](#43-do-not-mix-jsdoc-type-syntax-into-tsdoc)

### 5. JSDoc Rules (JavaScript)

5.1 [Write JSDoc Summaries with Intent](#51-write-jsdoc-summaries-with-intent)  
5.2 [Document Parameters with JSDoc Type Expressions](#52-document-parameters-with-jsdoc-type-expressions)  
5.3 [Use Optional and Default Parameter Strings Correctly](#53-use-optional-and-default-parameter-strings-correctly)  
5.4 [Use Nested Property Namepaths for Object Inputs](#54-use-nested-property-namepaths-for-object-inputs)  
5.5 [Document Return Value Semantics with `@returns`](#55-document-return-value-semantics-with-returns)  
5.6 [Document Error Contracts with `@throws`](#56-document-error-contracts-with-throws)  
5.7 [Add Practical `@example` Snippets](#57-add-practical-example-snippets)  
5.8 [Define Reusable Shapes with `@typedef` and `@property`](#58-define-reusable-shapes-with-typedef-and-property)  
5.9 [Document Async Behavior with `@async`](#59-document-async-behavior-with-async)  
5.10 [Document Generator Output with `@yields`](#510-document-generator-output-with-yields)  
5.11 [Document Constructors and Classes Clearly](#511-document-constructors-and-classes-clearly)  
5.12 [Use `@module` for Module-Level Docs](#512-use-module-for-module-level-docs)  
5.13 [Validate Access Tags with `check-access`](#513-validate-access-tags-with-check-access)  
5.14 [Restrict `@implements` to Classes or Constructors](#514-restrict-implements-to-classes-or-constructors)

---

## 1. Core API Contract Rules

### 1.1 Write Clear Summary Sentences

See: `rules/tsdoc/core/tsdoc-summary.md`

### 1.2 Use `@remarks` for Long-Form Context

See: `rules/tsdoc/core/tsdoc-remarks.md`

### 1.3 Document Parameters with `@param`

See: `rules/tsdoc/core/tsdoc-param.md`

### 1.4 Document Generics with `@typeParam`

See: `rules/tsdoc/core/tsdoc-typeparam.md`

### 1.5 Document Return Semantics with `@returns`

See: `rules/tsdoc/core/tsdoc-returns.md`

### 1.6 Document Expected Failures with `@throws`

See: `rules/tsdoc/core/tsdoc-throws.md`

### 1.7 Use `@example` for Non-Obvious Usage

See: `rules/tsdoc/core/tsdoc-example.md`

### 1.8 Use `@deprecated` with Migration Guidance

See: `rules/tsdoc/core/tsdoc-deprecated.md`

## 2. Cross-Reference and Reuse Rules

### 2.1 Prefer `{@link ...}` for Symbol References

See: `rules/tsdoc/crossref/tsdoc-link.md`

### 2.2 Use `@see` for Related APIs

See: `rules/tsdoc/crossref/tsdoc-see.md`

### 2.3 Use `@inheritDoc` Only for Equivalent Contracts

See: `rules/tsdoc/crossref/tsdoc-inheritdoc.md`

### 2.4 Use `{@label ...}` Only for Structured References

See: `rules/tsdoc/crossref/tsdoc-label.md`

## 3. Package and Internal Notes

### 3.1 Use `@packageDocumentation` for Entrypoint Docs

See: `rules/tsdoc/policy/tsdoc-package-documentation.md`

### 3.2 Use `@privateRemarks` for Maintainer-Only Notes

See: `rules/tsdoc/policy/tsdoc-private-remarks.md`

### 3.3 Document Defaults with `@defaultValue`

See: `rules/tsdoc/policy/tsdoc-default-value.md`

## 4. Stability and Modifier Policy

### 4.1 Apply Release Tags Consistently

See: `rules/tsdoc/policy/tsdoc-release-tags.md`

### 4.2 Use Modifier Tags Only When Semantically True

See: `rules/tsdoc/policy/tsdoc-modifier-tags.md`

### 4.3 Do Not Mix JSDoc Type Syntax into TSDoc

See: `rules/tsdoc/policy/tsdoc-no-jsdoc-braces.md`

## 5. JSDoc Rules (JavaScript)

These rules are part of the default documentation standard and should be followed even without an active linter.

### 5.1 Write JSDoc Summaries with Intent

See: `rules/jsdoc/core/jsdoc-summary.md`

### 5.2 Document Parameters with JSDoc Type Expressions

See: `rules/jsdoc/core/jsdoc-param.md`

### 5.3 Use Optional and Default Parameter Strings Correctly

See: `rules/jsdoc/core/jsdoc-optional-default.md`

### 5.4 Use Nested Property Namepaths for Object Inputs

See: `rules/jsdoc/core/jsdoc-property-namepaths.md`

### 5.5 Document Return Value Semantics with `@returns`

See: `rules/jsdoc/core/jsdoc-returns.md`

### 5.6 Document Error Contracts with `@throws`

See: `rules/jsdoc/core/jsdoc-throws.md`

### 5.7 Add Practical `@example` Snippets

See: `rules/jsdoc/core/jsdoc-example.md`

### 5.8 Define Reusable Shapes with `@typedef` and `@property`

See: `rules/jsdoc/advanced/jsdoc-typedef-property.md`

### 5.9 Document Async Behavior with `@async`

See: `rules/jsdoc/advanced/jsdoc-async.md`

### 5.10 Document Generator Output with `@yields`

See: `rules/jsdoc/advanced/jsdoc-yields.md`

### 5.11 Document Constructors and Classes Clearly

See: `rules/jsdoc/advanced/jsdoc-class-constructor.md`

### 5.12 Use `@module` for Module-Level Docs

See: `rules/jsdoc/advanced/jsdoc-module.md`

### 5.13 Validate Access Tags with `check-access`

See: `rules/jsdoc/core/jsdoc-check-access.md`

### 5.14 Restrict `@implements` to Classes or Constructors

See: `rules/jsdoc/advanced/jsdoc-implements-on-classes.md`

---

## References

1. [https://tsdoc.org](https://tsdoc.org)
2. [https://github.com/microsoft/tsdoc](https://github.com/microsoft/tsdoc)
3. [https://jsdoc.app](https://jsdoc.app)
