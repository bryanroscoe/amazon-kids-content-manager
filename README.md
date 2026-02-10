# Amazon Kids Content Manager

Bulk disable (or enable) content on the [Amazon Kids Parent Dashboard](https://parents.amazon.com/explore). Useful when you need to lock down all content for a child profile.

## How It Works

The script uses a two-layer approach for reliability:

1. **React Fiber** — reads item data and pagination state directly from Amazon's React component tree (no fragile CSS selectors)
2. **Semantic DOM Fallback** — if fiber access fails, falls back to `input[role="switch"]` and `aria-label` attributes

Toggling is done via concurrent DOM card clicks (the only method Amazon reliably persists). Items are clicked in parallel batches for speed.

## Usage

1. Go to **https://parents.amazon.com/explore** (substitute `.com` with your Amazon domain, e.g. `.ca`)
2. **Select your child** from the dashboard. Set their age range to **2–2** for maximum content visibility.
3. Open the browser console: `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (Mac)
4. Type `allow pasting` and press Enter
5. Edit the `CONFIG` section at the top of the script if needed (see below)
6. Paste the script into the console and press Enter
7. Repeat for each child profile

## Configuration

Edit the `CONFIG` object at the top of `amazon_kids_content_disabler.js`:

```javascript
const CONFIG = {
  // 'disable' = turn off content, 'enable' = turn on content
  mode: 'disable',

  // Filter by content type. null = all types.
  // Valid: 'APP', 'EBOOK', 'VIDEO', 'AUDIBLE', 'SKILL'
  contentTypes: null,

  // Keyword filter. null = all items.
  // Only items whose title contains ANY keyword will be processed.
  keywords: null,

  // Case-insensitive keyword matching
  keywordCaseSensitive: false,

  // Number of items to click at once before waiting
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

**Disable all content:**
```javascript
mode: 'disable',
```

**Re-enable all content:**
```javascript
mode: 'enable',
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
