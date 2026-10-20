import { test, expect } from '@playwright/test'
import { evaluateFormula } from '@runner/BusinessRuleEvaluator'
import { evaluateArithmetic } from '@runner/arithmetic'
import { BusinessRule } from '@types-local/index'

const rule = (formula: string, tolerance = 0.01): BusinessRule => ({
  id: 'subtotal_validation', formula, tolerance, captures: [],
})

test.describe('evaluateFormula', () => {
  test('passes when subtotal equals sum of item prices within tolerance', () => {
    const result = evaluateFormula(
      rule('subtotal == item_1_price + item_2_price'),
      { subtotal: 18.94, item_1_price: 12.97, item_2_price: 5.97 },
    )
    expect(result.pass).toBe(true)
    expect(result.evaluatedFormula).toBe('18.94 == 18.94')
  })

  test('fails when subtotal does not match beyond tolerance', () => {
    const result = evaluateFormula(
      rule('subtotal == item_1_price + item_2_price'),
      { subtotal: 19.00, item_1_price: 12.97, item_2_price: 5.97 },
    )
    expect(result.pass).toBe(false)
  })

  test('applies tolerance to >= comparisons', () => {
    expect(evaluateFormula(rule('subtotal >= item_price'), { subtotal: 9.995, item_price: 10 }).pass).toBe(true)
    expect(evaluateFormula(rule('subtotal >= item_price'), { subtotal: 9.9, item_price: 10 }).pass).toBe(false)
  })

  test('reports a missing comparison operator', () => {
    const result = evaluateFormula(rule('subtotal + 1'), { subtotal: 1 })
    expect(result.pass).toBe(false)
    expect(result.failReason).toContain('Cannot identify comparison operator')
  })

  test('reports an unknown variable as a failure, not a crash', () => {
    const result = evaluateFormula(rule('subtotal == missing'), { subtotal: 1 })
    expect(result.pass).toBe(false)
    expect(result.failReason).toContain('Unknown variable "missing"')
  })
})

test.describe('evaluateArithmetic', () => {
  test('follows operator precedence and parentheses', () => {
    expect(evaluateArithmetic('2 + 3 * 4', {})).toBe(14)
    expect(evaluateArithmetic('(2 + 3) * 4', {})).toBe(20)
    expect(evaluateArithmetic('10 / 4 - 1', {})).toBe(1.5)
  })

  test('supports unary minus, decimals and variables', () => {
    expect(evaluateArithmetic('-price + .5', { price: 2 })).toBe(-1.5)
    expect(evaluateArithmetic('qty * unit_price', { qty: 3, unit_price: 1.25 })).toBe(3.75)
  })

  test('rejects division by zero', () => {
    expect(() => evaluateArithmetic('1 / 0', {})).toThrow('Division by zero')
  })

  test('rejects malformed expressions', () => {
    expect(() => evaluateArithmetic('1 +', {})).toThrow()
    expect(() => evaluateArithmetic('(1 + 2', {})).toThrow('Missing ")"')
    expect(() => evaluateArithmetic('1 2', {})).toThrow()
  })

  // A plan file is untrusted input: nothing beyond plain arithmetic may run.
  test('rejects anything that is not plain arithmetic', () => {
    for (const expression of [
      'constructor',
      'price.constructor',
      'price["constructor"]',
      'process.exit(1)',
      'price; 1',
      'price ** 2',
      'sqrt(price)',
    ]) {
      expect(() => evaluateArithmetic(expression, { price: 1 }), expression).toThrow()
    }
  })
})
