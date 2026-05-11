import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3777';

test.describe('Deep UI Audit', () => {

  test('Settings disconnect button has no onClick handler', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('nav button span:has-text("Settings")').click();

    const disconnectBtn = page.locator('button:has-text("Disconnect Device")');
    await expect(disconnectBtn).toBeVisible();

    // Click the button and check if anything changes
    const statusBefore = await page.locator('header').textContent();
    await disconnectBtn.click();
    // Wait a moment for any state change
    await page.waitForTimeout(500);
    const statusAfter = await page.locator('header').textContent();

    // If nothing changed, the button is non-functional
    console.log('Disconnect button test - before:', statusBefore?.trim().substring(0, 50));
    console.log('Disconnect button test - after:', statusAfter?.trim().substring(0, 50));
  });

  test('Settings notification toggles have no onClick handlers', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('nav button span:has-text("Settings")').click();

    // Notification toggles - check if they're actually interactive
    const toggles = page.locator('.bg-blue-600.rounded-full');
    const count = await toggles.count();
    console.log(`Found ${count} notification toggles`);

    for (let i = 0; i < count; i++) {
      const toggle = toggles.nth(i);
      // Check if it has onClick
      const cursor = await toggle.evaluate(el => window.getComputedStyle(el).cursor);
      console.log(`Toggle ${i} cursor: ${cursor}`);
    }
  });

  test('Contact search does not actually filter', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('nav button span:has-text("Contacts")').click();

    const searchInput = page.locator('input[placeholder="Search contacts..."]');
    await searchInput.fill('zzzzz_nonexistent');
    await page.waitForTimeout(300);

    // Check if "No Contacts" message appeared (would mean filter works)
    // or if nothing changed (filter not implemented)
    const noContactsMsg = page.locator('text=No Contacts');
    const hasNoContactsMsg = await noContactsMsg.count() > 0;
    console.log(`Contact search filter working: ${!hasNoContactsMsg ? 'NO (no filtering)' : 'possibly yes'}`);
  });

  test('Dialpad number input and call button interaction', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('nav button span:has-text("Dialer Only")').click();

    // Try clicking digit buttons to build a number
    const btn1 = page.locator('button:has-text("1")').first();
    const btn2 = page.locator('button:has-text("2")').first();
    const btn3 = page.locator('button:has-text("3")').first();

    await btn1.click();
    await btn2.click();
    await btn3.click();

    // Check if there's a display showing the entered number
    const display = page.locator('input[type="tel"]').first();
    if (await display.count() > 0) {
      const val = await display.inputValue();
      console.log(`Dialpad display after clicking 1,2,3: "${val}"`);
    } else {
      console.log('No tel input found in dialpad');
    }
  });

  test('Dashboard header shows correct tab name', async ({ page }) => {
    await page.goto(BASE);

    // Header should show "Dashboard" not just "dashboard"
    const header = page.locator('header h2');
    const text = await header.textContent();
    console.log(`Header capitalization: "${text}"`);
    // CSS capitalize handles this, but let's verify the raw text
  });

  test('Templates not accessible from sidebar', async ({ page }) => {
    await page.goto(BASE);

    // Count sidebar nav items
    const navButtons = page.locator('nav button');
    const count = await navButtons.count();
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const label = await navButtons.nth(i).locator('span').textContent();
      if (label) labels.push(label);
    }
    console.log('Sidebar items:', labels.join(', '));
    console.log('Templates in sidebar:', labels.includes('Templates'));
  });

  test('SMS interface compose area', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('nav button span:has-text("Messages Only")').click();

    // Check for compose elements
    const composeInput = page.locator('textarea, input[placeholder*="message"], input[placeholder*="type"]').first();
    const hasCompose = await composeInput.count() > 0;
    console.log(`SMS compose input found: ${hasCompose}`);

    // Check for recipient input
    const recipientInput = page.locator('input[placeholder*="number"], input[placeholder*="recipient"], input[placeholder*="Search"]').first();
    const hasRecipient = await recipientInput.count() > 0;
    console.log(`SMS recipient/search input found: ${hasRecipient}`);
  });
});
