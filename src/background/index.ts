// Service Worker：管理 sidePanel 行为 + LLM 调用中转 + 日志中心。
// LLM 请求放在这里发，不放 sidepanel：
//   - sidepanel 关闭时不会中断
//   - 不暴露 apiKey 给页面 / content script
//   - host_permissions 让 fetch 不走页面 CORS

import type {
  AnyMessage,
  ErrorResponse,
  LlmGenerateFillsResponse,
  LlmGenerateIntentResponse,
} from '../shared/messages';
import type {
  AnyLogMessage,
  LogClearResponse,
  LogQueryResponse,
} from '../shared/log-types';
import { loadSettings } from '../shared/settings';
import { generateFills, generateIntent } from './llm';
import {
  appendEntries,
  clearEntries,
  forceFlush,
  getStoreSessionId,
  installFlushImpl,
  queryEntries,
} from './log-store';
import { createLogger, installDirectSink, setSessionId } from '../shared/logger';
import { FsLogError, getWriterStatus, writeBatch } from './fs-log-writer';

// ---------- 日志系统初始化（必须最先做，给后续模块用） ----------

setSessionId(getStoreSessionId());
installDirectSink((entries) => appendEntries(entries));

// FSA flush sink：log-store 攒到的 batch 由它写入磁盘
installFlushImpl(async (entries) => {
  try {
    await writeBatch(entries);
  } catch (err) {
    if (err instanceof FsLogError && err.kind === 'no-dir') {
      // 用户还没选目录：不当错误处理，否则 ring buffer 会一直 retry
      // store 会把 batch 退回 pending；下次有 dir 时自动 flush
      return; // 静默——避免无限刷错误日志
    }
    throw err; // 其他错误让 store 处理（重试/退回）
  }
});

const log = createLogger('background', 'sw');

// SW 启动 / 重启埋点
log.info('sw.startup', {
  sessionId: getStoreSessionId(),
  ts: Date.now(),
  writerStatus: getWriterStatus(),
});

// alarms 兜底：30s 周期触发 flush，防 SW 突然休眠丢日志
chrome.alarms.create('log-flush', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'log-flush') {
    void forceFlush();
  }
});

// ---------- 生命周期 ----------

chrome.runtime.onInstalled.addListener((details) => {
  log.info('sw.onInstalled', { reason: details.reason });
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => {
      log.error('sw.setPanelBehavior.error', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
});

chrome.runtime.onStartup?.addListener(() => {
  log.info('sw.onStartup');
});

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener(
  (msg: AnyMessage | AnyLogMessage, _sender, sendResponse) => {
    // 日志相关消息
    if (msg?.type === 'LOG_APPEND') {
      appendEntries(msg.entries);
      // 不需要响应；返回 false 表示同步处理完成
      return false;
    }
    if (msg?.type === 'LOG_QUERY') {
      const { entries, total } = queryEntries(msg.filter, msg.limit);
      const reply: LogQueryResponse = {
        ok: true,
        entries,
        total,
        sessionId: getStoreSessionId(),
      };
      sendResponse(reply);
      return false;
    }
    if (msg?.type === 'LOG_CLEAR') {
      const cleared = clearEntries();
      const reply: LogClearResponse = { ok: true, cleared };
      sendResponse(reply);
      return false;
    }
    if ((msg as { type?: string })?.type === 'LOG_FORCE_FLUSH') {
      void forceFlush();
      sendResponse({ ok: true });
      return false;
    }

    // 业务消息
    if (msg?.type === 'LLM_GENERATE_FILLS') {
      (async () => {
        const startedAt = Date.now();
        log.info('llmGenerateFills.start', {
          fieldsCount: msg.fields.length,
          intentLength: msg.userIntent.length,
        });
        try {
          const settings = await loadSettings();
          const result = await generateFills({
            settings,
            userIntent: msg.userIntent,
            fields: msg.fields,
            pageUrl: msg.pageUrl,
            pageTitle: msg.pageTitle,
          });
          const reply: LlmGenerateFillsResponse = {
            ok: true,
            fills: result.fills,
            debug: {
              model: result.model,
              durationMs: result.durationMs,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
            },
          };
          log.info(
            'llmGenerateFills.ok',
            {
              fillsCount: result.fills.length,
              model: result.model,
              tokens: {
                prompt: result.promptTokens,
                completion: result.completionTokens,
              },
            },
            { durationMs: Date.now() - startedAt },
          );
          sendResponse(reply);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(
            'llmGenerateFills.error',
            { error: errMsg },
            { durationMs: Date.now() - startedAt },
          );
          const reply: ErrorResponse = { ok: false, error: errMsg };
          sendResponse(reply);
        }
      })();
      return true;
    }

    if (msg?.type === 'LLM_GENERATE_INTENT') {
      (async () => {
        const startedAt = Date.now();
        log.info('llmGenerateIntent.start', {
          fieldsCount: msg.fields.length,
          hasPageSummary: !!msg.pageSummary,
        });
        try {
          const settings = await loadSettings();
          const result = await generateIntent({
            settings,
            fields: msg.fields,
            pageUrl: msg.pageUrl,
            pageTitle: msg.pageTitle,
            pageSummary: msg.pageSummary,
            existingIntent: msg.existingIntent,
          });
          const reply: LlmGenerateIntentResponse = {
            ok: true,
            intent: result.intent,
            debug: {
              model: result.model,
              durationMs: result.durationMs,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
            },
          };
          log.info(
            'llmGenerateIntent.ok',
            {
              intentLength: result.intent.length,
              model: result.model,
              tokens: {
                prompt: result.promptTokens,
                completion: result.completionTokens,
              },
            },
            { durationMs: Date.now() - startedAt },
          );
          sendResponse(reply);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(
            'llmGenerateIntent.error',
            { error: errMsg },
            { durationMs: Date.now() - startedAt },
          );
          const reply: ErrorResponse = { ok: false, error: errMsg };
          sendResponse(reply);
        }
      })();
      return true;
    }

    return false;
  },
);
