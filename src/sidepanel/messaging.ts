// sidepanel → content script 通信 helper。
//
// 解决两个真实场景的坑：
//
// 1) 扩展加载/刷新前已打开的 tab 上没有 content script
//    chrome.tabs.sendMessage 会抛 "Could not establish connection. Receiving end does not exist"
//    解决：捕获该错误后用 chrome.scripting.executeScript 按需注入，再重试一次
//
// 2) 含跨域 iframe（Marketo / reCAPTCHA / 各类嵌入表单）的页面有多个 frame 都注册了 listener
//    sendMessage 不带 frameId 会广播且取第一个 sendResponse —— 隐藏 iframe 容易抢答
//    解决：默认显式指定 frameId: 0 只发主 frame
//
// 多 frame 字段聚合（同源 iframe 表单）属于后续优化，本 helper 先把主 frame 跑稳。

import type { AnyMessage, ErrorResponse } from '../shared/messages';
import { createLogger } from '../shared/logger';

const log = createLogger('sidepanel', 'messaging');

const CONNECTION_ERROR_PATTERNS = [
  'Could not establish connection',
  'Receiving end does not exist',
  'message channel is closed',
];

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CONNECTION_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * 友好错误：把底层连接错误映射成用户能理解的话。
 * 业务错误（reply.ok === false）原样返回。
 */
export class ContentScriptUnavailableError extends Error {
  constructor(public readonly tabUrl?: string) {
    super(
      '当前页面无法访问。可能原因：\n' +
        '• 这是 Chrome 内部页（chrome://、扩展商店、新标签页等），扩展无法注入\n' +
        '• 这是 file:// 本地文件，扩展默认不能访问\n' +
        '• 页面 CSP 阻止了脚本注入',
    );
    this.name = 'ContentScriptUnavailableError';
  }
}

/**
 * 给指定 tab 发消息。失败时自动尝试注入 content script 后重试一次。
 *
 * @param tabId 目标 tab
 * @param msg 业务消息
 * @returns 业务响应（成功时）或 ErrorResponse（content script 处理时报错）
 * @throws ContentScriptUnavailableError 注入也失败（chrome:// 等）
 */
export async function sendToContentScript<TReply>(
  tabId: number,
  msg: AnyMessage,
): Promise<TReply | ErrorResponse> {
  try {
    return await chrome.tabs.sendMessage<AnyMessage, TReply>(tabId, msg, {
      frameId: 0, // 只发主 frame，避免 iframe 抢答
    });
  } catch (err) {
    if (!isConnectionError(err)) {
      throw err; // 非连接错误（业务异常），交给上层处理
    }
    log.warn('connectionLost.tryInject', {
      tabId,
      msgType: msg.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 走到这里说明初次连接失败 → 尝试注入
  await injectContentScript(tabId);

  // crxjs 的 loader 是异步动态 import 真模块（chrome.runtime.getURL + dynamic import），
  // 注入返回后 listener 还没注册完。需要 backoff 重试几次。
  const RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
  let lastErr: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      return await chrome.tabs.sendMessage<AnyMessage, TReply>(tabId, msg, {
        frameId: 0,
      });
    } catch (err) {
      lastErr = err;
      if (!isConnectionError(err)) throw err;
    }
  }
  log.error('connectionLost.afterInject', {
    tabId,
    msgType: msg.type,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  throw new ContentScriptUnavailableError();
}

/**
 * 用 chrome.scripting.executeScript 注入 content script。
 * 文件路径从 manifest 动态读，避免 hash 后缀变化时手改。
 */
async function injectContentScript(tabId: number): Promise<void> {
  const manifest = chrome.runtime.getManifest();
  const cs = manifest.content_scripts?.[0];
  const files = cs?.js;
  if (!files || files.length === 0) {
    throw new Error('manifest 没有 content_scripts.js 配置');
  }

  log.info('inject.start', { tabId, files });
  const startedAt = Date.now();

  try {
    // allFrames:true 与 manifest 的 all_frames:true 保持一致，
    // 后续多 frame 聚合时各 frame 都已就位
    const result = await chrome.scripting.executeScript({
      target: { tabId, allFrames: cs?.all_frames ?? false },
      files,
    });
    log.info(
      'inject.done',
      { tabId, frames: result.length },
      { durationMs: Date.now() - startedAt },
    );
  } catch (err) {
    log.error('inject.error', {
      tabId,
      error: err instanceof Error ? err.message : String(err),
    });
    // 注入失败基本只在 chrome://、edge:// 等无法访问的页面发生
    throw new ContentScriptUnavailableError();
  }
}
