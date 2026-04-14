import { getActiveTabContext } from './activeTab';
import { tryStartNext } from './scrapeQueue';

export { getActiveTabContext } from './activeTab';

export function broadcastTabContext(): void {
  void getActiveTabContext().then((payload) => {
    chrome.runtime.sendMessage({ type: 'tabContext/changed', payload }).catch(() => {
      /* side panel may be closed */
    });
    void tryStartNext();
  });
}

export function initTabContextListeners(): void {
  chrome.tabs.onActivated.addListener(() => broadcastTabContext());
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete' || info.url) {
      void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs[0]?.id === tabId) broadcastTabContext();
      });
    }
  });
  chrome.windows.onFocusChanged.addListener(() => broadcastTabContext());
}
