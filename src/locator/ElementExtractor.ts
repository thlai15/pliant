/// <reference lib="dom" />
import { BrowserDriver } from '@driver/BrowserDriver'
import { ExtractedElement, Region, RelativePosition } from '@types-local/index'
import { PliantError } from '@types-local/errors'
import { FORWARD_AFFORDANCE_KEYWORDS } from '@locator/types'

// Extend the browser Window type so in-page code is typed without `any`.
declare global {
  interface Window {
    __pliant_listeners?: WeakMap<Element, string[]>
  }
}

export class ElementExtractor {
  // Must be called before the first navigation.
  // Wraps addEventListener so that programmatic listeners are tracked in a
  // WeakMap exposed as window.__pliant_listeners.
  async addListenerTracker(driver: BrowserDriver): Promise<void> {
    await driver.addInitScript(() => {
      const tracked = new WeakMap<Element, string[]>()
      const original = EventTarget.prototype.addEventListener
      EventTarget.prototype.addEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (this instanceof Element) {
          const existing = tracked.get(this) ?? []
          if (!existing.includes(type)) {
            tracked.set(this, [...existing, type])
          }
        }
        return original.call(this, type, listener, options)
      }
      window.__pliant_listeners = tracked
    })
  }

  async extract(driver: BrowserDriver, includeContentElements = false): Promise<ExtractedElement[]> {
    const raw: unknown = await driver.evaluate((includeContent: boolean) => {
      // ── constants ──────────────────────────────────────────────────────────
      const SEMANTIC_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea'])
      const TRACKED_EVENTS = new Set(['click', 'mousedown', 'keydown', 'keypress', 'change'])
      const INTERACTIVE_ROLES = new Set([
        'button', 'link', 'checkbox', 'menuitem', 'option',
        'radio', 'switch', 'tab', 'combobox',
      ])
      const INLINE_HANDLERS = ['onclick', 'onmousedown', 'onkeydown'] as const

      // ── helpers ────────────────────────────────────────────────────────────

      function trackedEventsFor(el: Element): string[] {
        return window.__pliant_listeners?.get(el) ?? []
      }

      function inlineEventsFor(el: Element): string[] {
        return INLINE_HANDLERS
          .filter(h => el.hasAttribute(h))
          .map(h => h.slice(2))
      }

      function isInteractive(el: Element): boolean {
        // Guard: some custom/shadow elements on retail sites surface without a tagName
        if (typeof el.tagName !== 'string') return false
        const tag = el.tagName.toLowerCase()
        if (SEMANTIC_TAGS.has(tag)) return true
        if (trackedEventsFor(el).some(e => TRACKED_EVENTS.has(e))) return true
        if (inlineEventsFor(el).length > 0) return true
        const role = el.getAttribute('role')?.toLowerCase()
        if (role !== undefined && role !== null && INTERACTIVE_ROLES.has(role)) return true
        const tabindex = el.getAttribute('tabindex')
        if (tabindex !== null && parseInt(tabindex, 10) >= 0) return true
        return false
      }

      function isVisible(el: Element): boolean {
        if (el.getAttribute('aria-hidden') === 'true') return false
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 || rect.height > 0
      }

      // Returns a concise semantic label for an ancestor element, excluding any
      // text that comes from the branch of the DOM leading to targetEl.
      // This prevents the target element's own text from bleeding into the
      // ancestor label (e.g. "Login Form Submit" → "Login Form").
      function ancestorLabel(el: Element, targetEl: Element): string | null {
        // 1. aria-label (most explicit)
        const ariaLabel = el.getAttribute('aria-label')?.trim()
        if (ariaLabel) return ariaLabel

        // 2. aria-labelledby reference
        const labelledById = el.getAttribute('aria-labelledby')
        if (labelledById) {
          const ref = document.getElementById(labelledById)
          const t = ref?.textContent?.trim()
          if (t) return t
        }

        // 3. data-testid
        const testId = el.getAttribute('data-testid')
        if (testId) {
          return testId
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, (c: string) => c.toUpperCase())
        }

        // 4. First heading inside the ancestor that is NOT in the target's branch.
        //    Using querySelectorAll so headings wrapped in intermediate divs are found;
        //    the contains() guard ensures we don't pick up a heading that IS an ancestor
        //    of targetEl (which would be labelled at its own level anyway).
        for (const h of Array.from(el.querySelectorAll('h1, h2, h3, h4'))) {
          if (!h.contains(targetEl)) {
            const t = h.textContent?.trim()
            if (t && t.length <= 60) return t
          }
        }

        // 5. Composite text from direct children, excluding the target's branch.
        //    Only activates when the ancestor has at least one direct non-whitespace
        //    text node — this distinguishes phrasing ancestors that mix text with inline
        //    tags (<b>Login</b> form) from structural containers (nav lists, grid rows)
        //    whose direct children are only elements with no adjacent text.
        //    Block-level child elements are always skipped so sibling sections or
        //    list items don't pollute the label even when el has some direct text.
        // Block-level elements + invisible/scripted elements never contribute to
        // the label — their textContent is either structural or non-visible.
        const BLOCK = new Set([
          'div','p','ul','ol','li','section','article','aside','header','footer',
          'nav','main','form','table','thead','tbody','tfoot','tr','td','th',
          'fieldset','blockquote','pre','figure','figcaption','details','summary',
          'dialog','h1','h2','h3','h4','h5','h6',
          'script','style','noscript','template',
        ])
        let hasDirectText = false
        let combined = ''
        const soloInlineChildren: Element[] = []
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE) {
            const t = node.textContent ?? ''
            if (t.trim()) hasDirectText = true
            combined += t
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const child = node as Element
            const childTag = child.tagName.toLowerCase()
            if (!child.contains(targetEl) && !BLOCK.has(childTag)) {
              combined += child.textContent ?? ''
              soloInlineChildren.push(child)
            }
          }
        }
        if (!hasDirectText) {
          // No direct text nodes. Try single-element fallback: if exactly one
          // inline child doesn't lead to the target, that child's text names
          // this ancestor (e.g. <div><label>I agree</label><input/></div>
          // → "I agree"). Requires exactly one contributor so sibling lists
          // like <a>Blue Jeans</a><span>1.00</span> are still rejected.
          if (soloInlineChildren.length !== 1) return null
          const onlyChild = soloInlineChildren[0]
          if (onlyChild === undefined) return null
          const soloText = (onlyChild.textContent ?? '').trim().replace(/\s+/g, ' ')
          if (soloText.length > 0 && soloText.length <= 60 && /[a-zA-Z0-9]{2,}/.test(soloText)) {
            return soloText
          }
          return null
        }
        const text = combined.trim().replace(/\s+/g, ' ')
        // Accept only if compact (≤ 80 chars) and has ≥ 2 consecutive alphanumeric
        // chars — drops lone punctuation ("·", "→") that adds no meaning.
        // 80 chars accommodates real-world TOS labels like
        // "I agree with the terms of service and I adhere to them unconditionally" (71 chars).
        if (text.length > 0 && text.length <= 80 && /[a-zA-Z0-9]{2,}/.test(text)) {
          return text
        }

        return null
      }

      // Element's own label for ExtractedElement.label
      // (aria-label > label[for] > placeholder > value[submit/button] > title).
      function elementLabel(el: Element): string | null {
        const ariaLabel = el.getAttribute('aria-label')?.trim()
        if (ariaLabel) return ariaLabel

        const id = el.getAttribute('id')
        if (id) {
          const labelEl = document.querySelector(`label[for="${id}"]`)
          const t = labelEl?.textContent?.trim()
          if (t) return t
        }

        // Radio/checkbox fallback: look for a sibling <label> element that is
        // contextually paired with this input (same parent <li>/<div>),
        // OR a <label> ancestor that wraps this input without a 'for' attribute,
        // OR a direct text node sibling (e.g. <div>I agree...<input/></div>).
        // Handles: adjacent label, label-without-for, label-wraps-input, and
        // plain-text-next-to-input patterns.
        const inputType = (el.getAttribute('type') ?? '').toLowerCase()
        if (inputType === 'radio' || inputType === 'checkbox') {
          const parent = el.parentElement
          if (parent) {
            // Wrapping <label> pattern: <label><input ...> text</label>
            if (parent.tagName.toLowerCase() === 'label') {
              const t = parent.textContent?.trim().replace(/\s+/g, ' ')
              if (t) return t
            }
            // Adjacent sibling <label> pattern: <label>text</label><input ...>
            for (const child of Array.from(parent.children)) {
              if (child !== el && child.tagName.toLowerCase() === 'label') {
                const t = child.textContent?.trim()
                if (t) return t
              }
            }
            // Direct text-node sibling pattern: <div>I agree...<input/></div>
            // Covers TOS-style checkboxes where the label is raw text in the parent.
            const directText = Array.from(parent.childNodes)
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => (n.textContent ?? '').trim())
              .filter(t => t.length > 0)
              .join(' ')
              .trim()
            if (directText) return directText
          }
        }

        const placeholder = el.getAttribute('placeholder')?.trim()
        if (placeholder) return placeholder

        // <input type="submit|button|reset"> renders via the value attribute, not textContent.
        if (el.tagName.toLowerCase() === 'input') {
          const type = (el.getAttribute('type') ?? 'text').toLowerCase()
          if (type === 'submit' || type === 'button' || type === 'reset') {
            const val = el.getAttribute('value')?.trim()
            if (val) return val
          }
        }

        const title = el.getAttribute('title')?.trim()
        if (title) return title

        return null
      }

      // Walk up from el collecting up to 3 ancestor labels (outermost first),
      // then append the element's own visible text as the final segment.
      function buildPath(el: Element): string {
        const segments: string[] = []
        let current: Element | null = el.parentElement
        let collected = 0

        while (current !== null && current !== document.body && collected < 3) {
          const label = ancestorLabel(current, el)
          if (label !== null) {
            // Deduplicate at collection time: the same heading is reachable from
            // multiple ancestor levels via querySelectorAll, so skip a label that
            // is identical to the one most recently added (the inner ancestor).
            if (segments.length === 0 || label !== segments[0]) {
              segments.unshift(label)
              collected++
            }
          }
          current = current.parentElement
        }

        // For submit/button/reset inputs the visible text lives in the value attribute.
        const inputValueText =
          el.tagName.toLowerCase() === 'input' &&
          ['submit', 'button', 'reset'].includes((el.getAttribute('type') ?? 'text').toLowerCase())
            ? el.getAttribute('value')?.trim()
            : undefined

        const selfText =
          el.getAttribute('aria-label')?.trim() ||
          el.getAttribute('placeholder')?.trim() ||
          (el.textContent?.trim().slice(0, 100)) ||
          inputValueText ||
          el.getAttribute('title')?.trim() ||
          el.tagName.toLowerCase()

        segments.push(selfText)
        return segments.join(' > ')
      }

      function getRegion(el: Element): string {
        let current: Element | null = el.parentElement
        while (current !== null && current !== document.documentElement) {
          const tag = current.tagName.toLowerCase()
          const role = (current.getAttribute('role') ?? '').toLowerCase()
          // Check dialog FIRST — elements inside a product drawer that is rendered
          // inside <main> must still be labelled 'dialog', not 'main'.
          if (tag === 'dialog' || role === 'dialog')        return 'dialog'
          if (tag === 'main'   || role === 'main')          return 'main'
          if (tag === 'nav'    || role === 'navigation')    return 'nav'
          if (tag === 'aside'  || role === 'complementary') return 'aside'
          if (tag === 'header' || role === 'banner')        return 'header'
          if (tag === 'footer' || role === 'contentinfo')   return 'footer'
          current = current.parentElement
        }
        return 'unknown'
      }

      function getRelativePosition(rect: DOMRect): string {
        const vw = window.innerWidth  || document.documentElement.clientWidth
        const vh = window.innerHeight || document.documentElement.clientHeight
        const cx = rect.left + rect.width  / 2
        const cy = rect.top  + rect.height / 2
        const col = cx < vw / 3 ? 'left' : cx < (2 * vw) / 3 ? 'center' : 'right'
        const row = cy < vh / 3 ? 'top'  : cy < (2 * vh) / 3 ? 'mid'    : 'bot'
        return `${row}-${col}`
      }

      function getSiblings(el: Element): string[] {
        const result: string[] = []
        const prev2 = el.previousElementSibling?.previousElementSibling
        const prev1 = el.previousElementSibling
        const next1 = el.nextElementSibling

        const text = (e: Element | null | undefined): string =>
          e?.textContent?.trim().slice(0, 50) ?? ''

        if (prev2 && text(prev2)) result.push(text(prev2))
        if (prev1 && text(prev1)) result.push(text(prev1))
        if (next1 && text(next1)) result.push(text(next1))

        return result.slice(0, 3)
      }

      function escapeAttr(v: string): string {
        return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      }

      function isUnique(selector: string): boolean {
        return document.querySelectorAll(selector).length === 1
      }

      // Collect all elements from root and any open shadow roots it contains,
      // recursing up to 5 levels deep to handle nested custom elements.
      function collectAll(root: Document | ShadowRoot, depth: number): Element[] {
        if (depth > 5) return []
        const nodes = Array.from<Element>(root.querySelectorAll('*'))
        const fromShadow: Element[] = []
        for (const el of nodes) {
          if (el.shadowRoot !== null) {
            fromShadow.push(...collectAll(el.shadowRoot, depth + 1))
          }
        }
        return [...nodes, ...fromShadow]
      }

      // inShadow: element lives inside a shadow root — standard CSS selectors won't
      // pierce the boundary, so we skip the uniqueness check and prefer attribute
      // selectors that Playwright's CSS engine resolves transparently through shadow DOM.
      function generateSelector(el: Element, inShadow: boolean): string {
        const testId = el.getAttribute('data-testid')
        if (testId) {
          const s = `[data-testid="${escapeAttr(testId)}"]`
          if (inShadow || isUnique(s)) return s
        }

        const id = el.getAttribute('id')
        if (id) {
          const s = `#${CSS.escape(id)}`
          if (inShadow || isUnique(s)) return s
        }

        const ariaLabel = el.getAttribute('aria-label')
        if (ariaLabel) {
          const s = `[aria-label="${escapeAttr(ariaLabel)}"]`
          if (inShadow || isUnique(s)) return s
        }

        // For shadow DOM elements, also try placeholder and type-qualified tag before
        // falling back to structural selectors (which won't cross shadow boundaries).
        if (inShadow) {
          const placeholder = el.getAttribute('placeholder')
          if (placeholder) return `[placeholder="${escapeAttr(placeholder)}"]`
          const tag = el.tagName.toLowerCase()
          const type = el.getAttribute('type')
          if (type) return `${tag}[type="${escapeAttr(type)}"]`
          const name = el.getAttribute('name')
          if (name) return `[name="${escapeAttr(name)}"]`
          return tag
        }

        // Short nth-of-type path up to 4 levels from element
        const parts: string[] = []
        let cur: Element | null = el
        for (let i = 0; i < 4 && cur !== null && cur !== document.body; i++) {
          const tag = cur.tagName.toLowerCase()
          const parent: Element | null = cur.parentElement
          if (parent === null) break
          const sameTag = Array.from<Element>(parent.children).filter(c => c.tagName === cur!.tagName)
          if (sameTag.length > 1) {
            parts.unshift(`${tag}:nth-of-type(${sameTag.indexOf(cur) + 1})`)
          } else {
            parts.unshift(tag)
          }
          if (['main', 'nav', 'header', 'footer', 'aside', 'dialog'].includes(tag)) break
          cur = parent
        }
        return parts.join(' > ')
      }

      // ── main extraction ────────────────────────────────────────────────────

      type RawElement = {
        index: number
        tag: string
        role: string | null
        label: string | null
        text: string
        path: string
        events: string[]
        region: string
        boundingBox: { x: number; y: number; width: number; height: number }
        relativePosition: string
        siblings: string[]
        selector: string
        inputType: string | null
      }

      const allNodes = collectAll(document, 0).filter(el => typeof el.tagName === 'string')
      const interactiveEls = allNodes.filter(el => isInteractive(el) && isVisible(el))

      // Non-interactive text-bearing elements (headings, table cells, price spans, etc.)
      // included when the caller needs to read displayed values such as prices.
      // Indices start at 10000 to avoid collision with the interactive element range.
      const CONTENT_TAGS = new Set(['h1','h2','h3','h4','p','span','td','th','li','label','strong','em','dt','dd'])
      const contentEls = includeContent
        ? allNodes.filter(el => {
            if (isInteractive(el) || !isVisible(el)) return false
            if (!CONTENT_TAGS.has(el.tagName.toLowerCase())) return false
            return Array.from(el.childNodes).some(
              n => n.nodeType === Node.TEXT_NODE && (n.textContent?.trim().length ?? 0) > 3
            )
          })
        : []

      function mapEl(el: Element, index: number): RawElement {
        const rect     = el.getBoundingClientRect()
        const tag      = el.tagName.toLowerCase()
        const events   = [...new Set([...trackedEventsFor(el), ...inlineEventsFor(el)])]
        const inShadow = el.getRootNode() !== document
        return {
          index,
          tag,
          role:      el.getAttribute('role'),
          label:     elementLabel(el),
          text:      (el.textContent ?? '').trim().slice(0, 100),
          path:      buildPath(el),
          events,
          region:    getRegion(el),
          boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          relativePosition: getRelativePosition(rect),
          siblings:  getSiblings(el),
          selector:  generateSelector(el, inShadow),
          inputType: tag === 'input' ? (el.getAttribute('type') ?? 'text') : null,
        }
      }

      const result: RawElement[] = [
        ...interactiveEls.map((el, i) => mapEl(el, i)),
        ...contentEls.map((el, i) => mapEl(el, 10000 + i)),
      ]

      return result
    }, includeContentElements)

    if (!isExtractedElementArray(raw)) {
      throw new PliantError('ElementExtractor: unexpected extraction result shape')
    }

    return raw
  }

  // Returns elements whose visible text matches any forward-progression keyword.
  // Prefers elements in the "main" region; falls back to any region.
  async extractForwardAffordances(driver: BrowserDriver): Promise<ExtractedElement[]> {
    const all = await this.extract(driver)
    const keywords = FORWARD_AFFORDANCE_KEYWORDS as readonly string[]

    const matches = all.filter(el => {
      const t = el.text.toLowerCase()
      return keywords.some(kw => t.includes(kw))
    })

    const mainOnly = matches.filter(el => el.region === 'main')
    return mainOnly.length > 0 ? mainOnly : matches
  }
}

// ── runtime type guards ───────────────────────────────────────────────────────

function isExtractedElementArray(value: unknown): value is ExtractedElement[] {
  return Array.isArray(value) && value.every(isExtractedElement)
}

function isExtractedElement(value: unknown): value is ExtractedElement {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  const bb = o['boundingBox']
  return (
    typeof o['index']    === 'number' &&
    typeof o['tag']      === 'string' &&
    typeof o['text']     === 'string' &&
    typeof o['path']     === 'string' &&
    typeof o['selector'] === 'string' &&
    typeof o['region']   === 'string' &&
    typeof o['relativePosition'] === 'string' &&
    Array.isArray(o['events'])   &&
    Array.isArray(o['siblings']) &&
    (o['role']      === null || typeof o['role']      === 'string') &&
    (o['label']     === null || typeof o['label']     === 'string') &&
    (o['inputType'] === null || typeof o['inputType'] === 'string') &&
    typeof bb === 'object' && bb !== null
  )
}

// Narrow the region string to the Region union (invalid values become 'unknown').
export function coerceRegion(r: string): Region {
  const valid: Region[] = ['main', 'nav', 'aside', 'header', 'footer', 'dialog', 'unknown']
  return valid.includes(r as Region) ? (r as Region) : 'unknown'
}

// Narrow the relativePosition string to the RelativePosition union.
export function coerceRelativePosition(r: string): RelativePosition {
  const valid: RelativePosition[] = [
    'top-left', 'top-center', 'top-right',
    'mid-left', 'mid-center', 'mid-right',
    'bot-left', 'bot-center', 'bot-right',
  ]
  return valid.includes(r as RelativePosition) ? (r as RelativePosition) : 'mid-center'
}
