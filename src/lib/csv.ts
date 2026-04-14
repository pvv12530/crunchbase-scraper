/** Normalize to YYYY-MM-DD */
export function normalizeDateKey(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error('Empty date');
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (iso.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${raw}`);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse CSV text: header `date` or single column of dates */
export function parseCsvDates(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const first = lines[0].toLowerCase();
  const hasHeader = first.includes('date');
  const rows = hasHeader ? lines.slice(1) : lines;

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    const cell = row.split(',')[0]?.replace(/^"|"$/g, '').trim() ?? '';
    if (!cell) continue;
    const k = normalizeDateKey(cell);
    if (seen.has(k)) continue;
    seen.add(k);
    ordered.push(k);
  }
  return ordered;
}
