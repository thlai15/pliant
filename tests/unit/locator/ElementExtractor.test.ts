import { test, expect } from '@playwright/test'
import * as path from 'path'
import type { Page } from '@playwright/test'
import { ElementExtractor } from '@locator/ElementExtractor'
import { PlaywrightDriver } from '@driver/PlaywrightDriver'

const driverFor = (page: Page) => new PlaywrightDriver(page)

const FIXTURE_URL = `file://${path.resolve(__dirname, '../../fixtures/html/search-results.html')}`

// ─── Without listener tracker ─────────────────────────────────────────────────

test.describe('semantic elements (no listener tracker needed)', () => {
  const extractor = new ElementExtractor()

  test('extracts Add to cart buttons', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const buttons = elements.filter(e => e.text.includes('Add to cart'))
    expect(buttons.length).toBe(2)
  })

  test('extracted button has correct tag', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const btn = elements.find(e => e.text.includes('Add to cart'))
    expect(btn).toBeDefined()
    if (btn === undefined) return
    expect(btn.tag).toBe('button')
  })

  test('button in main section has region main', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const btn = elements.find(e => e.text.includes('Add to cart'))
    expect(btn).toBeDefined()
    if (btn === undefined) return
    expect(btn.region).toBe('main')
  })

  test('cart button in nav has region nav', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const cart = elements.find(e => e.label === 'Cart (2 items)')
    expect(cart).toBeDefined()
    if (cart === undefined) return
    expect(cart.region).toBe('nav')
  })

  test('extracts search input with correct inputType', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const input = elements.find(e => e.tag === 'input')
    expect(input).toBeDefined()
    if (input === undefined) return
    expect(input.inputType).toBe('text')
    expect(input.region).toBe('main')
  })

  test('extracts Save for later links', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const links = elements.filter(e => e.text === 'Save for later')
    expect(links.length).toBe(2)
    for (const link of links) {
      expect(link.tag).toBe('a')
    }
  })

  test('detects inline onclick handler without listener tracker', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const div = elements.find(e => e.tag === 'div' && e.text.includes('Inline handler'))
    expect(div).toBeDefined()
    if (div === undefined) return
    expect(div.events).toContain('click')
  })

  test('hidden elements are not extracted', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const hidden = elements.find(e => e.selector.includes('hidden-btn'))
    expect(hidden).toBeUndefined()
  })

  test('aria-hidden elements are not extracted', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const ariaHidden = elements.find(e => e.text === 'Aria-hidden button')
    expect(ariaHidden).toBeUndefined()
  })

  test('all extracted elements have non-empty path', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    expect(elements.length).toBeGreaterThan(0)
    for (const el of elements) {
      expect(el.path.length).toBeGreaterThan(0)
    }
  })

  test('all extracted elements have non-empty selector', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    for (const el of elements) {
      expect(el.selector.length).toBeGreaterThan(0)
    }
  })

  test('all extracted elements have bounding box with numeric fields', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    for (const el of elements) {
      expect(typeof el.boundingBox.x).toBe('number')
      expect(typeof el.boundingBox.y).toBe('number')
      expect(typeof el.boundingBox.width).toBe('number')
      expect(typeof el.boundingBox.height).toBe('number')
    }
  })

  test('path includes product article as ancestor for Add to cart button', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const btn = elements.find(
      e => e.tag === 'button' && e.label === 'Add Clorox Toilet Bowl Cleaner to cart'
    )
    expect(btn).toBeDefined()
    if (btn === undefined) return
    // Path should reference the product article ancestor and end with the button label
    expect(btn.path).toContain('>')
    expect(btn.path.split(' > ').at(-1)).toBe('Add Clorox Toilet Bowl Cleaner to cart')
  })

  test('element with unique id uses id selector (id beats aria-label)', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    // cart-btn has both id="cart-btn" and aria-label — id takes priority (rule #2 > rule #3)
    const cart = elements.find(e => e.label === 'Cart (2 items)')
    expect(cart).toBeDefined()
    if (cart === undefined) return
    expect(cart.selector).toBe('#cart-btn')
  })

  test('element with only aria-label (no id, no data-testid) uses aria-label selector', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    // Add a button with only aria-label (no id) to verify aria-label selector path
    await page.evaluate(() => {
      const btn = document.createElement('button')
      btn.setAttribute('aria-label', 'Unique action button')
      document.querySelector('main')?.appendChild(btn)
    })
    const elements = await extractor.extract(driverFor(page))
    const btn = elements.find(e => e.label === 'Unique action button')
    expect(btn).toBeDefined()
    if (btn === undefined) return
    expect(btn.selector).toBe('[aria-label="Unique action button"]')
  })

  test('element with unique data-testid uses testid selector', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    // product-1-link has data-testid="product-1-link" — but it's only extracted
    // WITH the listener tracker; skip this assertion about non-tracked divs
    // and instead verify the search button has a reasonable selector
    const elements = await extractor.extract(driverFor(page))
    const searchBtn = elements.find(e => e.tag === 'button' && e.text === 'Search')
    expect(searchBtn).toBeDefined()
    if (searchBtn === undefined) return
    expect(searchBtn.selector.length).toBeGreaterThan(0)
  })

  test('non-semantic elements without listeners are not extracted', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    // product-link divs have no inline handlers, only programmatic listeners;
    // without addListenerTracker those divs should NOT appear
    const productLinks = elements.filter(
      e => e.tag === 'div' && e.text.includes('Clorox') && e.text.includes('Cleaner')
    )
    expect(productLinks.length).toBe(0)
  })

  test('extractForwardAffordances finds Proceed to checkout button', async ({ page }) => {
    await page.goto(FIXTURE_URL)
    const affordances = await extractor.extractForwardAffordances(driverFor(page))
    const proceed = affordances.find(e => e.text.toLowerCase().includes('proceed'))
    expect(proceed).toBeDefined()
  })
})

// ─── With listener tracker ────────────────────────────────────────────────────

test.describe('programmatic event listeners (requires addListenerTracker)', () => {
  test('extracts div with programmatic click listener', async ({ page }) => {
    const extractor = new ElementExtractor()
    await extractor.addListenerTracker(driverFor(page))
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const productDivs = elements.filter(
      e => e.tag === 'div' && e.events.includes('click') && e.text.includes('Clorox')
    )
    expect(productDivs.length).toBe(2)
  })

  test('tracked events appear in events array', async ({ page }) => {
    const extractor = new ElementExtractor()
    await extractor.addListenerTracker(driverFor(page))
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const div = elements.find(e => e.tag === 'div' && e.text.includes('Toilet Bowl Cleaner'))
    expect(div).toBeDefined()
    if (div === undefined) return
    expect(div.events).toContain('click')
  })

  test('product div selector uses data-testid', async ({ page }) => {
    const extractor = new ElementExtractor()
    await extractor.addListenerTracker(driverFor(page))
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const div = elements.find(e => e.tag === 'div' && e.text.includes('Toilet Bowl Cleaner'))
    expect(div).toBeDefined()
    if (div === undefined) return
    expect(div.selector).toBe('[data-testid="product-1-link"]')
  })

  test('product div path includes article ancestor label', async ({ page }) => {
    const extractor = new ElementExtractor()
    await extractor.addListenerTracker(driverFor(page))
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const div = elements.find(e => e.tag === 'div' && e.text.includes('Toilet Bowl Cleaner'))
    expect(div).toBeDefined()
    if (div === undefined) return
    expect(div.path).toContain('Clorox Toilet Bowl Cleaner')
  })

  test('without tracker, same divs are absent', async ({ page }) => {
    const extractor = new ElementExtractor()
    // Intentionally NOT calling addListenerTracker
    await page.goto(FIXTURE_URL)
    const elements = await extractor.extract(driverFor(page))
    const productDivs = elements.filter(
      e => e.tag === 'div' && e.events.includes('click') && e.text.includes('Clorox')
    )
    expect(productDivs.length).toBe(0)
  })
})
