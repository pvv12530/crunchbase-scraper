import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Play, Trash2, Upload } from "lucide-react";
import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from "@shared/constants";
import type { ExtensionMessage } from "@shared/messages";
import type { ScrapeQueueState } from "@shared/models";
import { triggerDownload } from "./export/download";
import { Calendar } from "./components/Calendar";

const SUPABASE_JSON_PUBLIC_BASE =
  "https://gfxknuxbtkhomfodrrfr.supabase.co/storage/v1/object/public/json-files/";

function isDateKey(x: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(x);
}

/** Local calendar date as YYYY-MM-DD (for "today" log / upload panels). */
function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type ModeTab = "calendar" | "csv";

const btnBase =
  "rounded-lg border border-[#2a3140] bg-[#1e2430] px-3 py-2 text-xs text-[#e8eaef] cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed";

const LOGS_PERSIST_KEY = "crunchbaseDateBatch.logsByDate.v1";
const LOGS_MAX_DATES = 90;
const LOGS_MAX_PER_DATE = 250;

type LogLine = { at: string; level: "info" | "warn" | "error"; text: string };
type LogsByDate = Record<string, LogLine[]>;

function pruneLogsByDate(input: LogsByDate): LogsByDate {
  const dateKeys = Object.keys(input)
    .filter((k) => isDateKey(k))
    // newest first (YYYY-MM-DD sorts lexicographically)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, LOGS_MAX_DATES);

  const out: LogsByDate = {};
  for (const k of dateKeys) {
    const lines = Array.isArray(input[k]) ? input[k] : [];
    out[k] = lines.slice(-LOGS_MAX_PER_DATE).filter((x) => {
      if (!x || typeof x !== "object") return false;
      const at = (x as { at?: unknown }).at;
      const level = (x as { level?: unknown }).level;
      const text = (x as { text?: unknown }).text;
      return (
        typeof at === "string" &&
        (level === "info" || level === "warn" || level === "error") &&
        typeof text === "string"
      );
    }) as LogLine[];
  }
  return out;
}

async function loadPersistedLogsByDate(): Promise<LogsByDate> {
  try {
    if (chrome?.storage?.local) {
      const res = (await chrome.storage.local.get(LOGS_PERSIST_KEY)) as Record<
        string,
        unknown
      >;
      const raw = res?.[LOGS_PERSIST_KEY];
      if (raw && typeof raw === "object")
        return pruneLogsByDate(raw as LogsByDate);
      if (typeof raw === "string") {
        return pruneLogsByDate(JSON.parse(raw) as LogsByDate);
      }
      return {};
    }
  } catch {
    // ignore and fall back
  }
  try {
    const raw = localStorage.getItem(LOGS_PERSIST_KEY);
    if (!raw) return {};
    return pruneLogsByDate(JSON.parse(raw) as LogsByDate);
  } catch {
    return {};
  }
}

async function savePersistedLogsByDate(next: LogsByDate): Promise<void> {
  const pruned = pruneLogsByDate(next);
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({ [LOGS_PERSIST_KEY]: pruned });
      return;
    }
  } catch {
    // ignore and fall back
  }
  try {
    localStorage.setItem(LOGS_PERSIST_KEY, JSON.stringify(pruned));
  } catch {
    // ignore
  }
}

type SupabaseJsonFile = {
  id: string;
  file_date: string;
  file_path: string;
  created_at: string;
  signed_url?: string | null;
};

async function fetchJsonFilesByDate(date: string): Promise<SupabaseJsonFile[]> {
  const res = (await chrome.runtime.sendMessage({
    type: "supabase/getJsonByDate",
    date,
  } satisfies ExtensionMessage)) as
    | { ok: true; files: SupabaseJsonFile[] }
    | { ok: false; error: string };
  if (!res || typeof res !== "object" || res.ok !== true) {
    throw new Error(
      res && typeof res === "object" && "error" in res
        ? String((res as { error: unknown }).error)
        : "getJsonByDate failed",
    );
  }
  return Array.isArray(res.files) ? res.files : [];
}

export function App(): JSX.Element {
  const [selectedDateKey, setSelectedDateKey] = useState<string>("");
  const [selectedDateKeys, setSelectedDateKeys] = useState<string[]>([]);
  const rangeAnchorRef = useRef<string>("");
  const [todayDateKey, setTodayDateKey] = useState(() => localDateKey());
  const [importedDateOrder, setImportedDateOrder] = useState<string[]>([]);
  const [queueState, setQueueState] = useState<ScrapeQueueState | null>(null);
  const [csvHint, setCsvHint] = useState("");
  const [csvDragOver, setCsvDragOver] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvDragDepth = useRef(0);
  const [modeTab, setModeTab] = useState<ModeTab>("calendar");
  const prevModeTab = useRef<ModeTab>(modeTab);
  /** Last successful "Scrape results" snapshot (all paginated rows, all visible columns). */

  const [logsByDate, setLogsByDate] = useState<LogsByDate>({});
  const logsHydratedOnce = useRef(false);
  const saveLogsTimer = useRef<number | null>(null);
  const [remoteJsonFiles, setRemoteJsonFiles] = useState<SupabaseJsonFile[]>(
    [],
  );
  const [remoteJsonLoading, setRemoteJsonLoading] = useState(false);
  const [remoteJsonError, setRemoteJsonError] = useState<string>("");
  const [remoteJsonDownloadingById, setRemoteJsonDownloadingById] = useState<
    Record<string, boolean>
  >({});
  const [remoteJsonDeletingById, setRemoteJsonDeletingById] = useState<
    Record<string, boolean>
  >({});

  const downloadRemoteJsonFile = useCallback(async (f: SupabaseJsonFile) => {
    const publicUrl = `${SUPABASE_JSON_PUBLIC_BASE}${f.file_path}`;
    const url = (f.signed_url ?? "").trim() || publicUrl;
    const filename = f.file_path.split("/").pop() ?? "download.json";

    setRemoteJsonError("");
    setRemoteJsonDownloadingById((prev) => ({ ...prev, [f.id]: true }));
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        throw new Error(`Download failed (${res.status})`);
      }
      const blob = await res.blob();
      triggerDownload(blob, filename);
    } finally {
      setRemoteJsonDownloadingById((prev) => ({ ...prev, [f.id]: false }));
    }
  }, []);

  const deleteRemoteJsonFile = useCallback(async (id: string) => {
    setRemoteJsonError("");
    setRemoteJsonDeletingById((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(
        "https://gfxknuxbtkhomfodrrfr.supabase.co/functions/v1/delete-json",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Delete failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
        );
      }
      setRemoteJsonFiles((prev) => prev.filter((x) => x.id !== id));
    } finally {
      setRemoteJsonDeletingById((prev) => ({ ...prev, [id]: false }));
    }
  }, []);

  const loadQueueState = useCallback(async () => {
    const q = await chrome.runtime.sendMessage({
      type: "scrape/queueGet",
    } satisfies ExtensionMessage);
    if (q && typeof q === "object" && "pending" in q) {
      setQueueState(q as ScrapeQueueState);
    } else {
      setQueueState(null);
    }
  }, []);

  useEffect(() => {
    void loadQueueState();
  }, [loadQueueState]);

  useEffect(() => {
    const syncToday = () => {
      const k = localDateKey();
      setTodayDateKey((prev) => (prev !== k ? k : prev));
    };
    syncToday();
    const id = window.setInterval(syncToday, 60_000);
    const onVis = () => {
      if (document.visibilityState === "visible") syncToday();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    const prev = prevModeTab.current;
    prevModeTab.current = modeTab;
    if (modeTab !== "calendar" || prev === "calendar") return;
  }, [modeTab, selectedDateKey]);

  useEffect(() => {
    // Keep array selection in sync with single selection (CSV list, logs, etc.).
    if (!isDateKey(selectedDateKey)) return;
    setSelectedDateKeys((prev) =>
      prev.length > 0 && prev.includes(selectedDateKey)
        ? prev
        : [selectedDateKey],
    );
    if (!isDateKey(rangeAnchorRef.current))
      rangeAnchorRef.current = selectedDateKey;
  }, [selectedDateKey]);

  useEffect(() => {
    void (async () => {
      if (logsHydratedOnce.current) return;
      logsHydratedOnce.current = true;
      const restored = await loadPersistedLogsByDate();
      setLogsByDate(restored);
    })();
  }, []);

  useEffect(() => {
    // debounce to avoid writing on every log line
    if (!logsHydratedOnce.current) return;
    if (saveLogsTimer.current != null)
      window.clearTimeout(saveLogsTimer.current);
    saveLogsTimer.current = window.setTimeout(() => {
      void savePersistedLogsByDate(logsByDate);
    }, 250);
    return () => {
      if (saveLogsTimer.current != null) {
        window.clearTimeout(saveLogsTimer.current);
        saveLogsTimer.current = null;
      }
    };
  }, [logsByDate]);

  useEffect(() => {
    const onMsg = (msg: ExtensionMessage) => {
      if (
        msg.type === "scrape/progress" ||
        msg.type === "scrape/complete" ||
        msg.type === "scrape/error" ||
        msg.type === "scrape/queueChanged"
      ) {
        void loadQueueState();
      }
      if (msg.type === "scrape/log") {
        const bucket = localDateKey();
        const text =
          isDateKey(msg.dateKey) && msg.dateKey !== bucket
            ? `[${msg.dateKey}] ${msg.text}`
            : msg.text;
        setLogsByDate((prev) => {
          const cur = prev[bucket] ?? [];
          const next = [
            ...cur,
            { at: msg.at, level: msg.level, text },
          ].slice(-LOGS_MAX_PER_DATE);
          return { ...prev, [bucket]: next };
        });
      }
      if (msg.type === "scrape/jsonArtifactsUpdated") {
        const dk = msg.dateKey;
        if (!isDateKey(dk) || dk !== localDateKey()) return;
        setRemoteJsonLoading(true);
        setRemoteJsonError("");
        void (async () => {
          try {
            const files = await fetchJsonFilesByDate(dk);
            setRemoteJsonFiles(files);
          } catch (e) {
            setRemoteJsonFiles([]);
            setRemoteJsonError(e instanceof Error ? e.message : String(e));
          } finally {
            setRemoteJsonLoading(false);
          }
        })();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [loadQueueState]);

  useEffect(() => {
    if (!isDateKey(todayDateKey)) {
      setRemoteJsonFiles([]);
      setRemoteJsonError("");
      setRemoteJsonLoading(false);
      return;
    }
    setRemoteJsonLoading(true);
    setRemoteJsonError("");
    void (async () => {
      try {
        const files = await fetchJsonFilesByDate(todayDateKey);
        setRemoteJsonFiles(files);
      } catch (e) {
        setRemoteJsonFiles([]);
        setRemoteJsonError(e instanceof Error ? e.message : String(e));
      } finally {
        setRemoteJsonLoading(false);
      }
    })();
  }, [todayDateKey]);

  const onScrape = async () => {
    const dates =
      modeTab === "csv"
        ? importedDateOrder
        : Array.isArray(selectedDateKeys) && selectedDateKeys.length > 0
          ? selectedDateKeys
          : isDateKey(selectedDateKey)
            ? [selectedDateKey]
            : [];
    const runKey = dates[0] ?? selectedDateKey;
    const logBucket = localDateKey();
    const primary = dates[0] ?? runKey;
    const clickText =
      dates.length > 1
        ? `Clicked scrape (${dates.length} dates, first=${String(dates[0] ?? "")})`
        : isDateKey(primary)
          ? `Clicked scrape for ${primary}`
          : "Clicked scrape button";
    setLogsByDate((prev) => {
      const cur = prev[logBucket] ?? [];
      const next = [
        ...cur,
        {
          at: new Date().toISOString(),
          level: "info" as const,
          text: clickText,
        },
      ].slice(-LOGS_MAX_PER_DATE);
      return { ...prev, [logBucket]: next };
    });
    if (modeTab === "csv") {
      const first = dates[0];
      if (first) setSelectedDateKey(first);
      const groupId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await chrome.runtime.sendMessage({
        type: "scrape/start",
        dateKey: first ?? runKey,
        dateKeys: dates,
        groupId,
        sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
      } satisfies ExtensionMessage);
    } else if (dates.length > 1) {
      const groupId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await chrome.runtime.sendMessage({
        type: "scrape/start",
        dateKey: runKey,
        dateKeys: dates,
        groupId,
        sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
      } satisfies ExtensionMessage);
    } else {
      await chrome.runtime.sendMessage({
        type: "scrape/retryDate",
        dateKey: selectedDateKey,
        sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
      } satisfies ExtensionMessage);
    }
    void loadQueueState();
  };

  const onClearLogHistory = () => {
    if (!isDateKey(todayDateKey)) return;
    setLogsByDate((prev) => {
      const next = { ...prev };
      delete next[todayDateKey];
      return next;
    });
  };

  const applyCsvText = useCallback(
    async (text: string) => {
      const res = (await chrome.runtime.sendMessage({
        type: "import/csv",
        text,
      } satisfies ExtensionMessage)) as { dates?: string[]; error?: string };
      if (res.error) {
        setCsvHint(res.error);
        return;
      }
      const dates = res.dates ?? [];
      setImportedDateOrder(dates);
      if (dates.length > 0) {
        const first = dates[0];
        if (first) setSelectedDateKey(first);
      }
      setSelectedDateKeys(dates);
      setModeTab("csv");
      void loadQueueState();
    },
    [loadQueueState],
  );

  const onCsvInputChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await applyCsvText(text);
    ev.target.value = "";
  };

  const onCsvDropZoneDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    csvDragDepth.current = 0;
    setCsvDragOver(false);
    const file = ev.dataTransfer.files?.[0];
    if (!file) return;
    void (async () => {
      const text = await file.text();
      await applyCsvText(text);
    })();
  };

  const hasValidSelectedDate = isDateKey(selectedDateKey);
  const scrapeDisabled = !hasValidSelectedDate;
  const selectedQueued = hasValidSelectedDate
    ? (queueState?.pending ?? []).includes(selectedDateKey)
    : false;
  const selectedRunning =
    hasValidSelectedDate && queueState?.activeDateKey === selectedDateKey;
  const selectedScrapeBusy = selectedQueued || selectedRunning;

  const todayLogs = logsByDate[todayDateKey] ?? [];

  return (
    <div className="min-h-screen bg-[#0f1115] p-3 text-[13px] font-sans leading-snug text-[#e8eaef] antialiased">
      <section className="mb-3">
        <span
          className={[
            "block rounded-lg border border-[#2a3140] bg-[#161a22] px-2.5 py-2 text-xs",
            "text-[#8bd49a]",
          ].join(" ")}
        >
          Scrape runs in the current tab (must be on Crunchbase Discover Companies).
        </span>
      </section>

      <div
        className="mb-3 flex rounded-lg border border-[#2a3140] bg-[#12151c] p-0.5"
        role="tablist"
        aria-label="Date source"
      >
        <button
          type="button"
          role="tab"
          aria-selected={modeTab === "calendar"}
          className={[
            "flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors",
            modeTab === "calendar"
              ? "bg-[#4c8bf5] text-white"
              : "text-[#9aa3b2] hover:text-[#e8eaef]",
          ].join(" ")}
          onClick={() => setModeTab("calendar")}
        >
          Calendar
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={modeTab === "csv"}
          className={[
            "flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors",
            modeTab === "csv"
              ? "bg-[#4c8bf5] text-white"
              : "text-[#9aa3b2] hover:text-[#e8eaef]",
          ].join(" ")}
          onClick={() => setModeTab("csv")}
        >
          CSV
        </button>
      </div>

      {modeTab === "calendar" ? (
        <Calendar
          value={selectedDateKeys}
          onChange={(next) => {
            setSelectedDateKeys(next);
            if (next[0]) setSelectedDateKey(next[next.length - 1] ?? next[0]);
          }}
          onActiveDateKeyChange={(dk) => {
            setSelectedDateKey(dk);
          }}
          btnBaseClassName={btnBase}
        />
      ) : (
        <>
          <section className="mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5">
            <h2 className="mb-2 text-xs font-medium text-[#9aa3b2]">
              Import dates (CSV)
            </h2>
            <div
              role="button"
              tabIndex={0}
              className={[
                "group relative rounded-xl border-2 border-dashed px-3 py-6 text-center transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-[#4c8bf5]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f1115]",
                csvDragOver
                  ? "border-[#4c8bf5] bg-[#4c8bf5]/10"
                  : "border-[#3a4354] bg-[#12151c] hover:border-[#4c8bf5]/50 hover:bg-[#161a22]",
              ].join(" ")}
              onDragEnter={(e) => {
                e.preventDefault();
                csvDragDepth.current += 1;
                setCsvDragOver(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                csvDragDepth.current = Math.max(0, csvDragDepth.current - 1);
                if (csvDragDepth.current === 0) setCsvDragOver(false);
              }}
              onDrop={onCsvDropZoneDrop}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  csvInputRef.current?.click();
                }
              }}
              onClick={() => csvInputRef.current?.click()}
            >
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="Choose CSV file"
                onChange={onCsvInputChange}
              />
              <div className="pointer-events-none mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-[#2a3140] bg-[#1e2430] text-[#9aa3b2] group-hover:text-[#e8eaef]">
                <Upload className="h-5 w-5" strokeWidth={1.75} aria-hidden />
              </div>
              <p className="m-0 text-[13px] font-medium text-[#e8eaef]">
                Drop a CSV here or{" "}
                <span className="text-[#4c8bf5]">browse</span>
              </p>
            </div>
            {csvHint ? (
              <p
                className={`mt-2 mb-0 text-[11px] ${
                  csvHint.startsWith("Imported")
                    ? "text-[#8bd49a]"
                    : "text-[#f0a96e]"
                }`}
              >
                {csvHint}
              </p>
            ) : null}
          </section>
        </>
      )}

      <section id="detailPanel">
        <h2 id="detailTitle" className="mb-2 text-sm font-medium">
          Actions for {selectedDateKey || "—"}
        </h2>
        <div className="mb-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={[
              "group relative flex flex-1 min-w-[140px] items-center justify-center gap-2.5 overflow-hidden rounded-xl px-4 py-3 text-[13px] font-semibold tracking-tight text-white",
              "border border-[#6ea8ff]/25 bg-linear-to-b from-[#5f9aff] via-[#4c8bf5] to-[#3d7ae8]",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_4px_14px_rgba(76,139,245,0.35)]",
              "transition-[transform,box-shadow,filter] duration-150",
              "hover:from-[#6aa6ff] hover:via-[#5b94ff] hover:to-[#4586f0] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_6px_20px_rgba(76,139,245,0.45)]",
              "active:translate-y-px active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.12)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4c8bf5] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f1115]",
              "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none",
            ].join(" ")}
            disabled={scrapeDisabled || selectedScrapeBusy}
            onClick={() => void onScrape()}
          >
            {selectedRunning ? (
              <Loader2
                className="relative h-[18px] w-[18px] shrink-0 animate-spin text-white drop-shadow-sm"
                size={18}
                strokeWidth={2}
                aria-hidden
              />
            ) : (
              <Play
                className="relative h-[18px] w-[18px] shrink-0 text-white drop-shadow-sm"
                size={18}
                strokeWidth={2}
                aria-hidden
              />
            )}
            <span className="relative">
              {selectedRunning
                ? "Scraping…"
                : selectedQueued
                  ? "Queued…"
                  : "Scrape this date"}
            </span>
          </button>
          {/* <button
            type="button"
            className={btnBase}
            disabled={!isCb}
            onClick={() => void onScrapeResults()}
            title="Scrape current filtered results on the Crunchbase tab (no JSON saved)"
          >
            Scrape results
          </button> */}
        </div>
        <p className="mb-2 text-[11px] text-[#9aa3b2]">
          {!hasValidSelectedDate
            ? "Choose a date on the Calendar tab or select a row from your CSV list."
            : "A new Discover tab is opened per date; the scraper configures table view and date range automatically."}
        </p>

        <div className="mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-xs font-medium text-[#9aa3b2]">
              Log history (today — {todayDateKey})
            </h3>
            <button
              type="button"
              className={btnBase}
              disabled={todayLogs.length === 0}
              onClick={onClearLogHistory}
            >
              Clear
            </button>
          </div>
          {todayLogs.length === 0 ? (
            <p className="m-0 text-[11px] text-[#9aa3b2]">
              No log lines yet for today. Scrapes for any selected date append
              here; lines from other dates are prefixed{" "}
              <span className="font-mono text-[#b8c0cc]">[YYYY-MM-DD]</span>.
            </p>
          ) : (
            <ul className="m-0 max-h-[min(200px,35vh)] list-none space-y-1 overflow-y-auto p-0 font-mono text-[11px] leading-relaxed">
              {todayLogs.map((line, i) => {
                const color =
                  line.level === "error"
                    ? "text-[#f0a96e]"
                    : line.level === "warn"
                      ? "text-[#e8c170]"
                      : "text-[#b8c0cc]";
                return (
                  <li
                    key={`${line.at}-${i}`}
                    className={`wrap-break-word border-b border-[#2a3140]/60 pb-1 last:border-b-0 ${color}`}
                  >
                    <span className="text-[#5c6570]">
                      {new Date(line.at).toLocaleTimeString()}{" "}
                    </span>
                    {line.text}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <h3 className="mb-1.5 mt-3 text-xs font-medium text-[#9aa3b2]">
          JSON files for today (cloud — {todayDateKey})
        </h3>
        <p className="mb-1 m-0 text-[11px] text-[#9aa3b2]">
          Cloud files use <span className="font-mono text-[#b8c0cc]">file_date</span>{" "}
          = today ({todayDateKey}). Scrapes for other dates upload under those
          dates, not here.
        </p>
        <p className="mb-2 m-0 text-[11px] text-[#9aa3b2]">
          {remoteJsonLoading
            ? "Loading…"
            : remoteJsonError
              ? `Error: ${remoteJsonError}`
              : remoteJsonFiles.length === 0
                ? "No files for today's date key."
                : `${remoteJsonFiles.length} file${remoteJsonFiles.length === 1 ? "" : "s"} found.`}
        </p>
        {!remoteJsonLoading && !remoteJsonError ? (
          remoteJsonFiles.length === 0 ? (
            <div className="mb-3 rounded-lg border border-dashed border-[#2a3140] bg-[#12151c]/80 px-3 py-6 text-center text-[12px] text-[#9aa3b2]">
              No uploaded JSON files for {todayDateKey}.
            </div>
          ) : (
            <ul className="m-0 mb-3 max-h-[min(220px,40vh)] list-none space-y-1.5 overflow-y-auto p-0 pr-0.5">
              {remoteJsonFiles.map((f) => {
                const downloading = remoteJsonDownloadingById[f.id] === true;
                const deleting = remoteJsonDeletingById[f.id] === true;
                return (
                  <li
                    key={f.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-[#2a3140] bg-[#12151c] px-2.5 py-2 text-xs"
                  >
                    <span className="min-w-0 truncate text-[#e8eaef]">
                      <span className="text-[#5c6570]"> / </span>
                      {f.file_path.split("/").pop() ?? f.file_path}
                      <span className="text-[#9aa3b2]">
                        {" "}
                        — {new Date(f.created_at).toLocaleString()}
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        className={`${btnBase} px-2 py-2`}
                        onClick={() => void downloadRemoteJsonFile(f)}
                        disabled={deleting || downloading}
                        title={`Download\n${f.file_path}`}
                        aria-label={`Download ${f.file_path}`}
                      >
                        <Download className="h-4 w-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={`${btnBase} px-2 py-2`}
                        onClick={() => void deleteRemoteJsonFile(f.id)}
                        disabled={deleting || downloading}
                        title="Delete"
                        aria-label={`Delete ${f.file_path}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </section>
    </div>
  );
}
