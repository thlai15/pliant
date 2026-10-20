import { test, expect } from '@playwright/test'
import { RulesParser } from '@parser/RulesParser'
import { PlanParseError } from '@types-local/errors'

const parser = new RulesParser()

const SUBTOTAL_RULES_YAML = `\
id: subtotal_validation
formula: subtotal == item_1_price + item_2_price
tolerance: 0.01
capture:
  - name: item_1_price
    semantic: "unit price or each price of the first item in the cart"
    region: main
  - name: item_2_price
    semantic: "unit price or each price of the second item in the cart"
    region: main
  - name: subtotal
    semantic: "subtotal or estimated total before tax and shipping"
    region: main`

test('parses subtotal_validation rules block — snapshot', () => {
  const rule = parser.parse(SUBTOTAL_RULES_YAML)
  expect(JSON.stringify(rule, null, 2)).toMatchSnapshot()
})

test('id is correct', () => {
  const rule = parser.parse(SUBTOTAL_RULES_YAML)
  expect(rule.id).toBe('subtotal_validation')
})

test('formula is correct', () => {
  const rule = parser.parse(SUBTOTAL_RULES_YAML)
  expect(rule.formula).toBe('subtotal == item_1_price + item_2_price')
})

test('tolerance is parsed from YAML', () => {
  const rule = parser.parse(SUBTOTAL_RULES_YAML)
  expect(rule.tolerance).toBe(0.01)
})

test('three captures are extracted', () => {
  const rule = parser.parse(SUBTOTAL_RULES_YAML)
  expect(rule.captures).toHaveLength(3)
})

test('capture names match formula variables', () => {
  const rule = parser.parse(SUBTOTAL_RULES_YAML)
  const names = rule.captures.map(c => c.name)
  expect(names).toEqual(['item_1_price', 'item_2_price', 'subtotal'])
})

test('capture regions are all main', () => {
  const rule = parser.parse(SUBTOTAL_RULES_YAML)
  for (const capture of rule.captures) {
    expect(capture.region).toBe('main')
  }
})

test('tolerance defaults to 0.0 when absent', () => {
  const rule = parser.parse(`
id: price_check
formula: price == 9.99
capture:
  - name: price
    semantic: "displayed price"
    region: main
`)
  expect(rule.tolerance).toBe(0.0)
})

test('throws PlanParseError on invalid YAML', () => {
  expect(() => parser.parse('id: {\nbroken yaml: [')).toThrow(PlanParseError)
})

test('throws PlanParseError when id is missing', () => {
  expect(() => parser.parse(`
formula: a == b
capture:
  - name: a
    semantic: "a"
    region: main
`)).toThrow(PlanParseError)
})

test('throws PlanParseError when formula is missing', () => {
  expect(() => parser.parse(`
id: test
capture:
  - name: a
    semantic: "a"
    region: main
`)).toThrow(PlanParseError)
})

test('throws PlanParseError when capture entry has invalid region', () => {
  expect(() => parser.parse(`
id: test
formula: a == b
capture:
  - name: a
    semantic: "a"
    region: invalid_region
`)).toThrow(PlanParseError)
})

test('throws PlanParseError when capture entry is not an object', () => {
  expect(() => parser.parse(`
id: test
formula: a == b
capture:
  - just a string
`)).toThrow(PlanParseError)
})

test('accepts all valid region values', () => {
  const regions = ['main', 'nav', 'aside', 'header', 'footer', 'dialog', 'unknown'] as const
  for (const region of regions) {
    const rule = parser.parse(`
id: test
formula: a == 1
capture:
  - name: a
    semantic: "something"
    region: ${region}
`)
    const capture = rule.captures[0]
    expect(capture).toBeDefined()
    if (capture === undefined) continue
    expect(capture.region).toBe(region)
  }
})
