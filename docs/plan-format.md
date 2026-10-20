# Plan Format

## Base Format: Playwright Planner Markdown

Pliant reads test plans in Playwright Planner Markdown format. This is the format produced by
the `playwright-test-planner` agent and is also valid as a manually authored document.

Pliant is a lenient parser — sections it does not recognise (prerequisites, seeds, executive
summaries) are ignored. Only the following are parsed:

- Scenario headings (`###`)
- Step lines (numbered, inside `**Steps:**` section)
- Expect lines (`- expect:` indented under a step)
- Business rules blocks (` ```rules ` fenced blocks immediately after the last expect of a step)
- Stop markers (`- stop: true` on a step)

## Canonical Example

```markdown
# Shopping Cart Validation — Cross-Retailer Test Plan

## Overview

Validates a two-item shopping cart flow including subtotal calculation.
Ends before order submission. Target sites: public demo stores such as demowebshop.tricentis.com.

## Test Scenarios

### 1. Add Items to Cart and Validate Subtotal

**Steps:**

1. Navigate to the retailer home page
   - expect: Home page is displayed and the site is accessible

2. Search for "Clorox Disinfecting Bleach-Free All Purpose Cleaner, Crisp Lemon, 32 fl oz"
   - expect: Search results are displayed
   - expect: At least one Clorox lemon all purpose cleaner product is visible

3. Add the closest matching Clorox lemon cleaner result to the cart
   - expect: Item is added to cart
   - expect: Cart item count increases

4. Search for "Clorox Ocean Mist Toilet Bowl Cleaner Clinging Bleach Gel 48 fl oz"
   - expect: Search results are displayed
   - expect: At least one Clorox toilet bowl cleaner product is visible

5. Add the closest matching Clorox toilet bowl cleaner result to the cart
   - expect: Item is added to cart
   - expect: Cart item count increases

6. Navigate to the cart
   - expect: Cart page is displayed
   - expect: Two items are present in the cart

7. Validate the cart subtotal
   - expect: Subtotal is displayed
   - expect: Subtotal equals the sum of the two individual item prices

   ```rules
   id: subtotal_validation
   formula: subtotal == item_1_price + item_2_price
   tolerance: 0.01
   capture:
     - name: item_1_price
       semantic: "unit price of the first item in the cart"
       region: main
     - name: item_2_price
       semantic: "unit price of the second item in the cart"
       region: main
     - name: subtotal
       semantic: "order subtotal or cart subtotal"
       region: main
   ```

8. Proceed to checkout
   - expect: Checkout page or guest checkout option is displayed

9. Enter contact information
   - expect: Name and email fields accept input

10. Enter shipping address
    - expect: Address fields accept input

11. Enter payment information
    - expect: Payment fields accept input
    - stop: true
```

## Step Intent Parsing

The step number and text form the intent. The intent is passed as-is to `SemanticMatcher`.
It should be written in natural imperative language.

Good:
```
3. Add the closest matching Clorox lemon cleaner result to the cart
```

Bad (too vague):
```
3. Add item
```

Bad (too mechanical — the runner handles this):
```
3. Click the "Add to Cart" button on the Clorox Disinfecting product card
```

## Expect Lines

`- expect:` lines are structural assertions evaluated after the step's interaction completes.
They are natural language. The assertion evaluator sends them to the LLM along with the live page
state.

Multiple expects are all evaluated. If any fails, the step is marked failed. All results are
recorded in the report.

## Business Rules Block

The `rules` block is a YAML fenced code block with the identifier `rules`. It must appear
immediately after the last `- expect:` line of the step it belongs to, before the next step.

### Schema

```yaml
id: string                    # unique identifier for this rule, used in the report
formula: string               # expression to evaluate; must be a simple equality or comparison
tolerance: number             # optional, default 0.0; absolute tolerance for numeric comparison
capture:
  - name: string              # variable name used in the formula
    semantic: string          # natural language description sent to SemanticMatcher
    region: Region            # "main" | "nav" | "aside" | "header" | "footer" | "dialog"
```

### Formula Language

Formulas are simple arithmetic expressions evaluated by a safe parser (not `eval()`). Supported:

- Variables: names matching a `capture.name`
- Operators: `+`, `-`, `*`, `/`, `==`, `!=`, `<`, `>`, `<=`, `>=`
- Parentheses
- Numeric literals

```yaml
# Valid
formula: subtotal == item_1_price + item_2_price
formula: total == (subtotal * 1.0875)   # with tax
formula: discounted == original * 0.80

# Invalid — not supported
formula: subtotal == items.reduce((a, b) => a + b, 0)
```

For the discount formula use case, if the discount percentage is known it must be written as a
literal in the formula. If it is not known in advance, the capture must include the displayed
discount amount and the formula must add/subtract it explicitly.

### Value Extraction

Captured values are extracted as text from the element found by `SemanticMatcher`, then parsed:

1. Strip leading/trailing whitespace
2. Remove currency symbols (`$`, `£`, `€`, `¥`)
3. Remove thousands separators (`,`)
4. Parse as `parseFloat`
5. If `NaN`: capture fails, rule fails with `CAPTURE_PARSE_FAILED`

### Tolerance

The tolerance field handles floating-point display rounding. A tolerance of `0.01` means the
formula passes if `|lhs - rhs| <= 0.01`. Default is `0.00` (exact match).

Always use `tolerance: 0.01` for currency comparisons.

## Stop Marker

`- stop: true` on a step tells the runner to halt execution after verifying that step's expects
are met. The run is marked as complete and all subsequent steps are recorded as `SKIPPED`.

Used for the payment step to avoid submitting real orders.

## Step Dependencies (Optional)

Steps can declare that they must not be scheduled before certain other steps complete:

```markdown
9. Enter contact information
   - after: [8]
   - expect: Name and email fields accept input
```

The `- after: [stepId, ...]` line is parsed and enforced by `StepScheduler`. Steps 9, 10, 11
should all declare `- after: [8]` to prevent them from being selected before checkout begins.

Without `after`, the scheduler may select any pending step based on page context. For most steps
this is correct. Use `after` only where order genuinely matters across all retailers.

## Multiple Scenarios

A plan file can contain multiple `###` scenario headings. Each is executed as an independent
scenario. Pliant v1 executes scenarios sequentially. The report shows each scenario separately.

## Retailer-Agnostic Authoring Guidelines

1. Never reference a specific retailer's UI text in step intents or expects
2. Never hardcode prices — use the `rules` block to capture and compare
3. Write product names in full but do not assume they are the first search result
4. For form steps (contact, address, payment), keep expects at the field-presence level:
   "Address fields accept input" — not "The 'Street Address' label is visible"
5. Use `- after:` for steps that logically depend on prior steps completing
