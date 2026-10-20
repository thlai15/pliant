import { BoundingBox } from '@types-local/index'

// Every browser interaction Pliant performs goes through this interface.
// Elements are addressed by CSS selector (ExtractedElement.selector). When a
// selector matches several elements, implementations act on the first one.
//
// Implementations translate their library's failures into the typed errors in
// src/types/errors.ts (ClickInterceptedError, ExecutionContextDestroyedError)
// so callers never inspect library-specific error messages.
export interface BrowserDriver {
  // ── navigation and page state ──────────────────────────────────────────────
  goto(url: string): Promise<void>
  currentUrl(): Promise<string>
  // Waits for network activity to stop, falling back to DOM-ready. Best effort:
  // resolves (never throws) when the page does not settle within the timeout.
  waitForSettle(timeoutMs?: number): Promise<void>

  // ── scripts ────────────────────────────────────────────────────────────────
  // Runs `fn` in the page and returns its JSON-serialisable result.
  evaluate<R>(fn: () => R): Promise<R>
  evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R>
  // Registers `fn` to run in every new document before the page's own scripts.
  addInitScript(fn: () => void): Promise<void>

  // ── interaction ────────────────────────────────────────────────────────────
  click(selector: string, options?: ClickOptions): Promise<void>
  // Replaces the field's value, typing one character at a time when delayMs > 0.
  typeText(selector: string, text: string, delayMs?: number): Promise<void>
  selectOption(selector: string, option: SelectOptionTarget): Promise<void>
  // Visible text of every <option> in the <select> matched by `selector`.
  optionLabels(selector: string): Promise<string[]>
  pressKey(key: string): Promise<void>
  moveMouse(x: number, y: number, steps?: number): Promise<void>

  // ── queries ────────────────────────────────────────────────────────────────
  boundingBox(selector: string): Promise<BoundingBox | null>
  // True when the first element matching `selector` (and `hasText`, if given) is visible.
  isVisible(selector: string, options?: TextFilter): Promise<boolean>
  // Resolves true once a matching element is visible, false on timeout.
  waitForVisible(selector: string, timeoutMs: number, options?: TextFilter): Promise<boolean>

  // ── capture and lifecycle ──────────────────────────────────────────────────
  screenshot(options?: ScreenshotOptions): Promise<Buffer>
  close(): Promise<void>
}

export interface ClickOptions {
  timeoutMs?: number
  // Skip actionability checks (overlays, animations) and click anyway.
  force?: boolean
}

export type SelectOptionTarget = { value: string } | { label: string }

export interface TextFilter {
  hasText?: RegExp
}

export interface ScreenshotOptions {
  fullPage?: boolean
  clip?: BoundingBox
}

export type DriverName = 'playwright'
