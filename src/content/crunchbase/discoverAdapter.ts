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
import {
  extractAnyImageIdFromElement,
  extractCellPlainText,
  extractCrunchbaseImageId,
  normalizeRangeValue,
  normalizeRevenueRangeEnum,
  parseCrunchbaseOrgPermalinkFromHref,
  parseEntityIdentifiersFromCell,
  parseMoneyValue,
  type MoneyValue,
} from "./discoverParsers";

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
  afterApplyFiltersWaitMs: 20_000,
  initialResultsSettleMs: 2200,
  betweenPagesSettleMs: 2200,
  beforeNextClickMs: 60_000, // IMPORTANT: wait 1 min before clicking Next
  afterNextClickMs: 1600,
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
  noResults: [".no-results-content", "no-content .no-results-content"],

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

function hasNoResults(): boolean {
  for (const sel of SELECTORS.noResults) {
    const el = document.querySelector(sel);
    if (el && (el.textContent ?? "").toLowerCase().includes("no results"))
      return true;
  }
  return false;
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

function findResultsGridRoot(): Element | null {
  return (
    document.querySelector(".results-grid") ??
    document.querySelector("sheet-grid .results-grid") ??
    document.querySelector("sheet-grid")
  );
}

function scrapeResultsGridHeaderColumnIds(root: ParentNode): string[] {
  const headerRow = root.querySelector("grid-header-row");
  if (!headerRow) return [];
  const ids: string[] = [];
  for (const cell of headerRow.querySelectorAll("grid-cell[data-columnid]")) {
    const id = cell.getAttribute("data-columnid");
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

type DiscoverIdentifier = {
  permalink: string;
  image_id: string;
  value?: string;
};
type DiscoverRow = Record<string, unknown> & {
  identifier?: DiscoverIdentifier;
};

type OrgPreviewResponse = Record<string, unknown>;

const ORG_PREVIEW_BY_PERMALINK = new Map<string, OrgPreviewResponse>();

type PendingPreview = {
  resolve: (v: OrgPreviewResponse | null) => void;
  timer: number;
};
const ORG_PREVIEW_PENDING = new Map<string, PendingPreview>();
let ORG_PREVIEW_LISTENER_INSTALLED = false;

function ensureOrgPreviewNetworkInterceptorInstalled(): void {
  injectPageHook();
}

function ensureOrgPreviewListenerInstalled(): void {
  if (ORG_PREVIEW_LISTENER_INSTALLED) return;
  ORG_PREVIEW_LISTENER_INSTALLED = true;

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
    if (msg.kind !== "orgPreview") return;
    const json = msg.body;
    if (!json || typeof json !== "object") return;

    // Since we hover sequentially, attribute any orgPreview response to the single pending hover.
    if (ORG_PREVIEW_PENDING.size !== 1) return;
    const key = Array.from(ORG_PREVIEW_PENDING.keys())[0] ?? "";
    if (!key) return;

    ORG_PREVIEW_BY_PERMALINK.set(key, json as OrgPreviewResponse);
    const pending = ORG_PREVIEW_PENDING.get(key);
    if (pending) {
      window.clearTimeout(pending.timer);
      ORG_PREVIEW_PENDING.delete(key);
      pending.resolve(json as OrgPreviewResponse);
    }
  });
}

async function hoverAndCaptureOrgPreview(
  permalinkKey: string,
  anchor: HTMLAnchorElement,
  signal?: AbortSignal,
): Promise<OrgPreviewResponse | null> {
  const key = (permalinkKey ?? "").trim();
  if (!key) return null;
  const cached = ORG_PREVIEW_BY_PERMALINK.get(key);
  if (cached) return cached;

  ensureOrgPreviewNetworkInterceptorInstalled();
  ensureOrgPreviewListenerInstalled();

  if (signal?.aborted) {
    const err = new Error("Cancelled by user");
    err.name = "AbortError";
    throw err;
  }

  // Create the wait "slot" before triggering hover, so we don't miss very fast responses.
  const wait = new Promise<OrgPreviewResponse | null>((resolve) => {
    const existing = ORG_PREVIEW_PENDING.get(key);
    if (existing) {
      window.clearTimeout(existing.timer);
      ORG_PREVIEW_PENDING.delete(key);
    }
    const t = window.setTimeout(() => {
      ORG_PREVIEW_PENDING.delete(key);
      resolve(null);
    }, 10_000);
    ORG_PREVIEW_PENDING.set(key, { resolve, timer: t });
  });

  window.postMessage({ type: "cb-hover/setCurrent", key }, "*");
  // Give Crunchbase UI time to trigger the preview request.
  await sleep(120);
  if (signal?.aborted) {
    const err = new Error("Cancelled by user");
    err.name = "AbortError";
    throw err;
  }

  // Trigger hover.
  try {
    anchor.dispatchEvent(
      new MouseEvent("mouseenter", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
    anchor.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  } catch {
    // ignore
  }

  // Give the UI/network a moment to fire the request before we start waiting.
  await sleep(900);
  if (signal?.aborted) {
    const err = new Error("Cancelled by user");
    err.name = "AbortError";
    throw err;
  }

  return await wait;
}

async function enrichOrganizationPreviewsInRows(
  rowsWithAnchors: {
    row: DiscoverRow;
    anchor: HTMLAnchorElement;
    key: string;
  }[],
  log: (t: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!Array.isArray(rowsWithAnchors) || rowsWithAnchors.length === 0) return;

  let fetched = 0;
  for (const it of rowsWithAnchors) {
    if (signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }
    const preview: any = await hoverAndCaptureOrgPreview(
      it.key,
      it.anchor,
      signal,
    );
    if (preview) {
      const location_identifiers =
        preview.cards.overview_image_description.location_identifiers;
      const identifier = preview.cards.overview_image_description.identifier;
      (it.row as Record<string, unknown>).location_identifiers =
        location_identifiers;
      if (identifier !== undefined && identifier !== null) {
        // Replace if present; add if missing.
        (it.row as Record<string, unknown>).identifier = identifier;
      }
      (it.row as Record<string, unknown>).org_details = preview;
      fetched += 1;
    }
    // Small spacing so hover-triggered requests don't overlap.
    await sleep(250);
  }

  if (fetched > 0)
    await log(
      `Enriched ${fetched}/${rowsWithAnchors.length} row${rowsWithAnchors.length === 1 ? "" : "s"} with organization preview data.`,
    );
  else
    await log(
      `Hovered ${rowsWithAnchors.length} org row${rowsWithAnchors.length === 1 ? "" : "s"} but captured 0 org details responses (endpoint may differ or requests may be blocked).`,
    );
}

type FxRates = {
  base: "USD";
  rates: Record<string, number>;
  fetchedAt: string;
};

let FX_RATES_PROMISE: Promise<FxRates | null> | null = null;

async function getUsdFxRates(
  log: (t: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<FxRates | null> {
  if (FX_RATES_PROMISE) return FX_RATES_PROMISE;
  FX_RATES_PROMISE = (async () => {
    try {
      const url = "https://open.er-api.com/v6/latest/USD";
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`FX fetch failed: ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!body || typeof body !== "object")
        throw new Error("FX response invalid");
      const o = body as Record<string, unknown>;
      const rates = o.rates as Record<string, unknown> | undefined;
      if (!rates || typeof rates !== "object")
        throw new Error("FX rates missing");

      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(rates)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
      }
      // Ensure USD is present.
      out.USD = 1;
      return { base: "USD", rates: out, fetchedAt: new Date().toISOString() };
    } catch (e) {
      await log(
        `FX rates unavailable; leaving value_usd null for non-USD currencies: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  })();
  return FX_RATES_PROMISE;
}

async function enrichUsdValuesInRows(
  rows: DiscoverRow[],
  log: (t: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let needsFx = false;
  for (const r of rows) {
    for (const v of Object.values(r)) {
      if (
        v &&
        typeof v === "object" &&
        "currency" in (v as object) &&
        "value" in (v as object) &&
        "value_usd" in (v as object)
      ) {
        const mv = v as MoneyValue;
        if (mv.currency && mv.currency !== "USD" && mv.value_usd == null) {
          needsFx = true;
          break;
        }
      }
    }
    if (needsFx) break;
  }
  if (!needsFx) return;

  const fx = await getUsdFxRates(log, signal);
  if (!fx) return;

  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (
        v &&
        typeof v === "object" &&
        "currency" in (v as object) &&
        "value" in (v as object) &&
        "value_usd" in (v as object)
      ) {
        const mv = v as MoneyValue;
        if (mv.currency === "USD") continue;
        if (mv.value_usd != null) continue;
        const rate = fx.rates[mv.currency];
        if (!rate || !Number.isFinite(rate) || rate <= 0) continue;

        // fx.rates is "1 USD = rate <currency>"
        const usd = Math.round(mv.value / rate);
        r[k] = { ...mv, value_usd: Number.isFinite(usd) ? usd : null };
      }
    }
  }
}

function scrapeResultsGridRowsFromDom(root: ParentNode): {
  rows: DiscoverRow[];
  orgAnchors: { row: DiscoverRow; anchor: HTMLAnchorElement; key: string }[];
} {
  const out: DiscoverRow[] = [];
  const orgAnchors: {
    row: DiscoverRow;
    anchor: HTMLAnchorElement;
    key: string;
  }[] = [];
  const candidates = root.querySelectorAll("grid-row");
  for (const row of candidates) {
    if (!(row instanceof Element)) continue;
    if (!row.querySelector('grid-cell[data-columnid="identifier"]')) continue;
    const cells = row.querySelectorAll("grid-cell[data-columnid]");
    if (cells.length === 0) continue;
    const rec: DiscoverRow = {};
    for (const cell of cells) {
      const id = cell.getAttribute("data-columnid");
      if (!id) continue;

      if (id === "location_identifiers") continue;

      if (id === "identifier") {
        const a = cell.querySelector("a[href]") as HTMLAnchorElement | null;
        const img = cell.querySelector("img[src]") as HTMLImageElement | null;
        const permalink =
          (a?.href ? parseCrunchbaseOrgPermalinkFromHref(a.href) : null) || "";
        const imageId =
          extractCrunchbaseImageId(img?.src ?? "") ||
          extractAnyImageIdFromElement(cell);
        const value = (a?.getAttribute("title") ?? a?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();

        if (a && permalink)
          orgAnchors.push({ row: rec, anchor: a, key: permalink });

        if (imageId) {
          rec.identifier = { permalink, image_id: imageId, value };
        } else {
          const t = extractCellPlainText(cell);
          if (t && t !== "—") rec.identifier_label = t;
        }
        continue;
      }

      if (id === "location_group_identifiers") {
        const anchors = Array.from(cell.querySelectorAll("a[href]")).filter(
          (a): a is HTMLAnchorElement => a instanceof HTMLAnchorElement,
        );
        const parsed: { permalink: string; value: string }[] = [];
        for (const a of anchors) {
          const href = a.getAttribute("href") ?? "";
          const txt = (a.getAttribute("title") ?? a.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (!href || !txt) continue;

          // Examples:
          // /search/organizations/field/organization.companies/location_identifiers/tokyo-tokyo
          // /search/organizations/field/organization.companies/location_group_identifiers/asia-pacific
          const m = href
            .replace(/\/+$/, "")
            .match(
              /\/(location_identifiers|location_group_identifiers)\/([^/]+)$/i,
            );
          if (!m?.[2]) continue;
          const permalink = decodeURIComponent(m[2]);
          parsed.push({ permalink, value: txt });
        }
        if (parsed.length > 0) {
          rec[id] = parsed;
          continue;
        }
        // Fall back to plain text if Crunchbase renders this cell without links.
      }

      if (id === "linkedin") {
        const a = cell.querySelector(
          'a[href*="linkedin.com"]',
        ) as HTMLAnchorElement | null;
        const href = a?.href?.trim() ?? "";
        if (href) {
          rec[id] = { value: href };
          continue;
        }
      }

      if (id === "twitter") {
        const a = cell.querySelector(
          'a[href*="twitter.com"], a[href*="x.com"]',
        ) as HTMLAnchorElement | null;
        const href = a?.href?.trim() ?? "";
        if (href) {
          rec[id] = { value: href };
          continue;
        }
      }

      if (id === "facebook") {
        const a = cell.querySelector(
          'a[href*="facebook.com"]',
        ) as HTMLAnchorElement | null;
        const href = a?.href?.trim() ?? "";
        if (href) {
          rec[id] = { value: href };
          continue;
        }
      }

      if (id === "investor_identifiers" || id === "founder_identifier") {
        const ids = parseEntityIdentifiersFromCell(cell);
        if (ids.length > 0) {
          rec[id] =
            id === "investor_identifiers"
              ? ids.map(({ permalink, entity_def_id, value }) => ({
                  permalink,
                  entity_def_id,
                  value,
                }))
              : ids;
          continue;
        }
      }

      const t = extractCellPlainText(cell);
      // If any value is "—", omit the field for that company.
      if (!t || t === "—") continue;

      const pct = t.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
      if (pct?.[1]) {
        rec[id] = pct[1];
        continue;
      }

      if (id === "revenue_range") {
        const norm = normalizeRevenueRangeEnum(t);
        if (norm) {
          rec[id] = norm;
          continue;
        }
      }

      const rangeNorm = normalizeRangeValue(t);
      if (rangeNorm) {
        rec[id] = rangeNorm;
        continue;
      }

      const money = parseMoneyValue(t);
      if (money) {
        rec[id] = money;
        continue;
      }

      rec[id] = t;
    }
    if (Object.keys(rec).length > 0) out.push(rec);
  }
  return { rows: out, orgAnchors };
}

function mergeColumnOrder(headerIds: string[], rows: DiscoverRow[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of headerIds) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        ordered.push(k);
      }
    }
  }
  return ordered;
}

function discoverRowDedupeKey(row: DiscoverRow): string {
  const permalink = row.identifier?.permalink?.trim() ?? "";
  if (permalink.length > 0) return permalink;
  return JSON.stringify(row);
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

    await log("Waiting 10s for results to reload after date change…");
    await sleep(DELAYS.afterDatesResultsLoadMs);

    if (!didConfigureView) {
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

    // Scrape from DOM (no network JSON capture).
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      if (signal?.aborted) {
        const err = new Error("Cancelled by user");
        err.name = "AbortError";
        throw err;
      }

      await sleep(
        pageIndex === 0
          ? DELAYS.initialResultsSettleMs
          : DELAYS.betweenPagesSettleMs,
      );

      if (hasNoResults()) {
        await log("No results found for current filters.");
        const chunkId = `page-${String(pageIndex + 1).padStart(3, "0")}`;
        const record: ChunkRecord = {
          dateKey: r.runKey,
          sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
          chunkId,
          pageIndex: pageIndex + 1,
          rowCount: 0,
          capturedAt: new Date().toISOString(),
          payload: {
            mode: "dom-grid",
            runKey: r.runKey,
            startDate: r.startDate,
            endDate: r.endDate,
            pageIndex: pageIndex + 1,
            capturedUrl: window.location.href,
            columns: [],
            gridRows: [],
            note: "no_results_found",
          },
        };
        await emitChunk(record);
        break;
      }

      const gridRoot = findResultsGridRoot();
      const headerIds = gridRoot
        ? scrapeResultsGridHeaderColumnIds(gridRoot)
        : [];
      const scraped = gridRoot
        ? scrapeResultsGridRowsFromDom(gridRoot)
        : { rows: [], orgAnchors: [] };
      const pageRows = scraped.rows;
      await enrichUsdValuesInRows(pageRows, log, signal);
      await enrichOrganizationPreviewsInRows(scraped.orgAnchors, log, signal);

      totalRows += pageRows.length;
      totalRowsForDate += pageRows.length;

      const chunkId = `page-${String(pageIndex + 1).padStart(3, "0")}`;
      const record: ChunkRecord = {
        dateKey: r.runKey,
        sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
        chunkId,
        pageIndex: pageIndex + 1,
        rowCount: pageRows.length,
        capturedAt: new Date().toISOString(),
        payload: {
          mode: "dom-grid",
          runKey: r.runKey,
          startDate: r.startDate,
          endDate: r.endDate,
          pageIndex: pageIndex + 1,
          capturedUrl: window.location.href,
          columns: headerIds,
          gridRows: pageRows,
        },
      };
      await emitChunk(record);
      await log(`Saved ${chunkId} (rows=${pageRows.length})`);

      const next = findNextButton();
      if (!next) {
        await log("No Next control found — stopping pagination.");
        break;
      }
      if (isNextControlDisabled(next)) {
        await log("Next disabled — last page.");
        break;
      }

      await log("Waiting 60s before clicking Next…");
      await sleep(DELAYS.beforeNextClickMs);
      next.click();
      await log('Clicked "Next"');
      await sleep(DELAYS.afterNextClickMs);
      await log("Waiting 20s for next page results…");
      await sleep(DELAYS.afterApplyFiltersWaitMs);
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
  rows: DiscoverRow[];
}> {
  assertDiscoverOrgPage();

  await log("Scrape mode: current search results (no filter automation).");
  await log("Waiting for results table…");
  try {
    await waitForResultsRoot(12_000, signal);
    await log("Results visible. Starting scrape…");
  } catch {
    await log("Results table not detected yet (continuing).");
  }

  let totalRows = 0;
  const mergedRows: DiscoverRow[] = [];
  const seenRowKeys = new Set<string>();
  let columnOrder: string[] = [];
  const maxPages = 500;

  await log("Waiting 10s for results to load…");
  await sleep(DELAYS.afterDatesResultsLoadMs);

  await rewindResultsToFirstPage(log, signal, maxPages);

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    if (signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }

    await sleep(
      pageIndex === 0
        ? DELAYS.initialResultsSettleMs
        : DELAYS.betweenPagesSettleMs,
    );

    const gridRoot = findResultsGridRoot();
    const scraped = gridRoot
      ? scrapeResultsGridRowsFromDom(gridRoot)
      : { rows: [], orgAnchors: [] };
    const pageRows = scraped.rows;
    await enrichUsdValuesInRows(pageRows, log, signal);
    await enrichOrganizationPreviewsInRows(scraped.orgAnchors, log, signal);
    if (gridRoot) {
      const headerIds = scrapeResultsGridHeaderColumnIds(gridRoot);
      if (headerIds.length > 0)
        columnOrder = mergeColumnOrder(headerIds, mergedRows);
    }

    if (pageRows.length === 0 && hasNoResults()) {
      await log("No results found for current filters.");
      break;
    }

    let added = 0;
    for (const r of pageRows) {
      const key = discoverRowDedupeKey(r);
      if (seenRowKeys.has(key)) continue;
      seenRowKeys.add(key);
      mergedRows.push(r);
      added += 1;
    }
    columnOrder = mergeColumnOrder(columnOrder, mergedRows);
    totalRows = mergedRows.length;

    if (pageRows.length > 0) {
      await log(
        `Page ${pageIndex + 1}: scraped ${pageRows.length} row${pageRows.length === 1 ? "" : "s"} from the table (${added} new after de-dupe).`,
      );
    } else {
      await log(
        "Could not read results table rows yet — results may still be loading.",
      );
    }

    const chunkId = `page-${String(pageIndex + 1).padStart(3, "0")}`;
    const record: ChunkRecord = {
      dateKey: runKey,
      sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
      chunkId,
      pageIndex: pageIndex + 1,
      rowCount: pageRows.length,
      capturedAt: new Date().toISOString(),
      payload: {
        mode: "dom-grid",
        runKey,
        pageIndex: pageIndex + 1,
        capturedUrl: window.location.href,
        columns: columnOrder,
        gridRows: pageRows,
      },
    };
    await emitChunk(record);
    await log(`Saved ${chunkId} (rows=${pageRows.length})`);

    const next = findNextButton();
    if (!next) {
      await log("No Next control found — stopping pagination.");
      break;
    }
    if (isNextControlDisabled(next)) {
      await log("Next disabled — last page.");
      break;
    }

    await log("Waiting 60s before clicking Next…");
    await sleep(DELAYS.beforeNextClickMs);
    next.click();
    await log('Clicked "Next"');
    await sleep(DELAYS.afterNextClickMs);
    await log("Waiting 20s for next page results…");
    await sleep(DELAYS.afterApplyFiltersWaitMs);
  }

  const columns = mergeColumnOrder(columnOrder, mergedRows);
  return {
    totalRows: mergedRows.length > 0 ? mergedRows.length : totalRows,
    columns,
    rows: mergedRows,
  };
}
