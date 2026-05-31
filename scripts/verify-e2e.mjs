#!/usr/bin/env node
// 端到端自验证脚本：通过 CDP 连接已运行的调试 Chrome，逐项检查 5 个阶段。
//
// 前置条件：
//   1. Chrome 已用 --remote-debugging-port=9222 启动
//   2. dist/ 已 pnpm build
//   3. 用户已在 chrome://extensions 加载 dist/ 并启用扩展
//
// 用法：
//   pnpm verify
//
// 退出码：
//   0 = 全通过 / 关键项通过；非 0 = 某些关键项失败
//
// 设计：
//   - 每个 check 是一个 async 函数，返回 { ok, message, details? }
//   - 支持 critical: 关键项失败立即终止；非关键失败只警告
//   - 输出彩色对齐报告

import {
  activateTarget,
  closeTarget,
  connect,
  evalIn,
  getBrowserVersion,
  listTargets,
  newTab,
  sleep,
  waitFor,
} from './cdp.mjs';

const EXT_NAME = 'Chrome 网页表单助手';
// 用真实 http(s) 页面：data: URL 不被 content_scripts <all_urls> 匹配。
// example.com 简单稳定，DOM 极小不污染我们的字段计数。
const TEST_HOST_URL = 'https://example.com/';
const TEST_FORM_HTML = buildTestFormHtml();
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? 'http://localhost:3000/api/v1/llm';
const LLM_MODEL = process.env.LLM_MODEL ?? 'gemini-3.1-pro';

// ---------- 入口 ----------

async function main() {
  printHeader();

  const results = [];
  const ctx = {}; // 运行时上下文：扩展 ID、各 target 等

  for (const step of STEPS) {
    const startedAt = Date.now();
    process.stdout.write(`  ${step.name.padEnd(50)} `);
    try {
      const r = await step.run(ctx);
      const dur = `${Date.now() - startedAt}ms`.padStart(7);
      if (r.ok) {
        process.stdout.write(`${green('✓ pass')} ${dim(dur)}`);
        if (r.message) process.stdout.write(`  ${dim(r.message)}`);
        process.stdout.write('\n');
      } else {
        process.stdout.write(`${yellow('⚠ skip')} ${dim(dur)}  ${dim(r.message ?? '')}\n`);
      }
      results.push({ step, ok: r.ok, ...r });
      if (!r.ok && step.critical) {
        console.error(red(`\n关键步骤失败，终止：${r.message}`));
        printDetails(r);
        await cleanup(ctx);
        process.exit(1);
      }
    } catch (err) {
      const dur = `${Date.now() - startedAt}ms`.padStart(7);
      process.stdout.write(`${red('✗ fail')} ${dim(dur)}\n`);
      console.error(red(`    ${err.message}`));
      if (err.stack && process.env.VERBOSE) {
        console.error(dim(err.stack));
      }
      results.push({ step, ok: false, error: err });
      if (step.critical) {
        await cleanup(ctx);
        process.exit(1);
      }
    }
  }

  await cleanup(ctx);
  printSummary(results);
  const failed = results.filter((r) => !r.ok && r.step.critical);
  process.exit(failed.length > 0 ? 1 : 0);
}

async function cleanup(ctx) {
  // 还原用户的 settings（避免 verify 写入的临时数据残留）
  if (ctx.optionsCdp && ctx.optionsCdp.readyState === 1) {
    try {
      if (ctx.savedSettings) {
        await evalIn(
          ctx.optionsCdp,
          `chrome.storage.local.set({ llmSettings: ${JSON.stringify(ctx.savedSettings)} })`,
        );
      } else {
        // 用户原本没有 settings，直接删掉 verify 写入的
        await evalIn(
          ctx.optionsCdp,
          `chrome.storage.local.remove('llmSettings')`,
        );
      }
    } catch {
      // 还原失败不影响别的清理
    }
  }
  // 关闭脚本开的 tab
  for (const tabId of [ctx.testTabId, ctx.optionsTabId]) {
    if (tabId) {
      try {
        await closeTarget(tabId);
      } catch {}
    }
  }
  for (const cdp of [ctx.testTabCdp, ctx.swCdp, ctx.optionsCdp, ctx.sidepanelCdp]) {
    if (cdp) cdp.close();
  }
}

// ---------- 检查步骤 ----------

const STEPS = [
  {
    name: '1.0  CDP 连通性',
    critical: true,
    async run() {
      const v = await getBrowserVersion();
      return { ok: true, message: v.Browser };
    },
  },
  {
    name: '1.1  扩展已加载',
    critical: true,
    async run(ctx) {
      const targets = await listTargets();
      // 找到我们扩展的 service_worker 或任何 chrome-extension://<ID>/ 资源
      const candidates = targets.filter(
        (t) =>
          (t.url?.startsWith('chrome-extension://') ||
            t.type === 'service_worker') &&
          // 排除其他扩展（用 url 启动后会显示的扩展名匹配）
          (t.title?.includes('网页表单助手') ||
            t.title?.includes(EXT_NAME) ||
            t.url?.includes('sidepanel') ||
            t.url?.includes('options') ||
            t.url?.includes('logs') ||
            // service worker 没 title，但 url 形如 chrome-extension://<id>/service-worker-loader.js
            t.url?.includes('service-worker-loader')),
      );
      if (candidates.length === 0) {
        return {
          ok: false,
          message:
            '未发现本扩展的任何 target。请确认已在 chrome://extensions/ 加载 dist/ 并启用',
        };
      }
      // 提取 extension id
      const m = candidates[0].url.match(/chrome-extension:\/\/([a-z]+)/);
      if (!m) {
        return {
          ok: false,
          message: `候选 target 但 url 不含 extension id：${candidates[0].url}`,
        };
      }
      ctx.extId = m[1];
      // 进一步过滤：只保留属于本扩展的
      ctx.extTargets = targets.filter((t) =>
        t.url?.startsWith(`chrome-extension://${ctx.extId}/`),
      );
      // SW target 的 url 是 chrome-extension://<id>/service-worker-loader.js
      ctx.swTarget = ctx.extTargets.find(
        (t) =>
          t.type === 'service_worker' ||
          t.url?.includes('service-worker-loader'),
      );
      return {
        ok: true,
        message: `id=${ctx.extId} (${ctx.extTargets.length} targets, sw=${ctx.swTarget ? 'yes' : 'no'})`,
      };
    },
  },
  {
    name: '1.2  Service Worker 可达',
    critical: true,
    async run(ctx) {
      if (!ctx.swTarget) {
        return { ok: false, message: 'SW target 不存在（可能扩展刚加载，等几秒重试）' };
      }
      ctx.swCdp = await connect(ctx.swTarget.webSocketDebuggerUrl);
      await ctx.swCdp.send('Runtime.enable');
      await ctx.swCdp.send('Log.enable').catch(() => {});
      const hasChrome = await evalIn(
        ctx.swCdp,
        '(typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined")',
      );
      return {
        ok: hasChrome === true,
        message: hasChrome ? 'chrome.runtime ready' : 'chrome API not present',
      };
    },
  },
  {
    name: '1.3  打开 options 页作为消息发送代理',
    critical: true,
    async run(ctx) {
      // 关键设计：chrome.runtime.sendMessage 在 SW 内部调用时，listener 是同一个 SW，
      // 不会回调到自己（"Receiving end does not exist"）。必须从其他扩展页发。
      // options 页是 chrome-extension://<id>/，能调 chrome.runtime.sendMessage 给 SW。
      const optionsUrl = `chrome-extension://${ctx.extId}/src/options/index.html`;
      const t = await newTab(optionsUrl);
      ctx.optionsTabId = t.id;
      await sleep(800);
      const targets = await listTargets();
      const fresh = targets.find((x) => x.id === t.id);
      if (!fresh?.webSocketDebuggerUrl) {
        return { ok: false, message: 'options page target 没拿到' };
      }
      ctx.optionsCdp = await connect(fresh.webSocketDebuggerUrl);
      await ctx.optionsCdp.send('Runtime.enable');
      // 等 chrome.runtime 注入完毕
      await waitFor(
        () =>
          evalIn(
            ctx.optionsCdp,
            'typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined"',
          ),
        { timeout: 5000 },
      );
      // 备份用户原始 settings，cleanup 时还原（避免 verify 污染用户配置）
      ctx.savedSettings = await evalIn(
        ctx.optionsCdp,
        `chrome.storage.local.get('llmSettings').then(r => r.llmSettings ?? null)`,
      );
      return {
        ok: true,
        message:
          `options tab id=${t.id.slice(0, 8)}` +
          (ctx.savedSettings ? ', 已备份用户 settings' : ''),
      };
    },
  },
  {
    name: '2.0  日志系统：sessionId 存在',
    critical: false,
    async run(ctx) {
      const r = await evalIn(
        ctx.optionsCdp,
        `chrome.runtime.sendMessage({ type: 'LOG_QUERY', limit: 5 })`,
      );
      if (!r || !r.ok) {
        return {
          ok: false,
          message: `LOG_QUERY 未返回 ok：${JSON.stringify(r)?.slice(0, 100)}`,
        };
      }
      ctx.swSessionId = r.sessionId;
      return {
        ok: true,
        message: `session=${r.sessionId.slice(0, 8)}, total=${r.total}`,
      };
    },
  },
  {
    name: '2.1  注入测试日志能被查询到',
    critical: false,
    async run(ctx) {
      const tag = `verify-${Date.now()}`;
      await evalIn(
        ctx.optionsCdp,
        `chrome.runtime.sendMessage({
           type: 'LOG_APPEND',
           entries: [{
             seq: 999999,
             ts: Date.now(),
             sessionId: 'verify-script',
             level: 'info',
             source: 'background',
             module: 'verify',
             event: 'self.test',
             data: { tag: ${JSON.stringify(tag)} }
           }]
         })`,
      );
      await sleep(200);
      const r = await evalIn(
        ctx.optionsCdp,
        `chrome.runtime.sendMessage({
           type: 'LOG_QUERY',
           filter: { keyword: ${JSON.stringify(tag)} },
           limit: 10
         })`,
      );
      const found = r?.entries?.length > 0;
      return {
        ok: found,
        message: found ? `查到 ${r.entries.length} 条匹配` : '注入后未查到',
      };
    },
  },
  {
    name: '3.0  打开测试表单页',
    critical: true,
    async run(ctx) {
      // 步骤：
      //   1) 新开 example.com tab（http 页，content script 会被注入）
      //   2) 等页面加载完，再注入我们的测试表单 HTML 到 body
      //   3) 等 1.5s 让 MutationObserver 等机制稳定
      const t = await newTab(TEST_HOST_URL);
      ctx.testTabId = t.id;
      await activateTarget(t.id);
      await sleep(1200);

      const targets = await listTargets();
      const fresh = targets.find((x) => x.id === t.id);
      if (!fresh?.webSocketDebuggerUrl) {
        return { ok: false, message: '测试 tab target 没拿到' };
      }
      ctx.testTabCdp = await connect(fresh.webSocketDebuggerUrl);
      await ctx.testTabCdp.send('Runtime.enable');
      await ctx.testTabCdp.send('Page.enable');

      // 等 document 至少进入 interactive
      await waitFor(
        async () =>
          (await evalIn(ctx.testTabCdp, 'document.readyState')) !== 'loading',
        { timeout: 8000 },
      );

      // 注入测试表单（替换 body 内容）。注意 example.com 的 CSP 不限制 inline DOM 操作
      await evalIn(
        ctx.testTabCdp,
        `(() => {
          document.body.innerHTML = ${JSON.stringify(TEST_FORM_HTML)};
          return true;
        })()`,
      );
      await sleep(300);

      const formCount = await evalIn(
        ctx.testTabCdp,
        'document.querySelectorAll("input,select,textarea").length',
      );
      return {
        ok: typeof formCount === 'number' && formCount >= 5,
        message: `tab id=${t.id.slice(0, 8)}, 注入后字段数=${formCount}`,
      };
    },
  },
  {
    name: '3.1  扩展抓取字段（EXTRACT_FIELDS）',
    critical: true,
    async run(ctx) {
      // 通过 options page 调 chrome.tabs.sendMessage 给测试 tab，
      // 触发 content script 的 extractFields。
      const tabId = await findChromeTabIdByUrl(ctx, TEST_HOST_URL);
      if (!tabId) return { ok: false, message: '没找到测试 tab 的 chrome.tabs id' };
      ctx.testChromeTabId = tabId;

      const r = await evalIn(
        ctx.optionsCdp,
        `chrome.tabs.sendMessage(${tabId}, { type: 'EXTRACT_FIELDS' })`,
      );
      if (!r?.ok) {
        return {
          ok: false,
          message: `EXTRACT_FIELDS 失败：${JSON.stringify(r)?.slice(0, 150)}`,
        };
      }
      ctx.extractedFields = r.result.fields;
      ctx.extractedPageSummary = r.result.pageSummary;
      return {
        ok: r.result.fields.length >= 4,
        message: `抓到 ${r.result.fields.length} 字段, 跳过 ${r.result.skipped}, ${r.result.durationMs}ms${r.result.pageSummary ? `, summary(${r.result.pageSummary.headings.length}h+${r.result.pageSummary.intro.length}c)` : ''}`,
      };
    },
  },
  {
    name: '3.2  字段含 label 推断结果',
    critical: false,
    async run(ctx) {
      const fields = ctx.extractedFields ?? [];
      const labels = fields.map((f) => f.label);
      const hasNamedLabels = labels.filter(
        (l) => l && l !== '(未识别)' && l.length < 30,
      ).length;
      return {
        ok: hasNamedLabels >= Math.min(3, fields.length),
        message: `labels=[${labels.slice(0, 5).join(', ')}${labels.length > 5 ? '...' : ''}]`,
      };
    },
  },
  {
    name: '4.0  回填器写入字段（FILL_FIELDS）',
    critical: true,
    async run(ctx) {
      const fields = ctx.extractedFields ?? [];
      if (!ctx.testChromeTabId || fields.length === 0) {
        return { ok: false, message: 'no tab/fields' };
      }
      // 构造一组期望填的值（针对测试表单字段名固定）
      // 不走 LLM，直接给 fills——本步专测 filler，与 LLM 解耦
      const fills = [];
      for (const f of fields) {
        if (f.kind === 'text' && /name|姓/.test(f.label + (f.name ?? ''))) {
          fills.push({ id: f.id, value: '验证-张三', reason: 'verify' });
        } else if (f.type === 'email') {
          fills.push({ id: f.id, value: 'verify@example.com', reason: 'verify' });
        } else if (f.kind === 'select' && f.options?.length > 0) {
          fills.push({
            id: f.id,
            value: f.options[f.options.length - 1].value,
            reason: 'verify',
          });
        } else if (f.kind === 'checkbox') {
          fills.push({ id: f.id, value: 'true', reason: 'verify' });
        } else if (f.kind === 'radio' && f.options?.length > 0) {
          fills.push({ id: f.id, value: f.options[0].value, reason: 'verify' });
        }
      }
      ctx.fillsApplied = fills;

      const r = await evalIn(
        ctx.optionsCdp,
        `chrome.tabs.sendMessage(${ctx.testChromeTabId}, {
           type: 'FILL_FIELDS',
           fills: ${JSON.stringify(fills)}
         })`,
      );
      if (!r?.ok) {
        return { ok: false, message: `FILL_FIELDS 失败：${JSON.stringify(r)?.slice(0, 150)}` };
      }
      const okCount = r.reports.filter((x) => x.status === 'ok').length;
      ctx.fillReports = r.reports;
      return {
        ok: okCount === fills.length,
        message: `${okCount}/${fills.length} 写入成功`,
        details: { fills, reports: r.reports },
      };
    },
  },
  {
    name: '4.1  DOM 校验：填入值确实出现',
    critical: true,
    async run(ctx) {
      // 在测试 tab 里直接读 DOM，断言期望值
      const expr = `({
        textName: document.querySelector('[name="username"]')?.value,
        email:    document.querySelector('[name="email"]')?.value,
        country:  document.querySelector('[name="country"]')?.value,
        subscribe:document.querySelector('[name="subscribe"]')?.checked,
        gender:   Array.from(document.querySelectorAll('[name="gender"]')).find(r => r.checked)?.value
      })`;
      // ctx.testTabCdp 在长时间等 LLM 后可能 ws 断了，先检查
      if (!ctx.testTabCdp || ctx.testTabCdp.readyState !== 1) {
        const targets = await listTargets();
        const fresh = targets.find((x) => x.id === ctx.testTabId);
        if (!fresh?.webSocketDebuggerUrl) {
          return { ok: false, message: '测试 tab 已不存在' };
        }
        if (ctx.testTabCdp) ctx.testTabCdp.close();
        ctx.testTabCdp = await connect(fresh.webSocketDebuggerUrl);
        await ctx.testTabCdp.send('Runtime.enable');
      }
      const dom = await evalIn(ctx.testTabCdp, `(${expr})`);
      const checks = [
        { key: 'textName', want: '验证-张三', got: dom.textName },
        { key: 'email', want: 'verify@example.com', got: dom.email },
        { key: 'subscribe', want: true, got: dom.subscribe },
        { key: 'country', wantNonEmpty: true, got: dom.country },
        { key: 'gender', wantNonEmpty: true, got: dom.gender },
      ];
      const fails = checks.filter((c) =>
        c.want !== undefined ? c.got !== c.want : !c.got,
      );
      return {
        ok: fails.length === 0,
        message: fails.length === 0
          ? `所有字段校验通过`
          : `${fails.length} 项不匹配: ${fails.map((f) => f.key).join(',')}`,
        details: { dom, checks, fillReports: ctx.fillReports },
      };
    },
  },
  {
    name: '5.0  日志系统记录到本次操作',
    critical: false,
    async run(ctx) {
      const r = await evalIn(
        ctx.optionsCdp,
        `chrome.runtime.sendMessage({
           type: 'LOG_QUERY',
           filter: { keyword: 'fill.field.ok' },
           limit: 100
         })`,
      );
      const fillOkCount = r?.entries?.length ?? 0;
      const r2 = await evalIn(
        ctx.optionsCdp,
        `chrome.runtime.sendMessage({
           type: 'LOG_QUERY',
           filter: { keyword: 'extract.done' },
           limit: 100
         })`,
      );
      const extractDoneCount = r2?.entries?.length ?? 0;
      return {
        ok: fillOkCount > 0 && extractDoneCount > 0,
        message: `extract.done=${extractDoneCount}, fill.field.ok=${fillOkCount}`,
      };
    },
  },
  {
    name: '6.0  LLM 服务连通预检',
    critical: false,
    async run(ctx) {
      // 预检：脚本进程 fetch 一下，决定后面 6.1/6.2 是否跑。
      // 用 /chat/completions 探一个最小请求；不通就标 skip。
      try {
        const res = await fetch(`${LLM_ENDPOINT}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer not-needed',
          },
          body: JSON.stringify({
            model: LLM_MODEL,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          ctx.llmSkip = true;
          return {
            ok: false,
            message: `LLM 不通 HTTP ${res.status}，跳过 6.1/6.2`,
          };
        }
        ctx.llmAvailable = true;
        return { ok: true, message: `${LLM_ENDPOINT} 可达` };
      } catch (err) {
        ctx.llmSkip = true;
        return {
          ok: false,
          message: `LLM 不可达：${err instanceof Error ? err.message : err}（跳过 6.1/6.2）`,
        };
      }
    },
  },
  {
    name: '6.1  写入 settings 并触发 LLM_GENERATE_FILLS',
    critical: false,
    async run(ctx) {
      if (!ctx.llmAvailable) return { ok: false, message: 'LLM 不可达，跳过' };
      // 直接通过 chrome.storage.local 写 settings，避免开 sidepanel
      await evalIn(
        ctx.optionsCdp,
        `chrome.storage.local.set({
           llmSettings: {
             endpoint: ${JSON.stringify(LLM_ENDPOINT)},
             apiKey: 'not-needed',
             model: ${JSON.stringify(LLM_MODEL)},
             temperature: 0.3
           }
         })`,
      );
      // 触发 LLM_GENERATE_FILLS。fields 直接用前面 3.1 抓到的，省一次抓取。
      // 用户意图刻意明确，便于后面断言。
      const intent =
        '帮我填注册表，用户名 verify-llm-用户，邮箱 llm@verify.test，国家选中国，性别选女，订阅周刊';
      ctx.llmStartedAt = Date.now();
      const r = await evalIn(
        ctx.optionsCdp,
        `chrome.runtime.sendMessage({
           type: 'LLM_GENERATE_FILLS',
           userIntent: ${JSON.stringify(intent)},
           fields: ${JSON.stringify(ctx.extractedFields ?? [])},
           pageUrl: ${JSON.stringify(TEST_HOST_URL)},
           pageTitle: 'verify form'
         })`,
        // LLM 可能慢，给足时间
        { awaitPromise: true },
      );
      if (!r?.ok) {
        return {
          ok: false,
          message: `LLM_GENERATE_FILLS 未返回 ok：${JSON.stringify(r)?.slice(0, 200)}`,
        };
      }
      ctx.llmFills = r.fills;
      ctx.llmDebug = r.debug;
      return {
        ok: r.fills.length >= 3,
        message:
          `${r.fills.length} fills · ${r.debug.model} · ${r.debug.durationMs}ms · ` +
          `tokens=${r.debug.promptTokens ?? '?'}/${r.debug.completionTokens ?? '?'}`,
      };
    },
  },
  {
    name: '6.3  扩展重载后已打开 tab 的连接修复',
    critical: true,
    async run(ctx) {
      // 复刻用户真实场景：tab 已开 → 扩展 reload → content script 失联。
      // 通过 chrome.runtime.reload() 触发重载（SW 重启，已有 tab 上 content script 进程级失联）。
      // 然后用 sidepanel/messaging.ts 的策略（frameId:0 + 注入兜底）应该能恢复。
      //
      // 注意：reload 后所有 CDP 连接都会断，需要重连。
      const oldExtId = ctx.extId;
      const oldTabId = ctx.testChromeTabId;
      const oldTestTabTargetId = ctx.testTabId;
      if (!oldTabId || !oldTestTabTargetId) {
        return { ok: false, message: '上一步没传 testChromeTabId / testTabId' };
      }

      // 通过 SW 触发自身 reload
      const swCdp2 = await connect(ctx.swTarget.webSocketDebuggerUrl);
      await swCdp2.send('Runtime.enable');
      // reload 不等响应（reload 后 ws 立即断）
      evalIn(swCdp2, 'chrome.runtime.reload()').catch(() => {});
      await sleep(2000);
      try {
        swCdp2.close();
      } catch {}
      // 旧 optionsCdp / swCdp / testTabCdp 都失效了
      try {
        ctx.optionsCdp.close();
      } catch {}
      try {
        ctx.swCdp.close();
      } catch {}
      try {
        ctx.testTabCdp.close();
      } catch {}

      // 等扩展重新启动并重新拿到 SW target
      let swTarget;
      for (let i = 0; i < 10; i++) {
        const targets = await listTargets();
        swTarget = targets.find(
          (t) =>
            t.url?.startsWith(`chrome-extension://${oldExtId}/`) &&
            (t.type === 'service_worker' ||
              t.url?.includes('service-worker-loader')),
        );
        if (swTarget) break;
        await sleep(500);
      }
      if (!swTarget) {
        return { ok: false, message: 'reload 后 SW 未恢复' };
      }
      ctx.swTarget = swTarget;

      // 重开 options 当代理（旧 optionsTabId 在新扩展 ID 下也仍能连，但保险起见重开）
      const optTab = await newTab(
        `chrome-extension://${oldExtId}/src/options/index.html`,
      );
      ctx.optionsTabId = optTab.id;
      await sleep(800);
      const all = await listTargets();
      const fresh = all.find((x) => x.id === optTab.id);
      ctx.optionsCdp = await connect(fresh.webSocketDebuggerUrl);
      await ctx.optionsCdp.send('Runtime.enable');
      await waitFor(
        () =>
          evalIn(
            ctx.optionsCdp,
            'typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined"',
          ),
        { timeout: 5000 },
      );

      // 关键：在原测试 tab（仍存活但 content script 失联）上模拟 sidepanel/messaging.ts 的策略
      const result = await evalIn(
        ctx.optionsCdp,
        `(async () => {
           const tabId = ${oldTabId};
           const msg = { type: 'EXTRACT_FIELDS' };
           const sleep = (ms) => new Promise(r => setTimeout(r, ms));
           async function tryOnce() {
             return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
           }
           function isConn(e) {
             return String(e).includes('Could not establish connection') ||
                    String(e).includes('Receiving end does not exist');
           }
           try {
             const r = await tryOnce();
             return { phase: 'first-try', ok: true, r };
           } catch (e) {
             if (!isConn(e)) return { phase: 'first-try', ok: false, error: String(e) };
             const cs = chrome.runtime.getManifest().content_scripts[0];
             const inj = await chrome.scripting.executeScript({
               target: { tabId, allFrames: cs.all_frames ?? false },
               files: cs.js,
             });
             // crxjs loader 异步 import：backoff 重试
             const delays = [50, 100, 200, 400, 800];
             let lastErr;
             for (const d of delays) {
               await sleep(d);
               try {
                 const r = await tryOnce();
                 return { phase: 'after-inject-retry-' + d, ok: true, frames: inj.length, r };
               } catch (e2) {
                 lastErr = e2;
                 if (!isConn(e2)) return { phase: 'after-inject', ok: false, error: String(e2) };
               }
             }
             return { phase: 'after-inject-exhausted', ok: false, frames: inj.length, error: String(lastErr) };
           }
         })()`,
      );

      if (!result.ok || !result.r?.ok) {
        return {
          ok: false,
          message: `修复失败: ${JSON.stringify(result).slice(0, 200)}`,
        };
      }
      // 重新连测试 tab CDP，给 7.0 用
      const testFresh = (await listTargets()).find(
        (x) => x.id === oldTestTabTargetId,
      );
      if (testFresh) {
        ctx.testTabCdp = await connect(testFresh.webSocketDebuggerUrl);
        await ctx.testTabCdp.send('Runtime.enable');
      }
      // 替换 swCdp 让后续步骤复用
      ctx.swCdp = await connect(swTarget.webSocketDebuggerUrl);
      await ctx.swCdp.send('Runtime.enable');

      return {
        ok: true,
        message: `${result.phase} → ${result.r.result.fields.length} 字段恢复`,
      };
    },
  },
  // 注意：7.0 必须放在 6.x 之后——它会重写 testTab 的 DOM。
  {
    name: '7.0  React valueTracker 兼容性（受控组件模拟）',
    critical: true,
    async run(ctx) {
      // 6.x 之间长时间等待 LLM 后，testTabCdp 的 ws 可能已经断了。重连。
      if (!ctx.testTabCdp || ctx.testTabCdp.readyState !== 1 /* OPEN */) {
        const targets = await listTargets();
        const fresh = targets.find((x) => x.id === ctx.testTabId);
        if (!fresh?.webSocketDebuggerUrl) {
          return { ok: false, message: '测试 tab 已不存在' };
        }
        if (ctx.testTabCdp) ctx.testTabCdp.close();
        ctx.testTabCdp = await connect(fresh.webSocketDebuggerUrl);
        await ctx.testTabCdp.send('Runtime.enable');
      }

      // 真实 React 受控组件的核心机制：
      //   React 内部用 valueTracker 缓存 input 的 lastValue，
      //   onChange 触发时如果当前 value === lastValue 就跳过 setState。
      //   直接 el.value = x 不会更新 lastValue，导致 React 觉得"值没变"。
      //   必须用 native setter（HTMLInputElement.prototype.value 的 set）
      //   才会让 valueTracker 重置。
      //
      // 这一步：在测试 tab 注入一个等价的 valueTracker，
      //         扩展回填后断言 valueTracker 的 lastValue == input.value，
      //         以及 onChange 被触发了一次。
      //
      // 流程：
      //   1) 注入新表单（仅一个 text input + 一个 select）
      //   2) 给两个元素装上 valueTracker 和 onChange spy
      //   3) 重新触发抓取（拿到新 ids）
      //   4) 触发回填
      //   5) 检查 lastValue 同步、onChange 被调用

      // 步骤 1+2：注入新表单 + valueTracker
      await evalIn(
        ctx.testTabCdp,
        `(() => {
          document.body.innerHTML = \`
            <input id="ti" type="text" name="reactlike" />
            <select id="ts" name="rselect">
              <option value="">--</option>
              <option value="A">A选项</option>
              <option value="B">B选项</option>
            </select>
          \`;
          const ti = document.getElementById('ti');
          const ts = document.getElementById('ts');

          // 安装 valueTracker：模拟 React 的实现。
          // 关键：劫持 prototype 的 setter 不行（那是 native setter），
          // 而是劫持 instance 上的 value 属性，让 React-style 的 lastValue 跟踪。
          function installTracker(el, protoCtor) {
            const desc = Object.getOwnPropertyDescriptor(protoCtor.prototype, 'value');
            let lastValue = el.value;
            const tracker = {
              getValue: () => lastValue,
              setValue: (v) => { lastValue = v; },
            };
            // 劫持实例 value：写时同步到 native + 更新 lastValue（仅当 React 主动 setState 时）。
            // 这里我们模拟：实例上的 set 把值写到 native，但 lastValue 只通过 tracker.setValue 改。
            Object.defineProperty(el, 'value', {
              configurable: true,
              get() { return desc.get.call(this); },
              set(v) {
                desc.set.call(this, v);
                // 关键：React 不在这里更新 lastValue
                // —— 受控组件的 onChange 才会调 tracker.setValue
              },
            });
            return tracker;
          }

          window.__tiTracker = installTracker(ti, HTMLInputElement);
          window.__tsTracker = installTracker(ts, HTMLSelectElement);

          // onChange spy：模拟受控组件的 controller。
          // React 的逻辑：onChange 时取 currentValue（native 读），
          //             如果 currentValue !== lastValue 才走 setState 流程，
          //             并 tracker.setValue(currentValue) 同步。
          window.__tiChangeCount = 0;
          window.__tsChangeCount = 0;
          ti.addEventListener('input', (e) => {
            const cur = HTMLInputElement.prototype.__lookupGetter__('value').call(e.target);
            if (cur !== window.__tiTracker.getValue()) {
              window.__tiTracker.setValue(cur);
              window.__tiChangeCount++;
              window.__tiLastSeen = cur;
            }
          });
          ts.addEventListener('change', (e) => {
            const cur = HTMLSelectElement.prototype.__lookupGetter__('value').call(e.target);
            if (cur !== window.__tsTracker.getValue()) {
              window.__tsTracker.setValue(cur);
              window.__tsChangeCount++;
              window.__tsLastSeen = cur;
            }
          });

          return true;
        })()`,
      );

      // 步骤 3：重新抓取
      const extractR = await evalIn(
        ctx.optionsCdp,
        `chrome.tabs.sendMessage(${ctx.testChromeTabId}, { type: 'EXTRACT_FIELDS' })`,
      );
      if (!extractR?.ok) {
        return {
          ok: false,
          message: `重新抓取失败：${JSON.stringify(extractR)?.slice(0, 150)}`,
        };
      }
      const fields = extractR.result.fields;
      const tiField = fields.find((f) => f.name === 'reactlike');
      const tsField = fields.find((f) => f.name === 'rselect');
      if (!tiField || !tsField) {
        return {
          ok: false,
          message: `字段未抓全：tiField=${!!tiField}, tsField=${!!tsField}`,
        };
      }

      // 步骤 4：回填
      const fillR = await evalIn(
        ctx.optionsCdp,
        `chrome.tabs.sendMessage(${ctx.testChromeTabId}, {
           type: 'FILL_FIELDS',
           fills: [
             { id: ${tiField.id}, value: 'react-controlled-text', reason: 'verify' },
             { id: ${tsField.id}, value: 'B', reason: 'verify' }
           ]
         })`,
      );
      if (!fillR?.ok) {
        return { ok: false, message: `回填失败：${JSON.stringify(fillR)?.slice(0, 150)}` };
      }

      // 步骤 5：断言。关键 4 条：
      //   a) input.value（DOM 真实值）= 期望值
      //   b) tracker.lastValue = 期望值（valueTracker 同步成功）
      //   c) onChange 被触发了至少 1 次（说明扩展 dispatch 了正确事件）
      //   d) 同上 select
      const obs = await evalIn(
        ctx.testTabCdp,
        `({
           tiValue: document.getElementById('ti').value,
           tiTracker: window.__tiTracker.getValue(),
           tiChangeCount: window.__tiChangeCount,
           tsValue: document.getElementById('ts').value,
           tsTracker: window.__tsTracker.getValue(),
           tsChangeCount: window.__tsChangeCount,
         })`,
      );
      const issues = [];
      if (obs.tiValue !== 'react-controlled-text')
        issues.push(`text input.value="${obs.tiValue}"`);
      if (obs.tiTracker !== 'react-controlled-text')
        issues.push(`text valueTracker="${obs.tiTracker}"`);
      if (obs.tiChangeCount < 1)
        issues.push(`text onChange 未触发 (count=${obs.tiChangeCount})`);
      if (obs.tsValue !== 'B') issues.push(`select value="${obs.tsValue}"`);
      if (obs.tsTracker !== 'B') issues.push(`select valueTracker="${obs.tsTracker}"`);
      if (obs.tsChangeCount < 1)
        issues.push(`select onChange 未触发 (count=${obs.tsChangeCount})`);

      return {
        ok: issues.length === 0,
        message:
          issues.length === 0
            ? `valueTracker 同步 + onChange 触发: text(${obs.tiChangeCount}次) select(${obs.tsChangeCount}次)`
            : issues.join('; '),
        details: obs,
      };
    },
  },
  {
    name: '8.0  字段含 nearbyContext 与 pageSummary',
    critical: false,
    async run(ctx) {
      const fields = ctx.extractedFields ?? [];
      const withCtx = fields.filter((f) => f.nearbyContext).length;
      // 测试表单字段都被一个 div 包着，应该都有 nearbyContext
      // pageSummary 由 extractor 从 document 抽取，应该总是有
      const hasSummary = !!ctx.extractedPageSummary;
      return {
        ok: withCtx >= 3 && hasSummary,
        message: `nearbyContext=${withCtx}/${fields.length}, pageSummary=${hasSummary ? 'yes' : 'no'}`,
      };
    },
  },
  {
    name: '8.1  🪄 自动生成「以假乱真」意图（无 profile）',
    critical: false,
    async run(ctx) {
      if (!ctx.llmAvailable) return { ok: false, message: 'LLM 不可达，跳过' };
      // 不再写 profile。settings 里只有 endpoint/key/model
      await evalIn(
        ctx.optionsCdp,
        `chrome.storage.local.set({
           llmSettings: {
             endpoint: ${JSON.stringify(LLM_ENDPOINT)},
             apiKey: 'not-needed',
             model: ${JSON.stringify(LLM_MODEL)},
             temperature: 0.3
           }
         })`,
      );

      const r = await evalIn(
        ctx.optionsCdp,
        `chrome.runtime.sendMessage({
           type: 'LLM_GENERATE_INTENT',
           fields: ${JSON.stringify(ctx.extractedFields ?? [])},
           pageUrl: ${JSON.stringify(TEST_HOST_URL)},
           pageTitle: 'verify form',
           pageSummary: ${JSON.stringify(ctx.extractedPageSummary ?? null)}
         })`,
        { awaitPromise: true },
      );

      if (!r?.ok) {
        return {
          ok: false,
          message: `INTENT 未返回 ok：${JSON.stringify(r)?.slice(0, 200)}`,
        };
      }

      ctx.generatedIntent = r.intent;

      // 关键断言：不能出现 <...> 占位符（以假乱真规则的核心）
      const hasPlaceholder = /<[^>]+>/.test(r.intent);
      // 必须含真实邮箱格式
      const hasEmail = /\S+@\S+\.\S+/.test(r.intent);
      // 必须提到字段对应的内容（用户名/邮箱/国家/性别/订阅 中至少 3 个 label 关键词）
      const labelHits = [
        '用户名',
        '邮箱',
        '国家',
        '性别',
        '订阅',
      ].filter((kw) => r.intent.includes(kw)).length;

      const ok =
        !hasPlaceholder &&
        hasEmail &&
        labelHits >= 3 &&
        r.intent.length >= 20 &&
        r.intent.length <= 800;

      return {
        ok,
        message:
          `${r.intent.length}字 · ${r.debug.model} · ${r.debug.durationMs}ms · ` +
          `placeholder=${hasPlaceholder ? '❌有' : '✓无'} · email=${hasEmail ? '✓' : '❌'} · labels=${labelHits}/5\n        ${r.intent.slice(0, 140)}${r.intent.length > 140 ? '…' : ''}`,
      };
    },
  },
  {
    name: '8.2  🪄 含用户已有意图时优先采用其中信息',
    critical: false,
    async run(ctx) {
      if (!ctx.llmAvailable) return { ok: false, message: 'LLM 不可达，跳过' };
      // 用户已经在 textarea 里写了：明确指定 username 和 email
      const existingIntent = '帮我填，用户名 lin-wei-2026，邮箱 linwei@gmail.com';
      const r = await evalIn(
        ctx.optionsCdp,
        `chrome.runtime.sendMessage({
           type: 'LLM_GENERATE_INTENT',
           fields: ${JSON.stringify(ctx.extractedFields ?? [])},
           pageUrl: ${JSON.stringify(TEST_HOST_URL)},
           pageTitle: 'verify form',
           pageSummary: ${JSON.stringify(ctx.extractedPageSummary ?? null)},
           existingIntent: ${JSON.stringify(existingIntent)}
         })`,
        { awaitPromise: true },
      );
      if (!r?.ok) return { ok: false, message: JSON.stringify(r).slice(0, 150) };

      // LLM 必须采用用户给的明确信息
      const keepsUsername = r.intent.includes('lin-wei-2026');
      const keepsEmail = r.intent.includes('linwei@gmail.com');
      const noPlaceholder = !/<[^>]+>/.test(r.intent);

      return {
        ok: keepsUsername && keepsEmail && noPlaceholder,
        message:
          `保留用户名=${keepsUsername ? '✓' : '❌'} 邮箱=${keepsEmail ? '✓' : '❌'} 无占位符=${noPlaceholder ? '✓' : '❌'}\n        ${r.intent.slice(0, 140)}${r.intent.length > 140 ? '…' : ''}`,
      };
    },
  },
  {
    name: '6.2  LLM 返回的 fills 满足 schema 与意图',
    critical: false,
    async run(ctx) {
      if (!ctx.llmFills) return { ok: false, message: 'LLM 不可达，跳过' };
      const fields = ctx.extractedFields ?? [];
      const fieldById = new Map(fields.map((f) => [f.id, f]));
      const issues = [];
      for (const fill of ctx.llmFills) {
        const f = fieldById.get(fill.id);
        if (!f) {
          issues.push(`id=${fill.id} 不存在`);
          continue;
        }
        if (typeof fill.value !== 'string') {
          issues.push(`#${fill.id}(${f.label}) value 非 string`);
          continue;
        }
        // select/radio 必须是合法 option.value
        if ((f.kind === 'select' || f.kind === 'radio') && f.options) {
          const validValues = f.options.map((o) => o.value);
          if (!validValues.includes(fill.value)) {
            issues.push(
              `#${fill.id}(${f.label}) value="${fill.value}" 不在 options [${validValues.join(',')}]`,
            );
          }
        }
        if (f.kind === 'checkbox' && !['true', 'false'].includes(fill.value)) {
          issues.push(`#${fill.id}(${f.label}) checkbox value 应为 true/false`);
        }
      }
      // 弱断言意图：邮箱字段值含 '@'
      const emailField = fields.find((f) => f.type === 'email');
      if (emailField) {
        const emailFill = ctx.llmFills.find((x) => x.id === emailField.id);
        if (emailFill && !emailFill.value.includes('@')) {
          issues.push(`email 字段填的不像 email：${emailFill.value}`);
        }
      }
      const summary = ctx.llmFills
        .map((f) => {
          const lbl = fieldById.get(f.id)?.label ?? '?';
          return `${lbl}=${truncate(f.value, 12)}`;
        })
        .join(', ');
      return {
        ok: issues.length === 0,
        message:
          issues.length === 0
            ? `schema 合法 · ${summary}`
            : `${issues.length} 项问题: ${issues.slice(0, 2).join('; ')}`,
      };
    },
  },
];

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------- 工具：找 chrome.tabs id ----------

async function findChromeTabIdByUrl(ctx, url) {
  // 通过 options page 调 chrome.tabs.query。
  // data: URL 长度大，用 startsWith 前 60 字符匹配。
  const r = await evalIn(
    ctx.optionsCdp,
    `(async () => {
       const all = await chrome.tabs.query({});
       const exact = all.find(t => t.url === ${JSON.stringify(url)});
       if (exact) return exact.id;
       const starts = all.find(t => t.url && t.url.startsWith(${JSON.stringify(url.slice(0, 60))}));
       return starts?.id;
     })()`,
  );
  return r;
}

// ---------- 测试表单 HTML（注入到 example.com body）----------

function buildTestFormHtml() {
  return `<div style="font-family:system-ui;padding:20px;max-width:600px">
  <h1>E2E 验证表单</h1>
  <form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent=JSON.stringify(Object.fromEntries(new FormData(this)))">
    <p><label>用户名 <input name="username" required></label></p>
    <p><label>邮箱 <input type="email" name="email" required></label></p>
    <p><label>国家
      <select name="country">
        <option value="">--请选择--</option>
        <option value="CN">中国</option>
        <option value="US">美国</option>
        <option value="JP">日本</option>
      </select>
    </label></p>
    <fieldset><legend>性别</legend>
      <label><input type="radio" name="gender" value="m">男</label>
      <label><input type="radio" name="gender" value="f">女</label>
      <label><input type="radio" name="gender" value="o">其他</label>
    </fieldset>
    <p><label><input type="checkbox" name="subscribe">订阅周刊</label></p>
    <button type="submit">提交</button>
    <pre id="out"></pre>
  </form>
</div>`;
}

// ---------- 报告输出 ----------

function printHeader() {
  console.log('');
  console.log(bold('  Chrome 网页助手 · 端到端自验证'));
  console.log(dim(`  ${new Date().toLocaleString()}`));
  console.log('');
}

function printSummary(results) {
  console.log('');
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && r.step.critical).length;
  const skipped = results.filter((r) => !r.ok && !r.step.critical).length;
  console.log(
    bold('  汇总: ') +
      green(`${passed} pass`) +
      ' · ' +
      red(`${failed} fail`) +
      ' · ' +
      yellow(`${skipped} skip`) +
      ' / ' +
      total,
  );
  console.log('');
}

function printDetails(r) {
  if (r.details) {
    console.error(dim('  details:'));
    console.error(dim('  ' + JSON.stringify(r.details, null, 2).split('\n').join('\n  ')));
  }
}

// ---------- 颜色（不引依赖） ----------
const colorOn = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => colorOn ? `\x1b[${code}m${s}\x1b[0m` : s;
const green = wrap(32);
const red = wrap(31);
const yellow = wrap(33);
const dim = wrap(2);
const bold = wrap(1);

// ---------- 启动 ----------

main().catch((err) => {
  console.error(red(`\n未捕获异常：${err.message}`));
  if (err.stack) console.error(dim(err.stack));
  process.exit(1);
});
