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

export class CaptureError extends PliantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CaptureError'
  }
}

export class PlanParseError extends PliantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlanParseError'
  }
}
