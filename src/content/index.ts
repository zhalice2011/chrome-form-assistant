// Content Script：注入到所有页面，负责 DOM 读写。
// 阶段 5：所有处理路径都加日志埋点。

import type {
  AnyMessage,
  ExtractResponse,
  FillResponse,
  PingResponse,
  ErrorResponse,
} from '../shared/messages';
import { extractFields } from './extractor';
import { fillFields } from './filler';
import { createLogger } from '../shared/logger';

const log = createLogger('content', 'router');

chrome.runtime.onMessage.addListener(
  (msg: AnyMessage, _sender, sendResponse) => {
    try {
      if (msg?.type === 'PING') {
        const reply: PingResponse = {
          ok: true,
          pong: `pong from content: ${msg.text}`,
          url: location.href,
        };
        sendResponse(reply);
        return false;
      }

      if (msg?.type === 'EXTRACT_FIELDS') {
        const startedAt = Date.now();
        log.info('extract.start', {}, { pageUrl: location.href });
        const result = extractFields();
        log.info(
          'extract.done',
          {
            fields: result.fields.length,
            skipped: result.skipped,
          },
          {
            durationMs: Date.now() - startedAt,
            pageUrl: location.href,
          },
        );
        const reply: ExtractResponse = { ok: true, result };
        sendResponse(reply);
        return false;
      }

      if (msg?.type === 'FILL_FIELDS') {
        const startedAt = Date.now();
        log.info(
          'fill.start',
          { count: msg.fills.length, fills: msg.fills },
          { pageUrl: location.href },
        );
        const reports = fillFields(msg.fills);
        log.info(
          'fill.done',
          { reports },
          {
            durationMs: Date.now() - startedAt,
            pageUrl: location.href,
          },
        );
        const reply: FillResponse = { ok: true, reports };
        sendResponse(reply);
        return false;
      }

      return false;
    } catch (err) {
      log.error('router.exception', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      const reply: ErrorResponse = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      sendResponse(reply);
      return false;
    }
  },
);
