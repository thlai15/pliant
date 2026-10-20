# Report Format

## Overview

Pliant produces two output artefacts per run:

1. `run.json` — machine-readable run data, written incrementally as steps complete
2. `comparison-report.html` — a self-contained HTML comparison report generated after two runs

The HTML report is the primary demo artefact.

## run.json Schema

Written to `REPORT_OUTPUT_DIR/<run-id>/run.json`.

`<run-id>` is `<site-hostname>-<ISO-timestamp>`, e.g. `demowebshop.tricentis.com-2025-06-04T14-32-00`.

```typescript
interface RunReport {
  runId: string
  site: string              // TARGET_URL hostname
  targetUrl: string
  planFile: string
  startedAt: string         // ISO 8601
  completedAt: string
  outcome: 'PASS' | 'FAIL' | 'STUCK'
  llmProvider: string       // "claude" | "ollama"
  llmModel: string
  steps: StepReport[]
}

interface StepReport {
  stepId: string            // "1", "2", ... from the plan
  stepNumber: number
  intent: string            // the step text from the plan
  outcome: StepOutcome
  locatorStrategy: 'DIRECT' | 'SEMANTIC' | 'NOT_FOUND'
  matchedElement: {
    path: string
    label: string | null
    tag: string
    selector: string
    confidence: number
    reasoning: string
  } | null
  healingEvents: HealingEvent[]
  assertions: AssertionReport[]
  businessRule: BusinessRuleReport | null
  screenshots: {
    fullPage: string        // relative path to PNG
    element: string | null  // relative path to cropped element PNG, null if not found
  }
  durationMs: number
}

type StepOutcome = 'PASS' | 'FAIL' | 'HEALED' | 'SKIPPED' | 'STUCK'

interface HealingEvent {
  type: 'SEMANTIC_FALLBACK' | 'FORWARD_ADVANCE' | 'LOW_CONFIDENCE'
  description: string
  confidence?: number
}

interface AssertionReport {
  expect: string
  pass: boolean
  reasoning: string
}

interface BusinessRuleReport {
  ruleId: string
  formula: string
  capturedValues: Record<string, number>
  evaluatedFormula: string  // formula with values substituted, e.g. "44.98 == 12.99 + 31.99"
  pass: boolean
  toleranceApplied: number
  failReason?: string
}
```

## Screenshots

Screenshots are saved as PNG files alongside `run.json`:

```
reports/
  demowebshop.tricentis.com-2025-06-04T14-32-00/
    run.json
    screenshots/
      step-01-full.png
      step-01-element.png
      step-02-full.png
      step-02-element.png
      ...
```

**Full-page screenshot**: taken after the interaction settles (`networkidle` or `domcontentloaded`).
Captures the complete page, not just the viewport.

**Element screenshot**: a crop of the full-page screenshot using the matched element's bounding box,
padded by 20px on each side. If the element was not found (`NOT_FOUND` strategy), no element
screenshot is saved.

## Comparison Report (HTML)

`HtmlReporter` reads two `run.json` files and generates `comparison-report.html` in
`REPORT_OUTPUT_DIR/`. The file is self-contained — screenshots are embedded as base64 data URIs.
No server or internet connection required to view it.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  Pliant — Run Comparison                                         │
│  Site A  vs  Site B   │  Plan: shopping-cart.md  │  Jun 4 2025      │
├─────────────────────────────────┬────────────────────────────────────┤
│  STEPS                          │  FULL PAGE COMPARISON              │
│                                 │                                    │
│  ● Step 1: Navigate to home  ✓  │  ┌─ Site A ───┐  ┌─ Site B ──┐   │
│    [site-a elem]  [site-b elem] │  │            │  │           │   │
│                                 │  │ screenshot │  │ screenshot│   │
│  ● Step 2: Search for item 1 ✓  │  │            │  │           │   │
│    [site-a elem]  [site-b elem] │  └────────────┘  └───────────┘   │
│                                 │                                    │
│  ● Step 3: Add to cart       ✓  │                                    │
│    [site-a elem]  [site-b elem] │                                    │
│    🔧 Healed (semantic match)   │                                    │
│                                 │                                    │
│  ● Step 7: Validate subtotal ✓  │                                    │
│    Formula: 44.98 == 12.99 +    │                                    │
│             31.99               │                                    │
│                                 │                                    │
│  ● Step 11: Payment info     ✓  │                                    │
│    STOPPED (stop: true)         │                                    │
└─────────────────────────────────┴────────────────────────────────────┘
```

### Left Panel: Step List

Each step entry shows:
- Step number and intent text
- Outcome badge: ✓ PASS / ✗ FAIL / 🔧 HEALED / ⏭ SKIPPED
- Two element thumbnail images side by side (site A left, site B right)
  - Each thumbnail is the cropped element screenshot
  - If element not found: grey placeholder with "Not found"
- Healing event indicator if any healing occurred on either run
- For business rule steps: the evaluated formula with substituted values

Clicking a step updates the right panel.

### Right Panel: Full Page Comparison

Shows the full-page screenshots for the selected step, side by side:
- Left: site A screenshot
- Right: site B screenshot
- A red highlight box drawn over the interacted element's bounding box on each screenshot

The highlight box is drawn using the `boundingBox` from the `matchedElement` in the run report,
overlaid as a positioned `<div>` on top of the screenshot image.

### Healing Indicator

Steps where any healing occurred show a wrench icon (🔧) and a tooltip/expandable section:

```
🔧 Healed on site B
   Strategy: SEMANTIC_FALLBACK
   Matched: "Add to bag" (confidence: 0.71)
   Reasoning: Button text differs from plan intent but serves same purpose in cart context
```

### Business Rule Display

For step 7 (subtotal validation), the left panel shows an expanded formula section:

```
✓ Subtotal Validation

Site A:
  item_1_price = $12.97
  item_2_price = $5.97
  subtotal     = $18.94
  18.94 == 12.97 + 5.97 → 18.94 == 18.94 ✓

Site B:
  item_1_price = $13.49
  item_2_price = $6.29
  subtotal     = $19.78
  19.78 == 13.49 + 6.29 → 19.78 == 19.78 ✓
```

### Summary Bar

At the top of the report:

```
Site A: 11/11 steps passed (1 healed)  |  Site B: 11/11 steps passed (2 healed)
```

## Generating the Report

```bash
# After running against both retailers:
npm run report -- \
  --run-a reports/demowebshop.tricentis.com-2025-06-04T14-32-00 \
  --run-b reports/demo.nopcommerce.com-2025-06-04T15-01-00 \
  --output reports/comparison-report.html
```

Or via the convenience script that finds the two most recent runs automatically:

```bash
npm run report:latest
```
