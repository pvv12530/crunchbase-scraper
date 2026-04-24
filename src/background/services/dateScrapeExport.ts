import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from "@shared/constants";
import type { ExtensionMessage } from "@shared/messages";
import type { DateRunMeta } from "@shared/models";
import { zipSync } from "fflate";
import * as storage from "../../storage";
import * as scrapeQueue from "./scrapeQueue";

const SUPABASE_FN_UPLOAD_JSON =
  "https://gfxknuxbtkhomfodrrfr.supabase.co/functions/v1/upload-json";

function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function rowDedupeKey(row: Record<string, unknown>): string {
  const id = row.identifier;
  if (id && typeof id === "object" && "permalink" in id) {
    const p = String(
      (id as { permalink?: unknown }).permalink ?? "",
    ).trim();
    if (p.length > 0) return p;
  }
  return JSON.stringify(row);
}

function getGridRowsFromPayload(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const rows = p.gridRows;
  if (!Array.isArray(rows)) return [];
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (r && typeof r === "object" && !Array.isArray(r))
      out.push(r as Record<string, unknown>);
  }
  return out;
}

/**
 * MV3 service workers do not implement `URL.createObjectURL`. `chrome.downloads`
 * accepts a `data:` URL instead.
 */
function jsonTextToDownloadsDataUrl(jsonText: string): string {
  const utf8 = new TextEncoder().encode(jsonText);
  const chunk = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < utf8.length; i += chunk) {
    const sub = utf8.subarray(i, Math.min(i + chunk, utf8.length));
    let s = "";
    for (let j = 0; j < sub.length; j++) s += String.fromCharCode(sub[j]!);
    parts.push(s);
  }
  const b64 = btoa(parts.join(""));
  return `data:application/json;base64,${b64}`;
}

function uint8ToDownloadsDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    let s = "";
    for (let j = 0; j < sub.length; j++) s += String.fromCharCode(sub[j]!);
    parts.push(s);
  }
  const b64 = btoa(parts.join(""));
  return `data:${mime};base64,${b64}`;
}

async function emitLog(
  dateKey: string,
  level: "info" | "warn" | "error",
  text: string,
): Promise<void> {
  await chrome.runtime
    .sendMessage({
      type: "scrape/log",
      dateKey,
      level,
      text,
      at: new Date().toISOString(),
    } satisfies ExtensionMessage)
    .catch(() => {});
}

type MergedExportBuilt = {
  jsonText: string;
  filename: string;
  totalRows: number;
  meta: DateRunMeta;
};

async function buildMergedExportForDate(
  dateKey: string,
): Promise<MergedExportBuilt | null> {
  const meta = await storage.getRun(dateKey);
  if (!meta || meta.sourceId !== SOURCE_CRUNCHBASE_DISCOVER_ORGS) return null;

  const refs = [...meta.chunks].sort((a, b) => a.pageIndex - b.pageIndex);
  if (refs.length === 0) return null;

  const merged: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const record = await storage.getChunk(dateKey, ref.chunkId);
    if (!record) continue;
    const pageRows = getGridRowsFromPayload(record.payload);
    for (const r of pageRows) {
      const k = rowDedupeKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(r);
    }
  }

  if (merged.length === 0) return null;

  const totalRows = merged.length;
  const body = { entities: merged, count: totalRows };
  const jsonText = JSON.stringify(body, null, 2);
  const filename = `crunchbase-scrape-results-${dateKey}.json`;
  return { jsonText, filename, totalRows, meta };
}

async function uploadMergedJsonToSupabase(
  dateKey: string,
  built: MergedExportBuilt,
): Promise<boolean> {
  try {
    const fd = new FormData();
    // Requirement: bucket uploads by *current* date, not the scraped date.
    // The filename still includes the scraped dateKey for traceability.
    fd.append("date", localDateKey());
    if (built.meta.groupId) fd.append("group_id", built.meta.groupId);
    fd.append("rows_count", String(built.totalRows));
    fd.append(
      "file",
      new Blob([built.jsonText], { type: "application/json" }),
      built.filename,
    );
    const res = await fetch(SUPABASE_FN_UPLOAD_JSON, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      await emitLog(
        dateKey,
        "warn",
        `Merged JSON upload failed (${res.status}): ${built.filename}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    await emitLog(
      dateKey,
      "warn",
      `Merged JSON upload failed: ${e instanceof Error ? e.message : String(e)} (${built.filename})`,
    );
    return false;
  }
}

/**
 * When multiple dates were queued (calendar multi-select or CSV), per-date export
 * skips download and cloud; when the queue is idle, this uploads every merged JSON
 * to Supabase, then downloads one zip of all of them.
 */
export async function tryDownloadBatchZipIfComplete(): Promise<void> {
  const q = await scrapeQueue.getQueueState();
  if (!q.multiDateExportSession) return;
  const order = q.batchOrder;
  if (!order || order.length < 2) return;
  if (q.activeDateKey !== null || q.pending.length > 0) return;

  const logKey = order[0] ?? "batch";
  const uniqueOrder = [...new Set(order)];
  const builtList: { dateKey: string; built: MergedExportBuilt }[] = [];
  for (const dateKey of uniqueOrder) {
    const built = await buildMergedExportForDate(dateKey);
    if (built) builtList.push({ dateKey, built });
  }

  if (builtList.length === 0) {
    await emitLog(
      logKey,
      "warn",
      "Batch finished but no merged JSON files were available (skipped cloud + zip).",
    );
    await scrapeQueue.clearBatchOrder();
    return;
  }

  await emitLog(
    logKey,
    "info",
    `Batch: downloading zip of ${builtList.length} JSON file(s)…`,
  );

  const entries: Record<string, Uint8Array> = {};
  for (const { built } of builtList) {
    entries[built.filename] = new TextEncoder().encode(built.jsonText);
  }

  const zipped = zipSync(entries, { level: 0 });
  const first = uniqueOrder[0] ?? "start";
  const last = uniqueOrder[uniqueOrder.length - 1] ?? first;
  const zipName = `crunchbase-scrape-batch-${localDateKey()}_${first}_to_${last}.zip`;

  try {
    const dataUrl = uint8ToDownloadsDataUrl(zipped, "application/zip");
    await chrome.downloads.download({
      url: dataUrl,
      filename: zipName,
      saveAs: false,
    });
    await emitLog(
      logKey,
      "info",
      `Batch download: ${zipName} (${Object.keys(entries).length} JSON file(s)).`,
    );
  } catch (e) {
    await emitLog(
      logKey,
      "warn",
      `Batch zip download failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await scrapeQueue.clearBatchOrder();
  }
}

/**
 * Rebuilds one entities JSON from all DOM-grid chunks saved during `runDiscoverScrape`
 * (same shape as manual "Scrape results"), then downloads it and uploads to Supabase.
 */
export async function exportMergedJsonFromDateChunks(
  dateKey: string,
  opts?: { skipDownload?: boolean; skipUpload?: boolean },
): Promise<void> {
  const meta = await storage.getRun(dateKey);
  if (!meta || meta.sourceId !== SOURCE_CRUNCHBASE_DISCOVER_ORGS) return;
  if (meta.chunks.length === 0) {
    await emitLog(
      dateKey,
      "info",
      "No saved page chunks — skipped merged JSON export.",
    );
    return;
  }

  const built = await buildMergedExportForDate(dateKey);
  if (!built) {
    await emitLog(
      dateKey,
      "info",
      "No rows in saved chunks — skipped merged JSON export.",
    );
    return;
  }

  const { jsonText, filename, totalRows } = built;

  if (opts?.skipDownload && opts?.skipUpload) {
    await emitLog(
      dateKey,
      "info",
      `Merged ${totalRows} row${totalRows === 1 ? "" : "s"} from saved pages → ${filename} (batch: cloud + zip when batch completes).`,
    );
    return;
  }

  let downloadOk = false;
  if (!opts?.skipDownload) {
    try {
      const dataUrl = jsonTextToDownloadsDataUrl(jsonText);
      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
      });
      downloadOk = true;
    } catch (e) {
      await emitLog(
        dateKey,
        "warn",
        `Merged JSON download failed: ${e instanceof Error ? e.message : String(e)} (cloud upload will still run).`,
      );
    }
  }

  if (opts?.skipUpload) {
    return;
  }

  const uploaded = await uploadMergedJsonToSupabase(dateKey, built);
  if (!uploaded) {
    return;
  }

  const parts: string[] = [];
  if (downloadOk) parts.push("download");
  parts.push("cloud");
  await emitLog(
    dateKey,
    "info",
    `Merged ${totalRows} row${totalRows === 1 ? "" : "s"} from saved pages → ${filename}${parts.length > 0 ? ` (${parts.join(" + ")})` : ""}.`,
  );

  await chrome.runtime
    .sendMessage({
      type: "scrape/jsonArtifactsUpdated",
      // Refresh the current-day bucket where uploads land.
      dateKeys: [localDateKey()],
    } satisfies ExtensionMessage)
    .catch(() => {});
}
