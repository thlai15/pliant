import { test, expect } from '@playwright/test'
import * as path from 'path'
import { PlanParser } from '@parser/PlanParser'
import { Step } from '@types-local/index'

const SHOPPING_CART_PLAN = path.resolve(__dirname, '../../fixtures/plans/shopping-cart.md')

const parser = new PlanParser()

function findStep(steps: Step[], number: number): Step | undefined {
  return steps.find(s => s.number === number)
}

// ─── Full-plan integration tests (uses plans/shopping-cart.md) ────────────────

test('parses shopping-cart.md — full snapshot', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  expect(JSON.stringify(plan, null, 2)).toMatchSnapshot()
})

test('extracts correct title', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  expect(plan.title).toBe('Shopping Cart Validation — Cross-Retailer Test Plan')
})

test('extracts one scenario', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  expect(plan.scenarios).toHaveLength(1)
})

test('extracts 13 steps', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const scenario = plan.scenarios[0]
  expect(scenario).toBeDefined()
  if (scenario === undefined) return
  expect(scenario.steps).toHaveLength(13)
})

test('step 3 has two expects', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const step = findStep(plan.scenarios[0]?.steps ?? [], 3)
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.expects).toHaveLength(2)
})

test('step 9 has rules block with id subtotal_validation', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const step = findStep(plan.scenarios[0]?.steps ?? [], 9)
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.rules).not.toBeNull()
  if (step.rules === null) return
  expect(step.rules.id).toBe('subtotal_validation')
  expect(step.rules.formula).toBe('subtotal == item_1_price + item_2_price')
  expect(step.rules.tolerance).toBe(0.01)
  expect(step.rules.captures).toHaveLength(3)
})

test('step 13 has stop: true', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const step = findStep(plan.scenarios[0]?.steps ?? [], 13)
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.stop).toBe(true)
})

test('step 10 has after: [9]', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const step = findStep(plan.scenarios[0]?.steps ?? [], 10)
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.after).toEqual(['9'])
})

test('steps 11, 12, 13 each have after: [10]', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const steps = plan.scenarios[0]?.steps ?? []
  for (const num of [11, 12, 13]) {
    const step = findStep(steps, num)
    expect(step).toBeDefined()
    if (step === undefined) continue
    expect(step.after).toEqual(['10'])
  }
})

test('steps without after: have empty after array', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const step = findStep(plan.scenarios[0]?.steps ?? [], 1)
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.after).toEqual([])
})

test('steps without stop: have stop false', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const step = findStep(plan.scenarios[0]?.steps ?? [], 1)
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.stop).toBe(false)
})

test('steps without rules have rules null', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const step = findStep(plan.scenarios[0]?.steps ?? [], 1)
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.rules).toBeNull()
})

test('steps without element hint have element null', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const step = findStep(plan.scenarios[0]?.steps ?? [], 1)
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.element).toBeNull()
})

test('step ids are string representations of their numbers', async () => {
  const plan = await parser.parseFile(SHOPPING_CART_PLAN)
  const steps = plan.scenarios[0]?.steps ?? []
  for (const step of steps) {
    expect(step.id).toBe(String(step.number))
  }
})

// ─── Inline fixture tests ─────────────────────────────────────────────────────

test('single step with no expects', () => {
  const plan = parser.parse(`
# My Plan

### Scenario 1

**Steps:**

1. Do something
`)
  const scenario = plan.scenarios[0]
  expect(scenario).toBeDefined()
  if (scenario === undefined) return
  expect(scenario.steps).toHaveLength(1)
  const step = scenario.steps[0]
  expect(step).toBeDefined()
  if (step === undefined) return
  expect(step.expects).toHaveLength(0)
  expect(step.rules).toBeNull()
  expect(step.stop).toBe(false)
  expect(step.after).toEqual([])
})

test('multiple scenarios', () => {
  const plan = parser.parse(`
# Multi-scenario Plan

### Scenario 1

**Steps:**

1. Step A

### Scenario 2

**Steps:**

1. Step B
   - expect: Something is visible
`)
  expect(plan.scenarios).toHaveLength(2)
  expect(plan.scenarios[0]?.title).toBe('Scenario 1')
  expect(plan.scenarios[1]?.title).toBe('Scenario 2')
  expect(plan.scenarios[1]?.steps[0]?.expects).toHaveLength(1)
})

test('unknown sections are ignored and do not throw', () => {
  const plan = parser.parse(`
# Plan

## Prerequisites

Requires a live test environment.

## Seeds

Some seed data here.

### Scenario 1

**Steps:**

1. Navigate to home
   - expect: Home is visible
`)
  expect(plan.scenarios).toHaveLength(1)
  const step = plan.scenarios[0]?.steps[0]
  expect(step?.expects).toHaveLength(1)
})

test('malformed step number (not pure digits) is ignored gracefully', () => {
  const plan = parser.parse(`
# Plan

### Scenario 1

**Steps:**

1a. This is malformed
2. This is valid
   - expect: Valid step
`)
  const scenario = plan.scenarios[0]
  expect(scenario).toBeDefined()
  if (scenario === undefined) return
  // Only the valid step is parsed; the malformed line is skipped
  expect(scenario.steps).toHaveLength(1)
  expect(scenario.steps[0]?.number).toBe(2)
})

test('empty plan returns empty scenarios', () => {
  const plan = parser.parse('')
  expect(plan.title).toBe('')
  expect(plan.scenarios).toHaveLength(0)
})

test('parses element hint from step', () => {
  const plan = parser.parse(`
# Plan

### Scenario 1

**Steps:**

1. Click "Continue" to proceed past billing
   - after: [5]
   - expect: Next page is shown
   - element: {"label":"Continue","container":["Billing Form","Checkout"],"neighbors":["Back"],"tag":"input[submit]"}
`)
  const step = plan.scenarios[0]?.steps[0]
  expect(step?.element).not.toBeNull()
  expect(step?.element?.label).toBe('Continue')
  expect(step?.element?.container).toEqual(['Billing Form', 'Checkout'])
  expect(step?.element?.neighbors).toEqual(['Back'])
  expect(step?.element?.tag).toBe('input[submit]')
})

test('ignores malformed element hint', () => {
  const plan = parser.parse(`
# Plan

### Scenario 1

**Steps:**

1. Click something
   - element: {not valid json
`)
  const step = plan.scenarios[0]?.steps[0]
  expect(step?.element).toBeNull()
})

test('plan with multiple expects on one step', () => {
  const plan = parser.parse(`
# Plan

### Scenario 1

**Steps:**

1. Search for a product
   - expect: Results page is shown
   - expect: At least one result is visible
   - expect: Search term is reflected in the heading
`)
  const step = plan.scenarios[0]?.steps[0]
  expect(step?.expects).toHaveLength(3)
})

test('title is empty string when no h1 heading', () => {
  const plan = parser.parse(`
### Scenario 1

**Steps:**

1. Step one
`)
  expect(plan.title).toBe('')
})
