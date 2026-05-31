import { useMemo, useState } from 'react';
import type {
  ExtractMessage,
  ExtractResponse,
  ErrorResponse,
  ExtractedField,
  FillInstruction,
  FillMessage,
  FillReport,
  FillResponse,
  LlmGenerateFillsMessage,
  LlmGenerateFillsResponse,
  LlmGenerateIntentMessage,
  LlmGenerateIntentResponse,
  PageSummary,
} from '../shared/messages';
import { createLogger } from '../shared/logger';
import {
  Button,
  Icon,
  IconButton,
  Select,
  Textarea,
} from '../shared/ui';
import {
  ContentScriptUnavailableError,
  sendToContentScript,
} from './messaging';

const log = createLogger('sidepanel', 'ui');

/** 把异常转成给用户看的人话 */
function formatExceptionForUser(err: unknown): string {
  if (err instanceof ContentScriptUnavailableError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// LLM 经 background 路由，仍走标准 chrome.runtime.sendMessage
type LlmReply = LlmGenerateFillsResponse | ErrorResponse;

interface ExtractState {
  fields: ExtractedField[];
  pageUrl: string;
  pageTitle: string;
  durationMs: number;
  skipped: number;
  pageSummary?: PageSummary;
}

interface FillsState {
  fills: FillInstruction[];
  model: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

/** 用户在预览区可以编辑值 / 取消勾选某些字段 */
interface DraftRow {
  id: number;
  value: string;
  reason: string;
  enabled: boolean;
}

type Busy = 'idle' | 'extract' | 'intent' | 'llm' | 'fill';

export function App() {
  const [logLines, setLogLines] = useState<string[]>([]);
  const [extracted, setExtracted] = useState<ExtractState | null>(null);
  const [intent, setIntent] = useState('');
  const [fillsState, setFillsState] = useState<FillsState | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [reports, setReports] = useState<FillReport[] | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');

  const append = (line: string) =>
    setLogLines((prev) =>
      [...prev, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-100),
    );

  const fieldsById = useMemo(
    () => new Map(extracted?.fields.map((f) => [f.id, f]) ?? []),
    [extracted],
  );

  const getActiveTabId = async (): Promise<number | undefined> => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab?.id;
  };

  const handleExtract = async () => {
    log.info('click.extract');
    setBusy('extract');
    setExtracted(null);
    setFillsState(null);
    setDrafts([]);
    setReports(null);
    const startedAt = Date.now();
    try {
      const tabId = await getActiveTabId();
      if (!tabId) {
        log.warn('extract.noActiveTab');
        return append('未找到当前活动 tab');
      }
      const reply = await sendToContentScript<ExtractResponse>(tabId, {
        type: 'EXTRACT_FIELDS',
      } satisfies ExtractMessage);
      if (!reply.ok) {
        log.error('extract.replyError', { error: reply.error });
        return append(`extract err: ${reply.error}`);
      }
      setExtracted(reply.result);
      log.info(
        'extract.done',
        {
          fields: reply.result.fields.length,
          skipped: reply.result.skipped,
          pageUrl: reply.result.pageUrl,
          pageTitle: reply.result.pageTitle,
        },
        { durationMs: Date.now() - startedAt },
      );
      append(
        `extract ok: ${reply.result.fields.length} fields in ${reply.result.durationMs}ms`,
      );
    } catch (err) {
      log.error('extract.exception', {
        error: err instanceof Error ? err.message : String(err),
        kind:
          err instanceof ContentScriptUnavailableError
            ? 'unavailable'
            : 'unknown',
      });
      append(`extract ex: ${formatExceptionForUser(err)}`);
    } finally {
      setBusy('idle');
    }
  };

  const handleGenerateIntent = async () => {
    if (!extracted || extracted.fields.length === 0) {
      log.warn('intent.noFields');
      append('请先抓取页面字段');
      return;
    }
    log.info('click.generateIntent', {
      fieldsCount: extracted.fields.length,
      hasPageSummary: !!extracted.pageSummary,
      existingIntentLen: intent.length,
    });
    setBusy('intent');
    const startedAt = Date.now();
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: 'LLM_GENERATE_INTENT',
        fields: extracted.fields,
        pageUrl: extracted.pageUrl,
        pageTitle: extracted.pageTitle,
        pageSummary: extracted.pageSummary,
        existingIntent: intent,
      } satisfies LlmGenerateIntentMessage)) as
        | LlmGenerateIntentResponse
        | ErrorResponse;
      if (!reply.ok) {
        log.error('intent.replyError', { error: reply.error });
        append(`intent err: ${reply.error}`);
        return;
      }
      // 把 LLM 输出填进 textarea，覆盖原有内容（用户可改）
      setIntent(reply.intent);
      log.info(
        'intent.done',
        {
          intentLength: reply.intent.length,
          model: reply.debug.model,
          tokens: {
            prompt: reply.debug.promptTokens,
            completion: reply.debug.completionTokens,
          },
        },
        { durationMs: Date.now() - startedAt },
      );
      append(
        `intent ok: ${reply.intent.length}字, ${reply.debug.durationMs}ms`,
      );
    } catch (err) {
      log.error('intent.exception', {
        error: err instanceof Error ? err.message : String(err),
      });
      append(`intent ex: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy('idle');
    }
  };

  const handleAskLlm = async () => {
    if (!extracted || extracted.fields.length === 0) {
      log.warn('askLlm.noFields');
      append('请先抓取页面字段');
      return;
    }
    if (!intent.trim()) {
      log.warn('askLlm.emptyIntent');
      append('请输入要填什么');
      return;
    }
    log.info('click.askLlm', {
      intent: intent.trim(),
      fieldsCount: extracted.fields.length,
    });
    setBusy('llm');
    setFillsState(null);
    setDrafts([]);
    setReports(null);
    const startedAt = Date.now();
    try {
      const reply: LlmReply = await chrome.runtime.sendMessage({
        type: 'LLM_GENERATE_FILLS',
        userIntent: intent.trim(),
        fields: extracted.fields,
        pageUrl: extracted.pageUrl,
        pageTitle: extracted.pageTitle,
      } satisfies LlmGenerateFillsMessage);
      if (!reply.ok) {
        log.error('askLlm.replyError', { error: reply.error });
        return append(`llm err: ${reply.error}`);
      }
      setFillsState({ fills: reply.fills, ...reply.debug });
      setDrafts(
        reply.fills.map((f) => ({
          id: f.id,
          value: f.value,
          reason: f.reason,
          enabled: true,
        })),
      );
      log.info(
        'askLlm.done',
        {
          fillsCount: reply.fills.length,
          model: reply.debug.model,
          promptTokens: reply.debug.promptTokens,
          completionTokens: reply.debug.completionTokens,
        },
        { durationMs: Date.now() - startedAt },
      );
      append(
        `llm ok: ${reply.fills.length} fills, ${reply.debug.durationMs}ms`,
      );
    } catch (err) {
      log.error('askLlm.exception', {
        error: err instanceof Error ? err.message : String(err),
      });
      append(`llm ex: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy('idle');
    }
  };

  const handleFill = async () => {
    const enabled = drafts.filter((d) => d.enabled);
    if (enabled.length === 0) {
      log.warn('fill.nothingSelected');
      append('没有勾选任何字段');
      return;
    }
    log.info('click.fill', {
      enabledCount: enabled.length,
      totalDrafts: drafts.length,
    });
    setBusy('fill');
    setReports(null);
    const startedAt = Date.now();
    try {
      const tabId = await getActiveTabId();
      if (!tabId) {
        log.warn('fill.noActiveTab');
        return append('未找到当前活动 tab');
      }
      const fills: FillInstruction[] = enabled.map((d) => ({
        id: d.id,
        value: d.value,
        reason: d.reason,
      }));
      const reply = await sendToContentScript<FillResponse>(tabId, {
        type: 'FILL_FIELDS',
        fills,
      } satisfies FillMessage);
      if (!reply.ok) {
        log.error('fill.replyError', { error: reply.error });
        return append(`fill err: ${reply.error}`);
      }
      setReports(reply.reports);
      const okCount = reply.reports.filter((r) => r.status === 'ok').length;
      log.info(
        'fill.done',
        {
          ok: okCount,
          total: reply.reports.length,
          reports: reply.reports,
        },
        { durationMs: Date.now() - startedAt },
      );
      append(`fill ok: ${okCount}/${reply.reports.length} 字段写入成功`);
    } catch (err) {
      log.error('fill.exception', {
        error: err instanceof Error ? err.message : String(err),
        kind:
          err instanceof ContentScriptUnavailableError
            ? 'unavailable'
            : 'unknown',
      });
      append(`fill ex: ${formatExceptionForUser(err)}`);
    } finally {
      setBusy('idle');
    }
  };

  const updateDraft = (id: number, patch: Partial<DraftRow>) =>
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );

  const enabledCount = drafts.filter((d) => d.enabled).length;

  const openLogs = () => {
    log.info('click.openLogs');
    const url = chrome.runtime.getURL('src/logs/index.html');
    void chrome.tabs.create({ url });
  };

  return (
    <div className="flex h-full flex-col bg-slate-50 text-sm text-slate-900">
      {/* 顶栏 */}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white">
            <Icon name="sparkles" size={16} />
          </div>
          <h1 className="text-sm font-semibold text-slate-900">网页助手</h1>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            aria-label="打开日志"
            icon={<Icon name="logs" size={16} />}
            onClick={openLogs}
            title="日志"
          />
          <IconButton
            aria-label="打开设置"
            icon={<Icon name="settings" size={16} />}
            onClick={() => chrome.runtime.openOptionsPage()}
            title="设置"
          />
        </div>
      </header>

      {/* 主内容 */}
      <div className="flex flex-1 flex-col gap-2.5 overflow-hidden p-3">
        {/* Step 1：抓取 */}
        <Section step={1} title="抓取页面字段">
          <Button
            block
            variant="primary"
            loading={busy === 'extract'}
            disabled={busy !== 'idle'}
            leftIcon={<Icon name="refresh-ccw" size={14} />}
            onClick={handleExtract}
          >
            {busy === 'extract' ? '抓取中…' : '扫描当前页表单'}
          </Button>

          {extracted && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600">
              <Icon
                name="check-circle"
                size={14}
                className="text-brand-600"
              />
              <span className="flex-1 truncate" title={extracted.pageTitle}>
                {extracted.pageTitle || '(无标题)'}
              </span>
              <span className="shrink-0 rounded bg-brand-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-brand-700">
                {extracted.fields.length} 个字段
              </span>
            </div>
          )}
        </Section>

        {/* Step 2：意图 */}
        {extracted && extracted.fields.length > 0 && (
          <Section step={2} title="描述要填什么">
            <Button
              block
              variant="secondary"
              loading={busy === 'intent'}
              disabled={busy !== 'idle'}
              leftIcon={
                <Icon name="magic" size={14} className="text-brand-600" />
              }
              onClick={handleGenerateIntent}
              title="LLM 读页面 + 个人资料自动生成填写意图"
            >
              {busy === 'intent' ? '生成中…' : '让 AI 读页面自动生成'}
            </Button>

            <div className="mt-2 mb-1 flex items-baseline justify-between text-[11px] text-slate-500">
              <span>或手动描述：</span>
              {intent.length > 0 && (
                <button
                  type="button"
                  onClick={() => setIntent('')}
                  className="cursor-pointer text-slate-400 transition-colors duration-150 hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded"
                >
                  清空
                </button>
              )}
            </div>
            <Textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="例如：帮我填注册表，姓名张三，邮箱 a@b.com"
              rows={3}
            />

            <Button
              block
              variant="primary"
              className="mt-2"
              loading={busy === 'llm'}
              disabled={busy !== 'idle' || !intent.trim()}
              leftIcon={<Icon name="send" size={13} />}
              onClick={handleAskLlm}
            >
              {busy === 'llm' ? 'LLM 思考中…' : '生成填写方案'}
            </Button>
          </Section>
        )}

        {/* 预览区 */}
        <div className="flex-1 overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="h-full overflow-auto">
            {fillsState ? (
              <DraftPreview
                fillsState={fillsState}
                drafts={drafts}
                updateDraft={updateDraft}
                fieldsById={fieldsById}
                reports={reports}
                extractedTotal={extracted?.fields.length ?? 0}
              />
            ) : extracted ? (
              extracted.fields.length === 0 ? (
                <EmptyState
                  icon="info"
                  text="未发现可填字段"
                />
              ) : (
                <FieldTable fields={extracted.fields} />
              )
            ) : (
              <EmptyState
                icon="play"
                text='点击上方"扫描当前页表单"开始'
              />
            )}
          </div>
        </div>

        {/* Step 3：确认 CTA */}
        {drafts.length > 0 && !reports && (
          <Button
            block
            variant="cta"
            size="md"
            loading={busy === 'fill'}
            disabled={busy !== 'idle' || enabledCount === 0}
            leftIcon={<Icon name="check" size={14} />}
            onClick={handleFill}
          >
            {busy === 'fill'
              ? '填写中…'
              : `确认填写 ${enabledCount} 个字段`}
          </Button>
        )}

        {reports && (
          <Button
            block
            variant="secondary"
            leftIcon={<Icon name="refresh-ccw" size={14} />}
            onClick={handleExtract}
          >
            重新抓取页面
          </Button>
        )}

        {/* 折叠日志 */}
        <details className="group rounded-md border border-slate-200 bg-white">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-slate-500 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded-md">
            <Icon
              name="chevron-right"
              size={12}
              className="transition-transform duration-150 group-open:rotate-90"
            />
            <span>简要日志（{logLines.length} 条）</span>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openLogs();
              }}
              className="ml-auto inline-flex items-center gap-1 rounded text-brand-700 hover:text-brand-800 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 px-1"
            >
              <span>完整日志</span>
              <Icon name="chevron-right" size={11} />
            </button>
          </summary>
          <div className="max-h-40 overflow-auto rounded-b-md bg-slate-900 p-2 font-mono text-[11px] text-emerald-300">
            {logLines.length === 0 ? (
              <span className="text-slate-500">（空）</span>
            ) : (
              logLines.map((l, i) => <div key={i}>{l}</div>)
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

// ---------- 辅助组件 ----------

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-sm bg-slate-200 px-1 font-mono text-[10px] font-semibold tracking-wider text-slate-600">
          {step}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
          {title}
        </span>
      </div>
      {children}
    </section>
  );
}

function EmptyState({
  icon,
  text,
}: {
  icon: 'play' | 'info';
  text: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-slate-400">
      <Icon name={icon} size={28} className="text-slate-300" />
      <span className="text-xs">{text}</span>
    </div>
  );
}

// ---------- 预览/编辑组件 ----------

function DraftPreview({
  fillsState,
  drafts,
  updateDraft,
  fieldsById,
  reports,
  extractedTotal,
}: {
  fillsState: FillsState;
  drafts: DraftRow[];
  updateDraft: (id: number, patch: Partial<DraftRow>) => void;
  fieldsById: Map<number, ExtractedField>;
  reports: FillReport[] | null;
  extractedTotal: number;
}) {
  const reportById = useMemo(
    () => new Map((reports ?? []).map((r) => [r.id, r])),
    [reports],
  );

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-slate-200 bg-brand-50 px-2.5 py-1.5 text-[11px] text-brand-800">
        <Icon name="sparkles" size={12} className="text-brand-600" />
        <span>
          AI 建议填 {drafts.length}/{extractedTotal} 个字段
        </span>
        <span className="text-brand-600/70">·</span>
        <span className="font-mono text-brand-700">{fillsState.model}</span>
        <span className="text-brand-600/70">·</span>
        <span>{fillsState.durationMs}ms</span>
        {fillsState.promptTokens != null && (
          <>
            <span className="text-brand-600/70">·</span>
            <span>
              {fillsState.promptTokens}/{fillsState.completionTokens ?? '?'} tok
            </span>
          </>
        )}
      </div>

      {drafts.length === 0 ? (
        <div className="p-4 text-center text-xs text-slate-500">
          AI 未生成任何填写建议
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {drafts.map((d) => {
            const field = fieldsById.get(d.id);
            const report = reportById.get(d.id);
            return (
              <DraftRowEditor
                key={d.id}
                draft={d}
                field={field}
                report={report}
                onChange={(patch) => updateDraft(d.id, patch)}
                disabled={reports !== null}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function DraftRowEditor({
  draft,
  field,
  report,
  onChange,
  disabled,
}: {
  draft: DraftRow;
  field: ExtractedField | undefined;
  report: FillReport | undefined;
  onChange: (patch: Partial<DraftRow>) => void;
  disabled: boolean;
}) {
  const statusBadge = report ? <StatusBadge report={report} /> : null;
  const rowOpacity = !draft.enabled ? 'opacity-50' : '';

  return (
    <div className={`px-2.5 py-2 ${rowOpacity}`}>
      <div className="mb-1 flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          className="h-3.5 w-3.5 cursor-pointer accent-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded"
        />
        <div className="flex-1 truncate text-xs">
          <span className="font-mono text-slate-400">#{draft.id}</span>{' '}
          <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
            {field?.kind ?? '?'}
          </span>{' '}
          <span className="font-medium text-slate-900">
            {field?.label ?? '(未知字段)'}
          </span>
        </div>
        {statusBadge}
      </div>

      <ValueEditor
        draft={draft}
        field={field}
        onChange={onChange}
        disabled={disabled || !draft.enabled}
      />

      {draft.reason && (
        <div className="mt-1 ml-6 text-[10px] text-slate-500">
          {draft.reason}
        </div>
      )}
      {report && report.status !== 'ok' && (
        <div className="mt-1 ml-6 flex items-start gap-1 text-[10px] text-rose-600">
          <Icon name="alert" size={11} className="mt-px shrink-0" />
          <span>{report.message}</span>
        </div>
      )}
    </div>
  );
}

function ValueEditor({
  draft,
  field,
  onChange,
  disabled,
}: {
  draft: DraftRow;
  field: ExtractedField | undefined;
  onChange: (patch: Partial<DraftRow>) => void;
  disabled: boolean;
}) {
  const containerCls = 'ml-6 w-[calc(100%-1.5rem)]';

  // select / radio：用下拉选 option
  if (
    field &&
    (field.kind === 'select' || field.kind === 'radio') &&
    field.options
  ) {
    return (
      <div className={containerCls}>
        <Select
          value={draft.value}
          disabled={disabled}
          onChange={(e) => onChange({ value: e.target.value })}
          className="text-xs h-8"
        >
          {!field.options.some((o) => o.value === draft.value) && (
            <option value={draft.value}>⚠ {draft.value}（不在选项中）</option>
          )}
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.label !== o.value ? `  (${o.value})` : ''}
            </option>
          ))}
        </Select>
      </div>
    );
  }

  // checkbox：true/false 切换
  if (field?.kind === 'checkbox') {
    return (
      <div className={containerCls}>
        <Select
          value={draft.value}
          disabled={disabled}
          onChange={(e) => onChange({ value: e.target.value })}
          className="text-xs h-8"
        >
          <option value="true">true（勾选）</option>
          <option value="false">false（不勾选）</option>
        </Select>
      </div>
    );
  }

  // 长文本：textarea
  if (
    field?.kind === 'text' &&
    field.type !== 'email' &&
    field.type !== 'url' &&
    field.type !== 'tel' &&
    draft.value.length > 50
  ) {
    return (
      <div className={containerCls}>
        <Textarea
          value={draft.value}
          disabled={disabled}
          onChange={(e) => onChange({ value: e.target.value })}
          rows={2}
          className="text-xs font-mono"
        />
      </div>
    );
  }

  return (
    <div className={containerCls}>
      <input
        type="text"
        value={draft.value}
        disabled={disabled}
        onChange={(e) => onChange({ value: e.target.value })}
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-mono text-slate-900 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:border-brand-600 disabled:bg-slate-50 disabled:text-slate-400"
      />
    </div>
  );
}

function StatusBadge({ report }: { report: FillReport }) {
  const map: Record<
    FillReport['status'],
    { text: string; cls: string; icon: 'check' | 'x' | 'minus-circle' | 'alert' }
  > = {
    ok: {
      text: '已填',
      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      icon: 'check',
    },
    'not-found': {
      text: '失效',
      cls: 'bg-rose-50 text-rose-700 border-rose-200',
      icon: 'x',
    },
    unsupported: {
      text: '不支持',
      cls: 'bg-amber-50 text-amber-800 border-amber-200',
      icon: 'minus-circle',
    },
    error: {
      text: '失败',
      cls: 'bg-rose-50 text-rose-700 border-rose-200',
      icon: 'alert',
    },
  };
  const m = map[report.status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${m.cls}`}
    >
      <Icon name={m.icon} size={10} />
      {m.text}
    </span>
  );
}

function FieldTable({ fields }: { fields: ExtractedField[] }) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 bg-slate-50">
        <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
          <th className="border-b border-slate-200 px-2 py-1.5 font-medium">id</th>
          <th className="border-b border-slate-200 px-2 py-1.5 font-medium">
            字段
          </th>
          <th className="border-b border-slate-200 px-2 py-1.5 font-medium">
            类型
          </th>
          <th className="border-b border-slate-200 px-2 py-1.5 font-medium">
            当前值
          </th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.id} className="align-top hover:bg-slate-50/60">
            <td className="border-b border-slate-100 px-2 py-1 font-mono text-slate-500">
              {f.id}
            </td>
            <td className="border-b border-slate-100 px-2 py-1">
              <div className="flex items-center gap-1 font-medium text-slate-900">
                <span>{f.label}</span>
                {f.required && (
                  <Icon
                    name="alert"
                    size={11}
                    className="text-rose-500"
                    aria-label="必填"
                  />
                )}
              </div>
              {(f.name || f.placeholder) && (
                <div className="text-[10px] text-slate-400">
                  {f.name && <span>name={f.name} </span>}
                  {f.placeholder && <span>ph="{f.placeholder}"</span>}
                </div>
              )}
              {f.options && f.options.length > 0 && (
                <div className="mt-0.5 text-[10px] text-slate-500">
                  {f.options.length} 个选项：
                  {f.options
                    .slice(0, 3)
                    .map((o) => o.label)
                    .join(' / ')}
                  {f.options.length > 3 && ' …'}
                </div>
              )}
            </td>
            <td className="border-b border-slate-100 px-2 py-1 text-slate-600">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">
                {f.kind}
                {f.type && f.type !== f.kind ? `(${f.type})` : ''}
              </span>
            </td>
            <td className="border-b border-slate-100 px-2 py-1 text-slate-600">
              {f.currentValue ? (
                <span className="line-clamp-2 break-all">{f.currentValue}</span>
              ) : (
                <span className="text-slate-300">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
