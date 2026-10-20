import { test, expect } from '@playwright/test'
import * as path from 'path'
import { PlaywrightDriver } from '@driver/PlaywrightDriver'
import { ClickInterceptedError, ExecutionContextDestroyedError } from '@types-local/errors'

// Contract tests for BrowserDriver, run against PlaywrightDriver and a local
// HTML fixture. A new driver should pass the same cases.

const FIXTURE_URL = `file://${path.resolve(__dirname, '../../fixtures/html/driver-contract.html')}`

test.describe('PlaywrightDriver — BrowserDriver contract', () => {
  test('goto and currentUrl', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    expect(await driver.currentUrl()).toBe(FIXTURE_URL)
  })

  test('waitForSettle resolves on a loaded page', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    await expect(driver.waitForSettle(1000)).resolves.toBeUndefined()
  })

  test('evaluate runs with and without an argument', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    expect(await driver.evaluate(() => document.title)).toBe('Driver contract fixture')
    expect(await driver.evaluate((n: number) => n * 2, 21)).toBe(42)
  })

  test('addInitScript runs before the page scripts', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.addInitScript(() => {
      (window as unknown as { __initScriptRan: boolean }).__initScriptRan = true
    })
    await driver.goto(FIXTURE_URL)
    const sawInit = await driver.evaluate(() => (window as unknown as { pageScriptSawInit: boolean }).pageScriptSawInit)
    expect(sawInit).toBe(true)
  })

  test('click activates the element', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    await driver.click('#counter')
    await driver.click('#counter')
    expect(await page.getAttribute('#counter', 'data-clicks')).toBe('2')
  })

  test('click throws ClickInterceptedError when an overlay covers the target', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    await page.evaluate(() => document.body.classList.add('blocked'))
    const error = await driver.click('#counter', { timeoutMs: 1000 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ClickInterceptedError)
  })

  // A forced click skips the overlay check and does not throw. The mouse event
  // still lands on whatever is on top, so the target itself may not receive it.
  test('force click does not throw when an overlay covers the target', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    await page.evaluate(() => document.body.classList.add('blocked'))
    await expect(driver.click('#counter', { force: true, timeoutMs: 1000 })).resolves.toBeUndefined()
  })

  test('typeText replaces the existing value', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    await driver.typeText('#name', 'Alex Tester', 5)
    expect(await page.inputValue('#name')).toBe('Alex Tester')
  })

  test('selectOption by value and by label', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    await driver.selectOption('#state', { value: 'CA' })
    expect(await page.inputValue('#state')).toBe('CA')
    await driver.selectOption('#state', { label: 'New York' })
    expect(await page.inputValue('#state')).toBe('NY')
  })

  test('selectOption rejects an option that does not exist', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    await expect(driver.selectOption('#state', { value: 'TX' })).rejects.toThrow()
  })

  test('optionLabels lists every option', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    expect(await driver.optionLabels('#state')).toEqual(['Select state', 'California', 'New York'])
  })

  test('pressKey sends a key to the focused element', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    await page.focus('#name')
    await page.evaluate(() => { (document.getElementById('name') as HTMLInputElement).value = '' })
    await driver.pressKey('A')
    expect(await page.inputValue('#name')).toBe('A')
  })

  test('isVisible honours visibility and the hasText filter', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    expect(await driver.isVisible('#name')).toBe(true)
    expect(await driver.isVisible('#hidden')).toBe(false)
    expect(await driver.isVisible('#does-not-exist')).toBe(false)
    expect(await driver.isVisible('[role="dialog"] button', { hasText: /add.*cart/i })).toBe(true)
    expect(await driver.isVisible('[role="dialog"] button', { hasText: /checkout/i })).toBe(false)
  })

  test('waitForVisible returns true when present and false on timeout', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    expect(await driver.waitForVisible('[role="dialog"] button', 500, { hasText: /close/i })).toBe(true)
    expect(await driver.waitForVisible('#hidden', 200)).toBe(false)
  })

  test('boundingBox and moveMouse', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    const box = await driver.boundingBox('#go')
    expect(box).not.toBeNull()
    if (box === null) return
    expect(box.width).toBeGreaterThan(0)
    await expect(driver.moveMouse(box.x + 1, box.y + 1, 3)).resolves.toBeUndefined()
  })

  test('screenshot returns PNG data, full page and clipped', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const full = await driver.screenshot({ fullPage: true })
    const clip = await driver.screenshot({ clip: { x: 0, y: 0, width: 50, height: 20 } })
    expect(full.subarray(0, 4).equals(PNG_MAGIC)).toBe(true)
    expect(clip.subarray(0, 4).equals(PNG_MAGIC)).toBe(true)
  })

  test('evaluate throws ExecutionContextDestroyedError when the page navigates mid-script', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.goto(FIXTURE_URL)
    const error = await driver.evaluate((url: string) => {
      window.location.href = url
      return new Promise<never>(() => {})
    }, `${FIXTURE_URL}?next`).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExecutionContextDestroyedError)
  })

  test('close leaves a borrowed page open', async ({ page }) => {
    const driver = new PlaywrightDriver(page)
    await driver.close()
    expect(page.isClosed()).toBe(false)
  })
})
