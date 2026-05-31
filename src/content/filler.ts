// 回填器：把 LLM 给的 {id, value} 写回 DOM。
//
// 架构原则（来自记忆 architecture_decisions #3）：
//   - 必须用 native setter 绕过 React/Vue 等框架对 value 的拦截
//   - 写完之后必须 dispatch input + change 事件，让框架同步内部 state
//   - checkbox/radio 用 click()，让框架的 click handler 自然触发
//   - contenteditable 改 innerText 后 dispatch input
//
// 失败处理：单个字段失败不中断整批，每个字段返回独立 status。

import type { FillInstruction, FillReport } from '../shared/messages';
import { getElementById } from './extractor';
import { createLogger } from '../shared/logger';

const log = createLogger('content', 'filler');

// 缓存 native setter，第一次取出后复用
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)?.set;

const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value',
)?.set;

const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  'value',
)?.set;

const nativeCheckboxCheckedSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'checked',
)?.set;

const HIGHLIGHT_DURATION_MS = 2000;

export function fillFields(fills: FillInstruction[]): FillReport[] {
  const reports = fills.map(fillOne);
  for (const r of reports) {
    if (r.status === 'ok') {
      log.debug('fill.field.ok', {
        id: r.id,
        appliedValue: r.appliedValue,
      });
    } else {
      log.warn('fill.field.failed', {
        id: r.id,
        status: r.status,
        message: r.message,
      });
    }
  }
  return reports;
}

function fillOne(instruction: FillInstruction): FillReport {
  const { id, value } = instruction;
  const el = getElementById(id);
  if (!el) {
    return {
      id,
      status: 'not-found',
      message: '字段不存在或已失效（页面可能已变化，请重新抓取）',
    };
  }

  try {
    if (el instanceof HTMLInputElement) {
      return fillInput(el, instruction);
    }
    if (el instanceof HTMLTextAreaElement) {
      const applied = setTextareaValue(el, value);
      flashHighlight(el);
      return { id, status: 'ok', appliedValue: applied };
    }
    if (el instanceof HTMLSelectElement) {
      return fillSelect(el, instruction);
    }
    if (el.isContentEditable) {
      el.innerText = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      flashHighlight(el);
      return { id, status: 'ok', appliedValue: value };
    }
    return {
      id,
      status: 'unsupported',
      message: `不支持的元素类型: ${el.tagName}`,
    };
  } catch (err) {
    return {
      id,
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------- input ----------

function fillInput(
  el: HTMLInputElement,
  instruction: FillInstruction,
): FillReport {
  const { id, value } = instruction;

  switch (el.type) {
    case 'checkbox': {
      const want = parseBool(value);
      if (want !== el.checked) {
        // 用 click() 而非直接改 checked：让框架的 onChange 自然触发
        el.click();
      }
      flashHighlight(el);
      return { id, status: 'ok', appliedValue: el.checked ? 'true' : 'false' };
    }

    case 'radio': {
      // value 是 LLM 选定的 option value；找同组对应 radio 然后 click
      const target = findRadioInGroup(el, value);
      if (!target) {
        return {
          id,
          status: 'error',
          message: `radio 组内未找到 value=${value} 的选项`,
        };
      }
      if (!target.checked) target.click();
      flashHighlight(target);
      return { id, status: 'ok', appliedValue: value };
    }

    case 'date':
    case 'datetime-local':
    case 'month':
    case 'week':
    case 'time':
    case 'number':
    case 'range': {
      const applied = setInputValue(el, value);
      flashHighlight(el);
      return { id, status: 'ok', appliedValue: applied };
    }

    default: {
      // text/email/url/tel/search/password/...
      const applied = setInputValue(el, value);
      flashHighlight(el);
      return { id, status: 'ok', appliedValue: applied };
    }
  }
}

function findRadioInGroup(
  representative: HTMLInputElement,
  optionValue: string,
): HTMLInputElement | undefined {
  const name = representative.name;
  if (!name) return undefined;
  const scope: ParentNode = representative.form ?? document;
  const escaped = cssEscape(name);
  const all = scope.querySelectorAll<HTMLInputElement>(
    `input[type="radio"][name="${escaped}"]`,
  );
  return Array.from(all).find((r) => r.value === optionValue);
}

// ---------- select ----------

function fillSelect(
  el: HTMLSelectElement,
  instruction: FillInstruction,
): FillReport {
  const { id, value } = instruction;
  // 校验：LLM 应该返回 option.value，但留个兜底——找 label 匹配
  let matched = Array.from(el.options).find((o) => o.value === value);
  if (!matched) {
    matched = Array.from(el.options).find(
      (o) => o.textContent?.trim() === value,
    );
  }
  if (!matched) {
    return {
      id,
      status: 'error',
      message: `select 中未找到 value/label=${value} 的选项`,
    };
  }

  // native setter + change（框架库选择器多数依赖 change 而非 input）
  if (nativeSelectValueSetter) {
    nativeSelectValueSetter.call(el, matched.value);
  } else {
    el.value = matched.value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  flashHighlight(el);
  return { id, status: 'ok', appliedValue: matched.value };
}

// ---------- 通用：text input / textarea ----------

function setInputValue(el: HTMLInputElement, value: string): string {
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  // blur 可以触发更多框架的校验，但也可能跳焦让用户烦躁；MVP 不做。
  return value;
}

function setTextareaValue(el: HTMLTextAreaElement, value: string): string {
  if (nativeTextAreaValueSetter) {
    nativeTextAreaValueSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return value;
}

// 给 native checkbox setter 留个口子，目前 click() 路径走得稳就没用
// 但保留这个引用避免未使用警告 + 给未来 indeterminate 等场景留余地
void nativeCheckboxCheckedSetter;

// ---------- 视觉反馈 ----------

function flashHighlight(el: HTMLElement): void {
  // 用临时 box-shadow 高亮，不污染 inline style 的其他属性
  const original = el.style.getPropertyValue('box-shadow');
  const originalPriority = el.style.getPropertyPriority('box-shadow');
  const originalTransition = el.style.getPropertyValue('transition');

  el.style.setProperty(
    'box-shadow',
    '0 0 0 2px rgba(16, 185, 129, 0.7)',
    'important',
  );
  el.style.setProperty('transition', 'box-shadow 0.3s ease', 'important');

  setTimeout(() => {
    if (original) {
      el.style.setProperty('box-shadow', original, originalPriority);
    } else {
      el.style.removeProperty('box-shadow');
    }
    if (originalTransition) {
      el.style.setProperty('transition', originalTransition);
    } else {
      el.style.removeProperty('transition');
    }
  }, HIGHLIGHT_DURATION_MS);
}

// ---------- 工具 ----------

function parseBool(s: string): boolean {
  const v = s.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, '\\$&');
}
