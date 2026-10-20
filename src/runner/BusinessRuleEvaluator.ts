import { BrowserDriver } from '@driver/BrowserDriver'
import { ElementExtractor } from '@locator/ElementExtractor'
import { SemanticMatcher } from '@locator/SemanticMatcher'
import { BusinessRule, BusinessRuleReport, Region } from '@types-local/index'
import { createLogger } from '@types-local/logger'
import { evaluateArithmetic } from '@runner/arithmetic'

const logger = createLogger('BusinessRuleEvaluator')

export class BusinessRuleEvaluator {
  constructor(
    private readonly extractor: ElementExtractor,
    private readonly matcher: SemanticMatcher,
  ) {}

  async evaluate(rule: BusinessRule, driver: BrowserDriver): Promise<BusinessRuleReport> {
    const allCandidates = await this.extractor.extract(driver, true)
    const capturedValues: Record<string, number> = {}

    // Business rule captures look for displayed values (prices, totals) — these live in
    // content elements (index >= 10000: spans, tds, etc.) not in form inputs.
    // Further restrict to elements whose visible text is parseable as a number, so the
    // LLM is never shown section headers, labels, or other non-numeric text.
    // Fall back to allCandidates only when too few numeric content elements exist.
    const CONTENT_START = 10000
    const numericContent = allCandidates.filter(
      el => el.index >= CONTENT_START && parseNumericValue(el.text) !== null
    )

    for (const capture of rule.captures) {
      const regionNumeric = filterByRegion(numericContent, capture.region)
      const candidates = regionNumeric.length >= 3 ? regionNumeric
        : numericContent.length >= 3 ? numericContent
        : allCandidates

      let elementIndex: number
      try {
        const match = await this.matcher.match(capture.semantic, candidates)
        elementIndex = match.elementIndex
      } catch (error) {
        logger.warn(`Capture "${capture.name}" match failed: ${String(error)}`)
        return captureFailedReport(rule, capturedValues, `Could not locate ${capture.name} on page`)
      }

      const element = candidates.find(el => el.index === elementIndex)
      if (element === undefined) {
        return captureFailedReport(rule, capturedValues, `Element index ${elementIndex} not found for ${capture.name}`)
      }

      const value = parseNumericValue(element.text)
      if (value === null) {
        return captureFailedReport(
          rule, capturedValues,
          `Could not parse "${element.text}" as a number for ${capture.name}`,
          'CAPTURE_PARSE_FAILED',
        )
      }

      capturedValues[capture.name] = value
      logger.debug(`captured ${capture.name} = ${value}`)
    }

    return evaluateFormula(rule, capturedValues)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function filterByRegion(
  candidates: ReturnType<ElementExtractor['extract']> extends Promise<infer T> ? T : never,
  region: Region,
) {
  return candidates.filter(el => el.region === region)
}

function parseNumericValue(text: string): number | null {
  const cleaned = text
    .trim()
    .replace(/[$£€¥]/g, '')
    .replace(/,/g, '')
    .trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

// Evaluate both sides of the comparison, then apply tolerance to equality.
export function evaluateFormula(rule: BusinessRule, values: Record<string, number>): BusinessRuleReport {
  const compMatch = /^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/.exec(rule.formula)
  if (compMatch === null) {
    return {
      ruleId: rule.id, formula: rule.formula,
      capturedValues: values, evaluatedFormula: rule.formula,
      pass: false, toleranceApplied: rule.tolerance,
      failReason: `Cannot identify comparison operator in: ${rule.formula}`,
    }
  }

  const lhsExpr = compMatch[1]
  const op      = compMatch[2]
  const rhsExpr = compMatch[3]

  if (lhsExpr === undefined || op === undefined || rhsExpr === undefined) {
    return {
      ruleId: rule.id, formula: rule.formula,
      capturedValues: values, evaluatedFormula: rule.formula,
      pass: false, toleranceApplied: rule.tolerance,
      failReason: 'Regex capture group missing',
    }
  }

  let lhs: number
  let rhs: number
  try {
    lhs = evaluateArithmetic(lhsExpr, values)
    rhs = evaluateArithmetic(rhsExpr, values)
  } catch (error) {
    return {
      ruleId: rule.id, formula: rule.formula,
      capturedValues: values, evaluatedFormula: rule.formula,
      pass: false, toleranceApplied: rule.tolerance,
      failReason: `Formula evaluation error: ${String(error)}`,
    }
  }

  const evaluated = `${lhs} ${op} ${rhs}`
  const { tolerance } = rule

  let pass: boolean
  switch (op) {
    case '==': pass = Math.abs(lhs - rhs) <= tolerance;     break
    case '!=': pass = Math.abs(lhs - rhs) >  tolerance;     break
    case '<':  pass = lhs < rhs;                             break
    case '>':  pass = lhs > rhs;                             break
    case '<=': pass = lhs <= rhs + tolerance;                break
    case '>=': pass = lhs >= rhs - tolerance;                break
    default:   pass = false
  }

  logger.debug(`formula "${evaluated}" (tol=${tolerance}) → ${pass ? 'PASS' : 'FAIL'}`)

  return {
    ruleId: rule.id, formula: rule.formula,
    capturedValues: values, evaluatedFormula: evaluated,
    pass, toleranceApplied: tolerance,
  }
}

function captureFailedReport(
  rule: BusinessRule,
  partialValues: Record<string, number>,
  reason: string,
  failReason = 'CAPTURE_FAILED',
): BusinessRuleReport {
  return {
    ruleId: rule.id, formula: rule.formula,
    capturedValues: partialValues, evaluatedFormula: rule.formula,
    pass: false, toleranceApplied: rule.tolerance,
    failReason: `${failReason}: ${reason}`,
  }
}
