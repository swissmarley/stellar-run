import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/stellar-run/`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: `http://localhost:${PORT}/stellar-run/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    { name: 'android-chromium', use: { ...devices['Pixel 7'] } },
    {
      name: 'foldable-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 673, height: 841 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: 'ios-webkit', use: { ...devices['iPhone 15'] } },
  ],
});
