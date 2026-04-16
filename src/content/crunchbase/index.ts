import type { ExtensionMessage } from '@shared/messages';
import { runDiscoverScrape, runDiscoverScrapeCurrentResults } from './discoverAdapter';

let abortCurrent: (() => void) | null = null;

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'scrape/abort') {
    abortCurrent?.();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'scrape/resultsStart') {
    void (async () => {
      const { runKey } = message;
      const ac = new AbortController();
      abortCurrent = () => ac.abort();
      try {
        const { totalRows, columns, rows } = await runDiscoverScrapeCurrentResults(
          runKey,
          async () => {
            // Intentionally NO-OP: do not create JSON files
          },
          (text) => {
            void chrome.runtime.sendMessage({
              type: 'content/log',
              tabId: -1,
              dateKey: runKey,
              level: 'info',
              text,
            } satisfies ExtensionMessage);
          },
          ac.signal,
        );
        void chrome.runtime.sendMessage({
          type: 'content/log',
          tabId: -1,
          dateKey: runKey,
          level: 'info',
          text: `Scrape results finished (${rows.length} table row${rows.length === 1 ? '' : 's'}; totalRows~${totalRows})`,
        } satisfies ExtensionMessage);
        sendResponse({ ok: true, totalRows, columns, rows });
      } catch (e) {
        const errText = e instanceof Error ? e.message : String(e);
        const cancelled =
          e instanceof Error && (e.name === 'AbortError' || errText === 'Cancelled by user');
        void chrome.runtime.sendMessage({
          type: 'content/log',
          tabId: -1,
          dateKey: runKey,
          level: cancelled ? 'warn' : 'error',
          text: cancelled ? 'Cancelled by user' : `Error: ${errText}`,
        } satisfies ExtensionMessage);
        sendResponse({ ok: false, error: errText });
      } finally {
        abortCurrent = null;
      }
    })();
    return true;
  }

  if (message.type !== 'scrape/start') {
    return false;
  }

  void (async () => {
    const dateKeys =
      Array.isArray(message.dateKeys) && message.dateKeys.length > 0
        ? message.dateKeys
        : [message.dateKey];
    const dateKey = message.dateKey;
    const ac = new AbortController();
    abortCurrent = () => ac.abort();
    try {
      const totalRows = await runDiscoverScrape(
        dateKeys,
        async (record) => {
          await chrome.runtime.sendMessage({
            type: 'content/chunk',
            tabId: -1,
            record,
          } satisfies ExtensionMessage);
        },
        (text) => {
          void chrome.runtime.sendMessage({
            type: 'content/log',
            tabId: -1,
            dateKey,
            level: 'info',
            text,
          } satisfies ExtensionMessage);
        },
        ac.signal,
        {
          onDateComplete: async (dk, rows) => {
            await chrome.runtime.sendMessage({
              type: 'content/done',
              tabId: -1,
              dateKey: dk,
              totalRows: rows,
            } satisfies ExtensionMessage);
          },
        },
      );

      // For multi-date runs we emit content/done per date (above).
      // Keep the single-date behavior for backwards-compat.
      if (dateKeys.length === 1) {
        await chrome.runtime.sendMessage({
          type: 'content/done',
          tabId: -1,
          dateKey,
          totalRows,
        } satisfies ExtensionMessage);
      }
      sendResponse({ ok: true });
    } catch (e) {
      const errText = e instanceof Error ? e.message : String(e);
      const cancelled =
        e instanceof Error && (e.name === 'AbortError' || errText === 'Cancelled by user');
      await chrome.runtime.sendMessage({
        type: 'content/error',
        tabId: -1,
        dateKey,
        message: cancelled ? 'Cancelled by user' : errText,
        partial: cancelled,
        cancelled: cancelled || undefined,
      } satisfies ExtensionMessage);
      sendResponse({ ok: false, error: errText });
    } finally {
      abortCurrent = null;
    }
  })();

  return true;
});
