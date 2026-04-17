import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from '@shared/constants';
import type { ExtensionMessage } from '@shared/messages';
import type { ScrapeQueueState } from '@shared/models';
import * as storage from '../../storage';
import { getActiveTabContext } from './activeTab';
import { sendScrapeStartToTab } from './jobQueue';

const STORAGE_KEY = 'scrapeQueueV1';
const DISCOVER_COMPANIES_PATH_PREFIX = '/discover/organization.companies';

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
      type: 'scrape/log',
      dateKey,
      level: 'info',
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
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}

async function load(): Promise<void> {
  if (loaded) return;
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw = data[STORAGE_KEY] as ScrapeQueueState | undefined;
  if (raw && typeof raw === 'object') {
    mem = {
      pending: Array.isArray(raw.pending) ? [...raw.pending] : [],
      activeDateKey: raw.activeDateKey ?? null,
      stagedAfterAbort: raw.stagedAfterAbort
        ? [...raw.stagedAfterAbort]
        : null,
      batchOrder: raw.batchOrder ? [...raw.batchOrder] : null,
      multiDateExportSession: raw.multiDateExportSession === true,
      sessionGroupId:
        typeof raw.sessionGroupId === 'string' && raw.sessionGroupId.length > 0
          ? raw.sessionGroupId
          : null,
    };
  }
  loaded = true;
}

async function save(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: mem });
  chrome.runtime
    .sendMessage({ type: 'scrape/queueChanged' } satisfies ExtensionMessage)
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
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0);
  const next = [...new Set(cleaned)];
  const multi = next.length > 1;
  mem.sessionGroupId =
    typeof sessionGroupId === 'string' && sessionGroupId.length > 0
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
  await requestAbortActiveTab();
}

async function requestAbortActiveTab(): Promise<void> {
  if (activeRunTabId == null) return;
  await chrome.tabs
    .sendMessage(activeRunTabId, {
      type: 'scrape/abort',
    } satisfies ExtensionMessage)
    .catch(() => {});
}

async function assertActiveTabIsDiscoverCompanies(
  dateKeyForLog: string,
): Promise<number> {
  const ctx = await getActiveTabContext();
  if (ctx.activeTabId == null) throw new Error('No active tab found');
  const tabId = ctx.activeTabId;
  const activeUrl = ctx.activeUrl ?? '';
  emitUiLog(dateKeyForLog, `Active tab ${tabId} URL=${activeUrl || '(unknown)'}`);
  if (!activeUrl) {
    throw new Error(
      `Active tab has no URL. Open Crunchbase: https://www.crunchbase.com${DISCOVER_COMPANIES_PATH_PREFIX}`,
    );
  }
  let u: URL;
  try {
    u = new URL(activeUrl);
  } catch {
    throw new Error(
      `Active tab URL is invalid: ${activeUrl}. Open Crunchbase: https://www.crunchbase.com${DISCOVER_COMPANIES_PATH_PREFIX}`,
    );
  }
  if (
    u.hostname !== 'www.crunchbase.com' &&
    u.hostname !== 'crunchbase.com'
  ) {
    throw new Error(
      `Active tab is not Crunchbase (${u.hostname}). Open: https://www.crunchbase.com${DISCOVER_COMPANIES_PATH_PREFIX}`,
    );
  }
  if (!u.pathname.startsWith(DISCOVER_COMPANIES_PATH_PREFIX)) {
    throw new Error(
      `Active tab is not Discover Companies (${u.pathname}). Open: https://www.crunchbase.com${DISCOVER_COMPANIES_PATH_PREFIX}`,
    );
  }
  return tabId;
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
          ? 'Starting scrape…'
          : `Starting scrape (retry ${attempt + 1}/12)…`,
      );
      await sendScrapeStartToTab(
        dateKey,
        tabId,
        undefined,
        sessionGroupId,
      );
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      emitUiLog(dateKey, `Scrape start not ready yet: ${msg}`);

      // If the content script isn't injected/ready after redirect, inject it once as fallback.
      if (!didInject) {
        didInject = true;
        emitUiLog(dateKey, 'Injecting Crunchbase content script (fallback)…');
        await chrome.scripting
          .executeScript({
            target: { tabId },
            files: ['content/crunchbase.js'],
          })
          .catch(() => {});
      }

      // Content script may not be ready yet right after load; back off.
      await new Promise((r) => window.setTimeout(r, 500 + attempt * 250));
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
    // Only run if the *current tab* is already on Discover Companies.
    const tabId = await assertActiveTabIsDiscoverCompanies(dateKey);
    activeRunTabId = tabId;
    await sendScrapeStartWithRetries(
      dateKey,
      tabId,
      mem.sessionGroupId ?? undefined,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    mem.activeDateKey = null;
    activeRunTabId = null;
    await save();
    const meta = await storage.ensureRun(dateKey, SOURCE_CRUNCHBASE_DISCOVER_ORGS);
    await storage.upsertRun({
      ...meta,
      status: 'error',
      errorMessage: msg,
      updatedAt: new Date().toISOString(),
    });
    chrome.runtime
      .sendMessage({
        type: 'scrape/error',
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
  // Do not close the tab; we reuse the current tab across dates.
  activeRunTabId = null;

  if (mem.stagedAfterAbort !== null) {
    mem.pending = [...mem.stagedAfterAbort];
    mem.batchOrder = [...mem.stagedAfterAbort];
    mem.stagedAfterAbort = null;
  }
  await save();
  await tryStartNext();
}
