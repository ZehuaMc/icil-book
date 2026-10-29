import { defineConfig, devices } from '@playwright/test';
if (!process.env.DATABASE_URL || !process.env.ADMIN_STUDENT_ID || !process.env.ADMIN_PASSWORD) throw new Error('浏览器验证需要 DATABASE_URL、ADMIN_STUDENT_ID 和 ADMIN_PASSWORD；请配置并初始化专用测试数据库');
export default defineConfig({
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'reports/playwright.json' }]],
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 60000,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL ? undefined : { command: process.env.E2E_SERVER_COMMAND ?? 'npm run dev', url: 'http://127.0.0.1:3000', reuseExistingServer: process.env.E2E_REUSE_SERVER === 'true', timeout: 120000 },
});
