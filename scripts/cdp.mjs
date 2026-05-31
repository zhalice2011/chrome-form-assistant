// 极简 CDP 客户端：仅用 Node 22 内置 WebSocket / fetch，无外部依赖。
//
// 用法：
//   const browser = await listTargets();
//   const target = browser.find(t => t.url.includes('sidepanel'));
//   const cdp = await connect(target.webSocketDebuggerUrl);
//   const r = await cdp.send('Runtime.evaluate', { expression: '1+1' });
//   await cdp.close();
//
// 设计原则：
//   - 一个 CDP 连接一个对象，独立 id 序列
//   - send() 返回 Promise，await 即拿响应
//   - on(event, cb) 订阅事件
//   - 错误统一抛 Error，不静默吞

const CDP_HOST = process.env.CDP_HOST ?? 'http://localhost:9222';

/** 列出所有 target（page / service_worker / iframe / ...） */
export async function listTargets() {
  const res = await fetch(`${CDP_HOST}/json`);
  if (!res.ok) {
    throw new Error(`CDP listTargets failed: HTTP ${res.status}`);
  }
  return res.json();
}

export async function getBrowserVersion() {
  const res = await fetch(`${CDP_HOST}/json/version`);
  if (!res.ok) throw new Error(`CDP version failed: HTTP ${res.status}`);
  return res.json();
}

/** 在浏览器里新建 tab，返回 target 对象 */
export async function newTab(url) {
  const res = await fetch(
    `${CDP_HOST}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  if (!res.ok) throw new Error(`CDP newTab failed: HTTP ${res.status}`);
  return res.json();
}

export async function activateTarget(targetId) {
  await fetch(`${CDP_HOST}/json/activate/${targetId}`);
}

export async function closeTarget(targetId) {
  await fetch(`${CDP_HOST}/json/close/${targetId}`);
}

/**
 * 连接到一个 target 的 webSocketDebuggerUrl。
 * 返回一个 CdpSession：
 *   - send(method, params) → Promise<result>
 *   - on(event, cb) → cleanup fn
 *   - close()
 */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await once(ws, 'open');

  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject }
  const listeners = new Map(); // event → Set<cb>

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const handler = pending.get(msg.id);
      if (handler) {
        pending.delete(msg.id);
        if (msg.error) handler.reject(new CdpError(msg.error, msg.id));
        else handler.resolve(msg.result);
      }
    } else if (msg.method) {
      const set = listeners.get(msg.method);
      if (set) {
        for (const cb of set) {
          try {
            cb(msg.params, msg);
          } catch (err) {
            console.error(`[cdp] listener for ${msg.method} threw:`, err);
          }
        }
      }
    }
  });

  ws.addEventListener('close', () => {
    for (const handler of pending.values()) {
      handler.reject(new Error('CDP socket closed'));
    }
    pending.clear();
  });

  return {
    send(method, params = {}) {
      if (ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('CDP socket not open'));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
    get readyState() {
      return ws.readyState;
    },
  };
}

class CdpError extends Error {
  constructor(error, id) {
    super(`CDP error [${error.code}] ${error.message}`);
    this.code = error.code;
    this.cdpId = id;
    this.data = error.data;
  }
}

function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      emitter.removeEventListener('error', onErr);
      resolve();
    };
    const onErr = (e) => {
      emitter.removeEventListener(eventName, onOk);
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    emitter.addEventListener(eventName, onOk, { once: true });
    emitter.addEventListener('error', onErr, { once: true });
  });
}

// ---------- 高层便捷封装 ----------

/**
 * 在 target 里执行表达式，返回 result.value（已解 wrap）。
 * 默认 awaitPromise:true，方便写 async 表达式。
 */
export async function evalIn(cdp, expression, opts = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: opts.userGesture ?? false,
    ...opts,
  });
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails;
    const text =
      detail.exception?.description ||
      detail.text ||
      JSON.stringify(detail);
    throw new Error(`Runtime.evaluate threw: ${text}`);
  }
  return r.result?.value;
}

/**
 * 等待条件成立（轮询）。timeout 默认 10s，间隔 200ms。
 * predicate 返回 truthy 即结束。
 */
export async function waitFor(predicate, opts = {}) {
  const timeout = opts.timeout ?? 10_000;
  const interval = opts.interval ?? 200;
  const startedAt = Date.now();
  let lastErr;
  while (Date.now() - startedAt < timeout) {
    try {
      const v = await predicate();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(interval);
  }
  if (lastErr) throw lastErr;
  throw new Error(`waitFor timeout after ${timeout}ms`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
