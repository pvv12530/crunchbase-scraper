import type { ExtensionMessage } from '@shared/messages';
import * as storage from '../../storage';
import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from '@shared/constants';

/** Clear stored chunks and ask the content script to start scraping (throws if tab message fails). */
export async function sendScrapeStartToTab(
  dateKey: string,
  tabId: number,
  dateKeys?: string[],
  groupId?: string,
): Promise<void> {
  const keysToClear =
    Array.isArray(dateKeys) && dateKeys.length > 0 ? dateKeys : [dateKey];
  for (const k of keysToClear) {
    await storage.deleteChunksForDate(k);
    await storage.clearRunChunks(k, SOURCE_CRUNCHBASE_DISCOVER_ORGS, { groupId });
  }

  const msg: ExtensionMessage = {
    type: 'scrape/start',
    dateKey,
    dateKeys: Array.isArray(dateKeys) && dateKeys.length > 0 ? dateKeys : undefined,
    groupId,
    sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
  };
  await chrome.tabs.sendMessage(tabId, msg);
}
