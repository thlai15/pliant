import { test, expect } from '@playwright/test'
import { readdir, readFile } from 'fs/promises'
import * as path from 'path'

// Keeps the browser layer swappable: only the concrete driver may import a
// browser library, and only PlanRunner may construct a concrete driver.

const SRC = path.resolve(__dirname, '../../../src')

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  }))
  return nested.flat()
}

async function filesImporting(pattern: RegExp): Promise<string[]> {
  const files = await sourceFiles(SRC)
  const hits: string[] = []
  for (const file of files) {
    if (pattern.test(await readFile(file, 'utf-8'))) hits.push(path.relative(SRC, file))
  }
  return hits.sort()
}

test('only the Playwright driver imports Playwright', async () => {
  const hits = await filesImporting(/from ['"](@playwright\/test|playwright(-core)?)['"]/)
  expect(hits).toEqual(['driver/PlaywrightDriver.ts'])
})

test('only PlanRunner constructs a concrete driver', async () => {
  const hits = await filesImporting(/import .*PlaywrightDriver/)
  expect(hits).toEqual(['runner/PlanRunner.ts'])
})
