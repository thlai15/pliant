import * as yaml from 'js-yaml'
import { BusinessRule, CaptureSpec, Region } from '@types-local/index'
import { PlanParseError } from '@types-local/errors'

const VALID_REGIONS = new Set<string>([
  'main', 'nav', 'aside', 'header', 'footer', 'dialog', 'unknown',
])

export class RulesParser {
  parse(content: string): BusinessRule {
    let raw: unknown
    try {
      raw = yaml.load(content)
    } catch (error) {
      throw new PlanParseError('Invalid YAML in rules block', { cause: error })
    }

    if (!isRulesShape(raw)) {
      throw new PlanParseError(
        `Rules block missing required fields — expected id (string), formula (string), capture (array)`
      )
    }

    return {
      id: raw.id,
      formula: raw.formula,
      tolerance: raw.tolerance ?? 0.0,
      captures: raw.capture.map(parseCapture),
    }
  }
}

interface RawRules {
  id: string
  formula: string
  tolerance?: number
  capture: unknown[]
}

function isRulesShape(value: unknown): value is RawRules {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['formula'] === 'string' &&
    (obj['tolerance'] === undefined || typeof obj['tolerance'] === 'number') &&
    Array.isArray(obj['capture'])
  )
}

function parseCapture(value: unknown, index: number): CaptureSpec {
  if (typeof value !== 'object' || value === null) {
    throw new PlanParseError(`Capture entry [${index}] is not an object`)
  }
  const obj = value as Record<string, unknown>
  const name = obj['name']
  const semantic = obj['semantic']
  const region = obj['region']

  if (typeof name !== 'string') {
    throw new PlanParseError(`Capture entry [${index}] missing string "name"`)
  }
  if (typeof semantic !== 'string') {
    throw new PlanParseError(`Capture entry [${index}] missing string "semantic"`)
  }
  if (typeof region !== 'string' || !VALID_REGIONS.has(region)) {
    throw new PlanParseError(`Capture entry [${index}] has invalid region: ${String(region)}`)
  }

  return { name, semantic, region: region as Region }
}
