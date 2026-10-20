import { chromium, firefox, webkit } from '@playwright/test'
import type { Browser, Locator, Page } from '@playwright/test'
import {
  BrowserDriver, ClickOptions, SelectOptionTarget, TextFilter, ScreenshotOptions,
} from '@driver/BrowserDriver'
import { BoundingBox, BrowserType } from '@types-local/index'
import { ClickInterceptedError, ExecutionContextDestroyedError } from '@types-local/errors'
import { SETTLE_TIMEOUT_MS } from '@types-local/constants'

export interface PlaywrightLaunchOptions {
  browserType: BrowserType
  headless: boolean
  slowMo: number
  viewport: { width: number; height: number }
}

// The only file in src/ that imports Playwright. Everything else talks to BrowserDriver.
export class PlaywrightDriver implements BrowserDriver {
  // `browser` is null when wrapping a page whose lifecycle someone else owns
  // (e.g. the `page` fixture in unit tests); close() then leaves it open.
  constructor(
    private readonly page: Page,
    private readonly browser: Browser | null = null,
  ) {}

  static async launch(options: PlaywrightLaunchOptions): Promise<PlaywrightDriver> {
    const browserModule = options.browserType === 'firefox' ? firefox
      : options.browserType === 'webkit' ? webkit
      : chromium

    // Chromium gets an extra arg to suppress the automation banner; Firefox/WebKit do not.
    const launchOptions = options.browserType === 'chromium'
      ? { headless: options.headless, slowMo: options.slowMo, args: ['--disable-blink-features=AutomationControlled'] }
      : { headless: options.headless, slowMo: options.slowMo }

    const browser = await browserModule.launch(launchOptions)
    try {
      const context = await browser.newContext({ viewport: options.viewport })
      const page = await context.newPage()
      return new PlaywrightDriver(page, browser)
    } catch (error) {
      await browser.close().catch(() => {})
      throw error
    }
  }

  // ── navigation and page state ──────────────────────────────────────────────

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async currentUrl(): Promise<string> {
    return this.page.url()
  }

  async waitForSettle(timeoutMs: number = SETTLE_TIMEOUT_MS): Promise<void> {
    try {
      await this.page.waitForLoadState('networkidle', { timeout: timeoutMs })
    } catch {
      try {
        await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs })
      } catch {
        // best-effort: the interface promises to resolve even when the page never settles
      }
    }
  }

  // ── scripts ────────────────────────────────────────────────────────────────

  evaluate<R>(fn: () => R): Promise<R>
  evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R>
  async evaluate<A, R>(fn: (arg: A) => R, arg?: A): Promise<R> {
    try {
      return await this.page.evaluate(fn as (arg: unknown) => R, arg)
    } catch (error) {
      if (String(error).includes('context was destroyed')) {
        throw new ExecutionContextDestroyedError('Page navigated while a script was running', { cause: error })
      }
      throw error
    }
  }

  async addInitScript(fn: () => void): Promise<void> {
    await this.page.addInitScript(fn)
  }

  // ── interaction ────────────────────────────────────────────────────────────

  async click(selector: string, options: ClickOptions = {}): Promise<void> {
    const clickOptions: { timeout?: number; force?: boolean } = {}
    if (options.timeoutMs !== undefined) clickOptions.timeout = options.timeoutMs
    if (options.force !== undefined) clickOptions.force = options.force
    try {
      await this.first(selector).click(clickOptions)
    } catch (error) {
      if (String(error).includes('intercepts pointer events')) {
        throw new ClickInterceptedError(`Click on "${selector}" intercepted by another element`, { cause: error })
      }
      throw error
    }
  }

  async typeText(selector: string, text: string, delayMs: number = 0): Promise<void> {
    const locator = this.first(selector)
    await locator.fill('')
    await locator.pressSequentially(text, { delay: delayMs })
  }

  async selectOption(selector: string, option: SelectOptionTarget): Promise<void> {
    await this.first(selector).selectOption(option, { timeout: 3000 })
  }

  async optionLabels(selector: string): Promise<string[]> {
    return this.first(selector).locator('option').allTextContents()
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key)
  }

  async moveMouse(x: number, y: number, steps: number = 1): Promise<void> {
    await this.page.mouse.move(x, y, { steps })
  }

  // ── queries ────────────────────────────────────────────────────────────────

  async boundingBox(selector: string): Promise<BoundingBox | null> {
    return this.first(selector).boundingBox().catch(() => null)
  }

  async isVisible(selector: string, options: TextFilter = {}): Promise<boolean> {
    return this.filtered(selector, options).isVisible().catch(() => false)
  }

  async waitForVisible(selector: string, timeoutMs: number, options: TextFilter = {}): Promise<boolean> {
    return this.filtered(selector, options)
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false)
  }

  // ── capture and lifecycle ──────────────────────────────────────────────────

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const shotOptions: { fullPage?: boolean; clip?: BoundingBox } = {}
    if (options.fullPage !== undefined) shotOptions.fullPage = options.fullPage
    if (options.clip !== undefined) shotOptions.clip = options.clip
    return this.page.screenshot(shotOptions)
  }

  async close(): Promise<void> {
    if (this.browser !== null) await this.browser.close()
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private first(selector: string): Locator {
    return this.page.locator(selector).first()
  }

  private filtered(selector: string, options: TextFilter): Locator {
    const base = this.page.locator(selector)
    return (options.hasText !== undefined ? base.filter({ hasText: options.hasText }) : base).first()
  }
}
