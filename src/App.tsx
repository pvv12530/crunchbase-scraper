import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Play, Upload } from "lucide-react";
import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from "@shared/constants";
import type { ExtensionMessage } from "@shared/messages";
import type { ScrapeQueueState } from "@shared/models";
import { triggerDownload } from "./export/download";
import { Calendar } from "./components/Calendar";
import { DelaySettingsPanel } from "./components/DelaySettingsPanel";
import { JsonFilesList } from "./components/JsonFilesList";
import {
  SUPABASE_JSON_PUBLIC_BASE,
  fetchSupabaseJsonFilesByDate,
  type SupabaseJsonFile,
} from "./services/supabaseJsonFiles";

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
  /** Supabase `file_date` bucket(s) last queried (for refresh after delete). */
  const [remoteJsonQueryKeys, setRemoteJsonQueryKeys] = useState<string[]>([]);
  const [remoteCloudBucketsLabel, setRemoteCloudBucketsLabel] =
    useState<string>(() => localDateKey());

  const refreshRemoteJsonFilesForKeys = useCallback(
    async (dateKeysIn: string[]) => {
      const uniq = [...new Set(dateKeysIn)].filter(isDateKey);
      if (uniq.length === 0) {
        setRemoteJsonFiles([]);
        setRemoteJsonQueryKeys([]);
        setRemoteCloudBucketsLabel("");
        setRemoteJsonError("");
        setRemoteJsonLoading(false);
        return;
      }
      setRemoteJsonLoading(true);
      setRemoteJsonError("");
      try {
        const parts = await Promise.all(
          uniq.map((k) => fetchSupabaseJsonFilesByDate(k)),
        );
        const seen = new Set<string>();
        const merged: SupabaseJsonFile[] = [];
        for (const files of parts) {
          for (const f of files) {
            if (seen.has(f.id)) continue;
            seen.add(f.id);
            merged.push(f);
          }
        }
        merged.sort((a, b) => a.file_path.localeCompare(b.file_path));
        setRemoteJsonFiles(merged);
        setRemoteJsonQueryKeys(uniq);
        setRemoteCloudBucketsLabel(
          uniq.length > 1 ? uniq.join(" · ") : (uniq[0] ?? ""),
        );
      } catch (e) {
        setRemoteJsonFiles([]);
        setRemoteJsonError(e instanceof Error ? e.message : String(e));
      } finally {
        setRemoteJsonLoading(false);
      }
    },
    [],
  );

  const logListRef = useRef<HTMLUListElement>(null);
  const logStickToEndRef = useRef(true);
  const [logScrollMoreVisible, setLogScrollMoreVisible] = useState(false);

  const updateLogScrollUi = useCallback((el: HTMLUListElement) => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    logStickToEndRef.current = atBottom;
    const canScroll = el.scrollHeight > el.clientHeight + 2;
    setLogScrollMoreVisible(canScroll && !atBottom);
  }, []);

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

  const deleteRemoteJsonFile = useCallback(
    async (id: string) => {
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
        await refreshRemoteJsonFilesForKeys(
          remoteJsonQueryKeys.length > 0 ? remoteJsonQueryKeys : [todayDateKey],
        );
      } finally {
        setRemoteJsonDeletingById((prev) => ({ ...prev, [id]: false }));
      }
    },
    [refreshRemoteJsonFilesForKeys, remoteJsonQueryKeys, todayDateKey],
  );

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
          const next = [...cur, { at: msg.at, level: msg.level, text }].slice(
            -LOGS_MAX_PER_DATE,
          );
          return { ...prev, [bucket]: next };
        });
      }
      if (msg.type === "scrape/jsonArtifactsUpdated") {
        const keys = Array.isArray(msg.dateKeys)
          ? msg.dateKeys.filter((k): k is string => isDateKey(k))
          : [];
        if (keys.length > 0) void refreshRemoteJsonFilesForKeys(keys);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [loadQueueState, refreshRemoteJsonFilesForKeys]);

  useEffect(() => {
    void refreshRemoteJsonFilesForKeys([todayDateKey]);
  }, [todayDateKey, refreshRemoteJsonFilesForKeys]);

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

  const onStopScrape = useCallback(async () => {
    const logBucket = localDateKey();
    setLogsByDate((prev) => {
      const cur = prev[logBucket] ?? [];
      const next = [
        ...cur,
        {
          at: new Date().toISOString(),
          level: "warn" as const,
          text: "Clicked stop — requesting abort…",
        },
      ].slice(-LOGS_MAX_PER_DATE);
      return { ...prev, [logBucket]: next };
    });
    // Optimistically clear "running" UI immediately.
    setQueueState((prev) =>
      prev
        ? {
            ...prev,
            activeDateKey: null,
          }
        : prev,
    );
    await chrome.runtime.sendMessage({
      type: "scrape/stop",
    } satisfies ExtensionMessage);
    void loadQueueState();
  }, [loadQueueState]);

  const onClearSelectedQueued = useCallback(async () => {
    if (!isDateKey(selectedDateKey)) return;
    const logBucket = localDateKey();
    setLogsByDate((prev) => {
      const cur = prev[logBucket] ?? [];
      const next = [
        ...cur,
        {
          at: new Date().toISOString(),
          level: "info" as const,
          text: `Cleared queued date ${selectedDateKey}`,
        },
      ].slice(-LOGS_MAX_PER_DATE);
      return { ...prev, [logBucket]: next };
    });
    // Optimistically remove from pending so UI updates instantly.
    setQueueState((prev) =>
      prev
        ? {
            ...prev,
            pending: (prev.pending ?? []).filter((k) => k !== selectedDateKey),
          }
        : prev,
    );
    await chrome.runtime.sendMessage({
      type: "scrape/queueRemove",
      dateKey: selectedDateKey,
    } satisfies ExtensionMessage);
    void loadQueueState();
  }, [loadQueueState, selectedDateKey]);

  const onClearLogHistory = () => {
    if (!isDateKey(todayDateKey)) return;
    setLogsByDate((prev) => {
      const next = { ...prev };
      delete next[todayDateKey];
      return next;
    });
  };

  const applyCsvText = useCallback(async (text: string) => {
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
      setCsvHint(
        `Imported ${dates.length} date${dates.length === 1 ? "" : "s"} from CSV (not queued — click Scrape to run).`,
      );
    } else {
      setCsvHint("No dates found in CSV.");
    }
    setSelectedDateKeys(dates);
    setModeTab("csv");
  }, []);

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
  const anyRunning = queueState?.activeDateKey != null;

  const todayLogs = logsByDate[todayDateKey] ?? [];
  const lastLogTail =
    todayLogs.length > 0
      ? `${todayLogs[todayLogs.length - 1]!.at}\0${todayLogs[todayLogs.length - 1]!.text}`
      : "";

  useEffect(() => {
    logStickToEndRef.current = true;
  }, [todayDateKey]);

  useEffect(() => {
    if (todayLogs.length === 0) logStickToEndRef.current = true;
  }, [todayLogs.length]);

  useEffect(() => {
    const el = logListRef.current;
    if (!el || todayLogs.length === 0) {
      setLogScrollMoreVisible(false);
      return;
    }
    const pinIfStuck = (): void => {
      if (logStickToEndRef.current) {
        el.scrollTop = el.scrollHeight;
      }
      updateLogScrollUi(el);
    };
    const raf = requestAnimationFrame(pinIfStuck);
    const ro = new ResizeObserver(pinIfStuck);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [todayLogs.length, lastLogTail, todayDateKey, updateLogScrollUi]);

  return (
    <div className="flex min-h-screen flex-col bg-[#0f1115] p-3 text-[13px] font-sans leading-snug text-[#e8eaef] antialiased">
      <section className="mb-3">
        <span
          className={[
            "block rounded-lg border border-[#2a3140] bg-[#161a22] px-2.5 py-2 text-xs",
            "text-[#8bd49a]",
          ].join(" ")}
        >
          Scrape opens a new Crunchbase Discover tab per date and runs there.
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

      <DelaySettingsPanel btnBaseClassName={btnBase} />

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
            {importedDateOrder.length > 0 ? (
              <div className="mt-3">
                <h3 className="mb-1.5 text-xs font-medium text-[#9aa3b2]">
                  Dates in file ({importedDateOrder.length})
                </h3>
                <ul className="m-0 max-h-[min(200px,32vh)] list-none space-y-1 overflow-y-auto rounded-md border border-[#2a3140]/70 bg-[#12151c]/60 p-2 font-mono text-[11px] text-[#b8c0cc]">
                  {importedDateOrder.map((dk) => (
                    <li key={dk}>
                      <button
                        type="button"
                        className={[
                          "w-full rounded px-1.5 py-0.5 text-left transition-colors",
                          dk === selectedDateKey
                            ? "bg-[#4c8bf5]/20 text-[#e8eaef]"
                            : "text-[#b8c0cc] hover:bg-[#2a3140]/80 hover:text-[#e8eaef]",
                        ].join(" ")}
                        onClick={() => setSelectedDateKey(dk)}
                      >
                        {dk}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 mb-0 text-[10px] text-[#5c6570]">
                  Highlight matches &quot;Actions for&quot; selection. Scrape
                  uses all listed dates in order.
                </p>
              </div>
            ) : null}
          </section>
        </>
      )}

      <section id="detailPanel" className="flex min-h-0 flex-1 flex-col">
        <h2 id="detailTitle" className="mb-2 text-sm font-medium">
          Actions for {selectedDateKey || "—"}
        </h2>
        <div className="mb-2 flex flex-wrap gap-2">
          {anyRunning ? (
            <section className="mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[12px] text-[#9aa3b2]">
                  <Loader2
                    className="h-4 w-4 animate-spin text-[#4c8bf5]"
                    strokeWidth={2}
                    aria-hidden
                  />
                  <span>
                    Running{" "}
                    <span className="font-mono text-[#e8eaef]">
                      {queueState?.activeDateKey ?? "—"}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  className={[
                    "rounded-lg border px-3 py-2 text-xs font-semibold cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed",
                    "border-[#f0a96e]/35 bg-[#2a1f16] text-[#f0a96e] hover:bg-[#332419]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f0a96e]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f1115]",
                  ].join(" ")}
                  onClick={() => void onStopScrape()}
                >
                  Stop
                </button>
              </div>
              <p className="mt-2 mb-0 text-[11px] text-[#5c6570]">
                Stop will abort the active tab scrape immediately.
              </p>
            </section>
          ) : selectedQueued ? (
            <button
              type="button"
              className={[
                "rounded-lg border px-3 py-2 text-xs font-semibold cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed",
                "border-[#6ea8ff]/25 bg-[#12151c] text-[#cfe0ff] hover:bg-[#161a22]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4c8bf5] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f1115]",
              ].join(" ")}
              onClick={() => void onClearSelectedQueued()}
            >
              Clear queued
            </button>
          ) : (
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
              disabled={scrapeDisabled || anyRunning || selectedScrapeBusy}
              onClick={() => void onScrape()}
            >
              <Play
                className="relative h-[18px] w-[18px] shrink-0 text-white drop-shadow-sm"
                size={18}
                strokeWidth={2}
                aria-hidden
              />
              <span className="relative">
                {selectedQueued ? "Queued…" : "Scrape this date"}
              </span>
            </button>
          )}
        </div>

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
              here;
            </p>
          ) : (
            <div className="relative">
              <ul
                ref={logListRef}
                onScroll={(e) => updateLogScrollUi(e.currentTarget)}
                className="m-0 max-h-[min(200px,35vh)] list-none space-y-1 overflow-y-auto overscroll-y-contain rounded-md border border-[#2a3140]/50 bg-[#12151c]/40 p-2 pr-1 font-mono text-[11px] leading-relaxed"
              >
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
              {logScrollMoreVisible ? (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center justify-end pb-1.5 text-[#6b7484]"
                  aria-hidden
                >
                  <div className="absolute inset-x-0 bottom-0 h-11 bg-linear-to-t from-[#161a22] via-[#161a22]/88 to-transparent" />
                  <span className="relative z-1 flex items-center gap-0.5 text-[10px] font-medium tracking-wide">
                    <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2} />
                    More below
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <p className="mb-2 text-[11px] text-[#9aa3b2]">
          {!hasValidSelectedDate
            ? "Choose a date on the Calendar tab or select a row from your CSV list."
            : "A new Discover tab is opened per date; the scraper configures table view and date range automatically."}
        </p>

        <JsonFilesList
          bucketsLabel={remoteCloudBucketsLabel}
          files={remoteJsonFiles}
          loading={remoteJsonLoading}
          error={remoteJsonError}
          downloadingById={remoteJsonDownloadingById}
          deletingById={remoteJsonDeletingById}
          onDownload={downloadRemoteJsonFile}
          onDelete={deleteRemoteJsonFile}
        />
      </section>
    </div>
  );
}
