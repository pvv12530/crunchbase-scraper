import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Play,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from "@shared/constants";
import type { ExtensionMessage } from "@shared/messages";
import type { DateRunMeta, ScrapeQueueState } from "@shared/models";
import { triggerDownload } from "./export/download";

const SUPABASE_JSON_PUBLIC_BASE =
  "https://gfxknuxbtkhomfodrrfr.supabase.co/storage/v1/object/public/json-files/";

function todayKey(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function isDateKey(x: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(x);
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateKeyFromParts(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function parseDateKeyParts(
  key: string,
): { y: number; m: number; d: number } | null {
  if (!isDateKey(key)) return null;
  const [ys, ms, ds] = key.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
    return null;
  return { y, m, d };
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

/** First weekday 0=Sun for the first day of month (month 1–12). */
function firstWeekdayOfMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12 - 1, 1).getDay();
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

/** Browser download of the current-results snapshot (runs in parallel with UI updates). */
function downloadScrapeResultsJsonFile(payload: {
  runKey: string;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
}): void {
  const body = {
    entities: payload.rows,
    count: payload.totalRows,
  };
  const blob = new Blob([JSON.stringify(body, null, 2)], {
    type: "application/json",
  });
  triggerDownload(blob, `crunchbase-scrape-results-${payload.runKey}.json`);
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

async function uploadJsonToSupabase(payload: {
  date: string;
  filename: string;
  jsonText: string;
}): Promise<void> {
  const res = (await chrome.runtime.sendMessage({
    type: "supabase/uploadJson",
    date: payload.date,
    filename: payload.filename,
    jsonText: payload.jsonText,
  } satisfies ExtensionMessage)) as { ok: true } | { ok: false; error: string };
  if (!res || typeof res !== "object" || res.ok !== true) {
    throw new Error(
      res && typeof res === "object" && "error" in res
        ? String((res as { error: unknown }).error)
        : "uploadJson failed",
    );
  }
}

function labelForRow(
  dateKey: string,
  meta: DateRunMeta | undefined,
  q: ScrapeQueueState | null,
): string {
  if (q?.activeDateKey === dateKey) return "running";
  if (q?.pending.includes(dateKey)) return "queued";
  return meta?.status ?? "idle";
}

export function App(): JSX.Element {
  const [runs, setRuns] = useState<DateRunMeta[]>([]);
  const [selectedDateKey, setSelectedDateKey] = useState<string>("");
  const selectedDateKeyRef = useRef(selectedDateKey);
  selectedDateKeyRef.current = selectedDateKey;
  const [importedDateOrder, setImportedDateOrder] = useState<string[]>([]);
  const [queueState, setQueueState] = useState<ScrapeQueueState | null>(null);
  const [csvHint, setCsvHint] = useState("");
  const [csvDragOver, setCsvDragOver] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvDragDepth = useRef(0);
  const [tabCtx, setTabCtx] = useState<{ ok: boolean; text: string }>({
    ok: false,
    text: "Checking active tab…",
  });
  const [modeTab, setModeTab] = useState<ModeTab>("calendar");
  const [calendarView, setCalendarView] = useState<{ y: number; m: number }>(
    () => {
      const t = new Date();
      return { y: t.getFullYear(), m: t.getMonth() + 1 };
    },
  );
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

  const loadRuns = useCallback(async () => {
    const list = await chrome.runtime.sendMessage({
      type: "runs/list",
    } satisfies ExtensionMessage);
    setRuns(Array.isArray(list) ? (list as DateRunMeta[]) : []);
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

  const runForDate = useCallback(
    (key: string) => runs.find((r) => r.dateKey === key),
    [runs],
  );

  const refreshTabContext = useCallback(async () => {
    const ctx = await chrome.runtime.sendMessage({
      type: "tabContext/get",
    } satisfies ExtensionMessage);
    const isCb = ctx?.isCrunchbaseHost === true;
    setTabCtx({
      ok: isCb,
      text: isCb
        ? "Active tab: Crunchbase — batch scrape can run."
        : "Active tab is not Crunchbase — open crunchbase.com and the Discover page.",
    });
  }, []);

  useEffect(() => {
    void loadRuns();
    void loadQueueState();
    void refreshTabContext();
  }, [loadRuns, loadQueueState, refreshTabContext]);

  useEffect(() => {
    const prev = prevModeTab.current;
    prevModeTab.current = modeTab;
    if (modeTab !== "calendar" || prev === "calendar") return;
    const p = parseDateKeyParts(selectedDateKey);
    if (p) setCalendarView({ y: p.y, m: p.m });
  }, [modeTab, selectedDateKey]);

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

  const runScrapeResults = useCallback(
    async (opts?: { runKey?: string }) => {
      const runKey =
        opts?.runKey && isDateKey(opts.runKey)
          ? opts.runKey
          : isDateKey(selectedDateKey)
            ? selectedDateKey
            : todayKey();
      const downloadKey = todayKey();
      if (!isDateKey(selectedDateKey)) setSelectedDateKey(runKey);
      const startLog = 'Clicked "Scrape results"';
      setLogsByDate((prev) => {
        const cur = prev[runKey] ?? [];
        const next = [
          ...cur,
          {
            at: new Date().toISOString(),
            level: "info" as const,
            text: startLog,
          },
        ].slice(-LOGS_MAX_PER_DATE);
        return { ...prev, [runKey]: next };
      });
      const res = (await chrome.runtime.sendMessage({
        type: "scrape/resultsStart",
        runKey,
      } satisfies ExtensionMessage)) as {
        ok?: boolean;
        error?: string;
        totalRows?: number;
        columns?: string[];
        rows?: Record<string, unknown>[];
      };
      if (res && typeof res === "object" && res.ok === false && res.error) {
        setLogsByDate((prev) => {
          const cur = prev[runKey] ?? [];
          const next = [
            ...cur,
            {
              at: new Date().toISOString(),
              level: "error" as const,
              text: res.error ?? "Scrape results failed",
            },
          ].slice(-LOGS_MAX_PER_DATE);
          return { ...prev, [runKey]: next };
        });
        return;
      }
      const columns = Array.isArray(res?.columns) ? res.columns : [];
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      const totalRows =
        typeof res?.totalRows === "number" ? res.totalRows : rows.length;
      const snapshot = { runKey, columns, rows, totalRows };
      void queueMicrotask(() =>
        downloadScrapeResultsJsonFile({ ...snapshot, runKey: downloadKey }),
      );
      void queueMicrotask(async () => {
        try {
          const body = { entities: rows, count: totalRows };
          const jsonText = JSON.stringify(body, null, 2);
          const filename = `crunchbase-scrape-results-${downloadKey}.json`;
          await uploadJsonToSupabase({
            date: runKey,
            filename,
            jsonText,
          });
          const files = await fetchJsonFilesByDate(runKey);
          setRemoteJsonFiles(files);
        } catch (e) {
          setLogsByDate((prev) => {
            const cur = prev[runKey] ?? [];
            const next = [
              ...cur,
              {
                at: new Date().toISOString(),
                level: "warn" as const,
                text: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
              },
            ].slice(-LOGS_MAX_PER_DATE);
            return { ...prev, [runKey]: next };
          });
        }
      });
      setLogsByDate((prev) => {
        const cur = prev[runKey] ?? [];
        const next = [
          ...cur,
          {
            at: new Date().toISOString(),
            level: "info" as const,
            text: `Saved JSON download: crunchbase-scrape-results-${downloadKey}.json`,
          },
        ].slice(-LOGS_MAX_PER_DATE);
        return { ...prev, [runKey]: next };
      });
    },
    [selectedDateKey],
  );

  useEffect(() => {
    const onMsg = (msg: ExtensionMessage) => {
      if (msg.type === "tabContext/changed") {
        void refreshTabContext();
      }
      if (
        msg.type === "scrape/progress" ||
        msg.type === "scrape/complete" ||
        msg.type === "scrape/error" ||
        msg.type === "scrape/queueChanged"
      ) {
        void loadRuns();
        void loadQueueState();
      }
      if (msg.type === "scrape/log") {
        setLogsByDate((prev) => {
          const cur = prev[msg.dateKey] ?? [];
          const next = [
            ...cur,
            { at: msg.at, level: msg.level, text: msg.text },
          ].slice(-LOGS_MAX_PER_DATE);
          return { ...prev, [msg.dateKey]: next };
        });
        setSelectedDateKey((cur) => cur || msg.dateKey);
      }
      if (msg.type === "scrape/jsonArtifactsUpdated") {
        const dk = msg.dateKey;
        if (!isDateKey(dk) || dk !== selectedDateKeyRef.current) return;
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
  }, [loadRuns, loadQueueState, refreshTabContext]);

  useEffect(() => {
    if (!isDateKey(selectedDateKey)) {
      setRemoteJsonFiles([]);
      setRemoteJsonError("");
      setRemoteJsonLoading(false);
      return;
    }
    setRemoteJsonLoading(true);
    setRemoteJsonError("");
    void (async () => {
      try {
        const files = await fetchJsonFilesByDate(selectedDateKey);
        setRemoteJsonFiles(files);
      } catch (e) {
        setRemoteJsonFiles([]);
        setRemoteJsonError(e instanceof Error ? e.message : String(e));
      } finally {
        setRemoteJsonLoading(false);
      }
    })();
  }, [selectedDateKey]);

  const onScrape = async () => {
    setLogsByDate((prev) => {
      const cur = prev[selectedDateKey] ?? [];
      const next = [
        ...cur,
        {
          at: new Date().toISOString(),
          level: "info" as const,
          text: "Clicked scrape button",
        },
      ].slice(-LOGS_MAX_PER_DATE);
      return { ...prev, [selectedDateKey]: next };
    });
    await chrome.runtime.sendMessage({
      type: "scrape/retryDate",
      dateKey: selectedDateKey,
      sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
    } satisfies ExtensionMessage);
    void loadQueueState();
  };

  const onScrapeResults = async () => {
    await runScrapeResults();
  };

  const onClearLogHistory = () => {
    if (!isDateKey(selectedDateKey)) return;
    setLogsByDate((prev) => {
      const next = { ...prev };
      delete next[selectedDateKey];
      return next;
    });
  };

  const onRetryRow = async (dateKey: string) => {
    await chrome.runtime.sendMessage({
      type: "scrape/retryDate",
      dateKey,
      sourceId: SOURCE_CRUNCHBASE_DISCOVER_ORGS,
    } satisfies ExtensionMessage);
    void loadQueueState();
  };

  const onStop = async () => {
    await chrome.runtime.sendMessage({
      type: "scrape/stop",
    } satisfies ExtensionMessage);
    void loadQueueState();
  };

  const onClearQueue = async () => {
    await chrome.runtime.sendMessage({
      type: "scrape/queueClear",
    } satisfies ExtensionMessage);
    setImportedDateOrder([]);
    void loadQueueState();
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
      setModeTab("csv");
      void loadRuns();
      void loadQueueState();
    },
    [loadRuns, loadQueueState],
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

  const isCb = tabCtx.ok;
  const hasValidSelectedDate = isDateKey(selectedDateKey);
  const scrapeDisabled = !isCb || !hasValidSelectedDate;
  const hasActiveJob = queueState?.activeDateKey != null;
  const hasPending = (queueState?.pending.length ?? 0) > 0;
  const queueBusy = hasActiveJob || hasPending;
  const selectedQueued = hasValidSelectedDate
    ? (queueState?.pending ?? []).includes(selectedDateKey)
    : false;
  const selectedRunning =
    hasValidSelectedDate && queueState?.activeDateKey === selectedDateKey;
  const selectedScrapeBusy = selectedQueued || selectedRunning;

  /** Prefer local import list so a new upload shows all dates immediately; use persisted batchOrder after reload. */
  const dateRows =
    importedDateOrder.length > 0
      ? importedDateOrder
      : queueState?.batchOrder && queueState.batchOrder.length > 0
        ? queueState.batchOrder
        : [];

  const selectedLogs = logsByDate[selectedDateKey] ?? [];

  const calendarYear = calendarView.y;
  const calendarMonth = calendarView.m;
  const dim = daysInMonth(calendarYear, calendarMonth);
  const lead = firstWeekdayOfMonth(calendarYear, calendarMonth);
  const today = todayKey();
  const calendarCells: ({ day: number } | null)[] = [];
  for (let i = 0; i < lead; i++) calendarCells.push(null);
  for (let d = 1; d <= dim; d++) calendarCells.push({ day: d });
  while (calendarCells.length % 7 !== 0) calendarCells.push(null);
  while (calendarCells.length < 42) calendarCells.push(null);

  const monthTitle = new Date(
    calendarYear,
    calendarMonth - 1,
    1,
  ).toLocaleString(undefined, { month: "long", year: "numeric" });

  const bumpCalendarMonth = (delta: number) => {
    setCalendarView((cur) => {
      let m = cur.m + delta;
      let y = cur.y;
      while (m > 12) {
        m -= 12;
        y += 1;
      }
      while (m < 1) {
        m += 12;
        y -= 1;
      }
      return { y, m };
    });
  };

  return (
    <div className="min-h-screen bg-[#0f1115] p-3 text-[13px] font-sans leading-snug text-[#e8eaef] antialiased">
      <section className="mb-3">
        <span
          className={[
            "block rounded-lg border border-[#2a3140] bg-[#161a22] px-2.5 py-2 text-xs",
            isCb ? "text-[#8bd49a]" : "text-[#f0a96e]",
          ].join(" ")}
        >
          {tabCtx.text}
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
        <section
          className="mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5"
          aria-label="Calendar"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              className={`${btnBase} px-2 py-2`}
              onClick={() => bumpCalendarMonth(-1)}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <h2 className="m-0 min-w-0 flex-1 text-center text-sm font-medium text-[#e8eaef]">
              {monthTitle}
            </h2>
            <button
              type="button"
              className={`${btnBase} px-2 py-2`}
              onClick={() => bumpCalendarMonth(1)}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-medium uppercase tracking-wide text-[#9aa3b2]">
            {WEEKDAY_LABELS.map((w) => (
              <div key={w} className="py-1">
                {w}
              </div>
            ))}
          </div>
          <div className="mt-0.5 grid grid-cols-7 gap-0.5">
            {calendarCells.map((cell, idx) => {
              if (!cell) {
                return (
                  <div
                    key={`pad-${idx}`}
                    className="aspect-square min-h-8"
                  />
                );
              }
              const dk = dateKeyFromParts(
                calendarYear,
                calendarMonth,
                cell.day,
              );
              const isSel = hasValidSelectedDate && selectedDateKey === dk;
              const isTodayCell = today === dk;
              return (
                <button
                  key={dk}
                  type="button"
                  className={[
                    "flex aspect-square min-h-8 items-center justify-center rounded-lg border text-xs font-medium transition-colors",
                    isSel
                      ? "border-[#4c8bf5] bg-[#4c8bf5]/20 text-[#e8eaef]"
                      : "border-transparent bg-[#12151c] text-[#e8eaef] hover:border-[#3a4354] hover:bg-[#1e2430]",
                    isTodayCell && !isSel ? "ring-1 ring-[#6ea8ff]/50" : "",
                  ].join(" ")}
                  onClick={() => {
                    setSelectedDateKey(dk);
                  }}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#2a3140] pt-3">
            <p className="m-0 text-xs text-[#9aa3b2]">
              Selected:{" "}
              <span className="font-medium text-[#e8eaef]">
                {hasValidSelectedDate ? selectedDateKey : "—"}
              </span>
            </p>
            <button
              type="button"
              className={btnBase}
              onClick={() => {
                const t = todayKey();
                setSelectedDateKey(t);
                const p = parseDateKeyParts(t);
                if (p) setCalendarView({ y: p.y, m: p.m });
              }}
              title="Jump to today"
            >
              Today
            </button>
          </div>
        </section>
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

          <section className="mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 text-xs font-medium text-[#9aa3b2]">
                Dates from CSV
              </h2>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={`${btnBase} flex items-center gap-1`}
                  disabled={!hasActiveJob}
                  onClick={() => void onStop()}
                  title="Stop the current date only; remaining dates stay queued"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden />
                  Stop
                </button>
                <button
                  type="button"
                  className={btnBase}
                  disabled={!queueBusy}
                  onClick={() => void onClearQueue()}
                  title="Remove pending dates and stop the active scrape"
                >
                  Clear queue
                </button>
              </div>
            </div>
            {dateRows.length === 0 ? (
              <p className="m-0 rounded-md border border-dashed border-[#2a3140] bg-[#12151c]/80 px-3 py-6 text-center text-[12px] text-[#9aa3b2]">
                Upload a CSV to list dates and their scrape status.
              </p>
            ) : (
              <ul className="m-0 max-h-[min(220px,40vh)] list-none space-y-1 overflow-y-auto p-0">
                {dateRows.map((dk) => {
                  const rowMeta = runForDate(dk);
                  const label = labelForRow(dk, rowMeta, queueState);
                  const sel = selectedDateKey === dk;
                  return (
                    <li
                      key={dk}
                      className={[
                        "flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs",
                        sel
                          ? "border-[#4c8bf5] bg-[#4c8bf5]/10"
                          : "border-[#2a3140] bg-[#12151c]",
                      ].join(" ")}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-[#e8eaef]"
                        onClick={() => setSelectedDateKey(dk)}
                      >
                        {dk}
                        <span className="ml-2 text-[#9aa3b2]">— {label}</span>
                        {rowMeta?.errorMessage ? (
                          <span className="ml-1 text-[#f0a96e]">
                            ({rowMeta.errorMessage.slice(0, 80)}
                            {(rowMeta.errorMessage.length ?? 0) > 80
                              ? "…"
                              : ""}
                            )
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className={`${btnBase} shrink-0 py-1`}
                        disabled={
                          !isCb || label === "running" || label === "queued"
                        }
                        onClick={() => void onRetryRow(dk)}
                      >
                        Retry
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
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
          {!isCb
            ? "Switch to a Crunchbase tab to enable scraping."
            : !hasValidSelectedDate
              ? "Choose a date on the Calendar tab or select a row from your CSV list."
              : "Uses filters already visible on the page; set your date column filter on Crunchbase if needed."}
        </p>

        <div className="mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-xs font-medium text-[#9aa3b2]">
              Log history ({selectedDateKey || "—"})
            </h3>
            <button
              type="button"
              className={btnBase}
              disabled={!hasValidSelectedDate || selectedLogs.length === 0}
              onClick={onClearLogHistory}
            >
              Clear
            </button>
          </div>
          {!hasValidSelectedDate ? (
            <p className="m-0 text-[11px] text-[#9aa3b2]">
              Select a date to view logs for that run.
            </p>
          ) : selectedLogs.length === 0 ? (
            <p className="m-0 text-[11px] text-[#9aa3b2]">
              No log lines yet for this date.
            </p>
          ) : (
            <ul className="m-0 max-h-[min(200px,35vh)] list-none space-y-1 overflow-y-auto p-0 font-mono text-[11px] leading-relaxed">
              {selectedLogs.map((line, i) => {
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
          JSON files for this date (cloud)
        </h3>
        <p className="mb-2 m-0 text-[11px] text-[#9aa3b2]">
          {!hasValidSelectedDate
            ? "Select a date on the calendar or from the CSV list to load files."
            : remoteJsonLoading
              ? "Loading…"
              : remoteJsonError
                ? `Error: ${remoteJsonError}`
                : remoteJsonFiles.length === 0
                  ? "No files found for this date."
                  : `${remoteJsonFiles.length} file${remoteJsonFiles.length === 1 ? "" : "s"} found.`}
        </p>
        {hasValidSelectedDate && !remoteJsonLoading && !remoteJsonError ? (
          remoteJsonFiles.length === 0 ? (
            <div className="mb-3 rounded-lg border border-dashed border-[#2a3140] bg-[#12151c]/80 px-3 py-6 text-center text-[12px] text-[#9aa3b2]">
              No uploaded JSON files for {selectedDateKey}.
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
