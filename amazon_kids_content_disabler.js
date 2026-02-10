// Amazon Kids Content Manager v3
// https://github.com/bryanroscoe/amazon-kids-content-manager
//
// Bulk disable (or enable) content on Amazon Kids Parent Dashboard.
// Works on amazon.com and amazon.ca as of 2026-02-09.
//
// Instructions:
//   1. Go to https://parents.amazon.com/explore (substitute .com with your domain)
//   2. Set the child's age range to 2-2 for maximum content visibility.
//   3. Choose your view:
//        - Select a child for fast bulk disable (concurrent card clicks)
//        - Deselect the child (click the back arrow) for enable/disable
//          of ALL content, including items currently disabled
//   4. Clear all content-type filters for full visibility
//   5. Open DevTools console (Ctrl+Shift+I / Cmd+Option+I)
//   6. Type "allow pasting" and press Enter
//   7. Edit the CONFIG section below if needed
//   8. Paste this script and press Enter
//   9. Repeat for each child
//
// Controls:
//   Ctrl+Alt+C = Pause
//   Ctrl+Alt+R = Resume
//
// Based on: https://gist.github.com/tfriesen/dd6a7642ecd4e9caa0efb3223c17c873

// ============================================================================
// CONFIGURATION — edit these values before running
// ============================================================================
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
  // null = auto-detect (uses the first/only child, or the selectedChild from fiber).
  // Set to a name like 'Lily' to target a specific child when there are multiple.
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

// ============================================================================
// SCRIPT START — do not edit below unless you know what you're doing
// ============================================================================
(async () => {
  'use strict';

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Poll until predicate returns truthy or timeout
  function waitFor(predicate, timeoutMs = 5000, intervalMs = 100) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const val = predicate();
        if (val) { resolve(val); return; }
        if (Date.now() - start > timeoutMs) { resolve(null); return; }
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  // --------------------------------------------------------------------------
  // Logger
  // --------------------------------------------------------------------------
  const Logger = {
    _start: Date.now(),
    _elapsed() {
      const s = Math.floor((Date.now() - this._start) / 1000);
      const m = Math.floor(s / 60);
      return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
    },
    info(msg) {
      if (CONFIG.logLevel !== 'quiet') console.log(`[AKM ${this._elapsed()}] ${msg}`);
    },
    verbose(msg) {
      if (CONFIG.logLevel === 'verbose') console.log(`[AKM ${this._elapsed()}]   ${msg}`);
    },
    progress(stats, total) {
      if (CONFIG.logLevel === 'quiet') return;
      const pct = total > 0 ? Math.round(((stats.toggled + stats.skipped + stats.failed) / total) * 100) : 0;
      console.log(
        `[AKM ${this._elapsed()}] ${pct}% | Toggled: ${stats.toggled} | Skipped: ${stats.skipped} | Failed: ${stats.failed}` +
          (stats.retried ? ` | Retries: ${stats.retried}` : '')
      );
    },
    summary(stats) {
      console.log('\n=== Amazon Kids Content Manager — Complete ===');
      console.log(`Mode: ${CONFIG.mode}`);
      console.log(`Duration: ${this._elapsed()}`);
      console.log(`Toggled: ${stats.toggled}`);
      console.log(`Skipped: ${stats.skipped}`);
      console.log(`Failed: ${stats.failed}`);
      if (stats.retried) console.log(`Retries: ${stats.retried}`);
      if (CONFIG.keywords) console.log(`Keywords (include): ${CONFIG.keywords.join(', ')}`);
      if (CONFIG.excludeKeywords) console.log(`Keywords (exclude): ${CONFIG.excludeKeywords.join(', ')}`);
      if (CONFIG.contentTypes) console.log(`Content types: ${CONFIG.contentTypes.join(', ')}`);
      if (CONFIG.dryRun) console.log('** DRY RUN — no changes were made **');
      console.log('================================================\n');
    },
  };

  // --------------------------------------------------------------------------
  // State (pause / resume / stop)
  // --------------------------------------------------------------------------
  const State = {
    _state: 'idle',
    _pauseResolve: null,
    _pausePromise: null,

    start() { this._state = 'running'; },
    pause() {
      if (this._state !== 'running') return;
      this._state = 'paused';
      this._pausePromise = new Promise((r) => { this._pauseResolve = r; });
      Logger.info('PAUSED — press Ctrl+Alt+R to resume');
    },
    resume() {
      if (this._state !== 'paused') return;
      this._state = 'running';
      if (this._pauseResolve) this._pauseResolve();
      this._pausePromise = null;
      Logger.info('RESUMED');
    },
    stop() {
      this._state = 'done';
      if (this._pauseResolve) this._pauseResolve();
    },
    isRunning() { return this._state === 'running'; },
    isPaused() { return this._state === 'paused'; },
    async checkPause() {
      if (this._state === 'paused' && this._pausePromise) await this._pausePromise;
    },
  };

  // --------------------------------------------------------------------------
  // React Fiber Utility
  // --------------------------------------------------------------------------
  const FiberUtil = {
    _fiberKey: null,
    _propsKey: null,

    init() {
      const probe = document.querySelector('.content-card-clickable') ||
                    document.querySelector('input[role="switch"]') ||
                    document.querySelector('[class*="content-card"]');
      if (probe) {
        for (const key of Object.keys(probe)) {
          if (key.startsWith('__reactFiber$')) this._fiberKey = key;
          if (key.startsWith('__reactProps$')) this._propsKey = key;
        }
      }
      return !!this._fiberKey;
    },

    getFiber(el) { return el?.[this._fiberKey] ?? null; },

    findAncestor(el, predicate, maxDepth = 60) {
      let fiber = this.getFiber(el);
      for (let i = 0; i < maxDepth && fiber; i++) {
        if (predicate(fiber)) return fiber;
        fiber = fiber.return;
      }
      return null;
    },

    findPageComponent() {
      const probe = document.querySelector('.content-card-clickable') ||
                    document.querySelector('input[role="switch"]');
      if (!probe) return null;
      return this.findAncestor(probe, (f) => {
        const p = f.memoizedProps;
        return p && typeof p.fetchItems === 'function' && p.itemProps && p.basePageData;
      });
    },
  };

  // --------------------------------------------------------------------------
  // Page mode detection
  // --------------------------------------------------------------------------
  function detectPageMode() {
    // Child-selected mode: has inline toggle switches
    const inlineSwitches = document.querySelectorAll('input[role="switch"]');
    if (inlineSwitches.length > 0) return 'child-selected';

    // No-child-selected mode: has allowlist-count buttons (person icons)
    const accessBtns = document.querySelectorAll('.allowlist-count');
    if (accessBtns.length > 0) return 'no-child-selected';

    return null;
  }

  // --------------------------------------------------------------------------
  // Item Data Source — reads items from fiber or DOM in either page mode
  // --------------------------------------------------------------------------
  const ItemSource = {
    _fiberAvailable: false,
    _childId: null,
    _childName: null,

    init() {
      this._fiberAvailable = FiberUtil.init();
      if (this._fiberAvailable) {
        const pc = FiberUtil.findPageComponent();
        if (pc) {
          Logger.info('React Fiber access available');
          const bd = pc.memoizedProps.basePageData;
          this._childId = bd?.selectedChild?.directedId ?? null;
          this._childName = bd?.selectedChild?.firstName ?? null;
        } else {
          Logger.info('Fiber keys found but page component not located — using DOM');
          this._fiberAvailable = false;
        }
      } else {
        Logger.info('No fiber access — using DOM selectors');
      }
    },

    getChildInfo() {
      return { childId: this._childId, childName: this._childName };
    },

    // Get items in child-selected mode (has inline switches)
    getItemsChildSelected() {
      if (this._fiberAvailable) {
        const items = this._getFromFiber();
        if (items) return items;
        this._fiberAvailable = false;
      }
      return this._getFromDOMSwitches();
    },

    // Get items in no-child-selected mode (has person icon buttons)
    getItemsNoChild() {
      if (this._fiberAvailable) {
        const items = this._getFromFiberNoChild();
        if (items) return items;
        this._fiberAvailable = false;
      }
      return this._getFromDOMAccessButtons();
    },

    _getFromFiber() {
      const pc = FiberUtil.findPageComponent();
      if (!pc) return null;
      const props = pc.memoizedProps;
      const items = props.itemProps?.items;
      if (!items) return null;
      const childId = props.basePageData?.selectedChild?.directedId;
      const switches = document.querySelectorAll('input[role="switch"]');

      return items.map((item, idx) => {
        const accessVal = item.childDirectedIdAccessMap?.[childId];
        const isEnabled = accessVal === 'AVAILABLE';
        const sw = switches[idx] ?? null;
        const card = sw?.closest('.content-card-clickable') ?? null;
        return {
          itemId: item.itemId,
          title: item.title,
          contentType: item.activityCategory,
          isEnabled,
          _domSwitch: sw,
          _domCard: card,
        };
      });
    },

    _getFromFiberNoChild() {
      const pc = FiberUtil.findPageComponent();
      if (!pc) return null;
      const props = pc.memoizedProps;
      const items = props.itemProps?.items;
      if (!items) return null;

      // In no-child-selected mode, we need a childId to check access
      const childId = this._childId;
      const accessBtns = document.querySelectorAll('.allowlist-count');

      return items.map((item, idx) => {
        let isEnabled = false;
        if (childId) {
          const accessVal = item.childDirectedIdAccessMap?.[childId];
          isEnabled = accessVal === 'AVAILABLE';
        }
        const accessBtn = accessBtns[idx] ?? null;
        const card = accessBtn?.closest('.content-card-clickable') ?? null;
        return {
          itemId: item.itemId,
          title: item.title,
          contentType: item.activityCategory,
          isEnabled,
          _accessBtn: accessBtn,
          _domCard: card,
        };
      });
    },

    _getFromDOMSwitches() {
      const switches = document.querySelectorAll('input[role="switch"]');
      return Array.from(switches).map((sw) => {
        const label = sw.getAttribute('aria-label') || '';
        const lastComma = label.lastIndexOf(', ');
        const title = lastComma >= 0 ? label.substring(0, lastComma) : label;
        const contentType = lastComma >= 0 ? label.substring(lastComma + 2) : 'UNKNOWN';
        const card = sw.closest('.content-card-clickable') ||
                     sw.closest('[class*="content-card"]');
        return {
          itemId: null,
          title,
          contentType: contentType.toUpperCase(),
          isEnabled: sw.checked,
          _domSwitch: sw,
          _domCard: card,
        };
      });
    },

    _getFromDOMAccessButtons() {
      const accessBtns = document.querySelectorAll('.allowlist-count');
      return Array.from(accessBtns).map((btn) => {
        const label = btn.getAttribute('aria-label') || '';
        // Format: "Title, Type, N children have access"
        const parts = label.split(', ');
        const title = parts.length >= 3 ? parts.slice(0, -2).join(', ') : (parts[0] || '');
        const contentType = parts.length >= 3 ? parts[parts.length - 2] : 'UNKNOWN';
        const countText = btn.textContent.trim();
        const count = parseInt(countText, 10) || 0;
        const card = btn.closest('.content-card-clickable') ||
                     btn.closest('[class*="content-card"]');
        return {
          itemId: null,
          title,
          contentType: contentType.toUpperCase(),
          isEnabled: count > 0,  // rough heuristic when no fiber
          _accessBtn: btn,
          _domCard: card,
        };
      });
    },

    getPagination() {
      const buttons = document.querySelectorAll('button');
      let showMoreBtn = null;
      for (const btn of buttons) {
        const txt = btn.textContent.toLowerCase();
        if (txt.includes('show more')) { showMoreBtn = btn; break; }
      }

      let isLastPage = !showMoreBtn;
      let isLoading = false;
      if (this._fiberAvailable) {
        const pc = FiberUtil.findPageComponent();
        if (pc) {
          const props = pc.memoizedProps;
          isLastPage = props.itemProps?.isLastPage ?? isLastPage;
          isLoading = props.itemProps?.isLoading ?? false;
        }
      }

      return {
        isLastPage,
        isLoading,
        loadMore: showMoreBtn ? () => showMoreBtn.click() : null,
      };
    },
  };

  // --------------------------------------------------------------------------
  // Item Filter
  // --------------------------------------------------------------------------
  const Filter = {
    _normalize(str) {
      return CONFIG.keywordCaseSensitive ? str : (str || '').toLowerCase();
    },

    shouldProcess(item) {
      // For child-selected mode, use live DOM switch state
      const isEnabled = item._domSwitch ? item._domSwitch.checked : item.isEnabled;

      // Mode check
      if (CONFIG.mode === 'disable' && !isEnabled) return false;
      if (CONFIG.mode === 'enable' && isEnabled) return false;

      // Content type filter
      if (CONFIG.contentTypes) {
        const t = (item.contentType || '').toUpperCase();
        if (!CONFIG.contentTypes.some((ct) => ct.toUpperCase() === t)) return false;
      }

      const title = this._normalize(item.title);

      // Include keywords — item must match at least one
      if (CONFIG.keywords && CONFIG.keywords.length > 0) {
        const match = CONFIG.keywords.some((kw) => title.includes(this._normalize(kw)));
        if (!match) return false;
      }

      // Exclude keywords — item must NOT match any
      if (CONFIG.excludeKeywords && CONFIG.excludeKeywords.length > 0) {
        const excluded = CONFIG.excludeKeywords.some((kw) => title.includes(this._normalize(kw)));
        if (excluded) return false;
      }

      return true;
    },
  };

  // --------------------------------------------------------------------------
  // Toggle Engine — Child-Selected Mode (concurrent card clicks)
  // --------------------------------------------------------------------------
  const CardClickEngine = {
    _processedIds: new Set(),
    _stats: { toggled: 0, skipped: 0, failed: 0, retried: 0 },

    _waitForToggle(sw, expectedChecked, timeoutMs = 3000) {
      return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          if (sw.checked === expectedChecked) { resolve(true); return; }
          if (Date.now() - start > timeoutMs) { resolve(false); return; }
          setTimeout(check, 50);
        };
        setTimeout(check, 50);
      });
    },

    async processBatch(items) {
      const toProcess = items.filter((item) => {
        const key = item._domSwitch ?? item.itemId ?? item.title;
        return !this._processedIds.has(key) && Filter.shouldProcess(item);
      });

      if (toProcess.length === 0) return;

      for (const item of toProcess) {
        this._processedIds.add(item._domSwitch ?? item.itemId ?? item.title);
      }

      if (CONFIG.dryRun) {
        for (const item of toProcess) {
          Logger.verbose(`[DRY RUN] Would ${CONFIG.mode}: "${item.title}" (${item.contentType})`);
        }
        this._stats.skipped += toProcess.length;
        return;
      }

      const expectChecked = CONFIG.mode === 'enable';

      for (let i = 0; i < toProcess.length; i += CONFIG.clickConcurrency) {
        if (!State.isRunning()) break;
        await State.checkPause();

        const chunk = toProcess.slice(i, i + CONFIG.clickConcurrency);
        const clickPromises = chunk.map((item) => {
          const cardEl = item._domCard;
          if (!cardEl) {
            Logger.verbose(`No card element for "${item.title}"`);
            this._stats.failed++;
            return Promise.resolve();
          }
          const sw = item._domSwitch || cardEl.querySelector('input[role="switch"]');
          cardEl.click();

          if (sw) {
            return this._waitForToggle(sw, expectChecked).then((ok) => {
              if (ok) {
                this._stats.toggled++;
              } else {
                this._stats.retried++;
                cardEl.click();
                return this._waitForToggle(sw, expectChecked, 3000).then((ok2) => {
                  ok2 ? this._stats.toggled++ : this._stats.failed++;
                });
              }
            });
          } else {
            this._stats.toggled++;
            return Promise.resolve();
          }
        });

        await Promise.all(clickPromises);
        if (i + CONFIG.clickConcurrency < toProcess.length) {
          await sleep(CONFIG.clickDelayMs);
        }
      }
    },

    getStats() { return { ...this._stats }; },
  };

  // --------------------------------------------------------------------------
  // Toggle Engine — No-Child-Selected Mode (sequential panel toggles)
  // --------------------------------------------------------------------------
  const PanelEngine = {
    _processedIds: new Set(),
    _stats: { toggled: 0, skipped: 0, failed: 0, retried: 0 },
    _targetChildName: null,

    init(childName) {
      this._targetChildName = childName;
    },

    // Open the "Manage access" panel for an item
    async _openPanel(accessBtn) {
      accessBtn.click();
      // Wait for the switch to appear in the dialog
      const sw = await waitFor(
        () => document.querySelector('[role="dialog"] input[role="switch"], .panda-site-sheet-container input[role="switch"]'),
        3000, 100
      );
      return sw;
    },

    // Find the correct child's switch in the panel (when there are multiple children)
    _findChildSwitch() {
      const container = document.querySelector('.panda-site-sheet-container') ||
                        document.querySelector('[role="dialog"]');
      if (!container) return null;

      const switches = container.querySelectorAll('input[role="switch"]');
      if (switches.length === 0) return null;

      // If only one child, return the only switch
      if (switches.length === 1) return switches[0];

      // Multiple children — find by name
      if (this._targetChildName) {
        for (const sw of switches) {
          const row = sw.closest('label')?.parentElement;
          if (row && row.textContent.includes(this._targetChildName)) return sw;
        }
      }

      // Fallback: return first switch
      return switches[0];
    },

    // Click Done to confirm changes
    async _clickDone() {
      const doneBtn = await waitFor(() => {
        return Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent.trim() === 'Done'
        );
      }, 2000, 100);
      if (doneBtn) {
        doneBtn.click();
        // Wait for panel to close / toast to appear
        await sleep(300);
        return true;
      }
      return false;
    },

    // Close the panel without saving
    async _clickCancel() {
      const cancelBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === 'Cancel'
      );
      if (cancelBtn) {
        cancelBtn.click();
        await sleep(200);
      }
    },

    async processItems(items) {
      const toProcess = items.filter((item) => {
        const key = item._accessBtn ?? item.itemId ?? item.title;
        return !this._processedIds.has(key) && Filter.shouldProcess(item);
      });

      if (toProcess.length === 0) return;

      for (const item of toProcess) {
        this._processedIds.add(item._accessBtn ?? item.itemId ?? item.title);
      }

      if (CONFIG.dryRun) {
        for (const item of toProcess) {
          Logger.verbose(`[DRY RUN] Would ${CONFIG.mode}: "${item.title}" (${item.contentType})`);
        }
        this._stats.skipped += toProcess.length;
        return;
      }

      // Process items one at a time (panel UI constraint)
      for (let i = 0; i < toProcess.length; i++) {
        if (!State.isRunning()) break;
        await State.checkPause();

        const item = toProcess[i];
        const accessBtn = item._accessBtn;
        if (!accessBtn) {
          Logger.verbose(`No access button for "${item.title}"`);
          this._stats.failed++;
          continue;
        }

        // Scroll the button into view
        accessBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(50);

        // Open panel
        const sw = await this._openPanel(accessBtn);
        if (!sw) {
          Logger.verbose(`Panel did not open for "${item.title}"`);
          this._stats.failed++;
          continue;
        }

        // Find the right child's switch
        const childSw = this._findChildSwitch();
        if (!childSw) {
          Logger.verbose(`No child switch found for "${item.title}"`);
          await this._clickCancel();
          this._stats.failed++;
          continue;
        }

        // Check current state and toggle if needed
        const wantChecked = CONFIG.mode === 'enable';
        if (childSw.checked === wantChecked) {
          // Already in desired state
          Logger.verbose(`"${item.title}" already ${CONFIG.mode}d`);
          await this._clickCancel();
          this._stats.skipped++;
          continue;
        }

        // Toggle the switch
        const label = childSw.closest('label');
        if (label) {
          label.click();
        } else {
          childSw.click();
        }
        await sleep(100);

        // Verify toggle
        if (childSw.checked !== wantChecked) {
          Logger.verbose(`Switch did not toggle for "${item.title}", retrying`);
          this._stats.retried++;
          (label || childSw).click();
          await sleep(200);
        }

        // Click Done to save
        const saved = await this._clickDone();
        if (saved) {
          this._stats.toggled++;
          Logger.verbose(`${CONFIG.mode}d: "${item.title}"`);
        } else {
          Logger.verbose(`Failed to save "${item.title}"`);
          this._stats.failed++;
        }

        // Brief pause between items to let the UI settle
        await sleep(CONFIG.clickDelayMs);

        // Log progress every 10 items
        if ((i + 1) % 10 === 0) {
          Logger.progress(this._stats, toProcess.length);
        }
      }
    },

    getStats() { return { ...this._stats }; },
  };

  // --------------------------------------------------------------------------
  // Wait for new items to appear after a page load
  // --------------------------------------------------------------------------
  function waitForNewItems(getCount, previousCount, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (!State.isRunning() && !State.isPaused()) { resolve(); return; }
        if (getCount() > previousCount) { resolve(); return; }
        if (Date.now() - start > timeoutMs) {
          Logger.info('Timeout waiting for new items — continuing');
          resolve();
          return;
        }
        setTimeout(check, 150);
      };
      setTimeout(check, 150);
    });
  }

  // --------------------------------------------------------------------------
  // Main
  // --------------------------------------------------------------------------
  async function main() {
    Logger.info(`Amazon Kids Content Manager v3 starting (mode: ${CONFIG.mode})`);
    if (CONFIG.dryRun) Logger.info('** DRY RUN MODE — no changes will be made **');
    if (CONFIG.keywords) Logger.info(`Keywords (include): ${CONFIG.keywords.join(', ')}`);
    if (CONFIG.excludeKeywords) Logger.info(`Keywords (exclude): ${CONFIG.excludeKeywords.join(', ')}`);
    if (CONFIG.contentTypes) Logger.info(`Content type filter: ${CONFIG.contentTypes.join(', ')}`);

    // Pre-flight check
    if (!window.location.href.includes('parentdashboard') &&
        !window.location.href.includes('parents.amazon')) {
      Logger.info('ERROR: Navigate to https://parents.amazon.com/explore first');
      return;
    }

    // Initialize
    ItemSource.init();
    State.start();

    // Detect page mode
    const pageMode = detectPageMode();
    if (!pageMode) {
      Logger.info('ERROR: No content items found. Make sure you are on the content page.');
      return;
    }

    const isChildSelected = pageMode === 'child-selected';
    Logger.info(`Page mode: ${pageMode}`);

    if (isChildSelected && CONFIG.mode === 'enable') {
      Logger.info('WARNING: Enable mode in child-selected view only sees enabled items.');
      Logger.info('To re-enable disabled items, deselect the child first (click back arrow).');
    }

    // Determine target child name for panel mode
    if (!isChildSelected) {
      const childInfo = ItemSource.getChildInfo();
      const targetName = CONFIG.childName || childInfo.childName;
      PanelEngine.init(targetName);
      Logger.info(`Target child: ${targetName || '(first child)'}`);
    }

    let pageNum = 0;

    // Main loop: process current items, then load next page
    while (State.isRunning()) {
      await State.checkPause();
      pageNum++;

      const items = isChildSelected
        ? ItemSource.getItemsChildSelected()
        : ItemSource.getItemsNoChild();

      const engine = isChildSelected ? CardClickEngine : PanelEngine;
      Logger.info(`Page ${pageNum}: ${items.length} items loaded`);

      // Process items
      if (isChildSelected) {
        await engine.processBatch(items);
      } else {
        await engine.processItems(items);
      }

      Logger.progress(engine.getStats(), items.length);

      // Check pagination
      const pagination = ItemSource.getPagination();

      if (pagination.isLastPage) {
        Logger.info('Reached last page');
        break;
      }

      if (!pagination.loadMore) {
        Logger.info('No more pages to load');
        break;
      }

      if (pagination.isLoading) {
        Logger.verbose('Waiting for current page load to finish...');
        await sleep(1000);
        continue;
      }

      // Load next page
      Logger.verbose('Loading next page...');
      const prevCount = items.length;
      pagination.loadMore();

      const getCount = isChildSelected
        ? () => document.querySelectorAll('input[role="switch"]').length
        : () => document.querySelectorAll('.allowlist-count').length;

      await waitForNewItems(getCount, prevCount);
      await sleep(CONFIG.pageDelayMs);
    }

    // Final pass — catch any stragglers
    if (State.isRunning()) {
      const finalItems = isChildSelected
        ? ItemSource.getItemsChildSelected()
        : ItemSource.getItemsNoChild();
      if (isChildSelected) {
        await CardClickEngine.processBatch(finalItems);
      } else {
        await PanelEngine.processItems(finalItems);
      }
    }

    const engine = isChildSelected ? CardClickEngine : PanelEngine;
    State.stop();
    Logger.summary(engine.getStats());
  }

  // --------------------------------------------------------------------------
  // Keyboard controls
  // --------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key === 'c') {
      e.preventDefault();
      if (State.isRunning()) State.pause();
    }
    if (e.ctrlKey && e.altKey && e.key === 'r') {
      e.preventDefault();
      if (State.isPaused()) State.resume();
    }
  });

  // --------------------------------------------------------------------------
  // Go
  // --------------------------------------------------------------------------
  await main();
})();
