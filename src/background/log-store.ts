// 日志存储中心：service worker 持有的 ring buffer + pending 队列。
//
// 阶段 5-2 实现 ring buffer 和查询；阶段 5-3 会把 flushPending 接到 FSA。
// 当前 flushPending 是占位（NDJSON 拼好后 console.debug，便于验证管道）。

import type { LogEntry, LogQueryMessage } from '../shared/log-types';

const RING_CAPACITY = 1000;
const FLUSH_DEBOUNCE_MS = 1000;
const FLUSH_BATCH_SIZE = 50;

// ---------- ring buffer ----------

const ring: LogEntry[] = [];

/** 待落盘队列（5-3 接 FSA 时用） */
const pending: LogEntry[] = [];

let flushTimer: number | undefined;

/** 5-3 会替换为真正的 FSA 写入函数 */
let flushImpl: ((entries: LogEntry[]) => Promise<void>) | null = null;

export function installFlushImpl(
  impl: (entries: LogEntry[]) => Promise<void>,
): void {
  flushImpl = impl;
}

// ---------- session id ----------

let sessionId: string = generateSessionId();

export function getStoreSessionId(): string {
  return sessionId;
}

// ---------- 写入 ----------

export function appendEntries(entries: LogEntry[]): void {
  if (entries.length === 0) return;

  // 强制对齐 sessionId：即便从其他端发来时 sessionId 不一致，
  // 都改成 background 的，便于全局检索（每端独立 sessionId 反而难查）。
  for (const e of entries) {
    e.sessionId = sessionId;
    ring.push(e);
    pending.push(e);
  }

  // ring 溢出：丢最旧的
  while (ring.length > RING_CAPACITY) {
    ring.shift();
  }

  // 攒满 batch 立即 flush，否则防抖
  if (pending.length >= FLUSH_BATCH_SIZE) {
    void doFlush();
  } else {
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void doFlush();
  }, FLUSH_DEBOUNCE_MS) as unknown as number;
}

async function doFlush(): Promise<void> {
  if (pending.length === 0) return;
  // swap 出去再写，避免写入过程又有新日志
  const batch = pending.splice(0, pending.length);

  if (!flushImpl) {
    // 5-1/5-2 阶段没接 FSA；先放回 pending（等 5-3 装上 sink 再写出）
    // 但避免无限增长：超过 ring 容量就主动丢弃，与 ring 行为对齐
    if (pending.length + batch.length > RING_CAPACITY * 2) {
      console.warn(
        '[log-store] no flush sink; dropping',
        batch.length,
        'entries',
      );
      return;
    }
    pending.unshift(...batch);
    return;
  }

  try {
    await flushImpl(batch);
  } catch (err) {
    // FSA 失败：把 batch 退回 pending（最多保留 RING_CAPACITY 条），等下次重试
    console.warn('[log-store] flush failed:', err);
    pending.unshift(...batch.slice(-RING_CAPACITY));
  }
}

/** 提供给 alarm/外部触发的强制 flush */
export function forceFlush(): Promise<void> {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  return doFlush();
}

// ---------- 查询 ----------

export function queryEntries(
  filter: LogQueryMessage['filter'],
  limit: number = 1000,
): { entries: LogEntry[]; total: number } {
  let result = ring;
  if (filter) {
    const { levels, sources, modules, sessionId: sid, keyword, sinceTs, untilTs } = filter;
    result = ring.filter((e) => {
      if (levels && !levels.includes(e.level)) return false;
      if (sources && !sources.includes(e.source)) return false;
      if (modules && !modules.includes(e.module)) return false;
      if (sid && e.sessionId !== sid) return false;
      if (sinceTs !== undefined && e.ts < sinceTs) return false;
      if (untilTs !== undefined && e.ts > untilTs) return false;
      if (keyword) {
        const k = keyword.toLowerCase();
        const hay =
          `${e.module} ${e.event} ${e.message ?? ''} ${stringify(e.data)}`.toLowerCase();
        if (!hay.includes(k)) return false;
      }
      return true;
    });
  }
  // 取最新的 limit 条
  const slice = result.length > limit ? result.slice(-limit) : result;
  return { entries: slice.slice(), total: ring.length };
}

export function clearEntries(): number {
  const n = ring.length;
  ring.length = 0;
  pending.length = 0;
  return n;
}

// ---------- 工具 ----------

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stringify(d: unknown): string {
  if (d == null) return '';
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}
