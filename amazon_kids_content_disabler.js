// Amazon Kids Content Disabler v2
// https://github.com/bryanroscoe/amazon-kids-content-manager
//
// Bulk disable (or enable) content on Amazon Kids Parent Dashboard.
// Works on amazon.com and amazon.ca as of 2026-02-09.
//
// Instructions:
//   1. Go to https://parents.amazon.com/explore (substitute .com with your domain)
//   2. Select your child. Set their age range to 2-2 for maximum content visibility.
//   3. Open DevTools console (Ctrl+Shift+I / Cmd+Option+I)
//   4. Type "allow pasting" and press Enter
//   5. Paste this script and press Enter
//   6. Repeat for each child
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
  // 'disable' = turn off content for child, 'enable' = turn on content
  mode: 'disable',

  // Filter by content type. null = all types.
  // Valid: 'APP', 'EBOOK', 'VIDEO', 'AUDIBLE', 'SKILL'
  contentTypes: null,

  // Keyword filter. null = process all items.
  // Only items whose title contains ANY keyword will be processed.
  keywords: null,

  // Case-insensitive keyword matching
  keywordCaseSensitive: false,

  // Number of items to click at once before waiting for responses
  clickConcurrency: 5,

  // Delay between click batches in ms
  clickDelayMs: 150,

  // Delay between pagination loads in ms
  pageDelayMs: 100,

  // Max retries per failed toggle
  maxRetries: 3,

  // Logging: 'quiet', 'normal', 'verbose'
  logLevel: 'normal',

  // Dry run — log what would happen without actually toggling
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
      if (CONFIG.logLevel !== 'quiet') console.log(`[AKL ${this._elapsed()}] ${msg}`);
    },
    verbose(msg) {
      if (CONFIG.logLevel === 'verbose') console.log(`[AKL ${this._elapsed()}]   ${msg}`);
    },
    progress(stats, page) {
      if (CONFIG.logLevel === 'quiet') return;
      console.log(
        `[AKL ${this._elapsed()}] Page ${page} | Toggled: ${stats.toggled} | Skipped: ${stats.skipped} | Failed: ${stats.failed}` +
          (stats.retried ? ` | Retries: ${stats.retried}` : '')
      );
    },
    summary(stats) {
      console.log('\n=== Amazon Kids Content Disabler — Complete ===');
      console.log(`Mode: ${CONFIG.mode}`);
      console.log(`Duration: ${this._elapsed()}`);
      console.log(`Toggled: ${stats.toggled}`);
      console.log(`Skipped: ${stats.skipped}`);
      console.log(`Failed: ${stats.failed}`);
      if (stats.retried) console.log(`Retries: ${stats.retried}`);
      if (CONFIG.keywords) console.log(`Keywords: ${CONFIG.keywords.join(', ')}`);
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
    _containerKey: null,

    init() {
      // Fiber keys live on child DOM elements, not the root (which has __reactContainer$)
      const root = document.getElementById('root');
      if (!root) return false;

      // Find container key on root
      for (const key of Object.keys(root)) {
        if (key.startsWith('__reactContainer$')) this._containerKey = key;
      }

      // Find fiber/props keys from any content element
      const probe = document.querySelector('input[role="switch"]') ||
                    document.querySelector('.content-card-clickable') ||
                    document.querySelector('[class*="content-card"]');
      if (probe) {
        for (const key of Object.keys(probe)) {
          if (key.startsWith('__reactFiber$')) this._fiberKey = key;
          if (key.startsWith('__reactProps$')) this._propsKey = key;
        }
      }

      return !!(this._fiberKey || this._containerKey);
    },

    getFiber(el) {
      return el?.[this._fiberKey] ?? null;
    },

    // Walk up the fiber tree from an element to find a component matching a predicate
    findAncestor(el, predicate, maxDepth = 50) {
      let fiber = this.getFiber(el);
      for (let i = 0; i < maxDepth && fiber; i++) {
        if (predicate(fiber)) return fiber;
        fiber = fiber.return;
      }
      return null;
    },

    // Find the page-level component (has fetchItems + itemProps + basePageData)
    findPageComponent() {
      const probe = document.querySelector('input[role="switch"]') ||
                    document.querySelector('.content-card-clickable');
      if (!probe) return null;

      return this.findAncestor(probe, (fiber) => {
        const p = fiber.memoizedProps;
        return p && typeof p.fetchItems === 'function' && p.itemProps && p.basePageData;
      }, 60);
    },
  };

  // --------------------------------------------------------------------------
  // (API approach removed — Amazon silently ignores direct XHR toggle calls
  //  despite returning 200. Only DOM card clicks actually persist changes.)
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Item Data Source — reads items from React Fiber (preferred) or DOM (fallback)
  // --------------------------------------------------------------------------
  const ItemSource = {
    _fiberAvailable: false,

    init() {
      this._fiberAvailable = FiberUtil.init();
      if (this._fiberAvailable) {
        const pc = FiberUtil.findPageComponent();
        if (pc) {
          Logger.info('React Fiber access available');
        } else {
          Logger.info('Fiber keys found but page component not located — using DOM fallback');
          this._fiberAvailable = false;
        }
      } else {
        Logger.info('No fiber access — using DOM selectors');
      }
    },

    getItems() {
      if (this._fiberAvailable) {
        const items = this._getFromFiber();
        if (items) return items;
        // Fiber went stale, fall back
        this._fiberAvailable = false;
      }
      return this._getFromDOM();
    },

    _getFromFiber() {
      const pc = FiberUtil.findPageComponent();
      if (!pc) return null;

      const props = pc.memoizedProps;
      const items = props.itemProps?.items;
      if (!items) return null;

      const childId = props.basePageData?.selectedChild?.directedId;

      return items.map((item) => {
        const accessVal = item.childDirectedIdAccessMap?.[childId];
        // "AVAILABLE" means enabled/allowed, anything else means disabled
        const isEnabled = accessVal === 'AVAILABLE';

        return {
          itemId: item.itemId,
          title: item.title,
          contentType: item.activityCategory,
          isEnabled,
          _childId: childId,
        };
      });
    },

    _getFromDOM() {
      const switches = document.querySelectorAll('input[role="switch"]');
      return Array.from(switches).map((sw) => {
        const label = sw.getAttribute('aria-label') || '';
        // Format: "Title, ContentType"
        const lastComma = label.lastIndexOf(', ');
        const title = lastComma >= 0 ? label.substring(0, lastComma) : label;
        const contentType = lastComma >= 0 ? label.substring(lastComma + 2) : 'UNKNOWN';

        // Find the parent .content-card-clickable for click targeting
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

    getPagination() {
      // Find the "Show more" button — always use DOM click for pagination
      // (the React fetchItems function has a complex 9-arg signature we can't replicate)
      const buttons = document.querySelectorAll('button');
      let showMoreBtn = null;
      for (const btn of buttons) {
        if (btn.textContent.includes('Show more')) { showMoreBtn = btn; break; }
      }
      // Also try old selector as last resort
      if (!showMoreBtn) showMoreBtn = document.querySelector('.pd-margin-top .css-mnocv9');

      // Use fiber for reading state (isLastPage, isLoading) if available
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

    getChildId() {
      if (this._fiberAvailable) {
        const pc = FiberUtil.findPageComponent();
        if (pc) return pc.memoizedProps?.basePageData?.selectedChild?.directedId ?? null;
      }
      return null;
    },
  };

  // --------------------------------------------------------------------------
  // Item Filter
  // --------------------------------------------------------------------------
  const Filter = {
    shouldProcess(item) {
      // Mode check: disable mode processes enabled items, enable mode processes disabled
      if (CONFIG.mode === 'disable' && !item.isEnabled) return false;
      if (CONFIG.mode === 'enable' && item.isEnabled) return false;

      // Content type filter
      if (CONFIG.contentTypes) {
        const t = (item.contentType || '').toUpperCase();
        if (!CONFIG.contentTypes.some((ct) => ct.toUpperCase() === t)) return false;
      }

      // Keyword filter
      if (CONFIG.keywords && CONFIG.keywords.length > 0) {
        const title = CONFIG.keywordCaseSensitive ? item.title : (item.title || '').toLowerCase();
        const match = CONFIG.keywords.some((kw) => {
          const k = CONFIG.keywordCaseSensitive ? kw : kw.toLowerCase();
          return title.includes(k);
        });
        if (!match) return false;
      }

      return true;
    },
  };

  // --------------------------------------------------------------------------
  // Toggle Engine — uses DOM card clicks (the only method that persists)
  // --------------------------------------------------------------------------
  const Engine = {
    _processedIds: new Set(),
    _stats: { toggled: 0, skipped: 0, failed: 0 },

    async init() {
      Logger.info('Using DOM card clicks to toggle items');
    },

    _findCardByTitle(title) {
      const switches = document.querySelectorAll('input[role="switch"]');
      for (const sw of switches) {
        if ((sw.getAttribute('aria-label') || '').includes(title)) {
          return sw.closest('.content-card-clickable');
        }
      }
      return null;
    },

    // Wait for a card click to be acknowledged (switch state changes)
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
        const key = item.itemId ?? item.title;
        return !this._processedIds.has(key) && Filter.shouldProcess(item);
      });

      if (toProcess.length === 0) return;

      // Mark all as processed upfront to avoid double-processing
      for (const item of toProcess) {
        this._processedIds.add(item.itemId ?? item.title);
      }

      if (CONFIG.dryRun) {
        for (const item of toProcess) {
          Logger.verbose(`[DRY RUN] Would ${CONFIG.mode}: "${item.title}" (${item.contentType})`);
        }
        this._stats.skipped += toProcess.length;
        return;
      }

      const expectChecked = CONFIG.mode === 'enable';

      // Process in concurrent chunks
      for (let i = 0; i < toProcess.length; i += CONFIG.clickConcurrency) {
        if (!State.isRunning()) break;
        await State.checkPause();

        const chunk = toProcess.slice(i, i + CONFIG.clickConcurrency);

        // Click all items in this chunk simultaneously
        const clickPromises = chunk.map((item) => {
          const cardEl = item._domCard || this._findCardByTitle(item.title);
          if (!cardEl) {
            Logger.verbose(`Cannot toggle "${item.title}" — no DOM element found`);
            this._stats.failed++;
            return Promise.resolve();
          }

          // Find the switch to verify the click worked
          const sw = cardEl.querySelector('input[role="switch"]');
          cardEl.click();

          if (sw) {
            return this._waitForToggle(sw, expectChecked).then((ok) => {
              if (ok) {
                this._stats.toggled++;
              } else {
                // Retry once
                Logger.verbose(`Retrying toggle for "${item.title}"`);
                cardEl.click();
                return this._waitForToggle(sw, expectChecked, 3000).then((ok2) => {
                  if (ok2) {
                    this._stats.toggled++;
                  } else {
                    Logger.verbose(`Failed to toggle "${item.title}"`);
                    this._stats.failed++;
                  }
                });
              }
            });
          } else {
            this._stats.toggled++;
            return Promise.resolve();
          }
        });

        await Promise.all(clickPromises);
        // Small delay between chunks to avoid overwhelming the page
        if (i + CONFIG.clickConcurrency < toProcess.length) {
          await sleep(CONFIG.clickDelayMs);
        }
      }
    },

    getStats() { return { ...this._stats }; },
  };

  // --------------------------------------------------------------------------
  // Wait for new items to appear after a page load
  // --------------------------------------------------------------------------
  function waitForNewItems(previousCount, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (!State.isRunning() && !State.isPaused()) { resolve(); return; }
        const current = ItemSource.getItems();
        if (current.length > previousCount) { resolve(); return; }
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
    Logger.info(`Amazon Kids Content Disabler v2 starting (mode: ${CONFIG.mode})`);
    if (CONFIG.dryRun) Logger.info('** DRY RUN MODE — no changes will be made **');
    if (CONFIG.keywords) Logger.info(`Keyword filter: ${CONFIG.keywords.join(', ')}`);
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
    await Engine.init();

    let pageNum = 0;

    // Main loop: process current items, then load next page
    while (State.isRunning()) {
      await State.checkPause();
      pageNum++;

      const items = ItemSource.getItems();
      Logger.progress(Engine.getStats(), pageNum);

      // Process items on current page
      await Engine.processBatch(items);

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

      // Wait if currently loading
      if (pagination.isLoading) {
        Logger.verbose('Waiting for current page load to finish...');
        await sleep(1000);
        continue;
      }

      // Load next page by clicking "Show more" button
      Logger.verbose('Loading next page...');
      const prevCount = items.length;
      pagination.loadMore();

      await waitForNewItems(prevCount);
      await sleep(CONFIG.pageDelayMs);
    }

    // Final pass — catch any stragglers
    if (State.isRunning()) {
      const finalItems = ItemSource.getItems();
      await Engine.processBatch(finalItems);
    }

    State.stop();
    Logger.summary(Engine.getStats());
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
