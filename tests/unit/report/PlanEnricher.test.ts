import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PlanEnricher } from '@report/PlanEnricher'
import { fakeElement } from '@fixtures/FakeDriver'

const PLAN = `# Test plan

### 1. Search

**Steps:**

1. Click the search button
   - expect: Results are displayed
`

const searchButton = fakeElement({
  index: 1, tag: 'button', selector: '#go', label: 'Search', text: 'Search', path: 'Header > Search',
})

async function withPlan(run: (source: string, output: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pliant-enricher-'))
  try {
    const source = path.join(dir, 'plan.md')
    await writeFile(source, PLAN, 'utf-8')
    await run(source, path.join(dir, 'run', 'enriched-plan.md'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('writes hints to the output copy and leaves the source plan untouched', async () => {
  await withPlan(async (source, output) => {
    const enricher = new PlanEnricher(source, output)
    await enricher.enrich(1, 'Click the search button', searchButton, 0.95)

    expect(await readFile(source, 'utf-8')).toBe(PLAN)
    expect(enricher.wroteOutput).toBe(true)
    expect(await readFile(output, 'utf-8')).toContain('"label":"Search"')
  })
})

test('creates no output when nothing is worth recording', async () => {
  await withPlan(async (source, output) => {
    const enricher = new PlanEnricher(source, output)
    await enricher.enrich(1, 'Click the search button', searchButton, 0.1)

    expect(enricher.wroteOutput).toBe(false)
    expect(existsSync(output)).toBe(false)
    expect(await readFile(source, 'utf-8')).toBe(PLAN)
  })
})

test('refuses to use the source plan as its output', async () => {
  await withPlan(async source => {
    expect(() => new PlanEnricher(source, source)).toThrow()
  })
})
