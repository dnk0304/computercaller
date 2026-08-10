import { defineConfig, devices } from '@playwright/test';

/**
 * testDir './tests' also holds node/vitest-style unit files, so every project
 * scopes itself with testMatch rather than sweeping the directory. The mobile
 * projects deliberately run ONLY the mobile viewport spec: the existing
 * ui-audit / deep-audit specs drive the Sidebar, which Phone Mode does not
 * render, so running them under a phone viewport would fail for the wrong
 * reason.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  // Serial by necessity, not by preference: login bumps sessionVersion and
  // supersedes every other session for that user, so parallel workers sharing
  // one account sign each other out mid-test.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:3777',
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /(ui-audit|deep-audit)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'mobile-pixel5',
      testMatch: /mobile-viewport\.spec\.ts/,
      use: { ...devices['Pixel 5'] },
    },
    {
      // iPhone 13 metrics on Chromium rather than devices['iPhone 13'], which
      // pins browserName:'webkit' and fails on any machine without the WebKit
      // download. For a real iOS Safari pass (worth doing before an iOS-facing
      // release): `npx playwright install webkit`, then swap this back to
      // `...devices['iPhone 13']`.
      name: 'mobile-iphone13',
      testMatch: /mobile-viewport\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      // Smallest width we support. 320px is where fixed-width children show up.
      name: 'mobile-320',
      testMatch: /mobile-viewport\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 320, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
