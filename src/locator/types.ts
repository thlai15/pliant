// ExtractedElement and all related types (Region, RelativePosition, BoundingBox,
// MatchResult, SelectorCache) live in src/types/index.ts.
//
// This file holds locator-internal constants that don't belong in the shared domain model.

// Text patterns used to detect forward-progression affordances.
// Matched case-insensitively and partially (substring match).
export const FORWARD_AFFORDANCE_KEYWORDS = [
  'next',
  'continue',
  'proceed',
  'skip',
  'submit',
  'place order',
  'review order',
  'keep shopping',
] as const
