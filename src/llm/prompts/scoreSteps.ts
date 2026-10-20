import { LLMPrompt } from '@llm/LLMClient'
import { Step, PageContext } from '@types-local/index'

// StepScore is the per-step output of the LLM scoring call.
// Exported here so StepScheduler can import the type alongside the prompt.
export interface StepScore {
  stepId: string
  score: number
}

// The system prompt is written to survive small Ollama models (Mistral 7B).
// Key principles:
// - Open with the required output format so it is the first thing the model sees
// - Use numbered labels for steps so they read as data, not instructions to execute
// - Concrete examples anchor the expected JSON shape
const SYSTEM_PROMPT = `You are a JSON-only scoring API. You output ONLY a JSON array — no prose, no explanation, no markdown.

TASK: Given a web page context and a numbered list of test plan steps, assign each step a relevance score (0.0–1.0) indicating how well the step matches the CURRENT page.

SCORING RULES:
- Score 1.0: this step clearly applies to the current page (e.g. a "search" step when page has a search bar)
- Score 0.5: this step might apply but it is uncertain
- Score 0.0: this step does not apply to the current page (e.g. a "checkout" step on a search-results page)
- Consider the URL path, page title, and visible headings when deciding relevance
- Do NOT describe how to execute the steps — only score them

REQUIRED OUTPUT FORMAT (JSON array, nothing else):
[{"stepId":"1","score":0.9},{"stepId":"2","score":0.1},{"stepId":"3","score":0.0}]`

export function scoreStepsPrompt(
  pendingSteps: Step[],
  pageContext: PageContext
): LLMPrompt {
  // Label steps as [STEP N] so they read as data to score, not imperatives to execute
  const stepLines = pendingSteps
    .map(s => `[STEP ${s.id}] ${s.intent}`)
    .join('\n')

  const headings = pageContext.headings.length > 0
    ? pageContext.headings.join(' | ')
    : '(none)'
  const landmarks = pageContext.landmarkLabels.length > 0
    ? pageContext.landmarkLabels.join(' | ')
    : '(none)'

  const { features } = pageContext
  const featureLines = [
    `Search input present: ${features.hasSearchInput ? 'YES' : 'no'}`,
    `Cart element present: ${features.hasCartElement ? 'YES' : 'no'}`,
    `Product listing present: ${features.hasProductListing ? 'YES' : 'no'}`,
    `Form count: ${features.formCount}`,
  ].join('\n')

  return {
    id: 'scoreSteps',
    system: SYSTEM_PROMPT,
    user: `PAGE CONTEXT:
URL: ${pageContext.url}
Title: ${pageContext.title}
Headings: ${headings}
Landmarks: ${landmarks}
Interactive features:
${featureLines}

STEPS TO SCORE (output one {"stepId","score"} per step, nothing else):
${stepLines}

Output the JSON array now:`,
    maxTokens: 512,
    temperature: 0,
  }
}
