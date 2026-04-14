import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from "@shared/constants";
import type { ExtensionMessage } from "@shared/messages";
import * as storage from "../../storage";

const SUPABASE_FN_UPLOAD_JSON =
  "https://gfxknuxbtkhomfodrrfr.supabase.co/functions/v1/upload-json";

function todayKey(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
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

/**
 * Rebuilds one entities JSON from all DOM-grid chunks saved during `runDiscoverScrape`
 * (same shape as manual "Scrape results"), then downloads it and uploads to Supabase.
 */
export async function exportMergedJsonFromDateChunks(
  dateKey: string,
): Promise<void> {
  const meta = await storage.getRun(dateKey);
  if (!meta || meta.sourceId !== SOURCE_CRUNCHBASE_DISCOVER_ORGS) return;

  const refs = [...meta.chunks].sort((a, b) => a.pageIndex - b.pageIndex);
  if (refs.length === 0) {
    await emitLog(
      dateKey,
      "info",
      "No saved page chunks — skipped merged JSON export.",
    );
    return;
  }

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

  if (merged.length === 0) {
    await emitLog(
      dateKey,
      "info",
      "No rows in saved chunks — skipped merged JSON export.",
    );
    return;
  }

  const totalRows = merged.length;
  const body = { entities: merged, count: totalRows };
  const jsonText = JSON.stringify(body, null, 2);
  const filename = `crunchbase-scrape-results-${todayKey()}.json`;

  let downloadOk = false;
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

  let uploadOk = false;
  try {
    const fd = new FormData();
    fd.append("date", dateKey);
    fd.append(
      "file",
      new Blob([jsonText], { type: "application/json" }),
      filename,
    );
    const res = await fetch(SUPABASE_FN_UPLOAD_JSON, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      await emitLog(
        dateKey,
        "warn",
        `Merged JSON upload failed (${res.status}).${downloadOk ? " Local file was saved." : ""}`,
      );
      return;
    }
    uploadOk = true;
  } catch (e) {
    await emitLog(
      dateKey,
      "warn",
      `Merged JSON upload failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  const parts: string[] = [];
  if (downloadOk) parts.push("download");
  if (uploadOk) parts.push("cloud");
  await emitLog(
    dateKey,
    "info",
    `Merged ${totalRows} row${totalRows === 1 ? "" : "s"} from saved pages → ${filename}${parts.length > 0 ? ` (${parts.join(" + ")})` : ""}.`,
  );

  await chrome.runtime
    .sendMessage({
      type: "scrape/jsonArtifactsUpdated",
      dateKey,
    } satisfies ExtensionMessage)
    .catch(() => {});
}
