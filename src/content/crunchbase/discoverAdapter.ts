import type { ChunkRecord } from "@shared/models";
import { injectPageHook, PAGE_HOOK_SOURCE } from "./pageBridge";
import {
  clickElement,
  clickRadioByLabel,
  findButtonLikeByText,
  findOpenMenuPanel,
  getByTagName,
  getScrollParent,
  isElementDisplayed,
  normalizeText,
  setInputValue,
  sleep,
  waitForCheckboxChecked,
  waitForElement,
} from "./discoverDomUtils";

const SOURCE_CRUNCHBASE_DISCOVER_ORGS = "crunchbase-discover-orgs" as const;
const DISCOVER_ORGS_PATH = "/discover/organization.companies";

const DELAYS = {
  afterFinancialsClickMs: 650,
  afterCustomClickMs: 450,
  afterSetDatesMs: 650,
  afterDatesResultsLoadMs: 10_000,
  afterSettingsClickMs: 250,
  afterMenuOpenMs: 250,
  afterToggleColumnMs: 200,
  afterApplyViewMs: 1000,
  beforeNextClickMs: 60_000, // IMPORTANT: wait 1 min before clicking Next
  afterNextClickMs: 1600,
  afterApplyFiltersWaitMs: 20_000,
};

const SELECTORS = {
  /** Prefer Material pagination control (often `<a>` when disabled, not `<button>`). */
  nextPage: [
    "a.page-button-next[aria-label='Next']",
    "button.page-button-next[aria-label='Next']",
    'button[aria-label="Next"]',
    'a[aria-label="Next"]',
    '[data-testid="next-page"]',
  ],
  prevPage: [
    "a.page-button-prev[aria-label='Previous']",
    "button.page-button-prev[aria-label='Previous']",
    'button[aria-label="Previous"]',
    'a[aria-label="Previous"]',
    'button[aria-label="Prev"]',
    'a[aria-label="Prev"]',
    '[data-testid="prev-page"]',
  ],
  resultsRoot: [
    ".search-results",
    "search-results-header",
    ".results-grid",
    "sheet-grid",
  ],

  // Results header settings → "Edit table view" flow
  resultsHeaderSettingsButton: [
    'search-results-header button[aria-label="Settings"]',
    'search-results-header button[mattooltip="Settings"]',
    'button[aria-label="Settings"]',
    'button[mattooltip="Settings"]',
  ],
  menuPanel: [
    ".cdk-overlay-container .mat-mdc-menu-panel",
    ".mat-mdc-menu-panel",
  ],
  editViewDialog: ["mat-dialog-container", ".mat-mdc-dialog-container"],
  editViewFilterInput: [
    'mat-dialog-container input[placeholder="Find a filter..."]',
    'mat-dialog-container input[placeholder*="Find a filter"]',
    'mat-dialog-container input[type="text"][name="filter-finder-no-autocomplete"]',
  ],
};

function findAdvancedFilterByHeader(
  overlay: ParentNode,
  headerText: string,
): Element | null {
  const want = normalizeText(headerText);
  const candidates = getByTagName<Element>(overlay, "advanced-filter");
  for (const af of candidates) {
    const h4 = af.querySelector(".filter-header h4");
    if (!(h4 instanceof HTMLElement)) continue;
    if (normalizeText(h4.textContent ?? "") === want) return af;
  }
  return null;
}

async function configureResultsTableView(
  searchKeywords: string[],
  log: (t: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!Array.isArray(searchKeywords) || searchKeywords.length === 0) {
    await log(
      "Table view: no columns configured; skipping view configuration.",
    );
    return;
  }

  // Settings button exists only once results header is rendered.
  // Wait for results UI to render after filters change.
  await waitForResultsRoot(15_000, signal);

  const settingsSelector = SELECTORS.resultsHeaderSettingsButton.join(",");
  const settings = await waitForElement(settingsSelector, {
    timeoutMs: 15_000,
    signal,
  });

  // Don't blindly click Settings; it toggles the menu open/closed.
  // If the menu is already open, avoid clicking (which would close it).
  let menu = findOpenMenuPanel(SELECTORS.menuPanel);
  if (!menu) {
    clickElement(settings);
    await log('Clicked results header "Settings"');
    await sleep(DELAYS.afterSettingsClickMs);
    // Wait for menu panel to actually open.
    const maybeMenu = await waitForElement(SELECTORS.menuPanel.join(","), {
      timeoutMs: 8000,
      signal,
    });
    menu = isElementDisplayed(maybeMenu)
      ? maybeMenu
      : findOpenMenuPanel(SELECTORS.menuPanel);
  } else {
    await log('Settings menu already open; not clicking "Settings" again.');
  }

  if (!menu) {
    await log("Settings menu did not open (skipping).");
    return;
  }
  await sleep(DELAYS.afterMenuOpenMs);

  const editTable = findButtonLikeByText(menu, "Edit table view");
  if (!editTable) {
    await log(
      'Settings menu opened, but "Edit table view" was not found (skipping).',
    );
    return;
  }
  clickElement(editTable);
  await log('Clicked "Edit table view"');

  // Wait for Edit View dialog and its filter input.
  const dialog = await waitForElement(SELECTORS.editViewDialog.join(","), {
    timeoutMs: 10_000,
    signal,
  });

  const filterInputEl = (await waitForElement(
    SELECTORS.editViewFilterInput.join(","),
    { timeoutMs: 10_000, signal, root: dialog },
  )) as Element;
  if (!(filterInputEl instanceof HTMLInputElement)) {
    await log("Edit View: could not locate filter input (skipping).");
    return;
  }

  const getResultsRoot = (): Element | ParentNode => {
    // Scope specifically to the "Results" list inside panel-search-results,
    // so we don't accidentally target checkboxes in "Selected Columns".
    return (
      dialog.querySelector("panel-search-results mat-action-list") ??
      dialog.querySelector("panel-search-results") ??
      dialog
    );
  };

  const findVisibleResultCheckboxInputs = (): HTMLInputElement[] => {
    const root = getResultsRoot();
    const inputs = Array.from(
      root.querySelectorAll("mat-checkbox input[type='checkbox']"),
    ).filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);

    // De-dupe in case Crunchbase renders duplicate panels.
    return Array.from(new Set(inputs));
  };

  const clickAllVisibleUnchecked = async (
    inputs: HTMLInputElement[],
  ): Promise<number> => {
    let clicked = 0;
    for (const input of inputs) {
      if (signal?.aborted) {
        const err = new Error("Cancelled by user");
        err.name = "AbortError";
        throw err;
      }
      if (input.checked || input.disabled) continue;

      // Prefer clicking the label (larger hitbox).
      const lbl = input.closest("mat-checkbox")?.querySelector("label") ?? null;
      if (lbl) clickElement(lbl);
      else clickElement(input);

      // Keep per-checkbox latency bounded; we'll encounter the row again on the
      // next visibility/scroll pass if the click didn't take.
      await waitForCheckboxChecked(input, { timeoutMs: 100, signal }).catch(
        () => undefined,
      );
      clicked += 1;
      await sleep(100);
    }
    return clicked;
  };

  // For each keyword: type → check all visible result checkboxes.
  for (const keyword of searchKeywords) {
    if (signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }

    await log(`Edit View: selecting all matches for "${keyword}"…`);
    filterInputEl.focus();
    // Don't blur here; the suggestions/results panel is driven by focus + input.
    setInputValue(filterInputEl, keyword, { blur: false });

    // Wait for results to settle/render after typing.
    const started = Date.now();
    let inputs: HTMLInputElement[] = [];
    while (Date.now() - started < 9000) {
      if (signal?.aborted) {
        const err = new Error("Cancelled by user");
        err.name = "AbortError";
        throw err;
      }
      inputs = findVisibleResultCheckboxInputs();
      // Heuristic: if at least one checkbox is present, proceed.
      if (inputs.length > 0) break;
      await sleep(120);
    }

    if (inputs.length === 0) {
      await log(
        `Edit View: no checkbox results found for "${keyword}" (skipping).`,
      );
    } else {
      // Crunchbase renders the results list as a virtualized scroll region.
      // We need to scroll through it and keep checking new items as they appear.
      let checkedCount = 0;
      const root = getResultsRoot();
      const getResultsScrollBox = (): HTMLElement | null => {
        const host =
          (dialog.querySelector("panel-search-results") as Element | null) ??
          (root instanceof Element ? root : null);

        if (!host) return null;

        // Prefer the actual results list container first.
        // In many Crunchbase builds, results are in:
        // panel-search-results .wrapper mat-action-list (scrollable).
        const preferredSelectors = [
          "panel-search-results .wrapper mat-action-list",
          "panel-search-results mat-action-list",
          ".wrapper mat-action-list",
          "mat-action-list",

          // Some builds use a virtual scroll viewport.
          "cdk-virtual-scroll-viewport",
          ".cdk-virtual-scroll-viewport",
          "[class*='virtual-scroll']",

          // Fallback wrappers that sometimes host the scrollbar.
          "panel-search-results .wrapper",
          ".drill-panels",
          ".dialog-content-container",
        ];
        for (const sel of preferredSelectors) {
          const el = host.querySelector(sel);
          if (
            el instanceof HTMLElement &&
            el.scrollHeight > el.clientHeight + 4
          ) {
            return el;
          }
        }

        // Fallback: find the closest scroll parent from likely anchors.
        return (
          getScrollParent(host) ??
          getScrollParent(filterInputEl) ??
          (dialog instanceof Element ? getScrollParent(dialog) : null)
        );
      };

      const scrollBox = getResultsScrollBox();

      // If we can't find a scroll container, at least click what we can see.
      if (!scrollBox) {
        checkedCount += await clickAllVisibleUnchecked(inputs);
      } else {
        // Start from the top for each keyword to avoid missing early items.
        try {
          scrollBox.scrollTop = 0;
          scrollBox.dispatchEvent(new Event("scroll"));
        } catch {
          /* ignore */
        }
        await sleep(80);

        let lastScrollTop = -1;
        let stagnantPasses = 0;
        for (let pass = 0; pass < 80; pass++) {
          if (signal?.aborted) {
            const err = new Error("Cancelled by user");
            err.name = "AbortError";
            throw err;
          }

          const visible = findVisibleResultCheckboxInputs();
          checkedCount += await clickAllVisibleUnchecked(visible);

          const before = scrollBox.scrollTop;
          const maxTop = Math.max(
            0,
            scrollBox.scrollHeight - scrollBox.clientHeight,
          );
          const atBottom = before >= maxTop - 2;
          if (atBottom) break;

          // Scroll down roughly one viewport to reveal new rows.
          scrollBox.scrollTop = Math.min(
            maxTop,
            before + Math.max(220, scrollBox.clientHeight * 0.85),
          );
          scrollBox.dispatchEvent(new Event("scroll"));
          await sleep(90);

          const after = scrollBox.scrollTop;
          if (after === lastScrollTop) stagnantPasses += 1;
          else stagnantPasses = 0;
          lastScrollTop = after;

          // If we can't make progress scrolling, bail out.
          if (stagnantPasses >= 4) break;
        }
      }
      await log(
        `Edit View: checked ${checkedCount} option${checkedCount === 1 ? "" : "s"} for "${keyword}".`,
      );
    }

    // Clear input for next iteration and enforce 100ms pacing per column.
    setInputValue(filterInputEl, "", { blur: false });
    await sleep(DELAYS.afterToggleColumnMs);
  }

  const applyBtn = findButtonLikeByText(dialog, "Apply Changes");
  if (!applyBtn) {
    await log('Edit View: "Apply Changes" button not found (skipping).');
    return;
  }

  const isApplyDisabled = (): boolean =>
    (applyBtn instanceof HTMLButtonElement && applyBtn.disabled) ||
    applyBtn.getAttribute("disabled") != null ||
    applyBtn.classList.contains("mat-mdc-button-disabled");

  // Click "Apply Changes". If it remains disabled, dismiss via the header Close button.
  const enableStarted = Date.now();
  while (isApplyDisabled() && Date.now() - enableStarted < 1500) {
    if (signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }
    await sleep(120);
  }

  if (!isApplyDisabled()) {
    clickElement(applyBtn);
    await log('Clicked "Apply Changes"');
  } else {
    const closeBtn = dialog.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLElement | null;
    if (closeBtn) {
      clickElement(closeBtn);
      await log('Edit View: "Apply Changes" disabled; clicked Close.');
    } else {
      await log('Edit View: "Apply Changes" disabled and Close not found.');
    }
  }

  // Wait for dialog to close.
  const closeStarted = Date.now();
  while (Date.now() - closeStarted < 12_000) {
    if (signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }
    const stillOpen = document.querySelector(
      SELECTORS.editViewDialog.join(","),
    );
    if (!stillOpen) break;
    await sleep(120);
  }
  await sleep(DELAYS.afterApplyViewMs);
  await log("Table view: applied column changes.");
}

function waitForResultsRoot(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const selector = SELECTORS.resultsRoot.join(",");
  return waitForElement(selector, { timeoutMs, signal }).then(() => undefined);
}

async function applyFinancialsValuationDateFilter(
  startDate: string,
  endDate: string,
  log: (t: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const overlay = await waitForElement("filter-overlay", {
    timeoutMs: 6500,
    signal,
  });

  const adv = findAdvancedFilterByHeader(overlay, "Last Funding Date");
  if (!adv) {
    await log(
      "Financials overlay opened, but Last Funding Date filter not found (continuing).",
    );
    return;
  }

  const clickedCustom = clickRadioByLabel(adv, "Custom Date Range");
  if (!clickedCustom) {
    await log(
      "Last Funding Date: could not click Custom Date Range (continuing).",
    );
    return;
  }
  await log('Clicked "Custom Date Range"');

  await sleep(DELAYS.afterCustomClickMs);

  const inputs = Array.from(adv.querySelectorAll("input")).filter(
    (x): x is HTMLInputElement => x instanceof HTMLInputElement && !x.disabled,
  );

  // Heuristic: once Custom Date Range is selected, the component renders exactly 2 inputs for start/end.
  // If there are more, pick the last two (usually the date fields within this advanced-filter).
  const dateInputs = inputs.filter(
    (i) =>
      i.type === "date" ||
      i.getAttribute("placeholder")?.toLowerCase().includes("date"),
  );
  const pick = (dateInputs.length >= 2 ? dateInputs : inputs).slice(-2);
  const start = pick[0];
  const end = pick[1];

  if (!start || !end) {
    await log(
      "Last Funding Date: could not find start/end inputs (continuing).",
    );
    return;
  }

  await log("Input start date…");
  setInputValue(start, startDate);
  await sleep(DELAYS.afterSetDatesMs);
  await log("Input end date…");
  setInputValue(end, endDate);
  await sleep(DELAYS.afterSetDatesMs);
  await log(`Last Funding Date: set custom range to ${startDate} → ${endDate}`);
}

function clickFilterGroupButtonByLabel(label: string): boolean {
  const want = normalizeText(label);
  const buttons = Array.from(
    document.querySelectorAll(
      "button.filter-group-button, button.mat-mdc-button-base",
    ),
  );

  for (const b of buttons) {
    if (!(b instanceof HTMLButtonElement)) continue;
    const txt = normalizeText(b.textContent ?? "");
    if (!txt) continue;
    if (txt.includes(want)) {
      b.click();
      return true;
    }
  }
  return false;
}

export function assertDiscoverOrgPage(): void {
  const path = window.location.pathname;
  if (!path.includes("/discover/organization.companies")) {
    throw new Error(
      `Open this tab to Discover Organizations first:\nhttps://www.crunchbase.com${DISCOVER_ORGS_PATH}`,
    );
  }
}

/** Hint in URL for debugging; Crunchbase may ignore. */
function applyDateHint(dateKey: string): void {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("cb_date_hint", dateKey);
    window.history.replaceState({}, "", u.toString());
  } catch {
    /* ignore */
  }
}

function isNextControlDisabled(el: HTMLElement): boolean {
  if (el instanceof HTMLButtonElement && el.disabled) return true;
  if (el instanceof HTMLAnchorElement) {
    if (el.hasAttribute("disabled")) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
  }
  if (el.getAttribute("aria-disabled") === "true") return true;
  if (el.classList.contains("mat-mdc-button-disabled")) return true;
  return false;
}

function findNextButton(): HTMLElement | null {
  for (const sel of SELECTORS.nextPage) {
    const el = document.querySelector(sel);
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

function findPrevButton(): HTMLElement | null {
  for (const sel of SELECTORS.prevPage) {
    const el = document.querySelector(sel);
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

/**
 * If the grid is paginated and the user left the tab on a later page, scrape would
 * only capture from that page forward. Rewind with Previous (same cadence as Next)
 * until the first page, then the main loop walks Next through all pages.
 */
async function rewindResultsToFirstPage(
  log: (t: string) => void | Promise<void>,
  signal: AbortSignal | undefined,
  maxSteps: number,
): Promise<void> {
  const prev = findPrevButton();
  const next = findNextButton();
  if (!prev && !next) {
    await log("No pagination controls — single page or custom UI.");
    return;
  }
  if (!prev) {
    await log("No Previous control found — starting from current page.");
    return;
  }
  if (isNextControlDisabled(prev)) {
    await log("Previous is disabled — already on first page.");
    return;
  }

  await log(
    "Pagination: Previous is active — clicking back to first page before scraping…",
  );

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }

    const p = findPrevButton();
    if (!p || isNextControlDisabled(p)) {
      await log("Reached first page (Previous disabled).");
      return;
    }

    await log(
      `Waiting ${DELAYS.beforeNextClickMs / 1000}s before clicking Previous…`,
    );
    await sleep(DELAYS.beforeNextClickMs);
    p.click();
    await log('Clicked "Previous"');
    await sleep(DELAYS.afterNextClickMs);
    await log("Waiting for previous page results…");
    await sleep(DELAYS.afterApplyFiltersWaitMs);
  }

  await log(
    `Stopped rewinding after ${maxSteps} Previous clicks — verify you are on page 1.`,
  );
}

type CustomAdvancedSearchResponse = {
  url: string;
  body: {
    count?: number;
    entities?: unknown[];
  } & Record<string, unknown>;
};

type PendingSearch = {
  resolve: (v: CustomAdvancedSearchResponse | null) => void;
  timer: number;
};
const SEARCH_RESULTS_PENDING = new Map<string, PendingSearch>();
let SEARCH_RESULTS_LISTENER_INSTALLED = false;

function ensureSearchResultsNetworkInterceptorInstalled(): void {
  injectPageHook();
}

function ensureSearchResultsListenerInstalled(): void {
  if (SEARCH_RESULTS_LISTENER_INSTALLED) return;
  SEARCH_RESULTS_LISTENER_INSTALLED = true;

  window.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as unknown;
    if (!d || typeof d !== "object") return;
    const msg = d as {
      source?: unknown;
      kind?: unknown;
      url?: unknown;
      body?: unknown;
    };
    if (msg.source !== PAGE_HOOK_SOURCE) return;
    if (msg.kind !== "searchResults") return;
    if (typeof msg.url !== "string") return;
    if (!msg.body || typeof msg.body !== "object") return;

    // We paginate sequentially; attribute the captured response to the single pending wait.
    if (SEARCH_RESULTS_PENDING.size !== 1) return;
    const key = Array.from(SEARCH_RESULTS_PENDING.keys())[0] ?? "";
    if (!key) return;
    const pending = SEARCH_RESULTS_PENDING.get(key);
    if (!pending) return;

    window.clearTimeout(pending.timer);
    SEARCH_RESULTS_PENDING.delete(key);
    pending.resolve({
      url: msg.url,
      body: msg.body as CustomAdvancedSearchResponse["body"],
    });
  });
}

async function waitForCustomAdvancedSearchResults(
  key: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CustomAdvancedSearchResponse | null> {
  ensureSearchResultsNetworkInterceptorInstalled();
  ensureSearchResultsListenerInstalled();

  if (signal?.aborted) {
    const err = new Error("Cancelled by user");
    err.name = "AbortError";
    throw err;
  }

  return await new Promise<CustomAdvancedSearchResponse | null>((resolve) => {
    const cleaned = (key ?? "").trim() || "default";
    const existing = SEARCH_RESULTS_PENDING.get(cleaned);
    if (existing) {
      window.clearTimeout(existing.timer);
      SEARCH_RESULTS_PENDING.delete(cleaned);
    }
    const t = window.setTimeout(() => {
      SEARCH_RESULTS_PENDING.delete(cleaned);
      resolve(null);
    }, timeoutMs);
    SEARCH_RESULTS_PENDING.set(cleaned, { resolve, timer: t });
  });
}

type DateRangeRun = {
  runKey: string;
  startDate: string;
  endDate: string;
};

function buildPerDateRuns(dateKeyOrKeys: string | string[]): DateRangeRun[] {
  const keys = Array.isArray(dateKeyOrKeys) ? dateKeyOrKeys : [dateKeyOrKeys];
  const cleaned = keys.map((s) => (s ?? "").trim()).filter((s) => s.length > 0);
  const uniq = Array.from(new Set(cleaned)).sort(); // ISO YYYY-MM-DD sorts lexicographically
  if (uniq.length === 0) throw new Error("No dates provided");
  return uniq.map((d) => ({ runKey: d, startDate: d, endDate: d }));
}

export async function runDiscoverScrape(
  dateKeyOrKeys: string | string[],
  emitChunk: (record: ChunkRecord) => Promise<void>,
  log: (t: string) => void | Promise<void>,
  signal?: AbortSignal,
  opts?: {
    onDateComplete?: (
      dateKey: string,
      totalRowsForDate: number,
    ) => void | Promise<void>;
  },
): Promise<number> {
  assertDiscoverOrgPage();
  const ranges = buildPerDateRuns(dateKeyOrKeys);

  // Install network capture for the main search endpoint early.
  ensureSearchResultsNetworkInterceptorInstalled();
  ensureSearchResultsListenerInstalled();

  // Configure table columns in the results view (optional but recommended).
  // NOTE: Put your desired column labels here (exact strings you would type into the "Find a filter..." box).
  // const TABLE_VIEW_COLUMNS: string[] = [
  //   "Headquarters Regions", // location_group_identifiers
  //   "Headquarters Location", // location_group_identifiers_text
  //   "Operating Status",
  //   "linkedin", // linkedin
  //   "semrush monthly visits Growth", // semrush_visits_mom_pct
  //   "semrush average visits (6 months)", // semrush_visits_latest_6_months_avg
  //   "number of investors", // num_investors
  //   "semrush visit duration", //semrush_visit_duration
  //   "last funding date", //last_funding_at
  //   "last equity funding amount", //last_equity_funding_total
  //   "semrush bounce rate", //semrush_bounce_rate
  //   "semrush bounce rate growth", //semrush_bounce_rate_mom_pct
  //   "company type", //company_type
  //   "semrush visit duration growth", //semrush_visit_duration_mom_pct
  //   "founded date", //founded_on
  //   "website", //website
  //   "total equity funding amount", //equity_funding_total
  //   "number of funding rounds", //num_funding_rounds
  //   "number of articles", //num_articles
  //   "contact email", //contact_email
  //   "funding status", //funding_stage
  //   "last funding amount", //last_funding_total
  //   "trend scord (7days)", //rank_delta_d7
  //   "trend scord (30days)", //rank_delta_d30
  //   "trend scord (90days)", //rank_delta_d90
  //   "full description", //description
  //   "description", //short_description
  //   "number of acquisitions", //num_acquisitions
  //   "operating status", //operating_status
  //   "number of lead investors", //num_lead_investors
  //   "number of employees", //num_employees_enum
  //   "total funding amount", //funding_total
  //   "last equity funding type", //last_equity_funding_type
  //   "acquisition status", //acquisition_status
  //   "ipo status", //ipo_status
  //   "semrush visit pageviews / visit", //semrush_visit_pageviews
  //   "semrush visit pageviews / visit Growth", //semrush_visit_pageview_mom_pct
  //   "rank_org_company", //cb rank (company)
  //   "rank_org", //cb rank (organization)
  //   "semrush global traffic rank", //semrush_global_rank
  //   "semrush monthly rank growth", //semrush_global_rank_mom_pct
  //   "semrush monthly rank change", //semrush_global_rank_mom
  // ];
  const TABLE_VIEW_COLUMNS_SEARCH_KEYWORDS: string[] = [
    "basic info",
    "headquaters",
    "status",
    "description",
    "company type",
    "number",
    "Date",
    "last",
    "investor details",
    "Team",
    "Funding",
    "investors",
    "acquisitions",
    "M & A",
    "IPO & Stock Price",
    "rank & scores",
    "insights",
    "contact",
    "Web Traffic by SEMrush",
    "Company Tech Stack by G2 Stack",
    "private data",
  ];
  let didConfigureView = false;
  let totalRows = 0;

  // IMPORTANT: configure table view first (per user request).
  // This relies on the results header being rendered.
  try {
    await configureResultsTableView(
      TABLE_VIEW_COLUMNS_SEARCH_KEYWORDS,
      log,
      signal,
    );
    didConfigureView = true;
  } catch (e) {
    await log(
      `Table view configuration failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  for (const r of ranges) {
    let totalRowsForDate = 0;
    if (signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }

    await log(`Applying date range ${r.startDate} → ${r.endDate}…`);
    applyDateHint(r.runKey);

    const clickedFinancials = clickFilterGroupButtonByLabel("Financials");
    if (clickedFinancials) {
      await log('Clicked "Financials" button');
      await sleep(DELAYS.afterFinancialsClickMs);
      await log("Selected filter group: Financials");
      try {
        await applyFinancialsValuationDateFilter(
          r.startDate,
          r.endDate,
          log,
          signal,
        );
      } catch (e) {
        await log(
          `Financials overlay automation failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      await log("Could not find Financials filter-group button (continuing).");
    }

    // Start waiting for the first page API response as early as possible, so we
    // don't miss the response that fires immediately after applying the date filter.
    const firstWait = waitForCustomAdvancedSearchResults(
      `${r.runKey}/page-1`,
      90_000,
      signal,
    );

    await log("Waiting 10s for results to reload after date change…");
    await sleep(DELAYS.afterDatesResultsLoadMs);

    if (!didConfigureView) {
      // If configuration earlier failed (or results weren't visible yet), retry once after filters.
      try {
        await configureResultsTableView(
          TABLE_VIEW_COLUMNS_SEARCH_KEYWORDS,
          log,
          signal,
        );
        didConfigureView = true;
      } catch (e) {
        await log(
          `Table view configuration failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    await log("Waiting for results table…");
    try {
      await waitForResultsRoot(20_000, signal);
      await log("Results visible. Starting scrape…");
    } catch {
      await log("Results table not detected yet (continuing).");
    }

    const maxPages = 500;
    await rewindResultsToFirstPage(log, signal, maxPages);

    // Scrape by capturing Crunchbase search API responses only.
    let nextPageWait: Promise<CustomAdvancedSearchResponse | null> | null = null;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      if (signal?.aborted) {
        const err = new Error("Cancelled by user");
        err.name = "AbortError";
        throw err;
      }

      const captured =
        pageIndex === 0
          ? await (async () => {
              await log("Waiting for search API response (page 1) …");
              return await firstWait;
            })()
          : await (nextPageWait ??
              waitForCustomAdvancedSearchResults(
                `${r.runKey}/page-${pageIndex + 1}`,
                90_000,
                signal,
              ));
      if (!captured) {
        await log(
          `No matching search API response captured for page ${pageIndex + 1} (source=custom_advanced_search). Stopping pagination.`,
        );
        break;
      }
      nextPageWait = null;

      const entitiesRaw = captured.body.entities;
      const entities: Record<string, unknown>[] = Array.isArray(entitiesRaw)
        ? (entitiesRaw.filter(
            (x): x is Record<string, unknown> =>
              !!x && typeof x === "object" && !Array.isArray(x),
          ) as Record<string, unknown>[])
        : [];
      const count =
        typeof captured.body.count === "number" && Number.isFinite(captured.body.count)
          ? captured.body.count
          : null;

      totalRows += entities.length;
      totalRowsForDate += entities.length;

      const chunkId = `page-${String(pageIndex + 1).padStart(3, "0")}`;
      const record: ChunkRecord = {
        dateKey: r.runKey,
        sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
        chunkId,
        pageIndex: pageIndex + 1,
        rowCount: entities.length,
        capturedAt: new Date().toISOString(),
        payload: {
          mode: "api-search",
          runKey: r.runKey,
          startDate: r.startDate,
          endDate: r.endDate,
          pageIndex: pageIndex + 1,
          capturedUrl: window.location.href,
          apiUrl: captured.url,
          apiCount: count,
          gridRows: entities,
        },
      };
      await emitChunk(record);
      await log(
        `Saved ${chunkId} (entities=${entities.length}${count != null ? `; count=${count}` : ""})`,
      );

      const next = findNextButton();
      if (!next) {
        await log("No Next control found — stopping pagination.");
        break;
      }
      if (isNextControlDisabled(next)) {
        await log("Next disabled — last page.");
        break;
      }

      // Trigger loading next page (Crunchbase will call the same API again).
      // Create the pending slot BEFORE clicking Next so we don't miss fast responses.
      nextPageWait = waitForCustomAdvancedSearchResults(
        `${r.runKey}/page-${pageIndex + 2}`,
        90_000,
        signal,
      );
      await log("Waiting 60s before clicking Next…");
      await sleep(DELAYS.beforeNextClickMs);
      next.click();
      await log('Clicked "Next"');
      await sleep(DELAYS.afterNextClickMs);
    }

    await opts?.onDateComplete?.(r.runKey, totalRowsForDate);
  }

  return totalRows;
}

export async function runDiscoverScrapeCurrentResults(
  runKey: string,
  emitChunk: (record: ChunkRecord) => Promise<void>,
  log: (t: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<{
  totalRows: number;
  columns: string[];
  rows: Record<string, unknown>[];
}> {
  assertDiscoverOrgPage();

  await log("Scrape mode: current search results (API capture only).");
  ensureSearchResultsNetworkInterceptorInstalled();
  ensureSearchResultsListenerInstalled();
  await log("Waiting for results table…");
  try {
    await waitForResultsRoot(12_000, signal);
    await log("Results visible. Starting scrape…");
  } catch {
    await log("Results table not detected yet (continuing).");
  }

  let totalRows = 0;
  const mergedRows: Record<string, unknown>[] = [];
  const maxPages = 500;

  await log("Waiting 10s for results to load…");
  await sleep(DELAYS.afterDatesResultsLoadMs);

  const firstWait = waitForCustomAdvancedSearchResults(
    `${runKey}/page-1`,
    90_000,
    signal,
  );
  await rewindResultsToFirstPage(log, signal, maxPages);

  let nextPageWait: Promise<CustomAdvancedSearchResponse | null> | null = null;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    if (signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }

    const captured =
      pageIndex === 0
        ? await firstWait
        : await (nextPageWait ??
            waitForCustomAdvancedSearchResults(
              `${runKey}/page-${pageIndex + 1}`,
              90_000,
              signal,
            ));
    if (!captured) {
      await log(
        `No matching search API response captured for page ${pageIndex + 1} (source=custom_advanced_search). Stopping pagination.`,
      );
      break;
    }
    nextPageWait = null;

    const entitiesRaw = captured.body.entities;
    const entities: Record<string, unknown>[] = Array.isArray(entitiesRaw)
      ? (entitiesRaw.filter(
          (x): x is Record<string, unknown> =>
            !!x && typeof x === "object" && !Array.isArray(x),
        ) as Record<string, unknown>[])
      : [];

    mergedRows.push(...entities);
    totalRows = mergedRows.length;
    await log(
      `Page ${pageIndex + 1}: captured ${entities.length} entit${entities.length === 1 ? "y" : "ies"} from API (total=${totalRows}).`,
    );

    const chunkId = `page-${String(pageIndex + 1).padStart(3, "0")}`;
    const record: ChunkRecord = {
      dateKey: runKey,
      sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
      chunkId,
      pageIndex: pageIndex + 1,
      rowCount: entities.length,
      capturedAt: new Date().toISOString(),
      payload: {
        mode: "api-search",
        runKey,
        pageIndex: pageIndex + 1,
        capturedUrl: window.location.href,
        apiUrl: captured.url,
        apiCount:
          typeof captured.body.count === "number" &&
          Number.isFinite(captured.body.count)
            ? captured.body.count
            : null,
        gridRows: entities,
      },
    };
    await emitChunk(record);
    await log(`Saved ${chunkId} (entities=${entities.length})`);

    const next = findNextButton();
    if (!next) {
      await log("No Next control found — stopping pagination.");
      break;
    }
    if (isNextControlDisabled(next)) {
      await log("Next disabled — last page.");
      break;
    }

    nextPageWait = waitForCustomAdvancedSearchResults(
      `${runKey}/page-${pageIndex + 2}`,
      90_000,
      signal,
    );
    await log("Waiting 60s before clicking Next…");
    await sleep(DELAYS.beforeNextClickMs);
    next.click();
    await log('Clicked "Next"');
    await sleep(DELAYS.afterNextClickMs);
  }

  return {
    totalRows: mergedRows.length > 0 ? mergedRows.length : totalRows,
    columns: [],
    rows: mergedRows,
  };
}
