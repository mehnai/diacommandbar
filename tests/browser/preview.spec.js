import { test, expect } from '@playwright/test';

test('keyboard navigation, source filters, and empty states', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('option')).toHaveCount(4);
  const input = page.getByRole('combobox');
  await input.fill('github');
  await expect(page.getByRole('option')).toHaveCount(2);
  await input.press('ArrowDown');
  await expect(page.getByRole('option', { selected: true })).toContainText('GitHub');
  await input.press('Enter');
  await expect(page.locator('#status')).toContainText('Switch to');
  await input.fill('@ impossiblezz');
  await expect(page.getByText('No matches here.')).toBeVisible();
  await input.fill('> downloads');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Open downloads');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Bookmarks *', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable bookmarks' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('settings persist and the interface fits a narrow viewport', async ({ page }) => {
  await page.goto('/');
  await page.locator('.page-settings').click();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button', { name: 'Sage', exact: true }).click();
  await page.getByLabel('Search engine', { exact: true }).selectOption('duckduckgo');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'sage');
  await page.getByRole('combobox').fill('the best day');
  await expect(page.getByRole('option').first()).toContainText('Search DuckDuckGo');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('light and dark visual captures', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('option')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/preview-light.png', fullPage: true, animations: 'disabled' });
  await page.locator('.page-settings').click();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.screenshot({ path: 'test-results/preview-dark.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: 'test-results/preview-mobile.png', fullPage: true, animations: 'disabled' });
});
