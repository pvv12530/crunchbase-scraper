import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isDateKey(x: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(x);
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

function todayKey(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

/** First weekday 0=Sun for the first day of month (month 1–12). */
function firstWeekdayOfMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12 - 1, 1).getDay();
}

function dateFromKey(key: string): Date | null {
  const p = parseDateKeyParts(key);
  if (!p) return null;
  // Use UTC midnight to avoid DST issues when adding days.
  return new Date(Date.UTC(p.y, p.m - 1, p.d));
}

function dateKeyFromUtcDate(d: Date): string {
  return dateKeyFromParts(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
  );
}

function buildInclusiveDateRange(aKey: string, bKey: string): string[] {
  const a = dateFromKey(aKey);
  const b = dateFromKey(bKey);
  if (!a || !b) return [aKey];
  const start = a.getTime() <= b.getTime() ? a : b;
  const end = a.getTime() <= b.getTime() ? b : a;
  const out: string[] = [];
  for (
    let cur = new Date(start.getTime());
    cur.getTime() <= end.getTime();
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000)
  ) {
    out.push(dateKeyFromUtcDate(cur));
    if (out.length > 5000) break; // safety
  }
  return out;
}

export type CalendarProps = {
  value: string[];
  onChange: (next: string[]) => void;
  onActiveDateKeyChange?: (dateKey: string) => void;
  className?: string;
  /** Styles shared with the rest of the app. */
  btnBaseClassName: string;
};

export function Calendar(props: CalendarProps): JSX.Element {
  const value = Array.isArray(props.value) ? props.value : [];
  const selected = useMemo(() => new Set(value), [value]);
  const rangeAnchorRef = useRef<string>(value[0] ?? "");

  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const t = new Date();
    return { y: t.getFullYear(), m: t.getMonth() + 1 };
  });

  const calendarYear = view.y;
  const calendarMonth = view.m;
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
    setView((cur) => {
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

  const setSelection = (next: string[], active?: string) => {
    props.onChange(next);
    if (active) props.onActiveDateKeyChange?.(active);
  };

  return (
    <section
      className={
        props.className ??
        "mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5"
      }
      aria-label="Calendar"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          className={`${props.btnBaseClassName} px-2 py-2`}
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
          className={`${props.btnBaseClassName} px-2 py-2`}
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
              <div key={`pad-${idx}`} className="aspect-square min-h-8" />
            );
          }
          const dk = dateKeyFromParts(calendarYear, calendarMonth, cell.day);
          const isSel = selected.has(dk);
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
              onClick={(ev) => {
                const shift = ev.shiftKey;
                const ctrl = ev.ctrlKey || ev.metaKey;

                if (shift && isDateKey(rangeAnchorRef.current)) {
                  const range = buildInclusiveDateRange(
                    rangeAnchorRef.current,
                    dk,
                  );
                  rangeAnchorRef.current = dk;
                  setSelection(range, dk);
                  return;
                }

                if (ctrl) {
                  const s = new Set(value);
                  s.add(dk);
                  rangeAnchorRef.current = dk;
                  setSelection(Array.from(s).sort(), dk);
                  return;
                }

                rangeAnchorRef.current = dk;
                setSelection([dk], dk);
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
            {value.length === 0
              ? "—"
              : value.length === 1
                ? value[0]
                : `${value[0]} … ${value[value.length - 1]} (${value.length})`}
          </span>
        </p>
        <button
          type="button"
          className={props.btnBaseClassName}
          onClick={() => {
            const t = todayKey();
            const p = parseDateKeyParts(t);
            if (p) setView({ y: p.y, m: p.m });
            rangeAnchorRef.current = t;
            setSelection([t], t);
          }}
          title="Jump to today"
        >
          Today
        </button>
      </div>
    </section>
  );
}

