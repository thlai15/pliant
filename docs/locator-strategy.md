# Locator Strategy

## Why Not Playwright's Locator APIs

Playwright's built-in locators (`getByRole`, `getByLabel`, `getByText`, etc.) work from the
accessibility tree and visible DOM attributes. They miss a significant class of interactive
elements found on retail sites: `div`, `span`, and `li` elements with click event listeners bound
programmatically by React, Vue, or vanilla JS. A product card with an `onClick` handler is not a
`button` or `link` — Playwright's APIs won't surface it as interactive.

Pliant uses `page.evaluate()` to inject and run JavaScript in the browser context, giving
access to the full DOM including runtime-bound event listeners.

## Listener Tracker Injection

Before the first navigation, `PlanRunner` injects a tracker script that wraps the page's native
`addEventListener`. This must happen before the page's own JavaScript runs.

```typescript
await page.addInitScript(() => {
  const trackedListeners = new WeakMap<Element, string[]>();

  const originalAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (this instanceof Element) {
      const existing = trackedListeners.get(this) ?? [];
      if (!existing.includes(type)) {
        trackedListeners.set(this, [...existing, type]);
      }
    }
    return originalAdd.call(this, type, listener, options);
  };

  // Expose for extraction script
  (window as any).__pliant_listeners = trackedListeners;
});
```

This runs in the page context on every navigation automatically via `addInitScript`.

## Element Extraction

`ElementExtractor.extract(page)` calls `page.evaluate()` with the extraction script.
The script returns a plain JSON-serialisable array — no DOM references cross the boundary.

### What Gets Extracted

An element is included if any of the following are true:

- Its tag is `button`, `a`, `input`, `select`, `textarea`
- It has a tracked event listener for `click`, `mousedown`, `keydown`, `keypress`, or `change`
- It has an inline handler attribute: `onclick`, `onmousedown`, `onkeydown`
- It has `role="button"`, `role="link"`, `role="checkbox"`, `role="menuitem"` etc.
- It has `tabindex` >= 0 (explicitly keyboard-focusable)

Excluded regardless: elements with `display:none`, `visibility:hidden`, zero dimensions, or
`aria-hidden="true"`.

### ExtractedElement Type

```typescript
interface ExtractedElement {
  index: number           // position in the returned array, used by MatchResult
  tag: string             // lowercase tag name: "button", "div", "a", etc.
  role: string | null     // explicit ARIA role or null
  label: string | null    // aria-label > associated label text > placeholder > title
  text: string            // trimmed visible text content (max 100 chars)
  path: string            // "Ancestor2 > Ancestor1 > element label/text" (3 levels max)
  events: string[]        // ["click", "mousedown"] from tracker + inline handlers
  region: Region          // "main" | "nav" | "aside" | "header" | "footer" | "unknown"
  boundingBox: {
    x: number
    y: number
    width: number
    height: number
  }
  relativePosition: RelativePosition  // "top" | "middle" | "bottom", "left" | "center" | "right"
  siblings: string[]      // text of immediately adjacent elements (max 3, max 50 chars each)
  selector: string        // generated selector for fast-path replay
  inputType: string | null // for input elements: "text" | "email" | "password" | "tel" | etc.
}

type Region = 'main' | 'nav' | 'aside' | 'header' | 'footer' | 'dialog' | 'unknown'
type RelativePosition = 'top-left' | 'top-center' | 'top-right'
                      | 'mid-left' | 'mid-center' | 'mid-right'
                      | 'bot-left' | 'bot-center' | 'bot-right'
```

### Path Construction

The path is the most important disambiguation signal. The extraction script walks up the DOM from
the target element, collecting up to 3 ancestor labels, then concatenates them:

```
"Search Results > Clorox Toilet Bowl Cleaner > Add to cart"
 └─ section[aria-label]  └─ article[aria-label]   └─ button text
```

Ancestor label resolution priority (first non-empty wins):
1. `aria-label` attribute
2. `aria-labelledby` referenced element text
3. `data-testid` (cleaned: replace `-` and `_` with spaces, title-case)
4. Heading text (`h1`–`h3`) within the ancestor
5. First non-empty text node directly inside the ancestor (max 40 chars)

If an ancestor yields no useful label, it is skipped and the next ancestor up is tried. The path
always has the element's own label/text as the last segment.

### Selector Generation

The generated selector is used as a fast-path hint on subsequent runs. Generation priority:

1. If element has a unique `data-testid`: `[data-testid="value"]`
2. If element has a unique `id`: `#id`
3. If element has a unique `aria-label`: `[aria-label="value"]`
4. Otherwise: a short nth-child path from the nearest landmark ancestor

"Unique" means exactly one element on the page matches. The extraction script verifies this before
using the selector.

## Semantic Matching

`SemanticMatcher.match(intent, candidates)` sends the intent and candidate list to the LLM.

### Input to LLM

```
You are finding the best matching interactive element for a test step.

Step intent: "Add the first Clorox toilet bowl cleaner result to the cart"

Candidates (index | path | label | tag | events | region):
0 | Nav > Cart | Cart (3 items) | button | [click] | nav
1 | Search Results > Clorox ToiletWand Disposable System > Add to cart | Add to cart | button | [click] | main
2 | Search Results > Clorox Toilet Bowl Cleaner with Bleach > Add to cart | Add to cart | button | [click] | main
3 | Search Results > Clorox Toilet Bowl Cleaner with Bleach > Save for later | Save for later | button | [click] | main
...

Scoring rules:
- Element text/label match to step intent is the primary signal
- Product context in the path (ancestors) adds supporting evidence; each ancestor level
  has half the weight of the element itself
- Prefer elements in the "main" region for content interactions
- Prefer elements in "nav" for navigation actions
- The step says "first result" — prefer candidates that appear earlier in the list
  (lower index typically means higher on page)

Return JSON only:
{
  "elementIndex": <number>,
  "confidence": <0.0-1.0>,
  "reasoning": "<one sentence>",
  "fillValue": "<string or null>",
  "alternativeIndices": [<number>, ...]
}
```

### Confidence Thresholds

| Threshold | Meaning | Action |
|---|---|---|
| >= 0.75 | Strong match | Interact; log as `DIRECT` |
| 0.40–0.74 | Plausible match | Interact; log as `HEALED` (healing event recorded) |
| < 0.40 | No reliable match | Trigger Tier 2 escape valve |

## Product Search Matching

For steps that involve finding a specific product in search results (not just a UI element), the
same semantic matching approach applies but the candidates are product cards rather than
interactive elements.

The extraction for this context returns product cards with:
- Product title text
- Price text
- Position on page (for "first result" resolution)

The step intent includes the full product name: `"Clorox Disinfecting Bleach-Free All Purpose
Cleaner, Crisp Lemon, 32 fl oz"`. The LLM scores each product card against the intent, applying
the same path-weighted scoring. The closest matching product's "Add to cart" button is the
resolved interaction target.

This is how the framework finds the right variant even if it is not the top search result —
the LLM reads all visible product cards and picks the closest semantic match.

## Caching

Within a single run, resolved selectors are cached by step ID:

```typescript
type SelectorCache = Map<string, string>  // stepId → CSS selector
```

On subsequent steps in the same run, the fast path is attempted using the cached selector before
falling back to extraction + matching. This reduces LLM calls on long flows.

The cache is not persisted across runs. Cross-run fast-path reuse is a v2 feature.
