import { readFile } from 'fs/promises'
import { TestPlan, Scenario, Step, BusinessRule, ElementHint } from '@types-local/index'
import { RulesParser } from '@parser/RulesParser'

const STEP_LINE_RE = /^(\d+)\.\s+(.+)$/
const EXPECT_LINE_RE = /^\s+-\s+expect:\s*(.+)$/
const STOP_LINE_RE = /^\s+-\s+stop:\s*true\s*$/
const AFTER_LINE_RE = /^\s+-\s+after:\s*\[([^\]]*)\]\s*$/
const ELEMENT_HINT_RE = /^\s+-\s+element:\s*(\{.+\})\s*$/
const RULES_OPEN_RE = /^\s*```rules\s*$/
const RULES_CLOSE_RE = /^\s*```\s*$/

export class PlanParser {
  private readonly rulesParser = new RulesParser()

  async parseFile(filePath: string): Promise<TestPlan> {
    const content = await readFile(filePath, 'utf-8')
    return this.parse(content)
  }

  parse(content: string): TestPlan {
    const lines = content.split('\n')
    return {
      title: this.extractTitle(lines),
      scenarios: this.extractScenarios(lines),
    }
  }

  private extractTitle(lines: string[]): string {
    for (const line of lines) {
      if (line.startsWith('# ') && !line.startsWith('## ')) {
        return line.slice(2).trim()
      }
    }
    return ''
  }

  private extractScenarios(lines: string[]): Scenario[] {
    const scenarios: Scenario[] = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      if (line !== undefined && line.startsWith('### ')) {
        const title = line.slice(4).trim()
        const end = this.findNextScenarioHeading(lines, i + 1)
        scenarios.push({ title, steps: this.extractSteps(lines.slice(i + 1, end)) })
        i = end
      } else {
        i++
      }
    }

    return scenarios
  }

  private findNextScenarioHeading(lines: string[], from: number): number {
    for (let i = from; i < lines.length; i++) {
      const line = lines[i]
      if (line !== undefined && line.startsWith('### ')) return i
    }
    return lines.length
  }

  private extractSteps(lines: string[]): Step[] {
    const steps: Step[] = []
    let inStepsSection = false
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      if (line === undefined) { i++; continue }

      if (line.trim() === '**Steps:**') {
        inStepsSection = true
        i++
        continue
      }

      if (!inStepsSection) { i++; continue }

      const stepMatch = STEP_LINE_RE.exec(line)
      if (stepMatch !== null) {
        const numStr = stepMatch[1]
        const intent = stepMatch[2]
        if (numStr === undefined || intent === undefined) { i++; continue }

        const number = parseInt(numStr, 10)
        const { subLines, nextIndex } = this.collectSubLines(lines, i + 1)
        steps.push(this.parseStepContent(String(number), number, intent.trim(), subLines))
        i = nextIndex
      } else {
        i++
      }
    }

    return steps
  }

  // Collects the lines belonging to a step, aware of rules fence blocks so a
  // line like "1. something" inside YAML doesn't end the step prematurely.
  private collectSubLines(
    lines: string[],
    from: number
  ): { subLines: string[]; nextIndex: number } {
    const subLines: string[] = []
    let i = from
    let inRules = false

    while (i < lines.length) {
      const line = lines[i]
      if (line === undefined) break

      if (inRules) {
        subLines.push(line)
        if (RULES_CLOSE_RE.test(line)) inRules = false
        i++
        continue
      }

      if (RULES_OPEN_RE.test(line)) {
        inRules = true
        subLines.push(line)
        i++
        continue
      }

      if (STEP_LINE_RE.test(line)) break

      subLines.push(line)
      i++
    }

    return { subLines, nextIndex: i }
  }

  private parseStepContent(
    id: string,
    number: number,
    intent: string,
    lines: string[]
  ): Step {
    const expects: string[] = []
    let rules: BusinessRule | null = null
    let stop = false
    let after: string[] = []
    let element: ElementHint | null = null
    let inRules = false
    const rulesLines: string[] = []

    for (const line of lines) {
      if (inRules) {
        if (RULES_CLOSE_RE.test(line)) {
          inRules = false
          rules = this.rulesParser.parse(rulesLines.join('\n'))
        } else {
          rulesLines.push(line)
        }
        continue
      }

      if (RULES_OPEN_RE.test(line)) {
        inRules = true
        rulesLines.length = 0
        continue
      }

      const expectMatch = EXPECT_LINE_RE.exec(line)
      if (expectMatch !== null && expectMatch[1] !== undefined) {
        expects.push(expectMatch[1].trim())
        continue
      }

      if (STOP_LINE_RE.test(line)) {
        stop = true
        continue
      }

      const afterMatch = AFTER_LINE_RE.exec(line)
      if (afterMatch !== null && afterMatch[1] !== undefined) {
        const raw = afterMatch[1].trim()
        if (raw.length > 0) {
          after = raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
        }
        continue
      }

      const elementMatch = ELEMENT_HINT_RE.exec(line)
      if (elementMatch !== null && elementMatch[1] !== undefined) {
        try {
          const parsed: unknown = JSON.parse(elementMatch[1])
          if (isElementHint(parsed)) element = parsed
        } catch { /* ignore malformed hints */ }
        continue
      }
    }

    return { id, number, intent, expects, rules, stop, after, element }
  }
}

function isElementHint(v: unknown): v is ElementHint {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['label'] === 'string' &&
    Array.isArray(o['container']) &&
    Array.isArray(o['neighbors']) &&
    typeof o['tag'] === 'string'
  )
}
