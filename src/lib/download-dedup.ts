import type { DownloadTaskEntry } from './db';

/**
 * 下载防重复：同一视频源内禁止重复下载同一部影视。
 *
 * 去重键 = `${sourceKey}:${vodId}:${episodeIndex}`，与播放进度用的 episodeKey
 * 同一口径（见 watch/page.tsx）：同一源 + 同一影片 + 同一集。
 * 同一集换源（sourceKey 不同）不算重复，可正常下载。
 *
 * 拦截规则（在弹保存位置选择器之前检查，避免重复点下载还弹出文件选择器）：
 * - waiting / downloading / paused → 正在下载，拦截；
 * - completed → 已下载过，拦截；
 * - error → 下载失败可重试，不拦截；
 * - 用户在下载管理里删除记录后可重新下载；
 * - 改动上线前已有的旧记录没有 dedupKey，不参与拦截。
 */

/** 拦截时返回的重复状态；null = 不重复，可以入队 */
export type DuplicateDownloadState = 'downloading' | 'completed';

export function buildDownloadDedupKey(sourceKey: string, vodId: string, episodeIndex: number): string {
  return `${sourceKey}:${vodId}:${episodeIndex}`;
}

export function findDuplicateDownload(
  entries: DownloadTaskEntry[],
  dedupKey: string | undefined
): { entry: DownloadTaskEntry; state: DuplicateDownloadState } | null {
  if (!dedupKey) return null;
  const existing = entries.find((e) => e.dedupKey === dedupKey);
  if (!existing) return null;
  if (existing.status === 'completed') return { entry: existing, state: 'completed' };
  if (existing.status === 'waiting' || existing.status === 'downloading' || existing.status === 'paused') {
    return { entry: existing, state: 'downloading' };
  }
  return null; // error：失败可重试，不拦截
}
