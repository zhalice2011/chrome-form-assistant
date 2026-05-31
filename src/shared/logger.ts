// 统一 logger：三端共用同一套 API。
//
// 调用方无感知是否经过消息转发，例如：
//   const log = createLogger('sidepanel', 'ui');
//   log.info('click.extract', { tabId });
//
// 实现策略：
//   - background 端：直接调用 logStore.append（运行时注入，避免循环依赖）
//   - 其他端：批量缓冲 → chrome.runtime.sendMessage(LOG_APPEND)
//   - 200ms 内同 event + 同 data 自动去重（防 React StrictMode 双调）
//   - 消息发送失败时降级到 console（永远不让日志阻塞业务）

import type {
  LogAppendMessage,
  LogEntry,
  LogLevel,
  LogSource,
} from './log-types';

// ---------- 全局状态 ----------

/**
 * 单调序号。每端独立递增，配合 ts 在 UI 端做稳定排序。
 * 跨端的整体顺序由 background 接收顺序保证。
 */
let nextSeq = 1;

/** 当前 session id；background 端会被 log-store 覆盖为 SW 启动 id */
let currentSessionId = generateSessionId();

/** 同 event + 同 data hash 在 200ms 内的去重表 */
const DEDUP_WINDOW_MS = 200;
const dedupCache = new Map<string, number>();

// ---------- 公开 API ----------

export interface Logger {
  debug(event: string, data?: unknown, opts?: LogOpts): void;
  info(event: string, data?: unknown, opts?: LogOpts): void;
  warn(event: string, data?: unknown, opts?: LogOpts): void;
  error(event: string, data?: unknown, opts?: LogOpts): void;
}

interface LogOpts {
  message?: string;
  durationMs?: number;
  pageUrl?: string;
}

/** 创建一个绑定了 source/module 的 logger */
export function createLogger(source: LogSource, module: string): Logger {
  return {
    debug: (event, data, opts) =>
      emit({ source, module, level: 'debug', event, data, opts }),
    info: (event, data, opts) =>
      emit({ source, module, level: 'info', event, data, opts }),
    warn: (event, data, opts) =>
      emit({ source, module, level: 'warn', event, data, opts }),
    error: (event, data, opts) =>
      emit({ source, module, level: 'error', event, data, opts }),
  };
}

/** background 端在 SW 启动后调用，让序列号与 sessionId 与 store 一致 */
export function setSessionId(id: string): void {
  currentSessionId = id;
}

export function getSessionId(): string {
  return currentSessionId;
}

// ---------- 直接投递通道：背景端注入（避免循环依赖） ----------

type DirectSink = (entries: LogEntry[]) => void;
let directSink: DirectSink | null = null;

/**
 * 仅 background 端调用：注入直接落到 store 的 sink，跳过消息转发。
 * 这让 background 自身的日志不绕一圈消息。
 */
export function installDirectSink(sink: DirectSink): void {
  directSink = sink;
}

// ---------- 实现 ----------

interface EmitArgs {
  source: LogSource;
  module: string;
  level: LogLevel;
  event: string;
  data?: unknown;
  opts?: LogOpts;
}

function emit(args: EmitArgs): void {
  // 去重：200ms 内同 event + 同 data 的简单 hash 直接丢弃
  const dedupKey = `${args.module}:${args.event}:${stableStringify(args.data)}`;
  const now = Date.now();
  const last = dedupCache.get(dedupKey);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    return;
  }
  dedupCache.set(dedupKey, now);
  // 周期性清理：cache 超过 200 条时清掉过期项
  if (dedupCache.size > 200) {
    for (const [k, t] of dedupCache) {
      if (now - t > DEDUP_WINDOW_MS) dedupCache.delete(k);
    }
  }

  const entry: LogEntry = {
    seq: nextSeq++,
    ts: now,
    sessionId: currentSessionId,
    level: args.level,
    source: args.source,
    module: args.module,
    event: args.event,
    message: args.opts?.message,
    data: truncateData(args.data),
    durationMs: args.opts?.durationMs,
    pageUrl: args.opts?.pageUrl,
  };

  // 同步投递到 background：
  // 1) 如果是 background 自己（installDirectSink 已注入），直接走 sink
  // 2) 否则走 chrome.runtime.sendMessage（content/sidepanel/options/logs）
  if (directSink) {
    directSink([entry]);
  } else {
    sendToBackground(entry);
  }

  // 开发期同时打到 console，方便看
  if (typeof console !== 'undefined') {
    const fn =
      args.level === 'error'
        ? console.error
        : args.level === 'warn'
          ? console.warn
          : console.log;
    fn.call(
      console,
      `[${args.source}/${args.module}] ${args.event}`,
      args.data ?? '',
    );
  }
}

// ---------- 跨端发送 ----------

/**
 * 异步发送到 background。失败时不抛错，只在 console 提示——
 * 避免日志系统本身的故障影响业务。
 *
 * 不做批量：调用频率低（人触发为主），简单优先。后续如有高频埋点再加 batch。
 */
function sendToBackground(entry: LogEntry): void {
  try {
    const msg: LogAppendMessage = { type: 'LOG_APPEND', entries: [entry] };
    // chrome.runtime.sendMessage 在没有 listener 或 SW 死亡时 reject，
    // 我们 catch 掉避免 unhandled promise。
    void chrome.runtime.sendMessage(msg).catch((err) => {
      // SW 还没起来或者扩展上下文已失效——尽量留个 console 痕迹
      if (typeof console !== 'undefined') {
        console.warn('[logger] sendToBackground failed:', err?.message ?? err);
      }
    });
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[logger] sendToBackground threw:', err);
    }
  }
}

// ---------- 工具 ----------

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 兜底：极端老环境
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_DATA_BYTES = 64 * 1024; // 64KB 单条上限

function truncateData(data: unknown): unknown {
  if (data == null) return data;
  // 估算大小：用 stringify 长度近似（unicode 是 byte 上限的高估，足够安全）
  try {
    const s = JSON.stringify(data);
    if (s.length <= MAX_DATA_BYTES) return data;
    return {
      __truncated: true,
      __originalBytes: s.length,
      preview: `${s.slice(0, MAX_DATA_BYTES)}...`,
    };
  } catch {
    // 含循环引用等无法 stringify 的，给一个标记
    return { __unstringifiable: true, typeOf: typeof data };
  }
}

/** 稳定 stringify，仅用于去重 hash。失败时退回 String() */
function stableStringify(data: unknown): string {
  if (data == null) return '';
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
