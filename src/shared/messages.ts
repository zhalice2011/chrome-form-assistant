// 三端通信的消息类型定义。
// sidePanel <-> background <-> contentScript 都用同一套类型。

// ---------- 字段模型 ----------

export type FieldKind =
  | 'text' // input[type=text/email/url/tel/search/password] + textarea
  | 'number' // input[type=number/range]
  | 'date' // input[type=date/datetime-local/month/week/time]
  | 'checkbox' // input[type=checkbox]
  | 'radio' // input[type=radio]，按 name 聚合成一组
  | 'select' // <select>
  | 'contenteditable'; // [contenteditable=true]

export interface FieldOption {
  value: string;
  label: string;
}

/**
 * 给 LLM 看的字段元数据。
 * 关键约束：id 是 content script 内部维护的整数，LLM 只引用 id，
 * 绝不让 LLM 自己生成 selector。
 */
export interface ExtractedField {
  id: number;
  kind: FieldKind;
  label: string;
  /** 原始 type 属性（input 才有），保留给 LLM 做更精细判断 */
  type?: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  /** 当前值（文本类）或当前是否选中（checkbox/radio）。LLM 看一眼避免重复填 */
  currentValue?: string;
  /** select / radio group 的可选项 */
  options?: FieldOption[];
  /** 仅 radio：组名（与 name 相同），方便 LLM 识别这是一组而非独立项 */
  groupName?: string;
  /**
   * 字段邻近的页面文本（最多 ~200 字符）。
   * 用于让 LLM 理解字段的语义上下文（说明文字、字段所在 section 标题等），
   * 而不是只靠 label 推断。
   */
  nearbyContext?: string;
}

/** 页面摘要：title + 几条 heading + 主文前若干字符。给 LLM 理解"这是个什么页"。 */
export interface PageSummary {
  title: string;
  headings: string[];
  intro: string;
}

export interface ExtractResult {
  fields: ExtractedField[];
  /** 提取耗时（ms），调试用 */
  durationMs: number;
  /** 当前页面 url + title，给 LLM 做上下文 */
  pageUrl: string;
  pageTitle: string;
  /** 跳过的元素数量（如 disabled/hidden），调试用 */
  skipped: number;
  /** 页面摘要，给 LLM 理解整页语义；对填写值的判断质量有显著提升 */
  pageSummary?: PageSummary;
}

// ---------- LLM 模型 ----------

/**
 * LLM 返回的填写指令。reason 给用户看，让 ta 在预览阶段判断对不对。
 * 不确定的字段 LLM 应该不返回，而不是返回空 value。
 */
export interface FillInstruction {
  id: number;
  value: string;
  reason: string;
}

export interface LlmFillsPayload {
  fills: FillInstruction[];
}

// ---------- 设置 ----------

export interface LlmSettings {
  endpoint: string; // e.g. http://localhost:3000/api/v1/llm
  apiKey: string; // 占位字符串也允许（本地代理不验证）
  model: string; // e.g. gemini-3.1-pro
  temperature?: number;
  /**
   * 用户个人资料（自由格式）。
   * 例：
   *   姓名: 张三
   *   邮箱: zhang@example.com
   *   GitHub: zhang-3
   *   公司: ZenVFX
   * 用于 🪄 自动生成意图时让 LLM 知道用户是谁。可空。
   */
  profile?: string;
}

export const DEFAULT_SETTINGS: LlmSettings = {
  endpoint: 'http://localhost:3000/api/v1/llm',
  apiKey: 'not-needed',
  model: 'gemini-3.1-pro',
  temperature: 0.3, // 表单填写偏确定性
  profile: '',
};

// ---------- 消息类型 ----------

export type MessageType =
  | 'PING'
  | 'EXTRACT_FIELDS'
  | 'FILL_FIELDS' // 阶段4：sidepanel → content
  | 'LLM_GENERATE_FILLS' // 阶段3：sidepanel → background
  | 'LLM_GENERATE_INTENT'; // 阶段8：sidepanel → background，🪄 生成意图

export interface PingMessage {
  type: 'PING';
  text: string;
}

export interface PingResponse {
  ok: true;
  pong: string;
  url: string;
}

export interface ExtractMessage {
  type: 'EXTRACT_FIELDS';
}

export interface ExtractResponse {
  ok: true;
  result: ExtractResult;
}

/** sidepanel → background：让 LLM 根据用户意图给出填写指令 */
export interface LlmGenerateFillsMessage {
  type: 'LLM_GENERATE_FILLS';
  userIntent: string;
  fields: ExtractedField[];
  pageUrl: string;
  pageTitle: string;
}

export interface LlmGenerateFillsResponse {
  ok: true;
  fills: FillInstruction[];
  /** 调试用：实际发给 LLM 的 prompt 摘要、模型名、耗时 */
  debug: {
    model: string;
    durationMs: number;
    promptTokens?: number;
    completionTokens?: number;
  };
}

/**
 * 阶段 8：让 LLM 读页面 + profile，生成"人话意图"，填到 sidepanel textarea。
 * 不直接产 fills——用户改完意图后再调 LLM_GENERATE_FILLS。
 */
export interface LlmGenerateIntentMessage {
  type: 'LLM_GENERATE_INTENT';
  fields: ExtractedField[];
  pageUrl: string;
  pageTitle: string;
  pageSummary?: PageSummary;
  /** 用户当前 textarea 已有内容，非空时 LLM 必须沿用其中明确的信息 */
  existingIntent?: string;
}

export interface LlmGenerateIntentResponse {
  ok: true;
  intent: string; // 一段中文人话
  debug: {
    model: string;
    durationMs: number;
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

// ---------- 回填消息 ----------

export interface FillMessage {
  type: 'FILL_FIELDS';
  fills: FillInstruction[];
}

export type FillStatus = 'ok' | 'not-found' | 'unsupported' | 'error';

export interface FillReport {
  id: number;
  status: FillStatus;
  /** 失败时的原因 */
  message?: string;
  /** 实际写入的值（select/radio 可能映射到 option label） */
  appliedValue?: string;
}

export interface FillResponse {
  ok: true;
  reports: FillReport[];
}

export type AnyMessage =
  | PingMessage
  | ExtractMessage
  | LlmGenerateFillsMessage
  | LlmGenerateIntentMessage
  | FillMessage;
