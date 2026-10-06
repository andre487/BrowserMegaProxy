import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.mjs',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: { command: 'node tests/serve.mjs', port: 8765, reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } }
  ]
})
