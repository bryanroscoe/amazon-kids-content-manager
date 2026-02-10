# Amazon Kids Content Manager

Bulk disable (or enable) content on the [Amazon Kids Parent Dashboard](https://parents.amazon.com/explore). Useful when you need to lock down all content for a child profile.

## How It Works

The script uses a two-layer approach for reliability:

1. **React Fiber** — reads item data and pagination state directly from Amazon's React component tree (no fragile CSS selectors)
2. **Semantic DOM Fallback** — if fiber access fails, falls back to `input[role="switch"]`, `aria-label`, and `.allowlist-count` attributes

The script auto-detects which page mode you're on:

| Page Mode | How to get there | Toggling method | Speed |
|-----------|-----------------|----------------|-------|
| **Child selected** | Click a child's name | Concurrent card clicks (5 at a time) | Fast |
| **No child selected** | Click the back arrow / don't select a child | Sequential "Manage access" panel toggles | Slower, but can see all content |

**Important:** The child-selected view only shows *enabled* items. To re-enable disabled content, use the no-child-selected view.

## Usage

1. Go to **https://parents.amazon.com/explore** (substitute `.com` with your Amazon domain, e.g. `.ca`)
2. Set the child's age range to **2–2** for maximum content visibility
3. Choose your view:
   - **Select a child** for fast bulk disable (concurrent card clicks)
   - **Deselect the child** (click the back arrow) for enable/disable of ALL content, including items currently disabled
4. Clear all content-type filters for full visibility
5. Open the browser console: `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (Mac)
6. Type `allow pasting` and press Enter
7. Edit the `CONFIG` section at the top of the script if needed (see below)
8. Paste the script into the console and press Enter
9. Repeat for each child profile

## Configuration

Edit the `CONFIG` object at the top of `amazon_kids_content_disabler.js`:

```javascript
const CONFIG = {
  // 'disable' = turn off content, 'enable' = turn on content
  mode: 'disable',

  // Filter by content type. null = all types.
  // Valid: 'APP', 'EBOOK', 'VIDEO', 'AUDIBLE', 'SKILL'
  contentTypes: null,

  // Keyword filter (include). null = all items.
  // Only items whose title contains ANY keyword will be processed.
  keywords: null,

  // Keyword filter (exclude). null = no exclusion.
  // Items whose title contains ANY of these keywords will be SKIPPED.
  excludeKeywords: null,

  // Case-insensitive keyword matching
  keywordCaseSensitive: false,

  // Which child to manage (used in no-child-selected mode).
  // null = auto-detect. Set to a name like 'Lily' for multiple children.
  childName: null,

  // Number of items to click at once (child-selected mode only)
  clickConcurrency: 5,

  // Delay between click batches in ms
  clickDelayMs: 150,

  // Delay between pagination loads in ms
  pageDelayMs: 100,

  // Max retries per failed toggle
  maxRetries: 3,

  // Logging: 'quiet', 'normal', 'verbose'
  logLevel: 'normal',

  // Log what would happen without making changes
  dryRun: false,
};
```

### Examples

**Disable all content (fast — select child first):**
```javascript
mode: 'disable',
```

**Re-enable all content (deselect child first):**
```javascript
mode: 'enable',
```

**Disable everything EXCEPT PBS and Sesame Street apps:**
```javascript
mode: 'disable',
excludeKeywords: ['PBS', 'Sesame Street'],
contentTypes: ['APP'],
```

**Enable only specific items (deselect child first):**
```javascript
mode: 'enable',
keywords: ['PBS', 'Sesame Street'],
contentTypes: ['APP'],
```

**Disable only videos and apps:**
```javascript
mode: 'disable',
contentTypes: ['VIDEO', 'APP'],
```

**Disable only items matching keywords:**
```javascript
mode: 'disable',
keywords: ['minecraft', 'roblox'],
```

**Dry run (preview without changing anything):**
```javascript
dryRun: true,
logLevel: 'verbose',
```

## Controls

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+C` | Pause the script |
| `Ctrl+Alt+R` | Resume the script |

## Compatibility

Tested on:
- amazon.com
- amazon.ca

Requires a modern browser with DevTools console access (Chrome, Edge, Firefox, etc.).

## Credits

Based on the original script by [tfriesen](https://gist.github.com/tfriesen/dd6a7642ecd4e9caa0efb3223c17c873).

## Disclaimer

This script is provided as-is with no warranty. Use at your own risk. Amazon may change their dashboard at any time, which could break this script.
