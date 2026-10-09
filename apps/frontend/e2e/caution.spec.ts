import { expect, test } from '@playwright/test';

// FRONTEND F.9 test 4: create a run, start at 20×, inject a caution; within one displayed lap the flag chip turns
// amber, the map shows caution, a decision appears with a trigger badge, the audit log gains an entry and a caution
// band appears on the position chart.
test('caution scenario end to end', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '20x' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('ego-car')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Inject caution' }).click();
  await expect(page.getByTestId('flag-chip')).toContainText('CAUTION', { timeout: 60_000 });
  await expect(page.getByText('CAUTION · FIELD BUNCHED')).toBeVisible();
  await expect(page.getByTestId('decision-table')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('audit-log')).toContainText('injected caution', { timeout: 60_000 });
  await expect(page.getByTestId('caution-band').first()).toBeVisible({ timeout: 60_000 });
});
