import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LogEntry,
  LogLevel,
  LogQueryMessage,
  LogQueryResponse,
  LogSource,
} from '../shared/log-types';
import { Button, Icon, Input, Select } from '../shared/ui';

const ALL_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const ALL_SOURCES: LogSource[] = [
  'background',
  'sidepanel',
  'content',
  'options',
  'logs',
];

interface FilterState {
  levels: Set<LogLevel>;
  sources: Set<LogSource>;
  module: string;
  keyword: string;
  sessionId: string; // '' 表示全部
}

const DEFAULT_FILTER: FilterState = {
  levels: new Set(ALL_LEVELS),
  sources: new Set(ALL_SOURCES),
  module: '',
  keyword: '',
  sessionId: '',
};

export function LogsApp() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    const msg: LogQueryMessage = {
      type: 'LOG_QUERY',
      filter: {
        levels: filter.levels.size === ALL_LEVELS.length
          ? undefined
          : Array.from(filter.levels),
        sources: filter.sources.size === ALL_SOURCES.length
          ? undefined
          : Array.from(filter.sources),
        modules: filter.module ? [filter.module] : undefined,
        keyword: filter.keyword || undefined,
        sessionId: filter.sessionId || undefined,
      },
      limit: 1000,
    };
    try {
      const reply = (await chrome.runtime.sendMessage(msg)) as LogQueryResponse;
      if (reply?.ok) {
        setEntries(reply.entries);
        setTotal(reply.total);
        setCurrentSessionId(reply.sessionId);
      }
    } catch {
      // SW 暂时不可达——下个周期会自动重试
    }
  }, [filter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!autoRefresh) {
      if (timerRef.current !== undefined) {
        clearInterval(timerRef.current);
        timerRef.current = undefined;
      }
      return;
    }
    timerRef.current = setInterval(() => {
      void reload();
    }, 1500) as unknown as number;
    return () => {
      if (timerRef.current !== undefined) clearInterval(timerRef.current);
    };
  }, [autoRefresh, reload]);

  const sessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.sessionId);
    return Array.from(set);
  }, [entries]);

  const handleExport = () => {
    const blob = new Blob(
      entries.map((e) => JSON.stringify(e) + '\n'),
      { type: 'application/x-ndjson' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `chrome-assistant-logs-${ts}.ndjson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = async () => {
    if (!confirm('清空 Service Worker 内存中的日志？已写入磁盘的不受影响。')) return;
    await chrome.runtime.sendMessage({ type: 'LOG_CLEAR' });
    void reload();
  };

  const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-white">
            <Icon name="logs" size={16} />
          </div>
          <h1 className="text-lg font-semibold text-slate-900">日志查看</h1>
          <span className="text-xs text-slate-500">
            显示 <strong className="font-semibold text-slate-700">{entries.length}</strong>
            <span className="mx-1">/</span>内存{' '}
            <strong className="font-semibold text-slate-700">{total}</strong> 条
            <span className="mx-1.5 text-slate-300">·</span>
            session{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
              {currentSessionId.slice(0, 8)}
            </code>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="h-3.5 w-3.5 cursor-pointer accent-brand-600"
              />
              自动刷新（1.5s）
            </label>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="refresh" size={12} />}
              onClick={() => void reload()}
            >
              刷新
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="download" size={12} />}
              onClick={handleExport}
            >
              导出 NDJSON
            </Button>
            <Button
              variant="danger"
              size="sm"
              leftIcon={<Icon name="trash" size={12} />}
              onClick={handleClear}
            >
              清空内存
            </Button>
          </div>
        </div>

        {/* 过滤栏 */}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <FilterChips
            label="级别"
            all={ALL_LEVELS}
            active={filter.levels}
            colorOf={levelColor}
            onChange={(v) =>
              setFilter((f) => ({ ...f, levels: toggleSet(f.levels, v) }))
            }
          />
          <FilterChips
            label="来源"
            all={ALL_SOURCES}
            active={filter.sources}
            colorOf={() => 'bg-slate-200 text-slate-700'}
            onChange={(v) =>
              setFilter((f) => ({ ...f, sources: toggleSet(f.sources, v) }))
            }
          />
          <Input
            type="text"
            value={filter.module}
            onChange={(e) =>
              setFilter((f) => ({ ...f, module: e.target.value }))
            }
            placeholder="模块名（如 llm/extractor）"
            className="w-48 h-8 font-mono text-xs"
          />
          <Input
            type="text"
            value={filter.keyword}
            onChange={(e) =>
              setFilter((f) => ({ ...f, keyword: e.target.value }))
            }
            placeholder="关键字搜索"
            className="w-56 h-8 text-xs"
          />
          <Select
            value={filter.sessionId}
            onChange={(e) =>
              setFilter((f) => ({ ...f, sessionId: e.target.value }))
            }
            className="w-40 h-8 font-mono text-xs"
          >
            <option value="">全部 session</option>
            {sessionIds.map((sid) => (
              <option key={sid} value={sid}>
                {sid.slice(0, 8)}
                {sid === currentSessionId ? '  (当前)' : ''}
              </option>
            ))}
          </Select>
          <button
            type="button"
            onClick={() => setFilter(DEFAULT_FILTER)}
            className="cursor-pointer text-slate-500 transition-colors duration-150 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded px-1"
          >
            重置过滤
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-auto bg-white">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-slate-400">
            <Icon name="info" size={28} className="text-slate-300" />
            <span className="text-sm">暂无日志</span>
            <span className="text-xs">试试到 sidepanel 触发一次操作</span>
          </div>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-600">
              <tr>
                <th className="px-2 py-2 font-medium">时间</th>
                <th className="px-2 py-2 font-medium">级别</th>
                <th className="px-2 py-2 font-medium">来源</th>
                <th className="px-2 py-2 font-medium">模块</th>
                <th className="px-2 py-2 font-medium">事件</th>
                <th className="px-2 py-2 font-medium">数据</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {entries.map((e) => (
                <LogRow
                  key={`${e.sessionId}:${e.seq}`}
                  entry={e}
                  expanded={expandedSeq === e.seq}
                  onToggle={() =>
                    setExpandedSeq((cur) => (cur === e.seq ? null : e.seq))
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const dataStr = entry.data === undefined ? '' : safeStringify(entry.data);
  const preview = dataStr.length > 80 ? dataStr.slice(0, 80) + '…' : dataStr;

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-slate-100 align-top transition-colors duration-100 hover:bg-brand-50/40"
      >
        <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">
          {formatTime(entry.ts)}
        </td>
        <td className="px-2 py-1.5">
          <span
            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] ${levelColor(entry.level)}`}
          >
            {entry.level}
          </span>
        </td>
        <td className="px-2 py-1.5 text-slate-600">{entry.source}</td>
        <td className="px-2 py-1.5 text-brand-700">{entry.module}</td>
        <td className="px-2 py-1.5 font-medium text-slate-900">
          {entry.event}
          {entry.durationMs != null && (
            <span className="ml-1 text-[10px] text-slate-400">
              ({entry.durationMs}ms)
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 text-slate-600">
          <span className="break-all">{preview}</span>
          {entry.message && (
            <div className="text-[10px] text-slate-400">{entry.message}</div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="border-b border-slate-200 bg-slate-50 p-3">
            <pre className="whitespace-pre-wrap break-all text-[11px] text-slate-800">
              {safeStringify(entry, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function FilterChips<T extends string>({
  label,
  all,
  active,
  colorOf,
  onChange,
}: {
  label: string;
  all: readonly T[];
  active: Set<T>;
  colorOf: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-slate-500">{label}:</span>
      {all.map((v) => {
        const on = active.has(v);
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={[
              'cursor-pointer rounded border px-1.5 py-0.5 text-[10px] transition-colors duration-150',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600',
              on
                ? colorOf(v)
                : 'border-slate-200 bg-slate-50 text-slate-400 line-through',
            ].join(' ')}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

function levelColor(level: LogLevel): string {
  switch (level) {
    case 'debug':
      return 'border-slate-200 bg-slate-100 text-slate-700';
    case 'info':
      return 'border-brand-200 bg-brand-50 text-brand-700';
    case 'warn':
      return 'border-amber-200 bg-amber-50 text-amber-800';
    case 'error':
      return 'border-rose-200 bg-rose-50 text-rose-700';
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0') +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

function safeStringify(v: unknown, indent?: number): string {
  try {
    return JSON.stringify(v, null, indent);
  } catch {
    return String(v);
  }
}
