import { defineConfig } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadDotenv(filePath: string): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    const value =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotenv(resolve(__dirname, '.env'));

export default defineConfig({
  // Pliant does not use Playwright's test runner for the main framework.
  // This config exists for unit tests in tests/unit/ only.
  testDir: './tests/unit',
  timeout: 30_000,
  use: {
    headless: process.env.HEADLESS !== 'false',
    launchOptions: {
      slowMo: Number(process.env.SLOW_MO ?? 0),
    },
    screenshot: 'only-on-failure',
    video: 'off',
  },
  reporter: [['list'], ['html', { outputFolder: 'reports/unit', open: 'never' }]],
});
