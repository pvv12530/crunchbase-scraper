import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from '@shared/constants';
import type { ExtensionMessage } from '@shared/messages';
import type { ScrapeQueueState } from '@shared/models';
import * as storage from '../../storage';
import { getActiveTabContext } from './activeTab';
import { sendScrapeStartToTab } from './jobQueue';

const STORAGE_KEY = 'scrapeQueueV1';

let mem: ScrapeQueueState = {
  pending: [],
  activeDateKey: null,
  stagedAfterAbort: null,
  batchOrder: null,
};
let loaded = false;

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

async function broadcastQueue(): Promise<void> {
  await save();
}

export async function getQueueState(): Promise<ScrapeQueueState> {
  await load();
  return {
    pending: [...mem.pending],
    activeDateKey: mem.activeDateKey,
    stagedAfterAbort: mem.stagedAfterAbort ? [...mem.stagedAfterAbort] : null,
    batchOrder: mem.batchOrder ? [...mem.batchOrder] : null,
  };
}

/** Replace queue with CSV import; if a job is running, stage replacement and abort current. */
export async function enqueueFromImport(dates: string[]): Promise<void> {
  await load();
  const next = [...dates];
  if (mem.activeDateKey !== null) {
    mem.stagedAfterAbort = next;
    mem.batchOrder = [...next];
    await broadcastQueue();
    await requestAbortActiveTab();
    return;
  }
  mem.pending = next;
  mem.batchOrder = [...next];
  mem.stagedAfterAbort = null;
  await broadcastQueue();
  await tryStartNext();
}

/** User retry or manual scrape: prefer this date next (after current job if any). */
export async function enqueueRetry(dateKey: string): Promise<void> {
  await load();
  const i = mem.pending.indexOf(dateKey);
  if (i >= 0) mem.pending.splice(i, 1);
  mem.pending.unshift(dateKey);
  await broadcastQueue();
  await tryStartNext();
}

export async function clearPendingQueue(): Promise<void> {
  await load();
  mem.pending = [];
  mem.stagedAfterAbort = null;
  mem.batchOrder = null;
  await broadcastQueue();
  if (mem.activeDateKey !== null) {
    await requestAbortActiveTab();
  }
}

export async function requestStopCurrent(): Promise<void> {
  await requestAbortActiveTab();
}

async function requestAbortActiveTab(): Promise<void> {
  const ctx = await getActiveTabContext();
  if (ctx.activeTabId == null) return;
  await chrome.tabs
    .sendMessage(ctx.activeTabId, {
      type: 'scrape/abort',
    } satisfies ExtensionMessage)
    .catch(() => {});
}

export async function tryStartNext(): Promise<void> {
  await load();
  if (mem.activeDateKey !== null) return;
  if (mem.pending.length === 0) return;

  const ctx = await getActiveTabContext();
  if (!ctx.isCrunchbaseHost || ctx.activeTabId == null) return;

  const dateKey = mem.pending.shift()!;
  mem.activeDateKey = dateKey;
  await broadcastQueue();

  try {
    await sendScrapeStartToTab(dateKey, ctx.activeTabId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    mem.activeDateKey = null;
    await broadcastQueue();
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
  if (mem.stagedAfterAbort !== null) {
    mem.pending = [...mem.stagedAfterAbort];
    mem.batchOrder = [...mem.stagedAfterAbort];
    mem.stagedAfterAbort = null;
  }
  await broadcastQueue();
  await tryStartNext();
}
