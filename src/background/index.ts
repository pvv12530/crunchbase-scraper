import { initMessageRouter } from './router';
import { initTabContextListeners, broadcastTabContext } from './services/tabContext';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  /* ignore if unsupported */
});

initTabContextListeners();
broadcastTabContext();
initMessageRouter();

chrome.runtime.onInstalled.addListener(() => {
  broadcastTabContext();
});
