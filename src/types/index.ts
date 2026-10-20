// ─── Plan ────────────────────────────────────────────────────────────────────

export type Region = 'main' | 'nav' | 'aside' | 'header' | 'footer' | 'dialog' | 'unknown'

export interface CaptureSpec {
  name: string
  semantic: string
  region: Region
}

export interface BusinessRule {
  id: string
  formula: string
  tolerance: number
  captures: CaptureSpec[]
}

export interface ElementHint {
  label: string
  container: string[]  // ancestor labels, outermost first
  neighbors: string[]  // sibling element text snippets
  tag: string
}

export interface Step {
  id: string          // string representation of step number, e.g. "1"
  number: number
  intent: string
  expects: string[]
  rules: BusinessRule | null
  stop: boolean
  after: string[]     // IDs of steps that must complete before this one is scheduled
  element: ElementHint | null  // enriched element context captured from a prior run
}

export interface Scenario {
  title: string
  steps: Step[]
}

export interface TestPlan {
  title: string
  scenarios: Scenario[]
}

// ─── Locator ─────────────────────────────────────────────────────────────────

export type RelativePosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'mid-left' | 'mid-center' | 'mid-right'
  | 'bot-left' | 'bot-center' | 'bot-right'

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ExtractedElement {
  index: number
  tag: string
  role: string | null
  label: string | null
  text: string
  path: string
  events: string[]
  region: Region
  boundingBox: BoundingBox
  relativePosition: RelativePosition
  siblings: string[]
  selector: string
  inputType: string | null
}

export interface MatchResult {
  elementIndex: number
  confidence: number
  reasoning: string
  fillValue: string | null
  alternativeIndices: number[]
}

export type SelectorCache = Map<string, string>

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface PageFeatures {
  hasSearchInput: boolean
  hasCartElement: boolean
  hasProductListing: boolean
  formCount: number
}

export interface PageContext {
  url: string
  title: string
  headings: string[]
  landmarkLabels: string[]
  features: PageFeatures
}

// ─── Execution ───────────────────────────────────────────────────────────────

export type StepOutcome = 'PASS' | 'FAIL' | 'HEALED' | 'SKIPPED' | 'STUCK'

export type LocatorStrategy = 'DIRECT' | 'SEMANTIC' | 'NOT_FOUND'

export type HealingEventType = 'SEMANTIC_FALLBACK' | 'FORWARD_ADVANCE' | 'LOW_CONFIDENCE'

export interface HealingEvent {
  type: HealingEventType
  description: string
  confidence?: number
}

export interface AssertionReport {
  expect: string
  pass: boolean
  reasoning: string
}

export interface BusinessRuleReport {
  ruleId: string
  formula: string
  capturedValues: Record<string, number>
  evaluatedFormula: string
  pass: boolean
  toleranceApplied: number
  failReason?: string
}

export interface StepScreenshots {
  fullPage: string
  element: string | null
}

export interface StepResult {
  outcome: StepOutcome
  locatorStrategy: LocatorStrategy
  match: MatchResult | null
  matchedElement: MatchedElementSummary | null
  assertionResults: AssertionReport[]
  businessRuleResult: BusinessRuleReport | null
  healingEvents: HealingEvent[]
  screenshots: StepScreenshots
  durationMs: number
  error: string | null
}

// ─── Report ──────────────────────────────────────────────────────────────────

export type RunOutcome = 'PASS' | 'FAIL' | 'STUCK'

export interface MatchedElementSummary {
  path: string
  label: string | null
  tag: string
  selector: string
  confidence: number
  reasoning: string
  boundingBox: BoundingBox
}

export interface StepReport {
  stepId: string
  stepNumber: number
  intent: string
  outcome: StepOutcome
  locatorStrategy: LocatorStrategy
  matchedElement: MatchedElementSummary | null
  healingEvents: HealingEvent[]
  assertions: AssertionReport[]
  businessRule: BusinessRuleReport | null
  screenshots: StepScreenshots
  durationMs: number
}

export interface RunReport {
  runId: string
  site: string
  targetUrl: string
  planFile: string
  startedAt: string
  completedAt: string
  outcome: RunOutcome
  llmProvider: string
  llmModel: string
  steps: StepReport[]
}

import type { DriverName } from '@driver/BrowserDriver'

// ─── Config ──────────────────────────────────────────────────────────────────

export type LLMProvider    = 'claude' | 'ollama'
export type BrowserType    = 'chromium' | 'firefox' | 'webkit'

export interface HumanTiming {
  enabled: boolean
  stepDelayMin: number  // ms — minimum pause between steps
  stepDelayMax: number  // ms — maximum pause between steps
}

export interface RunConfig {
  targetUrl: string
  headless: boolean
  slowMo: number
  llmProvider: LLMProvider
  reportOutputDir: string
  planFile: string
  driver: DriverName
  browserType: BrowserType
  humanTiming: HumanTiming
}
