import { LLMPrompt } from '@llm/LLMClient'
import { ExtractedElement } from '@types-local/index'

const MAX_ELEMENTS    = 50
const MAX_PATH_CHARS  = 70
const MAX_TEXT_CHARS  = 80

const SYSTEM_PROMPT = `\
You are evaluating whether a natural language assertion holds for the current page state.

Rules:
- Use the page elements AND the visible page text (when provided) as evidence
- The assertion passes only if the evidence clearly supports it
- If the element list is ambiguous but leans toward the assertion being true, pass with a qualifying note in reasoning
- The visible page text section contains raw innerText from the page — use it to verify text-visibility assertions

Return this exact JSON object only. No explanation, no markdown, no preamble.
{
  "pass": <true or false>,
  "reasoning": "<one sentence explaining the verdict>"
}`

export function evaluateAssertionPrompt(
  assertion: string,
  pageElements: ExtractedElement[],
  pageUrl?: string,
  productDialogOpen?: boolean,
  pageText?: string,
): LLMPrompt {
  const textBearing = pageElements.filter(el => el.text.trim().length > 0 || el.label !== null)
  const relevant = filterByAssertionKeywords(textBearing, assertion)
  const capped = relevant.slice(0, MAX_ELEMENTS)
  const elementLines = capped
    .map(el => {
      const path = el.path.slice(0, MAX_PATH_CHARS)
      const text = (el.label ?? el.text).slice(0, MAX_TEXT_CHARS)
      return `- ${path}: "${text}"`
    })
    .join('\n')

  const urlLine = pageUrl != null ? `Current URL: ${pageUrl}\n\n` : ''
  const dialogNote = productDialogOpen === true
    ? 'Note: A product modal or drawer containing an "Add to cart" button is currently open on the page.\n\n'
    : ''

  // Raw page innerText provides product names, prices and other non-interactive text
  // not captured in the element list (which only contains interactive elements).
  const textSection = pageText != null && pageText.trim().length > 0
    ? `\nVisible page text:\n${pageText.slice(0, 2000)}\n`
    : ''

  return {
    id: 'evaluateAssertion',
    system: SYSTEM_PROMPT,
    user: `Assertion: "${assertion}"

${urlLine}${dialogNote}Interactive page elements (path: visible text or label):
${elementLines}${textSection}`,
    maxTokens: 256,
    temperature: 0,
  }
}

// Keep elements whose path or text contains at least one significant word from the
// assertion (4+ chars, skips 'the', 'for', etc.). Falls back to the full list when
// fewer than 5 match so assertions never evaluate against an empty set.
function filterByAssertionKeywords(
  elements: ExtractedElement[],
  assertion: string
): ExtractedElement[] {
  const words = (assertion.toLowerCase().match(/\b\w{4,}\b/g) ?? [])
  if (words.length === 0) return elements

  const relevant = elements.filter(el => {
    const haystack = `${el.path} ${el.label ?? el.text}`.toLowerCase()
    return words.some(w => haystack.includes(w))
  })
  return relevant.length > 0 ? relevant : elements
}
