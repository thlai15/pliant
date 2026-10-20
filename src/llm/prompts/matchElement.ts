import { LLMPrompt } from '@llm/LLMClient'
import { ExtractedElement, ElementHint } from '@types-local/index'

const MAX_CANDIDATES  = 50
const MAX_LABEL_CHARS = 50
const MAX_PATH_CHARS  = 80

const SYSTEM_PROMPT = `\
You are selecting the best matching interactive element on a web page for a test step.

Score each candidate by semantic similarity to the step intent using these weights:
- Element label/text (primary signal): weight 3 — must closely match the intent's target
- Immediate container (1 level up): weight 1.5 — supporting context from the parent section
- Parent/grandparent containers: weight 0.75 / 0.375 — broader page structure signal
- Neighbor elements (siblings): weight 0.5 — elements adjacent to the target

When a target hint is provided, treat it as strong prior evidence: a candidate whose label and container match the hint is the likely target unless clearly wrong for the intent.

Rules:
- For content interactions (clicking a product, form field, button), prefer elements in the "main" region
- For navigation actions (cart, menu, breadcrumb), prefer elements in the "nav" or "header" region
- If the intent references a position ("first result", "top item"), prefer lower-numbered candidates
- When multiple candidates have identical labels, choose the one whose container best aligns with the intent
- If the step requires text input ("enter X into Y", "type", "fill in", "fill out"), set fillValue to the exact string to type; otherwise set fillValue to null
- For select/dropdown elements (tag: select), always set fillValue to the option label or value to select — never null when the intent names what to choose

Return this exact JSON object only. No explanation, no markdown, no preamble.
{
  "elementIndex": <integer — the index field from the chosen candidate>,
  "confidence": <float 0.0–1.0>,
  "reasoning": "<one sentence>",
  "fillValue": <string to type, or null>,
  "alternativeIndices": [<integer>, ...]
}`

export type MatchElementResult = {
  prompt: LLMPrompt
  displayMap: ExtractedElement[]
}

export function matchElementPrompt(
  intent: string,
  candidates: ExtractedElement[],
  elementHint: ElementHint | null = null,
): MatchElementResult {
  let preFiltered: ExtractedElement[]
  if (isTextEntryIntent(intent)) {
    // Restrict to text-type inputs and textareas. Exclude radio/checkbox/submit/button
    // so the LLM never picks a non-fillable element for text-entry steps.
    // Do NOT filter by keyboard-event presence: form fields on event-delegated frameworks
    // (React, Vue) have events:[] even though they are fully interactive.
    const NON_TEXT_TYPES = new Set(['radio', 'checkbox', 'submit', 'button', 'reset', 'image', 'file', 'hidden'])
    const textInputs = candidates.filter(el => {
      if (el.tag === 'textarea' || el.tag === 'select') return true
      if (el.tag !== 'input') return false
      const type = el.inputType ?? 'text'
      return !NON_TEXT_TYPES.has(type)
    })
    const textInputList = textInputs.length > 0 ? textInputs : candidates
    // Secondary keyword narrowing: extract the field-descriptor portion of the intent
    // (the part after the action verb and quoted value) so filler words like "enter" and
    // "into" don't match all fields via their shared path context. When that yields
    // exactly one candidate, use it — removing index-confusion for Mistral 7B.
    const fieldDescriptor = intent.replace(/^(enter|type|fill\s+in|fill\s+out)\s+["'][^"']*["']\s+(into|in)\s+/i, '')
    const narrowed = strictKeywordFilter(textInputList, fieldDescriptor)
    preFiltered = narrowed.length === 1 ? narrowed : textInputList
  } else if (isDismissDialogIntent(intent)) {
    // For close/dismiss steps, restrict to buttons inside the visible dialog.
    const dialogEls = candidates.filter(el => el.region === 'dialog')
    preFiltered = dialogEls.length > 0 ? dialogEls : candidates
  } else if (isCheckboxIntent(intent)) {
    // When the intent explicitly mentions "checkbox" or "check the ... checkbox", restrict
    // to checkbox inputs so the LLM never picks a structural ancestor (form, div) instead
    // of the actual input element.
    const checkboxEls = candidates.filter(el => el.tag === 'input' && el.inputType === 'checkbox')
    preFiltered = checkboxEls.length > 0 ? checkboxEls : filterByIntentKeywords(candidates, intent)
  } else if (isRadioButtonIntent(intent)) {
    // When the intent explicitly mentions "radio button", restrict to radio inputs so the
    // LLM never picks a container div or section header instead of the actual input.
    const radioEls = candidates.filter(el => el.tag === 'input' && el.inputType === 'radio')
    preFiltered = radioEls.length > 0 ? radioEls : filterByIntentKeywords(candidates, intent)
  } else if (isSearchButtonIntent(intent)) {
    // For "click the search button/submit" steps, restrict to button and input elements.
    // Large <a> banners and product images frequently outscore the actual submit button on
    // keyword match alone — removing non-button candidates eliminates that false signal.
    const submitEls = candidates.filter(el => el.tag === 'button' || el.tag === 'input')
    preFiltered = submitEls.length > 0 ? submitEls : filterByIntentKeywords(candidates, intent)
  } else {
    preFiltered = filterByIntentKeywords(candidates, intent)
  }

  const deduplicated = deduplicateCandidates(preFiltered)

  // When a hint is available, float hint-matching elements to the front of the display
  // map before slicing to MAX_CANDIDATES. Small LLMs (Mistral 7B) are more reliable
  // when the target element appears near the top of the list than when it appears after
  // 30+ other candidates — even when the hint is also stated in the prompt text.
  let orderedMap: ExtractedElement[]
  let topHintMatch: ExtractedElement | null = null
  if (elementHint !== null) {
    const hintLabel = elementHint.label.toLowerCase().slice(0, 30)
    const hintContainer = elementHint.container.map(c => c.toLowerCase())

    const scoreForHint = (el: ExtractedElement): number => {
      const elLabel = (el.label ?? el.text).toLowerCase().slice(0, 30)
      const elPath  = el.path.toLowerCase()
      const labelScore = elLabel === hintLabel ? 2
        : elLabel.includes(hintLabel) || hintLabel.includes(elLabel) ? 1 : 0
      const containerScore = hintContainer.reduce(
        (sum, hc) => sum + (elPath.includes(hc.slice(0, 15)) ? 1 : 0), 0)
      return labelScore + containerScore
    }

    const hintMatches  = deduplicated.filter(el => scoreForHint(el) > 0)
      .sort((a, b) => scoreForHint(b) - scoreForHint(a))
    const hintMatchSet = new Set(hintMatches.map(el => el.index))
    const remaining    = deduplicated.filter(el => !hintMatchSet.has(el.index))
    orderedMap = [...hintMatches, ...remaining].slice(0, MAX_CANDIDATES)
    // Only promote the top element when it actually matches the hint — not a remaining element.
    topHintMatch = hintMatches.length > 0 ? (hintMatches[0] ?? null) : null
  } else {
    orderedMap = deduplicated.slice(0, MAX_CANDIDATES)
  }

  const hintSection = elementHint !== null
    ? topHintMatch !== null
      ? `\nPriority hint (from prior run): label="${elementHint.label.slice(0, 40)}", container=[${elementHint.container.join(' > ')}]\nBest match for this hint: index ${topHintMatch.index} — listed first below. Return ${topHintMatch.index} unless it clearly does not fit the intent.\n`
      : `\nPriority hint (from prior run): label="${elementHint.label.slice(0, 40)}", container=[${elementHint.container.join(' > ')}]\n`
    : ''

  const candidateLines = orderedMap.map(el => formatCandidate(el)).join('\n')

  return {
    prompt: {
      id: 'matchElement',
      system: SYSTEM_PROMPT,
      user: `Step intent: "${intent}"${hintSection}

Candidates (index | label | container | neighbors | tag | region):
${candidateLines}`,
      maxTokens: 256,
      temperature: 0,
    },
    displayMap: orderedMap,
  }
}

// Text-entry intents are fill operations: the action is typing a value INTO a field.
// Requires " into " so "Select or enter CA for the state field" does NOT match here —
// those fall through to filterByIntentKeywords which correctly narrows by field type.
function isTextEntryIntent(intent: string): boolean {
  const lower = intent.toLowerCase()
  return (
    lower.includes(' into ') ||
    lower.includes('type ') ||
    lower.includes('fill in') ||
    lower.includes('fill out')
  )
}

// True when the step is closing/dismissing a modal or drawer.
function isDismissDialogIntent(intent: string): boolean {
  const lower = intent.toLowerCase()
  return (
    (lower.includes('dismiss') || lower.includes('close') || lower.includes('continue shopping')) &&
    (lower.includes('modal') || lower.includes('drawer') || lower.includes('dialog'))
  )
}

// True when the step explicitly targets a checkbox input.
function isCheckboxIntent(intent: string): boolean {
  const lower = intent.toLowerCase()
  return lower.includes('checkbox') || (lower.includes('check') && lower.includes('unchecked'))
}

// True when the step explicitly asks to click a radio button.
function isRadioButtonIntent(intent: string): boolean {
  const lower = intent.toLowerCase()
  return lower.includes('radio button') || lower.includes('radio input')
}

// True when the step is clicking a search submit button (not filling a search field).
function isSearchButtonIntent(intent: string): boolean {
  const lower = intent.toLowerCase()
  return lower.includes('search') && (lower.includes('button') || lower.includes('submit'))
}

function formatCandidate(el: ExtractedElement): string {
  const label = (el.label ?? el.text).slice(0, MAX_LABEL_CHARS)
  const segments = el.path.split(' > ')
  // Container = all ancestor segments; self-text is the last segment.
  const container = segments.slice(0, -1).join(' > ').slice(0, MAX_PATH_CHARS)
  const neighbors = el.siblings.join(', ').slice(0, 60)
  const tagStr = el.inputType ? `${el.tag}[${el.inputType}]` : el.tag
  return `${el.index} | "${label}" | ${container || '—'} | ${neighbors || '—'} | ${tagStr} | ${el.region}`
}

function deduplicateCandidates(candidates: ExtractedElement[]): ExtractedElement[] {
  const seen = new Set<string>()
  const result: ExtractedElement[] = []
  for (const el of candidates) {
    // Include region in the key so a drawer button (region=dialog) and a search-results
    // button (region=main) with the same path+label are NOT collapsed into one.
    // For unlabeled radio inputs, add the selector so radio buttons in the same group
    // (e.g. payment methods) are not all collapsed into the first one.
    const labelText = el.label ?? el.text
    const radioSuffix = (!labelText && el.inputType === 'radio') ? `|${el.selector}` : ''
    const key = `${el.path}|${labelText}|${el.region}${radioSuffix}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(el)
    }
  }
  return result
}

// Strict keyword filter for secondary narrowing — no fallback to full list.
// Used only when we want to reduce a pre-filtered set to a single unambiguous candidate.
function strictKeywordFilter(candidates: ExtractedElement[], intent: string): ExtractedElement[] {
  const words = (intent.toLowerCase().match(/\b\w{4,}\b/g) ?? [])
  if (words.length === 0) return candidates
  return candidates.filter(el => {
    const haystack = `${el.path} ${el.label ?? el.text}`.toLowerCase()
    return words.some(w => haystack.includes(w))
  })
}

// Keep candidates whose text or path contains at least one significant word from the
// intent. Significant = 4+ chars (skips 'the', 'for', 'and', etc.). Falls back to the
// full list when fewer than 5 candidates match, so no step is ever left with nothing.
function filterByIntentKeywords(candidates: ExtractedElement[], intent: string): ExtractedElement[] {
  const words = (intent.toLowerCase().match(/\b\w{4,}\b/g) ?? [])
  if (words.length === 0) return candidates

  const relevant = candidates.filter(el => {
    const haystack = `${el.path} ${el.label ?? el.text}`.toLowerCase()
    return words.some(w => haystack.includes(w))
  })
  return relevant.length >= 5 ? relevant : candidates
}
