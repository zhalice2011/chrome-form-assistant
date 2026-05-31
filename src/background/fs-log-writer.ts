// FSA 文件日志 writer：把日志按 NDJSON 追加到用户选定的目录。
//
// 关键约束（来自调研）：
//   - showDirectoryPicker 必须在 sidepanel/options 调用，handle 通过 IDB 共享给 SW
//   - SW 端只能 queryPermission，不能 requestPermission（无激活手势）
//   - 每次写都新开 writable 并 close（长 stream 在 SW 休眠时不可靠）
//   - 失败立即降级到内存模式 + setBadgeText 通知 UI

import type { LogEntry } from '../shared/log-types';
import { idbGet } from '../shared/idb-handle';

export const LOG_DIR_KEY = 'logDir';

const FILE_NAME_PREFIX = 'logs-';
const FILE_NAME_EXT = '.log';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB 切下个文件

export type WriterStatus =
  | { kind: 'no-dir' } // 用户还没选目录
  | { kind: 'no-permission' } // 选过但权限失效，需用户手动重新授权
  | { kind: 'ok'; dirName: string }
  | { kind: 'error'; message: string };

let lastStatus: WriterStatus = { kind: 'no-dir' };

/** 从 IDB 取目录 handle；不存在返回 undefined */
async function getDirHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  return idbGet<FileSystemDirectoryHandle>(LOG_DIR_KEY);
}

/**
 * 仅查询权限（SW 不能 request）。
 * 如果当前已 granted 直接返回 true；否则返回 false 让 UI 提示用户。
 */
async function ensurePermissionOrFail(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  // queryPermission 在 spec 上是 readonly/readwrite 二选一
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  return perm === 'granted';
}

function todayFileName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${FILE_NAME_PREFIX}${yyyy}-${mm}-${dd}${FILE_NAME_EXT}`;
}

function rotatedFileName(suffix: number): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${FILE_NAME_PREFIX}${yyyy}-${mm}-${dd}-${suffix}${FILE_NAME_EXT}`;
}

/** 找到当天可写的文件（自动滚到下个 suffix 当超限） */
async function pickTargetFile(
  dir: FileSystemDirectoryHandle,
): Promise<{ handle: FileSystemFileHandle; size: number }> {
  // 先看主文件
  let name = todayFileName();
  let h = await dir.getFileHandle(name, { create: true });
  let f = await h.getFile();
  if (f.size < MAX_FILE_BYTES) return { handle: h, size: f.size };

  // 主文件满了，找 -2/-3...
  for (let i = 2; i < 100; i++) {
    name = rotatedFileName(i);
    h = await dir.getFileHandle(name, { create: true });
    f = await h.getFile();
    if (f.size < MAX_FILE_BYTES) return { handle: h, size: f.size };
  }
  // 极端情况：100 个轮转文件都满了 — 用最后一个继续写（用户应该已经清理了）
  return { handle: h, size: f.size };
}

function entriesToNdjson(entries: LogEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    try {
      lines.push(JSON.stringify(e));
    } catch {
      // 极少：data 含循环引用或 BigInt 等。降级写一个安全摘要。
      lines.push(
        JSON.stringify({
          seq: e.seq,
          ts: e.ts,
          sessionId: e.sessionId,
          level: e.level,
          source: e.source,
          module: e.module,
          event: e.event,
          message: e.message,
          data: '[unserializable]',
        }),
      );
    }
  }
  return lines.join('\n') + '\n';
}

/** 主 flush：写入一批日志到当天文件。失败抛错让 store 处理 */
export async function writeBatch(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const dir = await getDirHandle();
  if (!dir) {
    lastStatus = { kind: 'no-dir' };
    throw new FsLogError('no-dir', '尚未选择日志目录');
  }

  const granted = await ensurePermissionOrFail(dir);
  if (!granted) {
    lastStatus = { kind: 'no-permission' };
    await setBadgeNeedAttention();
    throw new FsLogError(
      'no-permission',
      '日志目录权限失效，请到设置页重新授权',
    );
  }

  try {
    const { handle: fileHandle, size } = await pickTargetFile(dir);
    const writable = await fileHandle.createWritable({
      keepExistingData: true,
    });
    try {
      await writable.seek(size);
      await writable.write(entriesToNdjson(entries));
    } finally {
      await writable.close();
    }
    lastStatus = { kind: 'ok', dirName: dir.name };
    // 写成功后清掉 badge
    await clearBadge();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : '';
    let kind: 'no-permission' | 'error' = 'error';
    if (name === 'NotAllowedError') kind = 'no-permission';
    lastStatus = { kind, message: msg };
    if (kind === 'no-permission') await setBadgeNeedAttention();
    throw new FsLogError(kind, msg);
  }
}

export class FsLogError extends Error {
  constructor(
    public readonly kind: 'no-dir' | 'no-permission' | 'error',
    message: string,
  ) {
    super(message);
    this.name = 'FsLogError';
  }
}

export function getWriterStatus(): WriterStatus {
  return lastStatus;
}

// ---------- badge ----------

async function setBadgeNeedAttention(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  } catch {
    // ignore
  }
}

async function clearBadge(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch {
    // ignore
  }
}
