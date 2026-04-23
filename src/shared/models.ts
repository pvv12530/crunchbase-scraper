import type { SourceId } from './constants';

export type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface ChunkRef {
  chunkId: string;
  pageIndex: number;
  rowCount?: number;
  capturedAt: string;
}

/** Metadata for one calendar date run (stored in chrome.storage.local) */
export interface DateRunMeta {
  dateKey: string;
  sourceId: SourceId;
  status: RunStatus;
  rowCount: number;
  /** Shared ID across a multi-date calendar selection. */
  groupId?: string;
  errorMessage?: string;
  chunks: ChunkRef[];
  updatedAt: string;
}

/** Payload stored in IndexedDB per chunk */
export interface ChunkRecord {
  dateKey: string;
  sourceId: SourceId;
  chunkId: string;
  pageIndex: number;
  rowCount?: number;
  capturedAt: string;
  payload: unknown;
}

export interface TabContextPayload {
  activeTabId: number | null;
  activeUrl: string | null;
  isCrunchbaseHost: boolean;
}

/** Background batch queue (persisted in chrome.storage.local). */
export interface ScrapeQueueState {
  pending: string[];
  activeDateKey: string | null;
  /** When non-null and in the future, background is intentionally waiting between dates. */
  cooldownUntilMs?: number | null;
  /** Date that just finished; used for UI while waiting. */
  cooldownFromDateKey?: string | null;
  stagedAfterAbort: string[] | null;
  /** Full CSV order for UI; survives reload while a batch exists. */
  batchOrder: string[] | null;
  /**
   * True when the user started this run with 2+ dates (multi calendar or CSV).
   * Used to skip per-date JSON downloads and only zip at the end (uploads still run).
   */
  multiDateExportSession: boolean;
  /** From panel `scrape/start`; applied when clearing run metadata per queued date. */
  sessionGroupId: string | null;
}
