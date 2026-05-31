import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type LlmSettings } from '../shared/messages';
import { loadSettings, saveSettings } from '../shared/settings';
import { createLogger } from '../shared/logger';
import { idbDel, idbGet, idbSet } from '../shared/idb-handle';
import { Button, Icon, Input } from '../shared/ui';

const log = createLogger('options', 'ui');

const LOG_DIR_KEY = 'logDir';

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'saved' }
  | { kind: 'testing' }
  | { kind: 'test-ok'; latencyMs: number; preview: string }
  | { kind: 'error'; message: string };

export function OptionsApp() {
  const [settings, setSettings] = useState<LlmSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const update = <K extends keyof LlmSettings>(key: K, value: LlmSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setStatus({ kind: 'idle' });
  };

  const handleSave = async () => {
    log.info('click.save', {
      endpoint: settings.endpoint,
      model: settings.model,
      temperature: settings.temperature,
      // 不记 apiKey 完整值（虽然用户允许不脱敏，但 settings 这种持久配置仍只存末 4 位）
      apiKeyTail: settings.apiKey.slice(-4),
    });
    setStatus({ kind: 'loading' });
    try {
      await saveSettings(settings);
      log.info('save.done');
      setStatus({ kind: 'saved' });
    } catch (err) {
      log.error('save.error', {
        error: err instanceof Error ? err.message : String(err),
      });
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS);
    setStatus({ kind: 'idle' });
  };

  const handleTest = async () => {
    log.info('click.testConnection', {
      endpoint: settings.endpoint,
      model: settings.model,
    });
    setStatus({ kind: 'testing' });
    const startedAt = Date.now();
    try {
      const url = `${settings.endpoint.replace(/\/+$/, '')}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey || 'not-needed'}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            {
              role: 'user',
              content: '只回复 "ok"，不要说别的',
            },
          ],
          max_tokens: 20,
        }),
      });
      const text = await res.text();
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        log.error('testConnection.httpError', {
          status: res.status,
          body: text,
          latencyMs,
        });
        setStatus({ kind: 'error', message: `HTTP ${res.status}: ${text.slice(0, 200)}` });
        return;
      }
      const json = JSON.parse(text);
      const preview =
        json?.choices?.[0]?.message?.content ?? JSON.stringify(json).slice(0, 100);
      log.info(
        'testConnection.ok',
        { preview },
        { durationMs: latencyMs },
      );
      setStatus({
        kind: 'test-ok',
        latencyMs,
        preview,
      });
    } catch (err) {
      log.error('testConnection.exception', {
        error: err instanceof Error ? err.message : String(err),
      });
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 text-sm text-slate-500">
        加载中…
      </div>
    );
  }

  return (
    <div className="min-h-full bg-slate-50">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600 text-white">
            <Icon name="sparkles" size={18} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              网页助手 · 设置
            </h1>
            <p className="text-xs text-slate-500">
              LLM 接口仅保存在本地浏览器（chrome.storage.local），不会上传任何后端。
            </p>
          </div>
        </div>

        <div className="space-y-5 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <Field
            label="Endpoint"
            hint="到 /llm 这一层（程序会自动拼 /chat/completions）"
          >
            <Input
              type="text"
              value={settings.endpoint}
              onChange={(e) => update('endpoint', e.target.value)}
              className="font-mono"
              placeholder="http://localhost:3000/api/v1/llm"
            />
          </Field>

          <Field label="API Key" hint="本地代理可填 not-needed">
            <Input
              type="password"
              value={settings.apiKey}
              onChange={(e) => update('apiKey', e.target.value)}
              className="font-mono"
            />
          </Field>

          <Field label="模型">
            <Input
              type="text"
              value={settings.model}
              onChange={(e) => update('model', e.target.value)}
              className="font-mono"
              placeholder="gemini-3.1-pro"
            />
          </Field>

          <Field
            label="Temperature"
            hint="表单填写建议 0.0~0.5（更确定性），默认 0.3"
          >
            <Input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={settings.temperature ?? 0.3}
              onChange={(e) => update('temperature', Number(e.target.value))}
              className="w-32 font-mono"
            />
          </Field>

          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="primary"
              loading={status.kind === 'loading'}
              leftIcon={<Icon name="check" size={14} />}
              onClick={handleSave}
            >
              保存
            </Button>
            <Button
              variant="secondary"
              loading={status.kind === 'testing'}
              leftIcon={<Icon name="plug" size={14} />}
              onClick={handleTest}
            >
              测试连接
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={handleReset}
            >
              恢复默认
            </Button>
          </div>

          <StatusBox status={status} />
        </div>

        <LogDirSection />
      </div>
    </div>
  );
}

// ---------- 日志目录设置 ----------

type LogDirState =
  | { kind: 'loading' }
  | { kind: 'unset' }
  | { kind: 'set'; dirName: string; permission: PermissionState }
  | { kind: 'error'; message: string };

function LogDirSection() {
  const [state, setState] = useState<LogDirState>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const handle = await idbGet<FileSystemDirectoryHandle>(LOG_DIR_KEY);
      if (!handle) {
        setState({ kind: 'unset' });
        return;
      }
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      setState({ kind: 'set', dirName: handle.name, permission: perm });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 关键：showDirectoryPicker + requestPermission 都必须在用户激活手势的
  // 同步路径里调用，不能 await 之后再调（会丢激活上下文）。
  const handlePick = async () => {
    log.info('logDir.pickStart');
    try {
      // 这里 await 之前没有任何其他 await——保持用户激活上下文
      const handle = await window.showDirectoryPicker({
        id: 'chrome-assistant-logs',
        mode: 'readwrite',
      });
      // 选完后立即请求 readwrite 权限（仍在激活上下文内）
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        log.warn('logDir.permissionDenied', { perm });
        setState({
          kind: 'error',
          message: `权限未授予：${perm}`,
        });
        return;
      }
      await idbSet(LOG_DIR_KEY, handle);
      log.info('logDir.set', { dirName: handle.name });
      setState({ kind: 'set', dirName: handle.name, permission: 'granted' });
    } catch (err) {
      // 用户取消会抛 AbortError，不算真错误
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError') {
        log.info('logDir.pickCancelled');
        return;
      }
      log.error('logDir.pickError', {
        error: err instanceof Error ? err.message : String(err),
      });
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 当 query 显示非 granted 时，UI 上提供"重新授权"按钮
  const handleReauthorize = async () => {
    if (state.kind !== 'set') return;
    log.info('logDir.reauthorizeStart');
    try {
      const handle = await idbGet<FileSystemDirectoryHandle>(LOG_DIR_KEY);
      if (!handle) {
        await refresh();
        return;
      }
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      log.info('logDir.reauthorized', { perm });
      await refresh();
      // 触发一次 SW 端 flush，把累积日志写出
      void chrome.runtime.sendMessage({ type: 'LOG_FORCE_FLUSH' }).catch(() => {});
    } catch (err) {
      log.error('logDir.reauthorizeError', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleClear = async () => {
    log.info('logDir.clear');
    await idbDel(LOG_DIR_KEY);
    setState({ kind: 'unset' });
    // 清掉 badge（如果之前因为权限失效设了）
    void chrome.action.setBadgeText({ text: '' }).catch(() => {});
  };

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-center gap-2">
        <Icon name="folder" size={16} className="text-brand-600" />
        <h2 className="text-sm font-semibold text-slate-900">日志目录</h2>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        选定本地目录后，扩展会把所有日志按 NDJSON 格式写入
        <code className="mx-1 rounded bg-slate-100 px-1 font-mono text-[11px]">
          logs-YYYY-MM-DD.log
        </code>
        文件。仅本地存储，不上传任何服务器。
      </p>

      <LogDirBody
        state={state}
        onPick={handlePick}
        onReauthorize={handleReauthorize}
        onClear={handleClear}
      />
    </div>
  );
}

function LogDirBody({
  state,
  onPick,
  onReauthorize,
  onClear,
}: {
  state: LogDirState;
  onPick: () => void;
  onReauthorize: () => void;
  onClear: () => void;
}) {
  if (state.kind === 'loading') {
    return <div className="text-xs text-slate-500">加载中…</div>;
  }

  if (state.kind === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
        <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
        <span className="flex-1">{state.message}</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={onPick}
          className="border-rose-300 text-rose-700 hover:bg-rose-100"
        >
          重新选择
        </Button>
      </div>
    );
  }

  if (state.kind === 'unset') {
    return (
      <Button
        variant="primary"
        leftIcon={<Icon name="folder" size={14} />}
        onClick={onPick}
      >
        选择日志目录…
      </Button>
    );
  }

  // state.kind === 'set'
  const granted = state.permission === 'granted';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">当前目录：</span>
        <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-slate-800">
          {state.dirName}
        </code>
        {granted ? (
          <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
            <Icon name="check" size={10} />
            已授权
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
            <Icon name="alert" size={10} />
            权限失效
          </span>
        )}
      </div>

      {!granted && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
          <span>浏览器重启后 FSA 权限默认会失效。点击下方按钮在用户手势中重新授权。</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!granted && (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="refresh" size={12} />}
            onClick={onReauthorize}
          >
            重新授权
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="folder" size={12} />}
          onClick={onPick}
        >
          换个目录…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-slate-500 hover:text-rose-600"
          leftIcon={<Icon name="trash" size={12} />}
          onClick={onClear}
        >
          移除
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        {hint && <span className="text-xs text-slate-400">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function StatusBox({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;

  const config = (() => {
    switch (status.kind) {
      case 'loading':
        return {
          cls: 'bg-brand-50 text-brand-800 border-brand-200',
          icon: 'refresh' as const,
          spinning: true,
        };
      case 'saved':
        return {
          cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          icon: 'check-circle' as const,
        };
      case 'testing':
        return {
          cls: 'bg-brand-50 text-brand-800 border-brand-200',
          icon: 'refresh' as const,
          spinning: true,
        };
      case 'test-ok':
        return {
          cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          icon: 'check-circle' as const,
        };
      case 'error':
        return {
          cls: 'bg-rose-50 text-rose-700 border-rose-200',
          icon: 'x-circle' as const,
        };
    }
  })();

  return (
    <div
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${config.cls}`}
    >
      <Icon
        name={config.icon}
        size={14}
        className={`mt-0.5 shrink-0 ${config.spinning ? 'animate-spin' : ''}`}
      />
      <div className="flex-1">
        {status.kind === 'loading' && '保存中…'}
        {status.kind === 'saved' && '已保存'}
        {status.kind === 'testing' && '测试中…'}
        {status.kind === 'test-ok' && (
          <>
            连接成功（{status.latencyMs} ms）— LLM 回复：
            <code className="ml-1 break-all rounded bg-emerald-100 px-1 font-mono text-emerald-900">
              {status.preview}
            </code>
          </>
        )}
        {status.kind === 'error' && status.message}
      </div>
    </div>
  );
}
