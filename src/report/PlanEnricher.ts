import { copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import * as path from 'path'
import { ElementHint, ExtractedElement } from '@types-local/index'
import { CONFIDENCE_THRESHOLD } from '@types-local/constants'
import { createLogger } from '@types-local/logger'

const logger = createLogger('PlanEnricher')

// Records element context hints for each successful step in a copy of the plan.
// The copy lives in the run's output directory; the source plan is never modified.
// The user decides whether to adopt the enriched copy.
// Guards: only writes when confidence is high enough AND the matched element label
// is plausibly related to the step intent, preventing corrupted hints from wrong matches.
export class PlanEnricher {
  private outputReady = false

  constructor(
    private readonly sourcePlanFile: string,
    readonly outputPlanFile: string,
  ) {
    if (path.resolve(sourcePlanFile) === path.resolve(outputPlanFile)) {
      throw new Error('PlanEnricher output must differ from the source plan')
    }
  }

  // True once at least one hint has been written to the output copy.
  get wroteOutput(): boolean {
    return this.outputReady
  }

  async enrich(
    stepNumber: number,
    stepIntent: string,
    matched: ExtractedElement,
    confidence: number,
  ): Promise<void> {
    // Only record hints from high-confidence matches. Low-confidence matches
    // may have found the wrong element — recording them as ground truth would
    // bias future runs toward incorrect elements.
    if (confidence < CONFIDENCE_THRESHOLD) {
      logger.debug(`Skipping enrichment for step ${stepNumber}: confidence ${confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}`)
      return
    }

    const label = matched.label ?? (matched.text.trim() || extractSelfText(matched.path))

    // Sanity check: the matched element's label should share at least one significant
    // word with the step intent. This catches cases where the LLM matched a completely
    // unrelated element that happened to pass a lenient assertion.
    if (!labelIsPlausible(label, stepIntent)) {
      logger.debug(`Skipping enrichment for step ${stepNumber}: label "${label.slice(0, 40)}" not plausible for intent`)
      return
    }

    const hint: ElementHint = {
      label,
      container: extractContainer(matched.path),
      // Sanitize neighbor text: strip JavaScript code and script tags, limit length.
      // Raw sibling text often includes inline <script> content that pollutes the hint.
      neighbors: matched.siblings
        .map(s => sanitizeText(s))
        .filter(s => s.length > 0 && s.length <= 80),
      tag: matched.inputType ? `${matched.tag}[${matched.inputType}]` : matched.tag,
    }

    let content: string
    try {
      await this.ensureOutputCopy()
      content = await readFile(this.outputPlanFile, 'utf-8')
    } catch (err) {
      logger.warn(`Could not prepare enriched plan copy: ${String(err)}`)
      return
    }

    const updated = updateStepElement(content, stepNumber, hint)
    if (updated === content) return

    try {
      await writeFile(this.outputPlanFile, updated, 'utf-8')
      logger.debug(`Enriched step ${stepNumber}: label="${hint.label}" container=[${hint.container.join(', ')}]`)
    } catch (err) {
      logger.warn(`Could not write enriched plan copy: ${String(err)}`)
    }
  }

  private async ensureOutputCopy(): Promise<void> {
    if (this.outputReady) return
    await mkdir(path.dirname(this.outputPlanFile), { recursive: true })
    await copyFile(this.sourcePlanFile, this.outputPlanFile)
    this.outputReady = true
  }
}

// Strips JavaScript patterns and limits text length.
// Sibling elements often include <script> tag content — this removes it.
function sanitizeText(text: string): string {
  return text
    .replace(/\$\s*\(.*$/s, '')        // remove jQuery and everything after
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/function\s*\([\s\S]*$/s, '')  // remove function expressions
    .replace(/\/\*[\s\S]*?\*\//g, '')   // remove block comments
    .trim()
    .slice(0, 80)
}

// Returns true unless the element label is clearly unrelated to the step intent.
// Catches corrupted hints (JS code as label, unrelated page sections) while
// allowing generic UI labels ("input", "Add to cart", "Search") that don't share
// words with the intent but are perfectly valid matches.
function labelIsPlausible(label: string, intent: string): boolean {
  // Reject labels containing JavaScript — these come from <script> sibling text
  // captured by getSiblings() bleeding into the label field.
  if (/\$\s*\(|function\s*\(|document\.ready|\.ready\(/.test(label)) return false

  // Extract only words with 6+ chars: those are specific enough to be meaningful.
  // Short words ("add", "cart", "input", "search") are generic UI affordances —
  // they match many intents and should not trigger a rejection.
  const labelLongWords = new Set((label.toLowerCase().match(/\b[a-z]{6,}\b/g) ?? []))
  const intentLongWords = new Set((intent.toLowerCase().match(/\b[a-z]{6,}\b/g) ?? []))

  // If the label has no long specific words, it's generic ("Add to cart", "input",
  // "Search", etc.) — allow it regardless of intent.
  if (labelLongWords.size === 0) return true

  // If any long label word appears in the intent, the match is plausible.
  for (const word of labelLongWords) {
    if (intentLongWords.has(word)) return true
  }

  // Label has specific words that don't appear in the intent.
  // A single non-matching long word is acceptable — it may be a brand name, carrier
  // name, or product variant ("Ground", "Checkout", etc.) that is correct but absent
  // from the generically-worded intent.
  // Reject only when there are 2+ long words that all fail to match — that level of
  // specificity strongly suggests a wrong element ("Recently viewed products").
  if (labelLongWords.size < 2) return true

  const commonUiWords = new Set(['button', 'submit', 'continue', 'cancel', 'checkout',
    'navigate', 'select', 'option', 'proceed'])
  return [...labelLongWords].every(w => commonUiWords.has(w))
}

function extractSelfText(path: string): string {
  const segments = path.split(' > ')
  return segments[segments.length - 1] ?? ''
}

function extractContainer(path: string): string[] {
  const segments = path.split(' > ')
  const all = segments.slice(0, -1).filter(s => s.length > 0)
  return all.filter((s, i) => i === 0 || s !== all[i - 1])
}

function updateStepElement(content: string, stepNumber: number, hint: ElementHint): string {
  const lines = content.split('\n')

  const stepLineIdx = lines.findIndex(l => {
    const m = /^(\d+)\.\s/.exec(l)
    return m !== null && parseInt(m[1] ?? '0', 10) === stepNumber
  })
  if (stepLineIdx === -1) return content

  // Find the end of this step's sub-lines: next step line or EOF.
  let endIdx = lines.length
  for (let i = stepLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined && /^\d+\.\s/.test(line)) {
      endIdx = i
      break
    }
  }

  const hintJson = JSON.stringify(hint)
  const indented  = `    - element: ${hintJson}`

  // Replace existing element line if present.
  const elementLineIdx = lines.findIndex(
    (l, i) => i > stepLineIdx && i < endIdx && /^\s+-\s+element:\s*/.test(l)
  )
  if (elementLineIdx !== -1) {
    lines[elementLineIdx] = indented
    return lines.join('\n')
  }

  // Insert after the last step metadata line (expect/after/stop).
  let insertIdx = stepLineIdx + 1
  for (let i = stepLineIdx + 1; i < endIdx; i++) {
    const line = lines[i]
    if (line !== undefined && /^\s+-\s+(expect:|after:|stop:)/.test(line)) {
      insertIdx = i + 1
    }
  }
  lines.splice(insertIdx, 0, indented)
  return lines.join('\n')
}
