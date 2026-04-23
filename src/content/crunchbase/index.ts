import type { ExtensionMessage } from '@shared/messages';
import { runDiscoverScrape, runDiscoverScrapeCurrentResults } from './discoverAdapter';

let abortCurrent: (() => void) | null = null;

declare global {
  // eslint-disable-next-line no-var
  var __crunchbaseDateBatchContentInstalled: boolean | undefined;
  // eslint-disable-next-line no-var
  var __crunchbaseDateBatchAutoStarted: boolean | undefined;
}

function parseAutoStartParams(): { enabled: boolean; dateKey: string | null } {
  try {
    const u = new URL(window.location.href);
    const enabled =
      (u.searchParams.get('cb_autostart') ?? '').trim() === '1' ||
      (u.searchParams.get('cb_autostart') ?? '').trim().toLowerCase() === 'true';
    const dateKey =
      (u.searchParams.get('cb_date_hint') ?? '').trim() ||
      (u.searchParams.get('cb_run_key') ?? '').trim() ||
      null;
    return { enabled, dateKey: dateKey || null };
  } catch {
    return { enabled: false, dateKey: null };
  }
}

async function startDiscoverScrapeRun(
  dateKeys: string[],
  logDateKey: string,
  sendResponse?: (r: unknown) => void,
): Promise<void> {
  const ac = new AbortController();
  abortCurrent = () => ac.abort();
  try {
    await runDiscoverScrape(
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
          dateKey: logDateKey,
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

    // `content/done` is emitted once per date from `onDateComplete` inside `runDiscoverScrape`.
    sendResponse?.({ ok: true });
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    const cancelled =
      e instanceof Error && (e.name === 'AbortError' || errText === 'Cancelled by user');
    await chrome.runtime.sendMessage({
      type: 'content/error',
      tabId: -1,
      dateKey: logDateKey,
      message: cancelled ? 'Cancelled by user' : errText,
      partial: cancelled,
      cancelled: cancelled || undefined,
    } satisfies ExtensionMessage);
    sendResponse?.({ ok: false, error: errText });
  } finally {
    abortCurrent = null;
  }
}

if (globalThis.__crunchbaseDateBatchContentInstalled) {
  // Prevent duplicate listeners if the script is injected multiple times.
  // (We rely on this for robustness after tab redirects.)
} else {
  globalThis.__crunchbaseDateBatchContentInstalled = true;

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
    await startDiscoverScrapeRun(dateKeys, dateKey, sendResponse);
  })();

  return true;
});

// Google-demo style: if we were opened with cb_autostart=1, start scraping immediately.
// This avoids background -> tab messaging races ("Receiving end does not exist").
const auto = parseAutoStartParams();
if (auto.enabled && auto.dateKey && !globalThis.__crunchbaseDateBatchAutoStarted) {
  globalThis.__crunchbaseDateBatchAutoStarted = true;
  void chrome.runtime.sendMessage({
    type: 'content/log',
    tabId: -1,
    dateKey: auto.dateKey,
    level: 'info',
    text: `Autostart enabled (dateKey=${auto.dateKey}). Starting scrape…`,
  } satisfies ExtensionMessage);
  void startDiscoverScrapeRun([auto.dateKey], auto.dateKey);
}

}
