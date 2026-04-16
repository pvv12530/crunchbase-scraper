import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from "@shared/constants";
import type { ExtensionMessage } from "@shared/messages";
import type { ChunkRef, DateRunMeta } from "@shared/models";
import { parseCsvDates } from "../lib/csv";
import * as storage from "../storage";
import { getActiveTabContext } from "./services/tabContext";
import { sendScrapeStartToTab } from "./services/jobQueue";
import {
  handleContentCancelled,
  handleContentDone,
  handleContentError,
} from "./services/messaging";
import * as scrapeQueue from "./services/scrapeQueue";

const SUPABASE_FN_GET_JSON_BY_DATE =
  "https://gfxknuxbtkhomfodrrfr.supabase.co/functions/v1/get-json-by-date";
const SUPABASE_FN_UPLOAD_JSON =
  "https://gfxknuxbtkhomfodrrfr.supabase.co/functions/v1/upload-json";

type SupabaseJsonFile = {
  id: string;
  file_date: string;
  file_path: string;
  created_at: string;
  signed_url?: string | null;
};

async function handleRunsList(): Promise<DateRunMeta[]> {
  return storage.loadAllRuns();
}

async function handleImportCsv(
  text: string,
): Promise<{ dates: string[]; error?: string }> {
  try {
    const dates = parseCsvDates(text);
    await scrapeQueue.enqueueFromImport(dates);
    return { dates };
  } catch (e) {
    return { dates: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function onContentChunk(
  dateKey: string,
  record: import("@shared/models").ChunkRecord,
): Promise<void> {
  await storage.putChunk(record);
  const meta = await storage.ensureRun(
    dateKey,
    SOURCE_CRUNCHBASE_DISCOVER_ORGS,
  );
  const ref: ChunkRef = {
    chunkId: record.chunkId,
    pageIndex: record.pageIndex,
    rowCount: record.rowCount,
    capturedAt: record.capturedAt,
  };
  const existingIdx = meta.chunks.findIndex((c) => c.chunkId === ref.chunkId);
  const chunks = [...meta.chunks];
  if (existingIdx >= 0) chunks[existingIdx] = ref;
  else chunks.push(ref);
  chunks.sort((a, b) => a.pageIndex - b.pageIndex);
  const rowSum = chunks.reduce((s, c) => s + (c.rowCount ?? 0), 0);
  const next: DateRunMeta = {
    ...meta,
    chunks,
    rowCount: rowSum,
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  await storage.upsertRun(next);
  chrome.runtime
    .sendMessage({
      type: "scrape/progress",
      dateKey,
      pageIndex: record.pageIndex,
      chunkId: record.chunkId,
      rowCount: record.rowCount,
    } satisfies ExtensionMessage)
    .catch(() => {});
}

export function initMessageRouter(): void {
  chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, sender, sendResponse: (r: unknown) => void) => {
      /** Content script messages: handle here, single async path */
      if (sender.tab?.id != null && message.type.startsWith("content/")) {
        void (async () => {
          try {
            switch (message.type) {
              case "content/chunk":
                await onContentChunk(message.record.dateKey, message.record);
                sendResponse({ ok: true });
                return;
              case "content/done":
                await handleContentDone(message.dateKey, message.totalRows);
                sendResponse({ ok: true });
                return;
              case "content/log":
                console.log(`[crunchbase ${message.dateKey}]`, message.text);
                chrome.runtime
                  .sendMessage({
                    type: "scrape/log",
                    dateKey: message.dateKey,
                    level: message.level,
                    text: message.text,
                    at: new Date().toISOString(),
                  } satisfies ExtensionMessage)
                  .catch(() => {});
                sendResponse({ ok: true });
                return;
              case "content/error":
                if (message.cancelled === true) {
                  await handleContentCancelled(
                    message.dateKey,
                    message.message,
                    message.partial,
                  );
                } else {
                  await handleContentError(
                    message.dateKey,
                    message.message,
                    message.partial,
                  );
                }
                sendResponse({ ok: true });
                return;
              default:
                sendResponse({ ok: false });
            }
          } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })();
        return true;
      }

      /** Panel / extension pages */
      void (async () => {
        try {
          switch (message.type) {
            case "tabContext/get":
              sendResponse(await getActiveTabContext());
              return;
            case "runs/list":
              sendResponse(await handleRunsList());
              return;
            case "supabase/getJsonByDate": {
              const res = await fetch(SUPABASE_FN_GET_JSON_BY_DATE, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ date: message.date }),
              });
              if (!res.ok) {
                sendResponse({
                  ok: false,
                  error: `get-json-by-date failed: ${res.status}`,
                });
                return;
              }
              const body = (await res.json()) as unknown;
              sendResponse({
                ok: true,
                files: Array.isArray(body) ? (body as SupabaseJsonFile[]) : [],
              });
              return;
            }
            case "supabase/uploadJson": {
              const fd = new FormData();
              fd.append("date", message.date);
              fd.append(
                "file",
                new Blob([message.jsonText], { type: "application/json" }),
                message.filename,
              );
              const res = await fetch(SUPABASE_FN_UPLOAD_JSON, {
                method: "POST",
                body: fd,
              });
              if (!res.ok) {
                sendResponse({
                  ok: false,
                  error: `upload-json failed: ${res.status}`,
                });
                return;
              }
              sendResponse({ ok: true });
              return;
            }
            case "import/csv":
              sendResponse(await handleImportCsv(message.text));
              return;
            case "scrape/resultsStart": {
              const ctx = await getActiveTabContext();
              if (!ctx.isCrunchbaseHost || ctx.activeTabId == null) {
                sendResponse({
                  ok: false,
                  error: "Active tab is not Crunchbase.",
                });
                return;
              }
              const res = await chrome.tabs
                .sendMessage(ctx.activeTabId, {
                  type: "scrape/resultsStart",
                  runKey: message.runKey,
                } satisfies ExtensionMessage)
                .catch((e: unknown) => ({
                  ok: false,
                  error: e instanceof Error ? e.message : String(e),
                }));
              sendResponse(res);
              return;
            }
            case "scrape/queueGet":
              sendResponse(await scrapeQueue.getQueueState());
              return;
            case "scrape/stop":
              await scrapeQueue.requestStopCurrent();
              sendResponse({ ok: true });
              return;
            case "scrape/queueClear":
              await scrapeQueue.clearPendingQueue();
              sendResponse({ ok: true });
              return;
            case "scrape/start":
            case "scrape/retryDate":
              if (
                message.type === "scrape/start" &&
                Array.isArray(message.dateKeys) &&
                message.dateKeys.length > 0
              ) {
                const ctx = await getActiveTabContext();
                if (!ctx.isCrunchbaseHost || ctx.activeTabId == null) {
                  sendResponse({
                    ok: false,
                    error: "Active tab is not Crunchbase.",
                  });
                  return;
                }
                // Run a single content-script job that loops all dates.
                await sendScrapeStartToTab(
                  message.dateKey,
                  ctx.activeTabId,
                  message.dateKeys,
                  message.groupId,
                );
                sendResponse({ ok: true });
                return;
              }
              await scrapeQueue.enqueueRetry(message.dateKey);
              sendResponse({ ok: true });
              return;
            default:
              sendResponse(undefined);
          }
        } catch (e) {
          sendResponse({ error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    },
  );
}
