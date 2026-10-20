type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function activeLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return 'info'
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export function createLogger(component: string): Logger {
  function emit(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${component}] ${message}`
    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }

  return {
    debug: (message) => emit('debug', message),
    info:  (message) => emit('info',  message),
    warn:  (message) => emit('warn',  message),
    error: (message) => emit('error', message),
  }
}
