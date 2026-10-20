import {
  BrowserDriver, ClickOptions, SelectOptionTarget, TextFilter, ScreenshotOptions,
} from '@driver/BrowserDriver'
import { BoundingBox, ExtractedElement } from '@types-local/index'

export type DriverCall = { method: string; args: unknown[] }

// In-memory BrowserDriver with no browser behind it. Tests describe the page as
// the list of elements ElementExtractor would return, and inspect `calls`.
//
// evaluate() cannot run real DOM code, so it answers by call shape:
//   - a boolean argument  → ElementExtractor.extract(): returns `elements`
//   - anything else       → returns `pageText` (page-text reads; other scripts ignore it)
export class FakeDriver implements BrowserDriver {
  readonly calls: DriverCall[] = []
  url = 'about:blank'
  elements: ExtractedElement[] = []
  pageText = ''
  // Called after every successful click, so a test can change the "page".
  onClick: (selector: string) => void = () => {}
  // Errors to throw from the next click() calls, in order.
  clickErrors: Error[] = []

  async goto(url: string): Promise<void> {
    this.record('goto', url)
    this.url = url
  }

  async currentUrl(): Promise<string> {
    return this.url
  }

  async waitForSettle(timeoutMs?: number): Promise<void> {
    this.record('waitForSettle', timeoutMs)
  }

  evaluate<R>(fn: () => R): Promise<R>
  evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R>
  async evaluate<A, R>(_fn: (arg: A) => R, arg?: A): Promise<R> {
    this.record('evaluate', arg)
    return (typeof arg === 'boolean' ? this.elements : this.pageText) as R
  }

  async addInitScript(_fn: () => void): Promise<void> {
    this.record('addInitScript')
  }

  async click(selector: string, options: ClickOptions = {}): Promise<void> {
    this.record('click', selector, options)
    const error = this.clickErrors.shift()
    if (error !== undefined) throw error
    this.onClick(selector)
  }

  async typeText(selector: string, text: string, delayMs?: number): Promise<void> {
    this.record('typeText', selector, text, delayMs)
  }

  async selectOption(selector: string, option: SelectOptionTarget): Promise<void> {
    this.record('selectOption', selector, option)
  }

  async optionLabels(selector: string): Promise<string[]> {
    this.record('optionLabels', selector)
    return []
  }

  async pressKey(key: string): Promise<void> {
    this.record('pressKey', key)
  }

  async moveMouse(x: number, y: number, steps?: number): Promise<void> {
    this.record('moveMouse', x, y, steps)
  }

  async boundingBox(selector: string): Promise<BoundingBox | null> {
    return this.elements.find(el => el.selector === selector)?.boundingBox ?? null
  }

  async isVisible(selector: string, options?: TextFilter): Promise<boolean> {
    this.record('isVisible', selector, options)
    return false
  }

  async waitForVisible(selector: string, timeoutMs: number, options?: TextFilter): Promise<boolean> {
    this.record('waitForVisible', selector, timeoutMs, options)
    return false
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    this.record('screenshot', options)
    return Buffer.alloc(0)
  }

  async close(): Promise<void> {
    this.record('close')
  }

  callsTo(method: string): unknown[][] {
    return this.calls.filter(c => c.method === method).map(c => c.args)
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }
}

// Builds an ExtractedElement with sensible defaults for tests.
export function fakeElement(overrides: Partial<ExtractedElement> & Pick<ExtractedElement, 'index' | 'tag' | 'selector'>): ExtractedElement {
  return {
    role: null,
    label: null,
    text: '',
    path: `main > ${overrides.tag}`,
    events: [],
    region: 'main',
    boundingBox: { x: 10, y: 10 + overrides.index * 30, width: 100, height: 24 },
    relativePosition: 'mid-center',
    siblings: [],
    inputType: null,
    ...overrides,
  }
}
