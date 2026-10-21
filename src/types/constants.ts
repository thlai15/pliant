export const CONFIDENCE_THRESHOLD = 0.75
export const MIN_CONFIDENCE = 0.40
export const SCHEDULER_MIN_SCORE = 0.50
export const MAX_CONSECUTIVE_ADVANCES = 3
export const ELEMENT_SCREENSHOT_PADDING = 20

// Upper bound for BrowserDriver.waitForSettle() — network idle, then DOM ready.
export const SETTLE_TIMEOUT_MS = 5000

// Wait before re-checking assertions that failed right after an action.
export const ASSERTION_RECHECK_DELAY_MS = 2000
