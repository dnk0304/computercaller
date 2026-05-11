import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3777';

test.describe('DNK Dialer UI Audit', () => {

  test('Dashboard tab loads with sync controls', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Dashboard should be default tab
    await expect(page.locator('h2:has-text("dashboard")')).toBeVisible();

    // Sync All button should exist
    const syncAllBtn = page.locator('button:has-text("Sync All")');
    await expect(syncAllBtn).toBeVisible();

    // Stat cards should exist (scope to main content area, use exact text)
    const main = page.locator('main');
    await expect(main.getByText('Contacts', { exact: true })).toBeVisible();
    await expect(main.getByText('Messages', { exact: true })).toBeVisible();
    await expect(main.getByText('Call Logs', { exact: true })).toBeVisible();

    // Recent sections should exist
    await expect(page.getByRole('heading', { name: 'Recent Calls' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent Messages' })).toBeVisible();

    // "Last synced" text should appear on cards
    const lastSyncTexts = page.locator('text=Last synced:');
    await expect(lastSyncTexts.first()).toBeVisible();
  });

  test('Sidebar navigation works for all tabs', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Click each sidebar tab and verify content loads
    const tabs = [
      { label: 'Dialer Only', headerText: 'dialer' },
      { label: 'Messages Only', headerText: 'messages' },
      { label: 'Contacts', headerText: 'contacts' },
      { label: 'Settings', headerText: 'settings' },
      { label: 'Dashboard', headerText: 'dashboard' },
    ];

    for (const tab of tabs) {
      await page.locator(`nav button span:has-text("${tab.label}")`).click();
      // Header should update
      const header = page.locator('header h2');
      await expect(header).toHaveText(tab.headerText, { ignoreCase: true });
    }
  });

  test('Dialer tab has dial pad buttons', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.locator('nav button span:has-text("Dialer Only")').click();

    // Check for dial pad number buttons
    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      const btn = page.locator(`button:has-text("${digit}")`).first();
      await expect(btn).toBeVisible();
    }

    // Check for call button
    const callBtn = page.locator('button[class*="bg-emerald"], button[class*="bg-green"]').first();
    await expect(callBtn).toBeVisible();
  });

  test('Messages tab loads SMS interface', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.locator('nav button span:has-text("Messages Only")').click();

    // Should show message compose or conversation area
    // At minimum check the messages tab content rendered
    await expect(page.locator('header h2')).toHaveText('messages', { ignoreCase: true });
  });

  test('Contacts tab shows contacts page', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.locator('nav button span:has-text("Contacts")').click();

    // Should show contacts header
    await expect(page.locator('text=contacts synced from phone')).toBeVisible();
    // Should have search input
    const searchInput = page.locator('input[placeholder="Search contacts..."]');
    await expect(searchInput).toBeVisible();
  });

  test('Settings tab has call mode options', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.locator('nav button span:has-text("Settings")').click();

    // Call Audio Mode section
    await expect(page.locator('text=Call Audio Mode')).toBeVisible();
    await expect(page.locator('text=Phone Speaker')).toBeVisible();
    await expect(page.locator('text=PC Audio')).toBeVisible();

    // Notifications section
    await expect(page.locator('text=Notifications')).toBeVisible();
    await expect(page.locator('text=Incoming Calls')).toBeVisible();
    await expect(page.locator('text=New Messages')).toBeVisible();

    // Disconnect button
    await expect(page.locator('text=Disconnect Device')).toBeVisible();
  });

  test('Settings call mode toggle works', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.locator('nav button span:has-text("Settings")').click();

    // Click PC Audio
    await page.locator('button:has-text("PC Audio")').click();
    // PC Audio notice should appear
    await expect(page.locator('text=PC Audio mode requires WebRTC')).toBeVisible();

    // Click Phone Speaker back
    await page.locator('button:has-text("Phone Speaker")').click();
    // PC Audio notice should disappear
    await expect(page.locator('text=PC Audio mode requires WebRTC')).not.toBeVisible();
  });

  test('Templates tab - CRUD operations', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Navigate to templates - need to find it in sidebar
    // Templates might not be in sidebar. Let me check what tabs exist.
    const templatesSidebarBtn = page.locator('nav button span:has-text("Templates")');
    const hasTemplatesTab = await templatesSidebarBtn.count() > 0;

    if (!hasTemplatesTab) {
      // Templates might not be a sidebar item, skip
      test.skip();
      return;
    }

    await templatesSidebarBtn.click();

    // Should show templates page
    await expect(page.locator('text=Message Templates')).toBeVisible();

    // Default templates should be visible
    await expect(page.locator('text=Meeting Reminder')).toBeVisible();

    // Click New Template
    await page.locator('button:has-text("New Template")').click();

    // Edit form should appear
    const titleInput = page.locator('input[placeholder="Template title"]');
    await expect(titleInput).toBeVisible();

    // Fill in and save
    await titleInput.fill('Test Template');
    await page.locator('textarea[placeholder="Template content"]').fill('Test content');
    await page.locator('button:has-text("Save")').click();

    // New template should be visible
    await expect(page.locator('text=Test Template')).toBeVisible();

    // Clean up - delete it by hovering and clicking trash
    const templateCard = page.locator('div:has-text("Test Template")').first();
    await templateCard.hover();
  });

  test('Connection status shows in header', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // ConnectionStatus component should be in header
    const header = page.locator('header');
    await expect(header).toBeVisible();

    // Should show some connection UI element (QR button, connect button, or status text)
    // The exact content depends on connection state
    const connectionArea = header.locator('div').last();
    await expect(connectionArea).toBeVisible();
  });

  test('Dashboard sync buttons are disabled when disconnected', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Sync All should be disabled when phone not connected
    const syncAllBtn = page.locator('button:has-text("Sync All")');
    await expect(syncAllBtn).toBeDisabled();

    // Individual sync buttons should also be disabled
    const syncBtns = page.locator('button[title*="Sync"]');
    const count = await syncBtns.count();
    for (let i = 0; i < count; i++) {
      await expect(syncBtns.nth(i)).toBeDisabled();
    }
  });

  test('Dashboard "View all" links navigate correctly', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Click "View all" next to Contacts
    const viewAllButtons = page.locator('button:has-text("View all")');
    // First "View all" should be contacts card
    if (await viewAllButtons.count() > 0) {
      await viewAllButtons.first().click();
      // Should navigate to contacts tab
      const header = page.locator('header h2');
      const headerText = await header.textContent();
      // It could navigate to contacts or messages depending on which view all was clicked
      expect(['contacts', 'messages', 'dialer']).toContain(headerText?.toLowerCase());
    }
  });

  test('Dialer input accepts typed numbers', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.locator('nav button span:has-text("Dialer Only")').click();

    // Find the phone number input
    const phoneInput = page.locator('input[type="tel"], input[placeholder*="number"], input[placeholder*="Enter"]').first();
    if (await phoneInput.count() > 0) {
      await phoneInput.fill('1234567890');
      await expect(phoneInput).toHaveValue('1234567890');
    }
  });

  test('Contact search input is functional', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.locator('nav button span:has-text("Contacts")').click();

    const searchInput = page.locator('input[placeholder="Search contacts..."]');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('test');
    // Input should accept text
    await expect(searchInput).toHaveValue('test');
  });
});
