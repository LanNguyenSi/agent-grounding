---
type: reference
title: Example drifted doc
description: fixture doc engineered to trigger every citations-resolve rule subtype plus a base citations-resolve warning and a non-citation notice. Only `src/fixture-source-2.ts` is declared under `sources:`, on purpose, so `sources-fresh` reports exactly the one untracked-file notice this fixture wants and nothing else.
tags: [example]
timestamp: 2026-08-31T00:00:00Z
sources:
  - scripts/fixtures/okf-selectors/src/fixture-source-2.ts
---

# Example drifted

Base citations-resolve drift, target file does not exist (`scripts/fixtures/okf-selectors/src/nope.ts:1-2#"nope"`).

No anchor at all on a full citation (`scripts/fixtures/okf-selectors/src/example.ts:5-7`).

Anchor text present but not on the LAST line of the range (`scripts/fixtures/okf-selectors/src/example.ts:1-3#"export function alpha"`).

Anchor text matches more than one line inside the range (`scripts/fixtures/okf-selectors/src/example.ts:5-11#"return"`).

Test file citation range starts mid-body and straddles into the sibling block (`scripts/fixtures/okf-selectors/src/example.test.ts:4-8#"y = 2;"`).

Ambiguous bare filename citation, matches two files (`shared.ts:1#"export const A = 1;"`).

Untracked source, staleness not assessable (`scripts/fixtures/okf-selectors/src/fixture-source-2.ts:1#"export const untracked = true;"`).
