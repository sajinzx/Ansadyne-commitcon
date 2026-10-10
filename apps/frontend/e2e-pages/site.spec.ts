import { expect, test, type Page } from '@playwright/test';

// The deployed static site: no server, races, jobs and model builds all run in Web Workers.

async function startRace(page: Page, trackId: string) {
  await page.goto('./');
  await expect(page.getByTestId('track-select')).toBeVisible();
  await page.getByTestId('track-select').selectOption(trackId);
  await page.getByRole('button', { name: '20x' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('ego-car')).toBeVisible({ timeout: 90_000 });
}

test('the track picker lists the five circuits', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('track-select').locator('option')).toHaveCount(5);
  const options = await page.getByTestId('track-select').locator('option').allTextContents();
  expect(options.join(' | ')).toMatch(/Daytona.*Sebring.*Road Atlanta.*Watkins Glen.*Spa/);
});

test('a race on Road Atlanta: team names, live radio from the green flag, caution call', async ({ page }) => {
  await startRace(page, 'road-atlanta');
  await expect(page.getByText(/Michelin Raceway Road Atlanta/).first()).toBeVisible();
  // team radio speaks at the green flag, naming our team
  await expect(page.getByTestId('radio-latest')).toContainText(/Lights out — Ansadyne/i, { timeout: 60_000 });
  // the race table shows F1 team names and ours
  const table = page.locator('table.data').filter({ hasText: 'Team' }).first();
  await expect(table).toContainText('Ansadyne');
  await expect(table).toContainText(/McLaren|Ferrari|Mercedes|Red Bull Racing/);
  // a status call within 5 laps names the cars around us
  await expect(page.getByTestId('radio-latest')).toContainText(/Lap \d+ — P\d+/i, { timeout: 90_000 });
  // inject a caution: the flag turns amber and the radio calls it
  await page.getByRole('button', { name: 'Inject caution' }).click();
  await expect(page.getByTestId('flag-chip')).toContainText('CAUTION', { timeout: 90_000 });
  await expect(page.getByText(/Full-course caution|Pit lane open/).first()).toBeVisible({ timeout: 90_000 });
});

test('track set-up applied to the race stays across tab switches until reset', async ({ page }) => {
  await startRace(page, 'daytona');
  await page.getByRole('tab', { name: /track/i }).click();
  await page.locator('input[type=checkbox]').first().check();
  await page.getByTestId('apply-surface').click();
  await page.getByRole('tab', { name: /^race/i }).click();
  await page.waitForTimeout(15_000);
  await page.getByRole('tab', { name: /track/i }).click();
  await expect(page.locator('input[type=checkbox]').first()).toBeChecked();
  await expect(page.getByTestId('surface-active')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Reset to original' }).click();
  await expect(page.getByTestId('surface-active')).toHaveCount(0, { timeout: 60_000 });
});

test('a small benchmark runs in the browser and reports per-family results', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('tab', { name: /benchmark/i }).click();
  // only F5, 2 seeds
  for (const f of ['F1', 'F2', 'F3', 'F6', 'F10']) await page.getByRole('button', { name: f, exact: true }).click();
  await page.getByLabel(/Seeds per family/).fill('2');
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await expect(page.getByTestId('bench-table')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('bench-table')).toContainText('F5');
});
