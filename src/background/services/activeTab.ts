import type { TabContextPayload } from '@shared/models';

function isCrunchbaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === 'www.crunchbase.com' || u.hostname === 'crunchbase.com';
  } catch {
    return false;
  }
}

export async function getActiveTabContext(): Promise<TabContextPayload> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const activeUrl = tab?.url ?? null;
  return {
    activeTabId: tab?.id ?? null,
    activeUrl,
    isCrunchbaseHost: isCrunchbaseUrl(activeUrl ?? undefined),
  };
}
