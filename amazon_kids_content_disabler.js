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

  // Max ASINs per single API call (the endpoint accepts arrays)
  apiBatchSize: 30,

  // Delay between individual DOM clicks in ms (fallback mode)
  clickDelayMs: 150,

  // Delay between pagination loads in ms
  pageDelayMs: 100,

  // Max retries per failed toggle
  maxRetries: 3,

  // Base delay for exponential backoff in ms
  retryBackoffMs: 1000,

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
  // API Discovery — intercept one real XHR to learn the toggle endpoint
  // --------------------------------------------------------------------------
  const ApiLayer = {
    _endpoint: null,
    _csrfHeader: null,
    _csrfValue: null,
    _childId: null,
    _discovered: false,

    // Try to discover API by intercepting an XHR from one real card click
    async discover(cardEl) {
      return new Promise((resolve) => {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        let captured = false;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this._capMethod = method;
          this._capUrl = url;
          this._capHeaders = {};
          return origOpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
          if (this._capHeaders) this._capHeaders[name] = value;
          return origSetHeader.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function (body) {
          if (!captured && this._capMethod === 'POST' && this._capUrl &&
              this._capUrl.includes('change-multi-item-status')) {
            captured = true;
            ApiLayer._endpoint = this._capUrl;

            // Extract CSRF header
            for (const [k, v] of Object.entries(this._capHeaders)) {
              if (k.toLowerCase().includes('csrf')) {
                ApiLayer._csrfHeader = k;
                ApiLayer._csrfValue = v;
              }
            }

            // Extract child ID from body
            try {
              const parsed = JSON.parse(body);
              const childIds = Object.keys(parsed.childDirectedIdAllowlistStatusMap || {});
              if (childIds.length > 0) ApiLayer._childId = childIds[0];
            } catch (e) { /* ignore */ }

            ApiLayer._discovered = true;

            // Restore XHR prototypes
            XMLHttpRequest.prototype.open = origOpen;
            XMLHttpRequest.prototype.send = origSend;
            XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
            resolve(true);
          }
          return origSend.apply(this, arguments);
        };

        // Trigger one real toggle via DOM click
        cardEl.click();

        // Timeout fallback
        setTimeout(() => {
          if (!captured) {
            XMLHttpRequest.prototype.open = origOpen;
            XMLHttpRequest.prototype.send = origSend;
            XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
            resolve(false);
          }
        }, 8000);
      });
    },

    // Make a direct XHR toggle call
    toggleViaApi(asins, status) {
      return new Promise((resolve, reject) => {
        if (!this._discovered || !this._endpoint || !this._childId) {
          reject(new Error('API not discovered'));
          return;
        }

        const xhr = new XMLHttpRequest();
        xhr.open('POST', this._endpoint, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (this._csrfHeader && this._csrfValue) {
          xhr.setRequestHeader(this._csrfHeader, this._csrfValue);
        }
        xhr.withCredentials = true;

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.status);
          } else if (xhr.status === 429) {
            reject(new Error('Rate limited (429)'));
          } else {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Timeout'));
        xhr.timeout = 15000;

        const body = JSON.stringify({
          childDirectedIdAllowlistStatusMap: { [this._childId]: status },
          asins: Array.isArray(asins) ? asins : [asins],
        });

        xhr.send(body);
      });
    },
  };

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
      return ApiLayer._childId ?? null;
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
  // Toggle Engine
  // --------------------------------------------------------------------------
  const Engine = {
    _processedIds: new Set(),
    _stats: { toggled: 0, skipped: 0, failed: 0, retried: 0 },
    _useApi: false,

    async init() {
      // Try to discover API by triggering one real toggle on a processable item
      const items = ItemSource.getItems();
      const firstTarget = items.find((item) => Filter.shouldProcess(item));

      if (firstTarget) {
        // We need a DOM card element to click for API discovery
        let cardEl = firstTarget._domCard;
        if (!cardEl) {
          // Find card by matching title in aria-labels
          const switches = document.querySelectorAll('input[role="switch"]');
          for (const sw of switches) {
            if ((sw.getAttribute('aria-label') || '').includes(firstTarget.title)) {
              cardEl = sw.closest('.content-card-clickable');
              break;
            }
          }
        }

        if (cardEl && !CONFIG.dryRun) {
          Logger.info('Discovering API by toggling one item...');
          this._useApi = await ApiLayer.discover(cardEl);
          // Mark this item as processed (the discovery click already toggled it)
          this._processedIds.add(firstTarget.itemId ?? firstTarget.title);
          this._stats.toggled++;

          if (this._useApi) {
            Logger.info('API discovered — using direct API calls (fast mode)');
          } else {
            Logger.info('API discovery failed — using DOM clicks (slower)');
          }
        }
      } else {
        Logger.info('No items to process on current page');
      }
    },

    // Toggle a single item via DOM click (fallback path)
    async toggleItemDOM(item) {
      const cardEl = item._domCard || this._findCardByTitle(item.title);
      if (!cardEl) {
        Logger.verbose(`Cannot toggle "${item.title}" — no DOM element found`);
        this._stats.failed++;
        return;
      }
      cardEl.click();
      await sleep(CONFIG.clickDelayMs);
      this._stats.toggled++;
    },

    // Sync UI: visually flip toggle switches to reflect the API change
    _syncUI(items) {
      const targetChecked = CONFIG.mode === 'enable';
      // Build a set of titles to match
      const titles = new Set(items.map((i) => i.title));
      const switches = document.querySelectorAll('input[role="switch"]');
      for (const sw of switches) {
        const label = sw.getAttribute('aria-label') || '';
        // aria-label format: "Title, ContentType" — extract title part
        const lastComma = label.lastIndexOf(', ');
        const swTitle = lastComma >= 0 ? label.substring(0, lastComma) : label;
        if (titles.has(swTitle)) {
          sw.checked = targetChecked;
          sw.setAttribute('aria-checked', String(targetChecked));
          titles.delete(swTitle);
          if (titles.size === 0) break;
        }
      }
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

      const apiStatus = CONFIG.mode === 'disable' ? 'BLOCK' : 'ALLOW';

      if (this._useApi && toProcess.every((i) => i.itemId)) {
        // Batch API calls — send multiple ASINs per request
        for (let i = 0; i < toProcess.length; i += CONFIG.apiBatchSize) {
          if (!State.isRunning()) break;
          await State.checkPause();

          const chunk = toProcess.slice(i, i + CONFIG.apiBatchSize);
          const asins = chunk.map((item) => item.itemId);

          for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
            try {
              await ApiLayer.toggleViaApi(asins, apiStatus);
              this._stats.toggled += chunk.length;
              Logger.verbose(`Batch ${CONFIG.mode}d ${chunk.length} items`);
              // Sync UI so toggles visually flip
              this._syncUI(chunk);
              break;
            } catch (err) {
              if (attempt < CONFIG.maxRetries) {
                const delay = CONFIG.retryBackoffMs * Math.pow(2, attempt);
                Logger.info(`Batch retry ${attempt + 1}/${CONFIG.maxRetries} (${chunk.length} items) in ${delay}ms: ${err.message}`);
                this._stats.retried++;
                await sleep(delay);
              } else {
                Logger.info(`Batch FAILED after ${CONFIG.maxRetries} retries (${chunk.length} items): ${err.message}`);
                this._stats.failed += chunk.length;
              }
            }
          }
        }
      } else {
        // Sequential DOM clicks (fallback)
        for (const item of toProcess) {
          if (!State.isRunning()) break;
          await State.checkPause();
          await this.toggleItemDOM(item);
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
