import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from "@shared/constants";
import type { ExtensionMessage } from "@shared/messages";
import type { ScrapeQueueState } from "@shared/models";
import {
  ensurePersistedDelaySettingsInitialized,
  loadPersistedDelaySettings,
} from "@shared/delaySettings";
import * as storage from "../../storage";

const STORAGE_KEY = "scrapeQueueV1";
const DISCOVER_COMPANIES_PATH_PREFIX = "/discover/organization.companies";
const DISCOVER_COMPANIES_RUN_URL =
  "https://www.crunchbase.com/discover/organization.companies/469b67bc5a0e3e95f6107877ef3245f3";

let mem: ScrapeQueueState = {
  pending: [],
  activeDateKey: null,
  stagedAfterAbort: null,
  batchOrder: null,
  multiDateExportSession: false,
  sessionGroupId: null,
};
let loaded = false;

// Internal runtime-only state; not persisted.
let activeRunTabId: number | null = null;

function emitUiLog(dateKey: string, text: string): void {
  chrome.runtime
    .sendMessage({
      type: "scrape/log",
      dateKey,
      level: "info",
      text,
      at: new Date().toISOString(),
    } satisfies ExtensionMessage)
    .catch(() => {});
}

function formatMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}

async function load(): Promise<void> {
  if (loaded) return;
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw = data[STORAGE_KEY] as ScrapeQueueState | undefined;
  if (raw && typeof raw === "object") {
    mem = {
      pending: Array.isArray(raw.pending) ? [...raw.pending] : [],
      activeDateKey: raw.activeDateKey ?? null,
      stagedAfterAbort: raw.stagedAfterAbort ? [...raw.stagedAfterAbort] : null,
      batchOrder: raw.batchOrder ? [...raw.batchOrder] : null,
      multiDateExportSession: raw.multiDateExportSession === true,
      sessionGroupId:
        typeof raw.sessionGroupId === "string" && raw.sessionGroupId.length > 0
          ? raw.sessionGroupId
          : null,
    };
  }
  loaded = true;
}

async function save(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: mem });
  chrome.runtime
    .sendMessage({ type: "scrape/queueChanged" } satisfies ExtensionMessage)
    .catch(() => {});
}

export async function getQueueState(): Promise<ScrapeQueueState> {
  await load();
  return {
    pending: [...mem.pending],
    activeDateKey: mem.activeDateKey,
    stagedAfterAbort: mem.stagedAfterAbort ? [...mem.stagedAfterAbort] : null,
    batchOrder: mem.batchOrder ? [...mem.batchOrder] : null,
    multiDateExportSession: mem.multiDateExportSession,
    sessionGroupId: mem.sessionGroupId,
  };
}

/** Replace queue with CSV import; if a job is running, stage replacement and abort current. */
export async function enqueueFromImport(
  dates: string[],
  sessionGroupId?: string,
): Promise<void> {
  await load();
  const cleaned = dates
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);
  const next = [...new Set(cleaned)];
  const multi = next.length > 1;
  mem.sessionGroupId =
    typeof sessionGroupId === "string" && sessionGroupId.length > 0
      ? sessionGroupId
      : null;
  if (mem.activeDateKey !== null) {
    mem.stagedAfterAbort = next;
    mem.batchOrder = [...next];
    mem.multiDateExportSession = multi;
    await save();
    await requestAbortActiveTab();
    return;
  }
  mem.pending = next;
  mem.batchOrder = [...next];
  mem.stagedAfterAbort = null;
  mem.multiDateExportSession = multi;
  await save();
}

/** User retry or manual scrape: prefer this date next (after current job if any). */
export async function enqueueRetry(dateKey: string): Promise<void> {
  await load();
  // Single-date flow: do not keep a multi-date batchOrder from a prior CSV / multi-select run.
  mem.batchOrder = null;
  mem.multiDateExportSession = false;
  mem.sessionGroupId = null;
  const i = mem.pending.indexOf(dateKey);
  if (i >= 0) mem.pending.splice(i, 1);
  mem.pending.unshift(dateKey);
  await save();
  await tryStartNext();
}

/** Clears batch tracking after a multi-date zip download (or empty batch). */
export async function clearBatchOrder(): Promise<void> {
  await load();
  const hadBatch = mem.batchOrder !== null;
  const hadMulti = mem.multiDateExportSession;
  if (hadBatch) mem.batchOrder = null;
  if (hadMulti) mem.multiDateExportSession = false;
  if (hadBatch || hadMulti) mem.sessionGroupId = null;
  if (hadBatch || hadMulti) await save();
}

export async function clearPendingQueue(): Promise<void> {
  await load();
  mem.pending = [];
  mem.stagedAfterAbort = null;
  mem.batchOrder = null;
  mem.multiDateExportSession = false;
  mem.sessionGroupId = null;
  await save();
  if (mem.activeDateKey !== null) {
    await requestAbortActiveTab();
  }
}

export async function requestStopCurrent(): Promise<void> {
  await load();
  const tabId = activeRunTabId;
  const dateKey = mem.activeDateKey;

  // Clear "running" state immediately so the panel doesn't re-show as active
  // after it reloads queue state from storage.
  if (mem.activeDateKey !== null) {
    mem.activeDateKey = null;
    // Runtime-only.
    activeRunTabId = null;
    await save();
  }

  // Best-effort: abort the currently running tab (if any).
  if (tabId == null) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "scrape/abort",
    } satisfies ExtensionMessage);
    return;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (dateKey)
      emitUiLog(dateKey, `Abort message failed; closing tab: ${msg}`);
  }

  // Hard stop fallback: close the tab.
  await chrome.tabs.remove(tabId).catch(() => {});

  // If we had to hard-close, also mark the run as cancelled (best effort).
  if (dateKey) {
    const meta = await storage.ensureRun(
      dateKey,
      SOURCE_CRUNCHBASE_DISCOVER_ORGS,
    );
    await storage.upsertRun({
      ...meta,
      status: "cancelled",
      errorMessage: "Cancelled by user",
      updatedAt: new Date().toISOString(),
    });
    chrome.runtime
      .sendMessage({
        type: "scrape/error",
        dateKey,
        message: "Cancelled by user",
        partial: true,
      } satisfies ExtensionMessage)
      .catch(() => {});
  }
}

async function requestAbortActiveTab(): Promise<void> {
  if (activeRunTabId == null) return;
  await load();
  const tabId = activeRunTabId;
  const dateKey = mem.activeDateKey;

  // Best effort: ask the content script to abort.
  // If messaging fails (no receiver / navigation), fall back to closing the tab
  // and marking the run cancelled so UI unblocks immediately.
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "scrape/abort",
    } satisfies ExtensionMessage);
    return;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (dateKey)
      emitUiLog(dateKey, `Abort message failed; closing tab: ${msg}`);
  }

  // Hard stop: close the tab to stop scraping immediately.
  await chrome.tabs.remove(tabId).catch(() => {});

  if (dateKey) {
    const meta = await storage.ensureRun(
      dateKey,
      SOURCE_CRUNCHBASE_DISCOVER_ORGS,
    );
    await storage.upsertRun({
      ...meta,
      status: "cancelled",
      errorMessage: "Cancelled by user",
      updatedAt: new Date().toISOString(),
    });
    chrome.runtime
      .sendMessage({
        type: "scrape/error",
        dateKey,
        message: "Cancelled by user",
        partial: true,
      } satisfies ExtensionMessage)
      .catch(() => {});

    // Advance queue.
    await onScrapeFinished(dateKey);
  }
}

async function waitForTabLoaded(
  tabId: number,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      globalThis.clearInterval(timer);
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId !== tabId) return;
      cleanup();
      reject(new Error(`Tab ${tabId} was closed before load finished`));
    };

    const onUpdated = (
      updatedTabId: number,
      info: chrome.tabs.TabChangeInfo,
    ) => {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        cleanup();
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    const timer = globalThis.setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        cleanup();
        reject(new Error(`Timed out waiting for tab ${tabId} to load`));
      }
    }, 250);

    // If the tab already finished loading before listeners were attached.
    void chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t?.status === "complete") {
          cleanup();
          resolve();
        }
      })
      .catch(() => {});
  });
}

async function waitForTabUrlPrefix(
  tabId: number,
  urlPrefix: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    const url = (t?.url ?? "").trim();
    if (url && url.startsWith(urlPrefix)) return;
    await new Promise((r) => globalThis.setTimeout(r, 250));
  }
  throw new Error(
    `Timed out waiting for tab ${tabId} URL to start with ${urlPrefix}`,
  );
}

async function injectCrunchbaseContentScript(
  tabId: number,
  dateKeyForLog: string,
): Promise<void> {
  emitUiLog(dateKeyForLog, "Injecting Crunchbase content script…");
  await chrome.scripting.executeScript({
    target: { tabId },
    // Bootstrap is a classic script (no top-level imports) that dynamic-imports
    // the real bundled module `content/crunchbase.js`.
    files: ["content/crunchbaseBootstrap.js"],
  });
  emitUiLog(dateKeyForLog, "Content script injected.");
}

function isNoReceiverError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return (
    msg.includes("Could not establish connection") ||
    msg.includes("Receiving end does not exist") ||
    msg.includes("No receiver") ||
    msg.includes("No matching receiver")
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((r) => globalThis.setTimeout(r, ms));
}

function buildDiscoverRunUrl(dateKeyForLog: string): string {
  const u = new URL(DISCOVER_COMPANIES_RUN_URL);
  // The content script auto-starts only when this flag is present.
  // Without these params we would successfully inject but do nothing.
  u.searchParams.set("cb_autostart", "1");
  // Used by content script to decide which date to run/log.
  u.searchParams.set("cb_date_hint", dateKeyForLog);
  // Back-compat: older code paths may read cb_run_key.
  u.searchParams.set("cb_run_key", dateKeyForLog);
  return u.toString();
}

async function openNewDiscoverCompaniesTab(
  dateKeyForLog: string,
): Promise<number> {
  const targetUrl = buildDiscoverRunUrl(dateKeyForLog);

  emitUiLog(dateKeyForLog, `Opening new Discover tab: ${targetUrl}`);
  const tab = await chrome.tabs.create({
    url: targetUrl,
    active: true,
  });
  const tabId = tab.id;
  if (typeof tabId !== "number") throw new Error("Failed to open new tab");
  try {
    await ensurePersistedDelaySettingsInitialized();
    const delays = await loadPersistedDelaySettings();
    const tabLoadTimeoutMs =
      typeof delays.tabLoadTimeoutMs === "number" ? delays.tabLoadTimeoutMs : 60_000;
    const tabUrlWaitTimeoutMs =
      typeof delays.tabUrlWaitTimeoutMs === "number" ? delays.tabUrlWaitTimeoutMs : 60_000;

    // Wait until the tab is fully loaded *and* has reached the expected URL
    // (Crunchbase can redirect through intermediate URLs).
    await waitForTabLoaded(tabId, tabLoadTimeoutMs);
    await waitForTabUrlPrefix(
      tabId,
      "https://www.crunchbase.com/discover/organization.companies",
      tabUrlWaitTimeoutMs,
    );

    // MV3-safe approach: inject content script explicitly after load.
    // This avoids races where the content script isn't ready immediately.
    await injectCrunchbaseContentScript(tabId, dateKeyForLog);
  } catch (e) {
    emitUiLog(
      dateKeyForLog,
      `Tab load wait failed (continuing with retries): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Basic safety check (non-fatal; retries + content script assert will still catch it).
  const u = (tab.url ?? "").trim();
  if (u) {
    try {
      const parsed = new URL(u);
      if (
        parsed.hostname !== "www.crunchbase.com" &&
        parsed.hostname !== "crunchbase.com"
      ) {
        emitUiLog(
          dateKeyForLog,
          `Warning: opened non-Crunchbase host: ${parsed.hostname}`,
        );
      } else if (!parsed.pathname.startsWith(DISCOVER_COMPANIES_PATH_PREFIX)) {
        emitUiLog(
          dateKeyForLog,
          `Warning: opened unexpected path: ${parsed.pathname}`,
        );
      }
    } catch {
      emitUiLog(dateKeyForLog, `Warning: opened invalid URL: ${u}`);
    }
  }
  return tabId;
}

async function reuseDiscoverCompaniesTab(
  tabId: number,
  dateKeyForLog: string,
): Promise<number> {
  const targetUrl = buildDiscoverRunUrl(dateKeyForLog);
  emitUiLog(dateKeyForLog, `Reusing Discover tab ${tabId}: ${targetUrl}`);

  const updated = await chrome.tabs
    .update(tabId, { url: targetUrl, active: true })
    .catch(() => null);
  const nextTabId = updated?.id;
  if (typeof nextTabId !== "number") {
    // Tab was likely closed; fall back to opening a new one.
    return await openNewDiscoverCompaniesTab(dateKeyForLog);
  }

  try {
    await ensurePersistedDelaySettingsInitialized();
    const delays = await loadPersistedDelaySettings();
    const tabLoadTimeoutMs =
      typeof delays.tabLoadTimeoutMs === "number" ? delays.tabLoadTimeoutMs : 60_000;
    const tabUrlWaitTimeoutMs =
      typeof delays.tabUrlWaitTimeoutMs === "number" ? delays.tabUrlWaitTimeoutMs : 60_000;

    await waitForTabLoaded(nextTabId, tabLoadTimeoutMs);
    await waitForTabUrlPrefix(
      nextTabId,
      "https://www.crunchbase.com/discover/organization.companies",
      tabUrlWaitTimeoutMs,
    );
    await injectCrunchbaseContentScript(nextTabId, dateKeyForLog);
  } catch (e) {
    emitUiLog(
      dateKeyForLog,
      `Tab reuse wait/inject failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return nextTabId;
}

async function sleepWithProgress(
  dateKey: string,
  totalMs: number,
  tickMs: number,
): Promise<void> {
  const started = Date.now();
  let lastRemaining = totalMs;
  emitUiLog(dateKey, `Wait: ${formatMs(totalMs)} remaining…`);
  while (Date.now() - started < totalMs) {
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, totalMs - elapsed);
    // Only log when we cross a tick boundary (avoid spam).
    if (
      remaining <= 0 ||
      Math.floor(remaining / tickMs) !== Math.floor(lastRemaining / tickMs)
    ) {
      emitUiLog(dateKey, `Wait: ${formatMs(remaining)} remaining…`);
      lastRemaining = remaining;
    }
    await new Promise((r) => window.setTimeout(r, Math.min(750, remaining)));
  }
}

async function sendScrapeStartWithRetries(
  dateKey: string,
  tabId: number,
  sessionGroupId?: string,
): Promise<void> {
  let lastErr: unknown = null;
  let didInject = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      emitUiLog(
        dateKey,
        attempt === 0
          ? "Starting scrape…"
          : `Starting scrape (retry ${attempt + 1}/12)…`,
      );

      // MV3-safe: ensure the content script is present before messaging.
      // Even after a "complete" load, SPA transitions/redirects can still race.
      if (!didInject || attempt === 0) {
        await injectCrunchbaseContentScript(tabId, dateKey).catch((e) => {
          // Non-fatal: we'll still attempt to send (and reinject on "no receiver").
          emitUiLog(
            dateKey,
            `Content script injection failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
          );
        });
        didInject = true;
        // Give the injected script a moment to register its onMessage listener.
        await sleepMs(250);
      }

      // NOTE: we no longer send a "start" message to the tab. The content script
      // auto-starts when cb_autostart=1 is present in the URL.
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      emitUiLog(dateKey, `Scrape start not ready yet: ${msg}`);

      // If the tab has no receiver, we need to (re)inject and retry.
      if (isNoReceiverError(e)) {
        didInject = false;
      }

      // Content script may not be ready yet right after load; back off.
      await sleepMs(500 + attempt * 250);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Failed to start scrape: ${String(lastErr)}`);
}

export async function tryStartNext(): Promise<void> {
  await load();
  if (mem.activeDateKey !== null) return;
  if (mem.pending.length === 0) return;

  const dateKey = mem.pending.shift()!;
  mem.activeDateKey = dateKey;
  await save();

  try {
    // Clear stored chunks + mark this run as "running" before starting.
    await storage.deleteChunksForDate(dateKey);
    await storage.clearRunChunks(dateKey, SOURCE_CRUNCHBASE_DISCOVER_ORGS, {
      groupId: mem.sessionGroupId ?? undefined,
    });

    // Multi-date workflow: open a new tab only for the first date, then reuse it.
    // This reduces tab spam and is less likely to trip Crunchbase anti-bot.
    if (activeRunTabId == null) {
      activeRunTabId = await openNewDiscoverCompaniesTab(dateKey);
    } else {
      activeRunTabId = await reuseDiscoverCompaniesTab(activeRunTabId, dateKey);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    mem.activeDateKey = null;
    activeRunTabId = null;
    await save();
    const meta = await storage.ensureRun(
      dateKey,
      SOURCE_CRUNCHBASE_DISCOVER_ORGS,
    );
    await storage.upsertRun({
      ...meta,
      status: "error",
      errorMessage: msg,
      updatedAt: new Date().toISOString(),
    });
    chrome.runtime
      .sendMessage({
        type: "scrape/error",
        dateKey,
        message: msg,
        partial: false,
      } satisfies ExtensionMessage)
      .catch(() => {});
    await onScrapeFinished(dateKey);
  }
}

/**
 * Called after content/done, content/error, or failed send — advances queue if `dateKey` was active.
 */
export async function onScrapeFinished(dateKey: string): Promise<void> {
  await load();
  if (mem.activeDateKey !== dateKey) {
    await tryStartNext();
    return;
  }
  mem.activeDateKey = null;
  // Keep the tab open; we reuse it across dates.

  if (mem.stagedAfterAbort !== null) {
    mem.pending = [...mem.stagedAfterAbort];
    mem.batchOrder = [...mem.stagedAfterAbort];
    mem.stagedAfterAbort = null;
  }
  await save();

  // Wait 1–2 minutes between dates.
  if (mem.pending.length > 0) {
    await ensurePersistedDelaySettingsInitialized();
    const delays = await loadPersistedDelaySettings();
    const betweenDatesMs =
      typeof delays.betweenDatesMs === "number" ? delays.betweenDatesMs : 120_000;
    const tickMs =
      typeof delays.betweenDatesLogTickMs === "number"
        ? delays.betweenDatesLogTickMs
        : 15_000;
    await sleepWithProgress(dateKey, betweenDatesMs, tickMs);
  }
  await tryStartNext();
}
