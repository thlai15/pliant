import type { Page } from '@playwright/test'
import { writeFile, mkdir } from 'fs/promises'
import * as path from 'path'
import { ExtractedElement, StepScreenshots } from '@types-local/index'
import { ELEMENT_SCREENSHOT_PADDING } from '@types-local/constants'
import { createLogger } from '@types-local/logger'

const logger = createLogger('ScreenshotManager')

export class ScreenshotManager {
  constructor(private readonly screenshotDir: string) {}

  async capture(
    page: Page,
    element: ExtractedElement | null,
    stepNumber: number
  ): Promise<StepScreenshots> {
    await mkdir(this.screenshotDir, { recursive: true })

    const prefix = `step-${String(stepNumber).padStart(2, '0')}`
    const fullPath = path.join(this.screenshotDir, `${prefix}-full.png`)

    try {
      const fullBuffer = await page.screenshot({ fullPage: true })
      await writeFile(fullPath, fullBuffer)
    } catch (error) {
      logger.warn(`Full-page screenshot failed for step ${stepNumber}: ${String(error)}`)
      return { fullPage: fullPath, element: null }
    }

    if (element === null || element.boundingBox.width === 0 || element.boundingBox.height === 0) {
      return { fullPage: fullPath, element: null }
    }

    const bb = element.boundingBox
    const x      = Math.max(0, bb.x - ELEMENT_SCREENSHOT_PADDING)
    const y      = Math.max(0, bb.y - ELEMENT_SCREENSHOT_PADDING)
    const width  = bb.width  + ELEMENT_SCREENSHOT_PADDING * 2
    const height = bb.height + ELEMENT_SCREENSHOT_PADDING * 2

    const elementPath = path.join(this.screenshotDir, `${prefix}-element.png`)
    try {
      const elBuffer = await page.screenshot({ clip: { x, y, width, height } })
      await writeFile(elementPath, elBuffer)
      return { fullPage: fullPath, element: elementPath }
    } catch (error) {
      logger.warn(`Element screenshot failed for step ${stepNumber}: ${String(error)}`)
      return { fullPage: fullPath, element: null }
    }
  }
}
