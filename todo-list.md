# DNK Dialer — UI Audit Results

Found via Playwright testing on 2026-03-05. All issues fixed.

## Issues Found & Fixed

### 1. Settings: Disconnect button had no onClick handler -- FIXED
- **File:** `app/page.tsx`
- **Fix:** Wired `onClick={disconnect}` using `usePhone()` hook

### 2. Settings: Notification toggles were non-functional -- FIXED
- **File:** `app/page.tsx`
- **Fix:** Added toggle state, onClick handlers, localStorage persistence, visual on/off states

### 3. Contact search didn't filter -- FIXED
- **File:** `app/page.tsx`
- **Fix:** Added `contactSearch` state, `onChange` handler, filter by name/number, "No matches" empty state

### 4. Templates not accessible from sidebar -- FIXED
- **File:** `components/Sidebar.tsx`
- **Fix:** Added `{ id: 'templates', icon: FileText, label: 'Templates' }` to menu items

## Verified Working (20 Playwright tests, all passing)

- [x] Dashboard loads with stat cards, sync controls, recent activity sections
- [x] Sync All button correctly disabled when disconnected
- [x] Individual sync buttons disabled when disconnected
- [x] Sidebar navigation works for all 6 tabs (including Templates)
- [x] Dialer pad displays and buttons are clickable
- [x] Settings call mode toggle works (Phone Speaker / PC Audio)
- [x] Settings notification toggles work with persistence
- [x] Settings disconnect button triggers disconnect
- [x] Contact page renders with working search filter
- [x] SMS interface has compose and recipient inputs
- [x] Templates CRUD (New/Edit/Delete/Copy) works
- [x] "View all" links navigate to correct tabs
- [x] Connection status displays in header
