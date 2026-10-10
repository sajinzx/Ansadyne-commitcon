import { defineConfig } from '@playwright/test';

// End-to-end tests of the static web build (the whole backend in the browser). By default they run against a local
// `vite preview` of `pnpm build:pages`; set PAGES_URL to test the deployed site instead.
const url = process.env.PAGES_URL ?? 'http://127.0.0.1:4173/Ansadyne-commitcon/';
export default defineConfig({
  testDir: './e2e-pages',
  timeout: 240_000,
  workers: 1,
  use: {
    baseURL: url,
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: process.env.PAGES_URL
    ? undefined
    : { command: 'VITE_BASE=/Ansadyne-commitcon/ pnpm exec vite preview --port 4173 --host 127.0.0.1', url, reuseExistingServer: true },
});
