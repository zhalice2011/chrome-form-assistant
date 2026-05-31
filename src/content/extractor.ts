// 字段提取器：扫描页面所有可交互元素，分配整数 id，返回字段元数据。
//
// 核心约定（来自架构决策 #1）：
//   - 元素 ↔ id 的映射存在 ELEMENT_REGISTRY 这个模块级 Map 里
//   - LLM 永远只看到 id，永远不接触 selector
//   - 回填阶段（filler.ts）用 id 反查元素
//
// 范围（MVP）：
//   - 普通 input/select/textarea/contenteditable
//   - 同源 iframe 通过 all_frames:true 自动各自跑一份 content script
//   - 不处理：闭合 Shadow DOM、跨域 iframe、文件上传、富文本

import type {
  ExtractResult,
  ExtractedField,
  FieldKind,
  FieldOption,
  PageSummary,
} from '../shared/messages';
import { createLogger } from '../shared/logger';

const log = createLogger('content', 'extractor');

/** 字段邻近文本上限：太长会爆 token，太短不够语义 */
const NEARBY_CONTEXT_MAX = 200;
/** 页面 intro 上限 */
const PAGE_INTRO_MAX = 1200;
/** 摘要里 heading 数量上限 */
const HEADINGS_MAX = 6;

/** 可控元素的联合类型。注意 contenteditable 是普通 HTMLElement。 */
type ControllableElement =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement
  | HTMLElement;

/**
 * 模块级注册表：id ↔ 元素双向映射。
 * 每次 EXTRACT 都会清空重建，避免页面 SPA 切换后 id 失效。
 * 阶段 4 回填时用 getElementById() 反查。
 */
const ELEMENT_REGISTRY = new Map<number, ControllableElement>();

export function getElementById(id: number): ControllableElement | undefined {
  return ELEMENT_REGISTRY.get(id);
}

export function clearRegistry(): void {
  ELEMENT_REGISTRY.clear();
}

// ---------- 主入口 ----------

export function extractFields(): ExtractResult {
  const startedAt = performance.now();
  ELEMENT_REGISTRY.clear();

  const fields: ExtractedField[] = [];
  let skipped = 0;
  let nextId = 1;

  // 处理过的 radio 组名（同组只产出一个 ExtractedField）
  const handledRadioGroups = new Set<string>();

  const candidates = document.querySelectorAll<HTMLElement>(
    [
      'input',
      'select',
      'textarea',
      '[contenteditable="true"]',
      '[contenteditable=""]', // 等价于 true
    ].join(','),
  );

  for (const el of Array.from(candidates)) {
    if (!isExtractable(el)) {
      skipped++;
      continue;
    }

    // radio 特殊：按 name 分组，组内所有元素共享一个 id（指向 group 的代表元素）。
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const group = el.name || '';
      if (group && handledRadioGroups.has(group)) {
        skipped++;
        continue;
      }
      const radios = collectRadioGroup(el);
      const id = nextId++;
      // 注册表只存第一个 radio，回填时用 value 选中对应项
      ELEMENT_REGISTRY.set(id, radios[0]);
      fields.push(buildRadioField(id, radios));
      if (group) handledRadioGroups.add(group);
      continue;
    }

    const id = nextId++;
    ELEMENT_REGISTRY.set(id, el as ControllableElement);
    fields.push(buildField(id, el as ControllableElement));
  }

  const pageSummary = extractPageSummary();

  const durationMs = Math.round(performance.now() - startedAt);
  log.debug('scan.summary', {
    candidates: candidates.length,
    extracted: fields.length,
    skipped,
    radioGroups: handledRadioGroups.size,
    summaryHeadings: pageSummary.headings.length,
    summaryIntroLen: pageSummary.intro.length,
  });
  return {
    fields,
    durationMs,
    pageUrl: location.href,
    pageTitle: document.title,
    skipped,
    pageSummary,
  };
}

// ---------- 页面摘要 ----------

/**
 * 抽 title + 前几个 heading + 主文前 N 字符。
 * 不引 Readability 等重库，启发式够用：title 直读，heading 取 h1/h2/h3 的前 6 条，
 * intro 用 document.body 的 textContent 前 1200 字符（去掉多余空白）。
 */
function extractPageSummary(): PageSummary {
  const headings = Array.from(
    document.querySelectorAll<HTMLElement>('h1, h2, h3'),
  )
    .map((h) => normalizeWhitespace(h.textContent ?? ''))
    .filter((s) => s.length > 0 && s.length <= 200)
    .slice(0, HEADINGS_MAX);

  // intro：用 body innerText 截断。innerText 比 textContent 更接近渲染后文本（去 script/style）。
  // 但 innerText 在隐藏元素上会反映 CSS，慢一点；可接受。
  let intro = normalizeWhitespace(document.body?.innerText ?? '');
  if (intro.length > PAGE_INTRO_MAX) {
    intro = intro.slice(0, PAGE_INTRO_MAX) + '…';
  }

  return {
    title: document.title,
    headings,
    intro,
  };
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------- 可见性 / 可交互性过滤 ----------

function isExtractable(el: HTMLElement): boolean {
  // hidden / disabled / readonly 跳过
  if (el instanceof HTMLInputElement) {
    if (el.type === 'hidden') return false;
    if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') {
      return false;
    }
    if (el.type === 'image' || el.type === 'file') return false; // MVP non-goal
  }
  if (
    (el as HTMLInputElement).disabled ||
    el.getAttribute('aria-disabled') === 'true'
  ) {
    return false;
  }
  if ((el as HTMLInputElement).readOnly) return false;

  // 不可见过滤：display:none / visibility:hidden / 0 尺寸
  // 注意：opacity:0 仍当作可见，因为常用于动画/渐入；用户能 tab 到就该填
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;

  return true;
}

// ---------- 字段构建 ----------

function buildField(id: number, el: ControllableElement): ExtractedField {
  const kind = inferKind(el);
  const base: ExtractedField = {
    id,
    kind,
    label: inferLabel(el),
  };
  const nearby = inferNearbyContext(el);
  if (nearby) base.nearbyContext = nearby;

  if (el instanceof HTMLInputElement) {
    if (el.type) base.type = el.type;
    if (el.name) base.name = el.name;
    if (el.placeholder) base.placeholder = el.placeholder;
    if (el.required) base.required = true;
    if (kind === 'checkbox') {
      base.currentValue = el.checked ? 'true' : 'false';
    } else {
      if (el.value) base.currentValue = el.value;
    }
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.name) base.name = el.name;
    if (el.placeholder) base.placeholder = el.placeholder;
    if (el.required) base.required = true;
    if (el.value) base.currentValue = el.value;
  } else if (el instanceof HTMLSelectElement) {
    if (el.name) base.name = el.name;
    if (el.required) base.required = true;
    if (el.value) base.currentValue = el.value;
    base.options = Array.from(el.options).map<FieldOption>((opt) => ({
      value: opt.value,
      label: (opt.textContent ?? opt.value).trim(),
    }));
  } else {
    // contenteditable
    const text = (el.innerText ?? '').trim();
    if (text) base.currentValue = text;
  }

  return base;
}

function buildRadioField(
  id: number,
  radios: HTMLInputElement[],
): ExtractedField {
  const first = radios[0];
  // 整组 label：优先 fieldset > legend，其次组内任意一个 radio 的 label
  const groupLabel = inferRadioGroupLabel(first) || inferLabel(first);
  const checked = radios.find((r) => r.checked);
  // 邻近上下文从 fieldset 或第一个 radio 的祖先取
  const ctxAnchor =
    (first.closest('fieldset') as HTMLElement | null) ?? first;
  const nearby = inferNearbyContext(ctxAnchor);

  const out: ExtractedField = {
    id,
    kind: 'radio',
    label: groupLabel,
    name: first.name,
    groupName: first.name,
    required: radios.some((r) => r.required),
    currentValue: checked?.value,
    options: radios.map<FieldOption>((r) => ({
      value: r.value,
      label: inferLabel(r) || r.value,
    })),
  };
  if (nearby) out.nearbyContext = nearby;
  return out;
}

function inferKind(el: ControllableElement): FieldKind {
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLTextAreaElement) return 'text';
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'number':
      case 'range':
        return 'number';
      case 'date':
      case 'datetime-local':
      case 'month':
      case 'week':
      case 'time':
        return 'date';
      default:
        return 'text';
    }
  }
  return 'contenteditable';
}

// ---------- label 推断 ----------
// 优先级：
// 1. <label for="id">  (最权威)
// 2. 包裹的 <label>     (常见模式)
// 3. aria-labelledby   (引用其他元素文字)
// 4. aria-label        (无障碍属性)
// 5. title 属性
// 6. 邻近文本节点（前一个非空节点）
// 7. placeholder       (兜底，质量最差)
// 8. name              (最后兜底)

function inferLabel(el: HTMLElement): string {
  // 1. label[for=id]
  if (el.id) {
    const escaped = cssEscape(el.id);
    const labelFor = document.querySelector<HTMLLabelElement>(
      `label[for="${escaped}"]`,
    );
    const text = labelFor?.textContent?.trim();
    if (text) return text;
  }

  // 2. 包裹的 label
  const wrapping = el.closest('label');
  if (wrapping) {
    // 排除元素自身的 value/text，只取 label 的非控件文本
    const text = textWithoutControls(wrapping);
    if (text) return text;
  }

  // 3. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }

  // 4. aria-label
  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;

  // 5. title
  const title = el.getAttribute('title')?.trim();
  if (title) return title;

  // 6. 邻近文本（往前找最近的非空 text/标题节点）
  const nearby = findNearbyText(el);
  if (nearby) return nearby;

  // 7. placeholder
  const placeholder = (el as HTMLInputElement).placeholder?.trim();
  if (placeholder) return placeholder;

  // 8. name
  const name = (el as HTMLInputElement).name?.trim();
  if (name) return name;

  return '(未识别)';
}

function inferRadioGroupLabel(radio: HTMLInputElement): string {
  // 优先 fieldset > legend
  const fieldset = radio.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector<HTMLLegendElement>('legend');
    const text = legend?.textContent?.trim();
    if (text) return text;
  }
  // 其次：包裹的 [role=group][aria-label]
  const group = radio.closest('[role="group"], [role="radiogroup"]');
  if (group) {
    const ariaLabel = group.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;
    const labelledBy = group.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = document.getElementById(labelledBy)?.textContent?.trim();
      if (text) return text;
    }
  }
  return '';
}

/** 取一个元素的纯文本（剥离子控件的 value），用于读 label 包裹模式 */
function textWithoutControls(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('input,select,textarea,button')
    .forEach((c) => c.remove());
  return clone.textContent?.trim().replace(/\s+/g, ' ') ?? '';
}

/**
 * 邻近文本启发式：往上找父节点的前序兄弟，捕获 label 没用 for 关联但
 * 视觉上紧邻的标题文本。最多回溯 3 层，避免抓到无关内容。
 */
function findNearbyText(el: HTMLElement): string {
  let cur: HTMLElement | null = el;
  for (let depth = 0; depth < 3 && cur; depth++) {
    const prev = cur.previousElementSibling;
    if (prev) {
      const text = (prev.textContent ?? '').trim().replace(/\s+/g, ' ');
      // 限制在合理长度内，避免抓到整段说明文字
      if (text && text.length > 0 && text.length <= 60) return text;
    }
    cur = cur.parentElement;
  }
  return '';
}

// ---------- 邻近上下文 ----------

/**
 * 字段邻近文本：用于让 LLM 理解字段说明（如帮助提示、相关 section 标题）。
 *
 * 策略：找最近的 label 包裹层 / .form-group / fieldset 等"字段卡片"容器，
 * 取它的 innerText，去除控件 value，截断到 NEARBY_CONTEXT_MAX。
 *
 * 启发式选择器优先级（多数表单设计都符合至少一个）：
 *   - <label>（包裹模式）
 *   - 父级 <fieldset>
 *   - 含 'form' / 'field' / 'input' class 的最近祖先 div（react/vue 常见模式）
 *   - 否则取直接父 element
 *
 * 不爬太高（避免抓到整页文案）：最多回溯 4 层。
 */
function inferNearbyContext(el: HTMLElement): string {
  // 先看 label 包裹（label 内通常就是说明 + 输入框）
  const wrappingLabel = el.closest('label');
  if (wrappingLabel && wrappingLabel.contains(el)) {
    const text = textWithoutControls(wrappingLabel);
    if (text.length > 0) return clampContext(text);
  }

  // 找形似"字段卡片"的祖先
  let cur: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 4 && cur; depth++) {
    if (looksLikeFieldContainer(cur)) {
      const text = textWithoutControls(cur);
      // 不要太短（label 自己已经覆盖），也不要太长（爬到整页 main 了）
      if (text.length >= 8 && text.length <= 1500) {
        return clampContext(text);
      }
    }
    cur = cur.parentElement;
  }

  // 兜底：直接父元素文本
  if (el.parentElement) {
    const text = textWithoutControls(el.parentElement);
    if (text.length > 0) return clampContext(text);
  }

  return '';
}

function looksLikeFieldContainer(el: HTMLElement): boolean {
  if (el.tagName === 'FIELDSET') return true;
  if (el.tagName === 'LABEL') return true;
  // class 名启发式：大量 UI 库都用这些
  const cls = (el.className && typeof el.className === 'string'
    ? el.className
    : ''
  ).toLowerCase();
  return /\b(form-?group|form-?field|field-?wrapper|input-?wrapper|form-?row|form-?control)\b/.test(
    cls,
  );
}

function clampContext(text: string): string {
  const t = text.length > NEARBY_CONTEXT_MAX
    ? text.slice(0, NEARBY_CONTEXT_MAX) + '…'
    : text;
  return t;
}

// ---------- radio 分组 ----------

function collectRadioGroup(radio: HTMLInputElement): HTMLInputElement[] {
  const name = radio.name;
  if (!name) return [radio];
  // 同 form 内同 name 的所有 radio。无 form 时退化成全文档同 name。
  const scope: ParentNode = radio.form ?? document;
  const escaped = cssEscape(name);
  const all = scope.querySelectorAll<HTMLInputElement>(
    `input[type="radio"][name="${escaped}"]`,
  );
  return Array.from(all).filter(isExtractable);
}

// ---------- 工具：CSS.escape 兜底 ----------

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  // 简单兜底：转义引号和反斜杠
  return s.replace(/["\\]/g, '\\$&');
}
