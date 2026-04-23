import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from '@shared/constants';
import type { ExtensionMessage } from '@shared/messages';
import * as storage from '../../storage';
import {
  exportMergedJsonFromDateChunks,
  tryDownloadBatchZipIfComplete,
} from './dateScrapeExport';
import {
  clearQueueAfterStop,
  getQueueState,
  handleRateLimitAndRetry,
  onScrapeFinished,
} from './scrapeQueue';

export async function handleContentDone(dateKey: string, totalRows: number): Promise<void> {
  const meta = await storage.ensureRun(dateKey, SOURCE_CRUNCHBASE_DISCOVER_ORGS);
  await storage.upsertRun({
    ...meta,
    status: 'done',
    rowCount: totalRows,
    updatedAt: new Date().toISOString(),
  });
  const done = await storage.getRun(dateKey);
  if (done) {
    chrome.runtime
      .sendMessage({ type: 'scrape/complete', dateKey, meta: done } satisfies ExtensionMessage)
      .catch(() => {});
  }
  await onScrapeFinished(dateKey);
  try {
    await exportMergedJsonFromDateChunks(dateKey, {
      // Requirement: always create + upload merged JSON when a date finishes.
      // (Batch zip download can still happen separately.)
      skipDownload: false,
      skipUpload: false,
    });
  } finally {
    await tryDownloadBatchZipIfComplete();
  }
}

export async function handleContentError(dateKey: string, message: string, partial: boolean): Promise<void> {
  // Special case: if content detected a rate-limit response, do NOT fail the run or advance the queue.
  // Instead: pause, refresh tab, and retry the same active date.
  if ((message ?? "").startsWith("RATE_LIMIT:")) {
    chrome.runtime
      .sendMessage({ type: 'scrape/log', dateKey, level: 'warn', text: message, at: new Date().toISOString() } satisfies ExtensionMessage)
      .catch(() => {});
    await handleRateLimitAndRetry(dateKey);
    return;
  }

  const meta = await storage.ensureRun(dateKey, SOURCE_CRUNCHBASE_DISCOVER_ORGS);
  await storage.upsertRun({
    ...meta,
    status: 'error',
    errorMessage: message,
    updatedAt: new Date().toISOString(),
  });
  chrome.runtime
    .sendMessage({ type: 'scrape/error', dateKey, message, partial } satisfies ExtensionMessage)
    .catch(() => {});
  await clearQueueAfterStop();
  await onScrapeFinished(dateKey);
  await tryDownloadBatchZipIfComplete();
}

export async function handleContentCancelled(dateKey: string, message: string, partial: boolean): Promise<void> {
  const meta = await storage.ensureRun(dateKey, SOURCE_CRUNCHBASE_DISCOVER_ORGS);
  await storage.upsertRun({
    ...meta,
    status: 'cancelled',
    errorMessage: message,
    updatedAt: new Date().toISOString(),
  });
  chrome.runtime
    .sendMessage({ type: 'scrape/error', dateKey, message, partial } satisfies ExtensionMessage)
    .catch(() => {});
  await clearQueueAfterStop();
  await onScrapeFinished(dateKey);
  await tryDownloadBatchZipIfComplete();
}
