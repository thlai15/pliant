import { Step, ExtractedElement, ElementHint } from '@types-local/index'
import { createLogger } from '@types-local/logger'

const logger = createLogger('StepScheduler')

export class StepScheduler {
  private readonly pending = new Map<string, Step>()
  private readonly completedIds = new Set<string>()

  constructor(steps: Step[]) {
    for (const step of steps) {
      this.pending.set(step.id, step)
    }
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }

  // Returns the first eligible step in plan order, respecting after: dependencies.
  next(): Step | null {
    for (const step of this.pending.values()) {
      if (step.after.every(id => this.completedIds.has(id))) {
        return step
      }
    }
    return null
  }

  // Returns pending steps within `range` positions of targetNumber,
  // sorted by proximity (closest first), excluding targetNumber itself.
  peekAdjacent(targetNumber: number, range: number): Step[] {
    const result: Step[] = []
    for (const step of this.pending.values()) {
      const distance = Math.abs(step.number - targetNumber)
      if (distance > 0 && distance <= range && step.after.every(id => this.completedIds.has(id))) {
        result.push(step)
      }
    }
    return result.sort((a, b) =>
      Math.abs(a.number - targetNumber) - Math.abs(b.number - targetNumber)
    )
  }

  markComplete(step: Step): void {
    this.pending.delete(step.id)
    this.completedIds.add(step.id)
  }

  drainPending(): Step[] {
    const remaining = [...this.pending.values()]
    this.pending.clear()
    return remaining
  }

  // Returns unexecuted steps whose element hint matches something currently visible
  // in the extracted DOM candidates. Used for page-state-driven recovery: when a
  // target step's element is not found, check if other steps can be executed on the
  // current page instead, then retry the target after they complete.
  findByPageState(candidates: ExtractedElement[]): Step[] {
    const result: Step[] = []
    for (const step of this.pending.values()) {
      if (step.element === null) continue
      if (isHintVisible(step.element, candidates)) {
        result.push(step)
      }
    }
    return result
  }
}

function isHintVisible(hint: ElementHint, candidates: ExtractedElement[]): boolean {
  const hintLabel = hint.label.toLowerCase()
  return candidates.some(el => {
    const elLabel = (el.label ?? el.text).toLowerCase()
    const labelMatch = elLabel.includes(hintLabel) || hintLabel.includes(elLabel)
    if (!labelMatch) return false
    if (hint.container.length === 0) return true
    const path = el.path.toLowerCase()
    return hint.container.some(c => path.includes(c.toLowerCase()))
  })
}
