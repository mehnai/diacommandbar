import { test, expect } from '@playwright/test';

async function section(page, name) {
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true }).click();
}
async function choose(page, tab, label, value) {
  await section(page, tab);
  const choice = page.getByRole('group', { name: label, exact: true }).getByRole('button', { name: value, exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
}

test('keyboard navigation, source filters, settings action, and empty states', async ({ page }) => {
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
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await input.fill('> downloads');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Open downloads');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Bookmarks *', exact: true }).click();
  await expect(page.getByText('Searching bookmarks is off.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on', exact: true })).toBeVisible();
  await input.fill('> settings'); await input.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(input).toBeFocused();
  expect(errors).toEqual([]);
});

test('settings persist, default scope resets, hidden hints retain a keyboard route to settings', async ({ page }) => {
  await page.goto('/');
  await page.locator('.footer-settings').click();
  await choose(page, 'Appearance', 'Theme', 'Dark');
  await choose(page, 'Appearance', 'Accent color', 'Green');
  await choose(page, 'Search', 'Search with', 'DuckDuckGo');
  await choose(page, 'Sources', 'Start by searching', 'Open tabs');
  await choose(page, 'Command bar', 'Show keyboard hints', 'Off');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'green');
  await expect(page.locator('.palette-footer')).toBeHidden();
  await expect(page.locator('[data-filter=tabs]')).toHaveAttribute('aria-pressed', 'true');
  const input = page.getByRole('combobox');
  await input.fill('> downloads'); await input.press('Escape');
  await expect(page.locator('[data-filter=tabs]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-filter=all]').click();
  await input.fill('the best day');
  await expect(page.getByRole('option').first()).toContainText('with DuckDuckGo');
  await input.press('Control+,');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('.palette-footer')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'mono');
});

test('customization changes the bar, clock, and sources; IME and number keys keep focus rules', async ({ page }) => {
  await page.goto('/');
  await page.locator('.footer-settings').click();
  await choose(page, 'Appearance', 'Font', 'Mono');
  await choose(page, 'Appearance', 'Spacing', 'Compact');
  await choose(page, 'Appearance', 'Contrast', 'Higher');
  await page.getByRole('button', { name: 'Increase bar width' }).click();
  await expect(page.locator('.stage')).toHaveCSS('width', '640px');
  await choose(page, 'Command bar', 'Highlight', 'Soft');
  await choose(page, 'Command bar', 'Show filter buttons', 'Off');
  await choose(page, 'Command bar', 'Show icons', 'Off');
  await choose(page, 'Command bar', 'Label each result', 'Off');
  await choose(page, 'Command bar', 'Show number shortcuts', 'On');
  await choose(page, 'New tab', 'Background', 'Dot grid');
  await choose(page, 'New tab', 'Time format', '15:30');
  await expect(page.locator('#time')).not.toContainText(/AM|PM/);
  await choose(page, 'New tab', 'Show date and time', 'Off');
  await choose(page, 'Sources', 'Include tabs from other windows', 'Off');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await expect(page.locator('.clock')).toBeHidden();
  await expect(page.locator('.filter-row')).toBeHidden();
  await expect(page.locator('.result-icon').first()).toBeHidden();
  await expect(page.locator('.result-kind').first()).toBeHidden();
  await expect(page.locator('.result-number').first()).toBeVisible();
  const input = page.getByRole('combobox');
  await input.fill('@ github');
  await expect(page.getByRole('option')).toHaveCount(1);
  await input.dispatchEvent('compositionstart');
  await input.press('Escape'); await input.press('Enter');
  await expect(input).toHaveValue('@ github'); await expect(page.locator('#status')).toBeEmpty();
  await input.dispatchEvent('compositionend');
  await page.locator('.footer-settings').focus(); await page.keyboard.press('Control+1');
  await expect(page.locator('#status')).toBeEmpty();
  await input.focus(); await input.press('Control+1');
  await expect(page.locator('#status')).toContainText('Switch to');
});

test('light, dark, narrow and settings visual captures; every section stays usable on mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('option')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/preview-light.png', fullPage: true, animations: 'disabled' });
  await page.locator('.footer-settings').click();
  await page.screenshot({ path: 'test-results/settings-light.png', animations: 'disabled' });
  await choose(page, 'Appearance', 'Theme', 'Dark');
  await page.screenshot({ path: 'test-results/settings-dark.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.screenshot({ path: 'test-results/preview-dark.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: 'test-results/preview-mobile.png', fullPage: true, animations: 'disabled' });
  await page.locator('.footer-settings').click();
  for (const name of ['Appearance', 'Command bar', 'New tab', 'Search', 'Sources', 'Overlay', 'Shortcuts']) {
    await section(page, name);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    expect(await page.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator('#settings-status').scrollIntoViewIfNeeded();
  }
  await section(page, 'Appearance');
  await page.screenshot({ path: 'test-results/settings-mobile.png', animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
