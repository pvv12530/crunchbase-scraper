import type { ExtensionMessage } from '@shared/messages';
import * as storage from '../../storage';
import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from '@shared/constants';

/** Clear stored chunks and ask the content script to start scraping (throws if tab message fails). */
export async function sendScrapeStartToTab(dateKey: string, tabId: number): Promise<void> {
  await storage.deleteChunksForDate(dateKey);
  await storage.clearRunChunks(dateKey, SOURCE_CRUNCHBASE_DISCOVER_ORGS);

  const msg: ExtensionMessage = {
    type: 'scrape/start',
    dateKey,
    sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
  };
  await chrome.tabs.sendMessage(tabId, msg);
}
