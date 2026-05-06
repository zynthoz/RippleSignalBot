# RippleSignalBot: Per-User Watchlist & Notifications Implementation Plan

## Overview
Enable users to create granular, personal watchlist rules. Notification-enabled watchlist items trigger Telegram + in-app notifications when new signals match user-defined criteria.

**Assumptions:**
- Registration starts on the website first.
- Telegram linking is optional after signup and is used only to connect the same user to Telegram notifications.
- Website remains lightweight; heavy lifting stays in backend.
- MVP-to-Standard scope: full filtering options, reasonable rule limits (~20 watchlist rules per user).

---

## UX Architecture Decision: No Header Tabs

> [!IMPORTANT]
> The original plan proposed adding `Signals | My Watchlist | Notifications` tabs to the header. This is **rejected** for the following reasons:
> 1. **Header is sacred**: The 48px header bar is a persistent identity strip (`MarketPulse AI` + utility icons). Adding tabs bloats it and breaks the clean, tool-like aesthetic.
> 2. **Tab-switching destroys context**: The three-panel layout (Signal Feed → Topology → Analysis) is the core value prop. Navigating away from it to a "My Watchlist" page loses the spatial context that makes the dashboard powerful.
> 3. **Bloomberg/Refinitiv pattern**: Professional terminals never hide the feed to show settings. Watchlist configuration is always a secondary layer (modal, drawer, or inline).

### Chosen Pattern: Integrated Inline + Drawer Architecture

All new features are woven **into the existing three-panel layout** without adding any new pages or tabs:

| Feature | Placement | Rationale |
|---|---|---|
| **Watchlist rules** | Slide-over drawer from the right edge (triggered by a header icon) | Keeps the main workspace visible underneath. Rules are a "configure and forget" interaction — you don't stare at them. A drawer is the right affordance for settings-like CRUD. |
| **Notifications** | Dropdown popover from a header bell icon (like GitHub/Slack) | Notifications are glanceable, not a destination. A popover with a scrollable list + badge count is the standard. Clicking a notification navigates to that signal in the existing feed. |
| **"Watching" a ticker** | Inline action on the Analysis Node panel (the existing "SET ALERT" button becomes functional) | The user is already looking at a signal's detail. The "SET ALERT" button in the sticky footer is the natural entry point to create a watchlist rule for that ticker. Tapping it opens a compact inline form or the drawer pre-filled with that ticker. |
| **Auth / Login** | Compact auth state in the header right-side icons area | Replace the `terminal` icon with a user avatar/icon. Clicking it opens a small auth popover (login/register). Logged-in state shows initials or avatar. |
| **Telegram linking** | Inside the user popover or drawer settings section | Not a primary action. Nested under account settings. |

### Visual Hierarchy (Header Changes)

Current header right-side icons: `sensors | settings | terminal`

New header right-side icons:
```
sensors | notifications_active (with badge) | person (auth) | settings
```

- `notifications_active` — Opens a dropdown popover listing recent notifications. Badge count for unread.
- `person` — Opens auth popover (login/register when logged out, account menu when logged in with Telegram link option).
- `settings` — Opens the watchlist drawer from the right edge. Contains the list of watchlist rules and a "Create Rule" form.

### Watchlist Drawer Spec

- **Trigger**: Click the `settings` icon (or rename to `tune` for clarity — it's a "preferences" action).
- **Width**: ~380px, slides in from the right, overlaying the Analysis Node panel.
- **Backdrop**: Semi-transparent dark overlay on the rest of the workspace. Click to dismiss.
- **Content**:
  - Header: `WATCHLIST RULES` (same 11px uppercase tracking as all section headers)
  - List of existing rules as compact cards (ticker pill, direction dot, confidence range, horizon, toggle for notifications, edit/delete actions)
  - Floating `+ ADD RULE` button at the bottom
  - Inline form when creating/editing: ticker input, direction dropdown, confidence range slider, time horizon dropdown, notification toggles (Telegram / In-App)
- **Empty state**: Same pattern as the Analysis Node empty state — centered icon + "No rules yet. Watch a ticker to get started."

### Notification Popover Spec

- **Trigger**: Click the `notifications_active` icon in the header.
- **Position**: Anchored below the bell icon, right-aligned.
- **Width**: ~340px, max-height 400px with scroll.
- **Content**:
  - Header: `NOTIFICATIONS` + "Mark all read" link
  - List of notification items: signal headline, matched ticker pill, timestamp, unread dot indicator
  - Click a notification → marks as read + loads that signal in the Signal Feed & Analysis Node
- **Empty state**: "No notifications yet. Set up watchlist rules to get started."
- **Polling**: Every 15 seconds, poll `/api/notifications?unread=true&limit=10` for badge count.

### "SET ALERT" Button Integration

The existing sticky footer button `SET ALERT` in the Analysis Node becomes functional:
1. If **not logged in**: clicking shows the auth popover with a message "Log in to set alerts".
2. If **logged in**: clicking opens the watchlist drawer, pre-filled with the current signal's primary ticker, direction, and confidence as defaults. The user can tweak and save.

---

## Phase 1: Database Schema & Core Data Model

### Subtask 1.1: Extend `users` table
Add user authentication & preferences:
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token VARCHAR(256);
ALTER TABLE users ADD COLUMN IF NOT EXISTS authenticated_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code VARCHAR(50) UNIQUE;
```

### Subtask 1.2: Create `user_watchlist` table
The alert concept is just a watchlist item with notifications enabled. Do not model alerts as a separate product concept.
Store per-user watchlist rules:
```sql
CREATE TABLE IF NOT EXISTS user_watchlist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    name VARCHAR(255),
    ticker VARCHAR(10) NOT NULL,
    direction VARCHAR(20),  -- 'BULLISH', 'BEARISH', 'MIXED', or NULL (any)
    min_confidence INTEGER DEFAULT 0,
    max_confidence INTEGER DEFAULT 100,
    time_horizon VARCHAR(50),  -- 'intraday', 'short-term', 'medium-term', 'long-term', or NULL (any)
    source_quality VARCHAR(50),  -- 'high', 'medium', 'low', or NULL (any)
    notify_telegram BOOLEAN DEFAULT true,
    notify_in_app BOOLEAN DEFAULT true,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_user_watchlist_user_id ON user_watchlist(user_id);
CREATE INDEX idx_user_watchlist_active ON user_watchlist(active);
```

### Subtask 1.3: Create `user_in_app_notifications` table
Track delivered in-app notifications:
```sql
CREATE TABLE IF NOT EXISTS user_in_app_notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    signal_id UUID NOT NULL REFERENCES signals(id),
    watchlist_id UUID REFERENCES user_watchlist(id),
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_notifications_user_id ON user_in_app_notifications(user_id);
CREATE INDEX idx_notifications_signal_id ON user_in_app_notifications(signal_id);
```

---

## Phase 2: Backend APIs (Node.js / dispatcher.js changes)

### Subtask 2.1: Add alert matching logic
In `src/dispatcher.js`, add a function to match a signal against user watchlist rules:
```js
async function matchUserWatchlist(pool, signal) {
  // Returns map: { user_id: [watchlist_ids_that_matched] }
  const query = `
    SELECT w.user_id, w.id, u.telegram_id 
    FROM user_watchlist w
    JOIN users u ON w.user_id = u.id
    WHERE w.active = true
    AND (w.ticker = $1 OR w.ticker IS NULL)
    AND (w.direction IS NULL OR w.direction = $2)
    AND ($3 >= w.min_confidence AND $3 <= w.max_confidence)
    AND (w.time_horizon IS NULL OR w.time_horizon = $4)
    AND (w.source_quality IS NULL OR w.source_quality = $5)
  `;
  const result = await pool.query(query, [
    signal.tickers[0],  // Just first ticker for now
    signal.direction,
    signal.confidence,
    signal.time_horizon,
    classifySourceQuality(signal.source_attribution)  // 'high', 'medium', 'low'
  ]);
  // Group by user_id
  return result.rows;
}
```

### Subtask 2.2: Update dispatcher to filter by user watchlist items
Replace broadcast-to-all with watchlist-aware dispatch for users who have watchlist rules.
- If a subscribed user has one or more watchlist rules, only send matching signals.
- If a subscribed user has no watchlist rules, continue sending all signals.
- Log watchlist_id with notification.

### Subtask 2.3: REST API endpoints (Express/Node)
Add to `src/index.js`:

**POST /api/watchlist** (create watchlist item)
```
Body: { ticker, direction, min_confidence, max_confidence, time_horizon, source_quality, notify_telegram, notify_in_app, name }
Returns: { id, ... }
Auth: website user session, with optional Telegram link later
```

**GET /api/watchlist** (list user's watchlist items)
```
Returns: [{ id, ticker, direction, min_confidence, ... }]
Auth: website user session
```

**PUT /api/watchlist/:id** (update watchlist item)
```
Body: partial watchlist object
Auth: website user session
```

**DELETE /api/watchlist/:id** (deactivate watchlist item)
```
Auth: website user session
```

**GET /api/notifications** (fetch in-app notifications)
```
Returns: [{ id, signal_id, watchlist_id, read, created_at, signal_details }]
Auth: website user session
Filters: ?unread=true, ?limit=20
```

**POST /api/notifications/:id/read** (mark notification as read)
```
Auth: website user session
```

---

## Phase 3: Telegram Bot Commands (optional, for power users)

### Subtask 3.1: Add Telegram commands
In `src/index.js` bot command handlers:

**`/linktelegram`**
- Connect the Telegram account to the website user after website signup.

**`/watch AAPL bullish --min-confidence 75`**
- Parse command, create watchlist item with notifications enabled.

**`/watchlist`**
- List user's active watchlist items.

**`/unwatch <id>`**
- Deactivate a watchlist item.

---

## Phase 4: Website Frontend

### Subtask 4.1: Update header icons
Replace the current right-side header icons with:
```html
<!-- In header right-side icon group -->
<div class="flex items-center gap-3">
  <span class="material-symbols-outlined ...">sensors</span>
  
  <!-- Notification bell with badge -->
  <div class="relative cursor-pointer" onclick="toggleNotificationPopover()">
    <span class="material-symbols-outlined ...">notifications</span>
    <div id="notif-badge" class="hidden absolute -top-1 -right-1 w-4 h-4 bg-error text-on-error rounded-full text-[9px] font-bold flex items-center justify-center">3</div>
  </div>
  
  <!-- Auth / User -->
  <div class="relative cursor-pointer" onclick="toggleAuthPopover()">
    <span class="material-symbols-outlined ...">person</span>
  </div>
  
  <!-- Watchlist drawer trigger -->
  <span class="material-symbols-outlined ... cursor-pointer" onclick="toggleWatchlistDrawer()">tune</span>
</div>
```

### Subtask 4.2: Build Watchlist Drawer
- Right-side slide-over drawer (~380px width) with dark backdrop overlay
- Uses the standard section header pattern (48px height, 11px uppercase tracking)
- Lists existing watchlist rules as compact cards
- Each card shows: ticker pill, direction dot, confidence range bar, horizon tag, notification toggles, edit/delete icons
- Bottom floating `+ ADD RULE` button
- Inline create/edit form with: ticker input, direction dropdown, confidence slider, horizon dropdown, toggle switches for Telegram/In-App notifications
- Matches the existing design tokens: `bg-surface-card`, `border-hairline`, `font-label-caps`

### Subtask 4.3: Build Notification Popover
- Dropdown popover anchored below the bell icon
- ~340px wide, max-height 400px with overflow scroll
- Standard section header: `NOTIFICATIONS` + "Mark all read" action
- Each notification row: signal headline, matched ticker pill, relative timestamp, unread dot
- Click notification → dismiss popover, load signal in feed and analysis panel
- Poll `/api/notifications?unread=true&limit=10` every 15s for badge count

### Subtask 4.4: Wire "SET ALERT" button
- If not authenticated: show auth popover with prompt
- If authenticated: open watchlist drawer with form pre-filled from current signal context (ticker, direction, confidence)

### Subtask 4.5: Build Auth Popover
- Small popover from the `person` icon
- Logged out state: email/password login form + register link
- Logged in state: user display name, "Link Telegram" button (shows a code to send to the bot), "Log out" button
- Session stored in `localStorage` + validated against `session_token` in the database

### Subtask 4.6: Show signals for untracked users too
- If the user has no watchlist items, the Signals tab still behaves like the global feed.
- Keep the old broadcast behavior for those users.

---

## Phase 5: Dispatcher Logic Update

### Subtask 5.1: Watchlist matching service
**Decision:** Keep dispatch in Node.js. The dispatcher already listens to `signals:ready`; add watchlist matching there for simplicity.

### Subtask 5.2: Implement watchlist evaluation
When signal published to `signals:ready`:
1. Query all watchlist rules for all active users
2. For each signal, filter user_ids whose watchlist items match
3. For matching users, send Telegram + insert in-app notification
4. If a subscribed user has no watchlist items, send all signals to preserve current broadcast behavior

---

## Phase 6: Testing & Iteration

### Subtask 6.1: Test alert matching logic
- Unit test: verify alert conditions filter correctly
- Integration test: create user → create alert → publish signal → verify notification sent

### Subtask 6.2: Test website auth flow
- Verify user can authenticate via website
- Verify can see only own alerts/watchlist

### Subtask 6.3: Test in-app notifications
- Verify badge updates, notifications display, mark-as-read works

### Subtask 6.4: Test drawer & popover UX
- Verify drawer opens/closes without layout shift
- Verify popover dismisses on outside click
- Verify "SET ALERT" pre-fills correctly from active signal context

---

## Implementation Order (Recommended)

1. **Phase 1** (Database) — ~2 hours
2. **Phase 2.1 + 2.2** (Dispatcher alert matching) — ~3 hours
3. **Phase 2.3** (REST APIs) — ~2 hours
4. **Phase 4.5** (Auth popover) — ~1.5 hours
5. **Phase 4.1** (Header icon updates) — ~0.5 hours
6. **Phase 4.2** (Watchlist drawer) — ~3 hours
7. **Phase 4.3** (Notification popover) — ~2 hours
8. **Phase 4.4** (Wire SET ALERT button) — ~0.5 hours
9. **Phase 6** (Testing) — ~2 hours
10. **Phase 3** (Telegram bot commands, optional) — ~1 hour

**Total estimate: ~18 hours of development**

---

## Out of Scope (Nice-to-haves)
- Alert scheduling (e.g., "only notify 9am–5pm")
- Alert history / performance stats
- Mobile app (use website in responsive mode)
- Email notifications (Telegram + in-app is enough)
- Complex multi-ticker rules (e.g., "AAPL OR MSFT")

---

## Resolved Questions

1. **Telegram linking:** Website shows a manual connect code in the user account popover. User sends that code to the Telegram bot via `/linktelegram <code>`.
2. **Non-watchlist subscribers:** If a user is subscribed but has no watchlist items, they should receive all signals. ✅
3. **Watchlist vs notifications:** A watchlist item can either be silent or notification-enabled. ✅
4. **Source quality mapping:** Use credible-but-not-perfect sources as high when they are strong enough to justify confidence. Primary sources and official filings rank highest. ✅
5. **No header tabs:** Watchlist and notifications are overlay UI (drawer + popover), not separate pages. The three-panel layout is never interrupted. ✅
