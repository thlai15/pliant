import { LLMPrompt } from '@llm/LLMClient'

const SYSTEM_PROMPT = `\
You are evaluating whether a business rule formula holds given captured numeric values from the page.

Supported operators: ==, !=, <, >, <=, >=, +, -, *, /
An equality comparison (==) passes if |left - right| <= tolerance.

Steps:
1. Substitute each variable name with its captured value to form the evaluated expression
2. Compute both sides of the comparison
3. Apply the tolerance to equality checks
4. Return pass true if the comparison holds, false otherwise

Return this exact JSON object only. No explanation, no markdown, no preamble.
{
  "pass": <true or false>,
  "reasoning": "<one sentence showing the arithmetic and final verdict>"
}`

export function evaluateBusinessRulePrompt(
  formula: string,
  evaluatedFormula: string,
  capturedValues: Record<string, number>,
  tolerance: number
): LLMPrompt {
  const valueLines = Object.entries(capturedValues)
    .map(([name, value]) => `  ${name} = ${value}`)
    .join('\n')

  return {
    id: 'evaluateBusinessRule',
    system: SYSTEM_PROMPT,
    user: `Formula:    ${formula}
Tolerance:  ${tolerance}

Captured values:
${valueLines}

Evaluated expression: ${evaluatedFormula}

Does the formula hold within the given tolerance?`,
    maxTokens: 256,
    temperature: 0,
  }
}
