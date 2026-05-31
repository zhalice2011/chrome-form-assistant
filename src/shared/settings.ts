// 设置的统一读写：chrome.storage.local。
// 三端（sidepanel / background / options）都从这里读，确保唯一来源。

import { DEFAULT_SETTINGS, type LlmSettings } from './messages';

const STORAGE_KEY = 'llmSettings';

export async function loadSettings(): Promise<LlmSettings> {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  const stored = obj[STORAGE_KEY] as Partial<LlmSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(s: LlmSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: s });
}

export function onSettingsChanged(
  cb: (s: LlmSettings) => void,
): () => void {
  const listener = (
    changes: { [k: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    if (area === 'local' && changes[STORAGE_KEY]?.newValue) {
      cb({
        ...DEFAULT_SETTINGS,
        ...(changes[STORAGE_KEY].newValue as Partial<LlmSettings>),
      });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
