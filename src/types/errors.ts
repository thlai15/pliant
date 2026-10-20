export class PliantError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PliantError'
  }
}

export class LLMParseError extends PliantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LLMParseError'
  }
}

export class LLMApiError extends PliantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LLMApiError'
  }
}

// The model declined the request (stop_reason "refusal"). Retrying the same request
// would be declined again, so callers should not retry.
export class LLMRefusalError extends LLMApiError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LLMRefusalError'
  }
}

export class CaptureError extends PliantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CaptureError'
  }
}

// Raised by a BrowserDriver when another element (usually an overlay) would
// receive the click instead of the target.
export class ClickInterceptedError extends PliantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClickInterceptedError'
  }
}

// Raised by a BrowserDriver when a navigation destroys the page's script
// context while a script is running.
export class ExecutionContextDestroyedError extends PliantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExecutionContextDestroyedError'
  }
}

export class PlanParseError extends PliantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlanParseError'
  }
}
