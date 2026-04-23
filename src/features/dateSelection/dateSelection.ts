export type DateSourceMode = "calendar" | "csv";

export function isDateKey(x: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(x);
}

export function computeDatesToScrape(args: {
  mode: DateSourceMode;
  importedDateOrder: string[];
  selectedDateKeys: string[];
  selectedDateKey: string;
}): string[] {
  const mode = args.mode;
  if (mode === "csv") {
    return (args.importedDateOrder ?? []).filter(isDateKey);
  }
  const arr =
    Array.isArray(args.selectedDateKeys) && args.selectedDateKeys.length > 0
      ? args.selectedDateKeys
      : isDateKey(args.selectedDateKey)
        ? [args.selectedDateKey]
        : [];
  return arr.filter(isDateKey);
}

