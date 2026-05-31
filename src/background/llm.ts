// LLM 客户端：调用 OpenAI 兼容 chat/completions 接口，返回结构化 fill 指令。
//
// 架构原则（来自记忆 architecture_decisions）：
//   - 在 service worker 里发请求，避免页面 CSP / 暴露 key
//   - LLM 返回的填写指令必须用 id 引用字段，不让模型生成 selector
//   - JSON 解析失败给用户报错，而非静默吞掉
//
// 兼容 ZenVFX 本地代理：
//   - endpoint 形如 http://localhost:3000/api/v1/llm，再拼 /chat/completions
//   - 错误响应可能是 { success:false, error:{code,message} }，要识别后给友好提示

import {
  DEFAULT_SETTINGS,
  type ExtractedField,
  type FillInstruction,
  type LlmFillsPayload,
  type LlmSettings,
  type PageSummary,
} from '../shared/messages';
import { createLogger } from '../shared/logger';

const log = createLogger('background', 'llm');

const REQUEST_TIMEOUT_MS = 60_000;

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string };
}

interface ZenvfxErrorResponse {
  success: false;
  error?: { code?: string; message?: string };
}

export interface GenerateFillsResult {
  fills: FillInstruction[];
  model: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export async function generateFills(args: {
  settings: LlmSettings;
  userIntent: string;
  fields: ExtractedField[];
  pageUrl: string;
  pageTitle: string;
}): Promise<GenerateFillsResult> {
  const { settings, userIntent, fields, pageUrl, pageTitle } = args;
  const startedAt = Date.now();

  if (fields.length === 0) {
    throw new Error('当前页面没有可填字段，无法调用 LLM');
  }
  if (!userIntent.trim()) {
    throw new Error('请先输入要填写什么内容');
  }

  const url = buildChatCompletionsUrl(settings.endpoint);
  const userPromptContent = buildUserPrompt({
    userIntent,
    fields,
    pageUrl,
    pageTitle,
  });
  const body = {
    model: settings.model || DEFAULT_SETTINGS.model,
    temperature: settings.temperature ?? DEFAULT_SETTINGS.temperature,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPromptContent },
    ],
    response_format: { type: 'json_object' },
    stream: false,
  };

  // 用户已确认完整记录 prompt 与响应原文（不脱敏）。
  log.info('llm.request', {
    url,
    model: body.model,
    temperature: body.temperature,
    fieldsCount: fields.length,
    userIntent,
    pageUrl,
    pageTitle,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPromptContent,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 即便代理不校验，也带上以兼容标准 OpenAI 服务
        Authorization: `Bearer ${settings.apiKey || 'not-needed'}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      log.error('llm.timeout', { url, timeoutMs: REQUEST_TIMEOUT_MS });
      throw new Error(`LLM 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`);
    }
    log.error('llm.networkError', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `无法连接 LLM 服务: ${err instanceof Error ? err.message : String(err)}\n请检查 endpoint 是否可达：${url}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text();
  log.info(
    'llm.response',
    {
      status: res.status,
      ok: res.ok,
      rawText, // 完整原文，包含 LLM 返回的所有 JSON
    },
    { durationMs: Date.now() - startedAt },
  );

  if (!res.ok) {
    throw new Error(formatHttpError(res.status, rawText));
  }

  const json = safeJsonParse(rawText);
  if (!json) {
    throw new Error(`LLM 返回非 JSON：${truncate(rawText, 200)}`);
  }

  // ZenVFX 错误格式（即使 HTTP 200 时一般不会返回这种，但稳一点）
  if (
    typeof (json as ZenvfxErrorResponse).success === 'boolean' &&
    (json as ZenvfxErrorResponse).success === false
  ) {
    const e = (json as ZenvfxErrorResponse).error;
    throw new Error(`LLM 错误[${e?.code ?? '?'}]：${e?.message ?? '未知'}`);
  }

  const chat = json as OpenAiChatResponse;
  if (chat.error) {
    throw new Error(`LLM 错误：${chat.error.message ?? JSON.stringify(chat.error)}`);
  }

  const content = chat.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM 返回为空');
  }

  const fills = parseFills(content);

  // 过滤 LLM 可能返回的不存在 id（容错，避免回填阶段炸）
  const validIds = new Set(fields.map((f) => f.id));
  const cleaned = fills.filter((f) => validIds.has(f.id));
  const droppedCount = fills.length - cleaned.length;
  if (droppedCount > 0) {
    log.warn('llm.invalidIdsFiltered', {
      droppedCount,
      droppedFills: fills.filter((f) => !validIds.has(f.id)),
    });
  }
  log.info('llm.parsed', {
    fillsCount: cleaned.length,
    fills: cleaned,
  });

  return {
    fills: cleaned,
    model: chat.choices?.[0]?.finish_reason
      ? body.model
      : body.model, // finish_reason 单纯保留兼容判断
    durationMs: Date.now() - startedAt,
    promptTokens: chat.usage?.prompt_tokens,
    completionTokens: chat.usage?.completion_tokens,
  };
}

// ---------- prompt ----------

const SYSTEM_PROMPT = `你是网页表单填写助手。根据用户的意图，把每个字段需要填的值映射到给定的 id。

严格规则：
1. 只输出 JSON，格式：{"fills": [{"id": <int>, "value": "<string>", "reason": "<string>"}]}
2. id 必须来自给定字段列表，绝不编造新 id
3. 不确定该填什么的字段，**不要**出现在结果中（不要返回空字符串占位）
4. 字段 kind=select 或 kind=radio 时，value 必须是 options 里某个 option 的 value（不是 label）
5. 字段 kind=checkbox 时，value 用 "true" 或 "false"
6. 字段 kind=date 时，value 用 ISO 格式（YYYY-MM-DD 或 YYYY-MM-DDTHH:mm）
7. reason 用一句话说明为什么这样填（让用户能快速判断），中文
8. 如果用户意图与页面字段完全不相关，返回 {"fills": []}`;

function buildUserPrompt(args: {
  userIntent: string;
  fields: ExtractedField[];
  pageUrl: string;
  pageTitle: string;
}): string {
  const { userIntent, fields, pageUrl, pageTitle } = args;
  // 字段 JSON 要紧凑，不浪费 token
  const fieldsJson = JSON.stringify(fields.map(slimField));
  return [
    `页面标题：${pageTitle}`,
    `页面 URL：${pageUrl}`,
    '',
    '页面字段（数组）：',
    fieldsJson,
    '',
    '用户意图：',
    userIntent,
  ].join('\n');
}

/** 只发给 LLM 必要的字段，去掉空属性省 token */
function slimField(f: ExtractedField): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: f.id,
    kind: f.kind,
    label: f.label,
  };
  if (f.type) out.type = f.type;
  if (f.name) out.name = f.name;
  if (f.placeholder) out.placeholder = f.placeholder;
  if (f.required) out.required = true;
  if (f.currentValue) out.currentValue = f.currentValue;
  if (f.options) out.options = f.options;
  if (f.nearbyContext) out.nearbyContext = f.nearbyContext;
  return out;
}

// ---------- 解析 ----------

function parseFills(content: string): FillInstruction[] {
  // 1) 直接当 JSON 解析
  let data = safeJsonParse(content);

  // 2) 模型可能多嘴包了 ```json fences，剥一层再试
  if (!data) {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) data = safeJsonParse(fenced[1]);
  }

  // 3) 实在不行，找第一对花括号
  if (!data) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      data = safeJsonParse(content.slice(start, end + 1));
    }
  }

  if (!data || typeof data !== 'object') {
    throw new Error(`LLM 返回的内容不是有效 JSON：${truncate(content, 200)}`);
  }

  // 容忍模型把数组直接返回的情况
  const fillsRaw = Array.isArray(data)
    ? data
    : (data as LlmFillsPayload).fills;

  if (!Array.isArray(fillsRaw)) {
    throw new Error(
      `LLM 返回缺少 fills 数组：${truncate(JSON.stringify(data), 200)}`,
    );
  }

  return fillsRaw
    .filter((x): x is FillInstruction => {
      return (
        x &&
        typeof x === 'object' &&
        typeof (x as FillInstruction).id === 'number' &&
        typeof (x as FillInstruction).value === 'string'
      );
    })
    .map((x) => ({
      id: x.id,
      value: x.value,
      reason: typeof x.reason === 'string' ? x.reason : '',
    }));
}

// ---------- 工具 ----------

function buildChatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  // 用户可能填的是 http://host/api/v1/llm 也可能是 .../chat/completions
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function safeJsonParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function formatHttpError(status: number, body: string): string {
  // 优先用 ZenVFX 错误结构
  const json = safeJsonParse(body);
  if (json && typeof json === 'object') {
    const z = json as ZenvfxErrorResponse;
    if (z.error?.message) {
      return `LLM ${status} ${z.error.code ?? ''}: ${z.error.message}`;
    }
    const o = json as OpenAiChatResponse;
    if (o.error?.message) {
      return `LLM ${status}: ${o.error.message}`;
    }
  }
  return `LLM HTTP ${status}: ${truncate(body, 200)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

// ============================================================
// 阶段 8：generateIntent —— 让 LLM 读页面 + profile 输出"人话意图"
// ============================================================

const INTENT_SYSTEM_PROMPT = `你是网页表单填写助手。给你一个页面摘要、字段清单、以及（可选的）用户已有意图，
请输出一段中文人话意图，让用户复制到"填写意图"里继续推动 LLM 生成填写值。

核心规则——**为每个字段生成具体、真实格式的演示数据，绝不输出占位符**：

1. 输出一段话，2-8 句，自然口语，不要列表/markdown
2. 第一句先说清楚"这是什么页面/什么表单"（根据 pageTitle + 页面摘要判断）
3. 用户已有意图里明确给的信息（如"我叫张三，邮箱 a@b.com"）必须**完全采用、不要改写**；用户没提的字段才你来生成
4. 生成数据要"以假乱真"——格式正确、语义合理：
   - 姓名：常见中文姓名或拼音（如"李明"/"王芳"/"Lin Wei"）
   - 邮箱：真实格式，用大众域名 gmail.com / outlook.com / qq.com，前缀和姓名匹配
   - 电话：符合区号格式
   - GitHub 用户名：lowercase、合理（如 "lin-wei-dev" / "wangfang2024"）
   - URL：用合理的 github.com/user/repo 之类的真实格式
   - 公司/组织：真实存在或听起来真实的中小公司名
   - 长说明字段（项目重要性、使用计划、备注等）：写一段 1-3 句具体的描述，不要空话
5. 字段是 select/radio：直接说"选 XX" 用 label 文字（不是 value）；选项有多个时**随机选一个合理的**
6. 字段是 checkbox：明确说"勾选/不勾选 XX"；多个 checkbox 可独立判断（兴趣类的可以多选）
7. 不要使用 \`<...>\` 这样的占位符；不要写"建议填写"/"请输入"这种没动作的话
8. 不要重复字段的英文 name/id，用 label 描述
9. 注意：这是演示用途，所以不要生成可能误导他人的真实身份信息（如真实身份证号、真实手机号），用看起来合理但虚构的`;

export interface GenerateIntentResult {
  intent: string;
  model: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export async function generateIntent(args: {
  settings: LlmSettings;
  fields: ExtractedField[];
  pageUrl: string;
  pageTitle: string;
  pageSummary?: PageSummary;
  /** 用户当前已经在 textarea 里输的内容；非空时优先采用 */
  existingIntent?: string;
}): Promise<GenerateIntentResult> {
  const { settings, fields, pageUrl, pageTitle, pageSummary, existingIntent } =
    args;
  const startedAt = Date.now();

  if (fields.length === 0) {
    throw new Error('当前页面没有可填字段，无法生成意图');
  }

  const url = buildChatCompletionsUrl(settings.endpoint);
  const userPrompt = buildIntentUserPrompt({
    fields,
    pageUrl,
    pageTitle,
    pageSummary,
    existingIntent: existingIntent ?? '',
  });

  const body = {
    model: settings.model || DEFAULT_SETTINGS.model,
    // intent 需要随机感，温度调高一些
    temperature: 0.8,
    messages: [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
  };

  log.info('intent.request', {
    url,
    model: body.model,
    fieldsCount: fields.length,
    pageUrl,
    pageTitle,
    hasPageSummary: !!pageSummary,
    existingIntentLen: (existingIntent ?? '').length,
    systemPrompt: INTENT_SYSTEM_PROMPT,
    userPrompt,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey || 'not-needed'}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      log.error('intent.timeout', { url, timeoutMs: REQUEST_TIMEOUT_MS });
      throw new Error(`LLM 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`);
    }
    log.error('intent.networkError', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `无法连接 LLM 服务: ${err instanceof Error ? err.message : String(err)}\n请检查 endpoint：${url}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text();
  log.info(
    'intent.response',
    { status: res.status, ok: res.ok, rawText },
    { durationMs: Date.now() - startedAt },
  );

  if (!res.ok) {
    throw new Error(formatHttpError(res.status, rawText));
  }

  const json = safeJsonParse(rawText);
  if (!json || typeof json !== 'object') {
    throw new Error(`LLM 返回非 JSON：${truncate(rawText, 200)}`);
  }

  const chat = json as OpenAiChatResponse;
  if (chat.error) {
    throw new Error(`LLM 错误：${chat.error.message ?? JSON.stringify(chat.error)}`);
  }

  const content = chat.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new Error('LLM 返回为空');
  }

  // 去掉模型可能加的引号 / 代码块
  const cleaned = stripIntentWrappers(content.trim());

  return {
    intent: cleaned,
    model: body.model,
    durationMs: Date.now() - startedAt,
    promptTokens: chat.usage?.prompt_tokens,
    completionTokens: chat.usage?.completion_tokens,
  };
}

function buildIntentUserPrompt(args: {
  fields: ExtractedField[];
  pageUrl: string;
  pageTitle: string;
  pageSummary?: PageSummary;
  existingIntent: string;
}): string {
  const { fields, pageUrl, pageTitle, pageSummary, existingIntent } = args;
  const lines: string[] = [];

  lines.push(`页面 URL：${pageUrl}`);
  lines.push(`页面标题：${pageTitle}`);

  if (pageSummary) {
    if (pageSummary.headings.length > 0) {
      lines.push('页面主要标题：');
      for (const h of pageSummary.headings) lines.push(`  - ${h}`);
    }
    if (pageSummary.intro) {
      lines.push('页面正文摘要：');
      lines.push(pageSummary.intro);
    }
  }

  lines.push('');
  lines.push('页面表单字段：');
  lines.push(JSON.stringify(fields.map(slimField)));

  lines.push('');
  if (existingIntent.trim()) {
    lines.push('用户已经写下的意图（务必采用其中明确的信息，不能改写）：');
    lines.push(existingIntent.trim());
    lines.push('');
    lines.push('请补全用户没提到的字段（用真实格式的演示数据），并整理成一段连贯人话。');
  } else {
    lines.push('用户没有给出具体意图。请你根据字段语义，为每个字段生成具体、真实格式的演示数据，整理成一段连贯人话。');
  }

  return lines.join('\n');
}

/** 模型偶尔会用 "..." 包住或加 ```...``` fence，剥掉 */
function stripIntentWrappers(s: string): string {
  let r = s;
  // 代码块
  const fence = r.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  if (fence) r = fence[1].trim();
  // 整段被引号包
  if (
    (r.startsWith('"') && r.endsWith('"')) ||
    (r.startsWith('「') && r.endsWith('」'))
  ) {
    r = r.slice(1, -1).trim();
  }
  return r;
}
