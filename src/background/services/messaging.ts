import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from '@shared/constants';
import type { ExtensionMessage } from '@shared/messages';
import * as storage from '../../storage';
import { onScrapeFinished } from './scrapeQueue';

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
}

export async function handleContentError(dateKey: string, message: string, partial: boolean): Promise<void> {
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
  await onScrapeFinished(dateKey);
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
  await onScrapeFinished(dateKey);
}
