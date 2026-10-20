// Evaluates the arithmetic side of a business-rule formula, e.g.
// "item_1_price + item_2_price * 2". Supports numbers, variable names,
// + - * /, unary minus and parentheses. Anything else is rejected, so a plan
// file can never make Pliant run code.

import { PliantError } from '@types-local/errors'

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')' }

export function evaluateArithmetic(expression: string, variables: Record<string, number>): number {
  const tokens = tokenize(expression)
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]
  const isOp = (t: Token | undefined, v: string): boolean => t?.kind === 'op' && t.value === v

  // expr := term (('+' | '-') term)*
  function expr(): number {
    let value = term()
    while (isOp(peek(), '+') || isOp(peek(), '-')) {
      const op = tokens[pos++]
      const rhs = term()
      value = op?.value === '+' ? value + rhs : value - rhs
    }
    return value
  }

  // term := factor (('*' | '/') factor)*
  function term(): number {
    let value = factor()
    while (isOp(peek(), '*') || isOp(peek(), '/')) {
      const op = tokens[pos++]
      const rhs = factor()
      if (op?.value === '/' && rhs === 0) throw new PliantError(`Division by zero in "${expression}"`)
      value = op?.value === '*' ? value * rhs : value / rhs
    }
    return value
  }

  // factor := '-' factor | '(' expr ')' | number | name
  function factor(): number {
    const token = tokens[pos++]
    if (token === undefined) throw new PliantError(`Unexpected end of expression "${expression}"`)
    if (isOp(token, '-')) return -factor()
    if (isOp(token, '(')) {
      const value = expr()
      if (!isOp(tokens[pos++], ')')) throw new PliantError(`Missing ")" in "${expression}"`)
      return value
    }
    if (token.kind === 'number') return token.value
    if (token.kind === 'name') {
      // Own properties only: inherited names like "constructor" are not variables.
      const value = Object.hasOwn(variables, token.value) ? variables[token.value] : undefined
      if (typeof value !== 'number') throw new PliantError(`Unknown variable "${token.value}" in "${expression}"`)
      return value
    }
    throw new PliantError(`Unexpected "${token.value}" in "${expression}"`)
  }

  const result = expr()
  if (pos !== tokens.length) {
    throw new PliantError(`Unexpected "${String(tokens[pos]?.value)}" in "${expression}"`)
  }
  return result
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  const pattern = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_]\w*)|([-+*/()]))/y
  let index = 0
  while (index < expression.length) {
    if (expression.slice(index).trim() === '') break
    pattern.lastIndex = index
    const match = pattern.exec(expression)
    if (match === null) {
      throw new PliantError(`Unsupported character "${expression.slice(index).trim()[0]}" in "${expression}"`)
    }
    const [, num, name, op] = match
    if (num !== undefined) tokens.push({ kind: 'number', value: Number(num) })
    else if (name !== undefined) tokens.push({ kind: 'name', value: name })
    else if (op !== undefined) tokens.push({ kind: 'op', value: op as '+' | '-' | '*' | '/' | '(' | ')' })
    index = pattern.lastIndex
  }
  return tokens
}
