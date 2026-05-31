// 日志系统的纯类型定义。三端共用，不放任何运行逻辑（避免循环依赖）。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSource = 'sidepanel' | 'background' | 'content' | 'options' | 'logs';

/** 一条日志记录。NDJSON 文件每行就是这个结构。 */
export interface LogEntry {
  /** 单调递增的本地序号，用于 UI 稳定排序（同一毫秒内多条） */
  seq: number;
  ts: number; // Date.now()
  sessionId: string; // SW 启动时一个 uuid
  level: LogLevel;
  source: LogSource;
  /** 模块名，例如 'extractor' / 'llm' / 'filler' / 'ui' / 'options' / 'log-store' */
  module: string;
  /** 事件名，点分隔，例如 'extract.done' / 'llm.request' / 'fill.report' */
  event: string;
  /** 人类可读的简短描述（可选） */
  message?: string;
  /** 结构化数据（含 LLM prompt/response 原文等） */
  data?: unknown;
  /** 耗时（ms），如 LLM 调用 */
  durationMs?: number;
  /** 当前页 URL（content/sidepanel 触发时） */
  pageUrl?: string;
}

// ---------- 消息类型（沿用阶段 1-4 的消息体系） ----------

export interface LogAppendMessage {
  type: 'LOG_APPEND';
  /** 一次可能批量投递多条（content 端 batch flush 时） */
  entries: LogEntry[];
}

export interface LogQueryMessage {
  type: 'LOG_QUERY';
  /** 可选过滤；空表示全部 */
  filter?: {
    levels?: LogLevel[];
    sources?: LogSource[];
    modules?: string[];
    sessionId?: string;
    keyword?: string;
    /** ts 范围 */
    sinceTs?: number;
    untilTs?: number;
  };
  /** 最多返回多少条，默认 1000 */
  limit?: number;
}

export interface LogQueryResponse {
  ok: true;
  entries: LogEntry[];
  /** ring buffer 当前总条数（未过滤） */
  total: number;
  /** 当前 sessionId */
  sessionId: string;
}

export interface LogClearMessage {
  type: 'LOG_CLEAR';
}

export interface LogClearResponse {
  ok: true;
  cleared: number;
}

export type AnyLogMessage = LogAppendMessage | LogQueryMessage | LogClearMessage;
