import type { SourceId } from '@shared/constants';
import type { DateRunMeta } from '@shared/models';

const RUNS_KEY = 'dateRunsMeta';

function runsKey(): string {
  return RUNS_KEY;
}

export async function loadAllRuns(): Promise<DateRunMeta[]> {
  const data = await chrome.storage.local.get(runsKey());
  const raw = data[runsKey()] as Record<string, DateRunMeta> | undefined;
  if (!raw) return [];
  return Object.values(raw).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

export async function getRun(dateKey: string): Promise<DateRunMeta | undefined> {
  const data = await chrome.storage.local.get(runsKey());
  const raw = data[runsKey()] as Record<string, DateRunMeta> | undefined;
  return raw?.[dateKey];
}

export async function upsertRun(meta: DateRunMeta): Promise<void> {
  const data = await chrome.storage.local.get(runsKey());
  const raw = (data[runsKey()] as Record<string, DateRunMeta>) ?? {};
  raw[meta.dateKey] = meta;
  await chrome.storage.local.set({ [runsKey()]: raw });
}

export async function ensureRun(dateKey: string, sourceId: SourceId): Promise<DateRunMeta> {
  const existing = await getRun(dateKey);
  if (existing) return existing;
  const now = new Date().toISOString();
  const meta: DateRunMeta = {
    dateKey,
    sourceId,
    status: 'idle',
    rowCount: 0,
    chunks: [],
    updatedAt: now,
  };
  await upsertRun(meta);
  return meta;
}

export async function clearRunChunks(
  dateKey: string,
  sourceId: SourceId,
  opts?: { groupId?: string },
): Promise<DateRunMeta> {
  const meta = await ensureRun(dateKey, sourceId);
  const cleared: DateRunMeta = {
    ...meta,
    chunks: [],
    rowCount: 0,
    status: 'running',
    groupId: opts?.groupId ?? meta.groupId,
    errorMessage: undefined,
    updatedAt: new Date().toISOString(),
  };
  await upsertRun(cleared);
  return cleared;
}
