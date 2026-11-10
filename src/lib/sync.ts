import { useEffect, useRef } from 'react';
import { db, type FavoriteEntry, type HistoryEntry } from './db';

/**
 * 跨设备同步：观看历史 + 我的收藏。
 * 后端是 Cloudflare Worker + D1（sync.moontvplus.top），口令鉴权。
 * 同步流程固定为「先推后拉」：先把本机的新变化推上去，再把云端合并后的
 * 全量拉下来覆盖本机——这样本机未推的改动不会被拉取冲掉。
 * 删除靠墓碑同步：本机删一条，推一个 deleted=1 的墓碑，别的设备拉取时
 * 不再看到它；墓碑推成功后本机清除。
 */

export const SYNC_WORKER_URL = 'https://sync.moontvplus.top';
const SYNC_CODE_KEY = 'libretv-sync-code';
const SYNC_LAST_AT_KEY = 'libretv-sync-last-at';
/** 自动同步节流：两次自动同步至少间隔 5 分钟（手动同步不受限） */
const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60_000;

export function getSyncCode(): string | null {
  try {
    return (localStorage.getItem(SYNC_CODE_KEY) || '').trim() || null;
  } catch {
    return null;
  }
}

export function setSyncCode(code: string): void {
  try {
    localStorage.setItem(SYNC_CODE_KEY, code.trim());
  } catch {
    // 服务端预渲染 / 隐私模式下无 localStorage，静默跳过
  }
}

export function clearSyncCode(): void {
  try {
    localStorage.removeItem(SYNC_CODE_KEY);
    localStorage.removeItem(SYNC_LAST_AT_KEY);
  } catch {
    // 服务端预渲染 / 隐私模式下无 localStorage，静默跳过
  }
}

export function getLastSyncAt(): number {
  try {
    return Number(localStorage.getItem(SYNC_LAST_AT_KEY) || 0);
  } catch {
    // 服务端预渲染时无 localStorage，返回 0（客户端注水后会读到真实值）
    return 0;
  }
}

function setLastSyncAt(t: number): void {
  try {
    localStorage.setItem(SYNC_LAST_AT_KEY, String(t));
  } catch {
    // 服务端预渲染 / 隐私模式下无 localStorage，静默跳过
  }
}

export interface SyncResult {
  pushed: number;
  historyCount: number;
  favoritesCount: number;
  at: number;
}

interface RemoteHistoryRow {
  id: string;
  source_key: string;
  source_url: string | null;
  vod_id: string;
  title: string;
  pic: string | null;
  episode_index: number;
  total_episodes: number;
  playback_position: number;
  duration: number;
  updated_at: number;
}

interface RemoteFavoriteRow {
  id: string;
  source_key: string;
  source_url: string | null;
  vod_id: string;
  title: string;
  pic: string | null;
  total_episodes: number | null;
  updated_at: number;
}

function toHistoryEntry(r: RemoteHistoryRow): HistoryEntry {
  return {
    id: r.id,
    sourceKey: r.source_key,
    sourceUrl: r.source_url ?? undefined,
    vodId: r.vod_id,
    title: r.title,
    pic: r.pic ?? undefined,
    episodeIndex: r.episode_index,
    totalEpisodes: r.total_episodes,
    playbackPosition: r.playback_position,
    duration: r.duration,
    timestamp: r.updated_at,
  };
}

function toFavoriteEntry(r: RemoteFavoriteRow): FavoriteEntry {
  return {
    id: r.id,
    sourceKey: r.source_key,
    sourceUrl: r.source_url ?? undefined,
    vodId: r.vod_id,
    title: r.title,
    pic: r.pic ?? undefined,
    totalEpisodes: r.total_episodes ?? undefined,
    timestamp: r.updated_at,
  };
}

/** 一次完整同步：先推本机变化，再拉云端全量覆盖本机。未设口令时直接抛错。 */
export async function syncNow(code: string): Promise<SyncResult> {
  const trimmed = code.trim();
  if (!trimmed) throw new Error('请先输入同步口令');

  // —— 推：本机历史 + 收藏 + 删除墓碑 ——
  const [localHistory, localFavorites, tombstones] = await Promise.all([
    db.history.toArray(),
    db.favorites.toArray(),
    db.syncTombstones.toArray(),
  ]);

  const historyPayload = localHistory.map((h) => ({
    id: h.id,
    sourceKey: h.sourceKey,
    sourceUrl: h.sourceUrl,
    vodId: h.vodId,
    title: h.title,
    pic: h.pic,
    episodeIndex: h.episodeIndex,
    totalEpisodes: h.totalEpisodes,
    playbackPosition: h.playbackPosition,
    duration: h.duration,
    updatedAt: h.timestamp,
    deleted: false,
  }));
  const favoritesPayload = localFavorites.map((f) => ({
    id: f.id,
    sourceKey: f.sourceKey,
    sourceUrl: f.sourceUrl,
    vodId: f.vodId,
    title: f.title,
    pic: f.pic,
    totalEpisodes: f.totalEpisodes,
    updatedAt: f.timestamp,
    deleted: false,
  }));
  // 墓碑：按 kind 分流到对应表，updatedAt 取删除时间
  for (const t of tombstones) {
    const base = { id: t.id, updatedAt: t.deletedAt, deleted: true };
    if (t.kind === 'history') {
      historyPayload.push({
        ...base,
        sourceKey: '',
        sourceUrl: undefined,
        vodId: '',
        title: '',
        pic: undefined,
        episodeIndex: 0,
        totalEpisodes: 0,
        playbackPosition: 0,
        duration: 0,
      });
    } else {
      favoritesPayload.push({
        ...base,
        sourceKey: '',
        sourceUrl: undefined,
        vodId: '',
        title: '',
        pic: undefined,
        totalEpisodes: undefined,
      });
    }
  }

  const pushRes = await fetch(`${SYNC_WORKER_URL}/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: trimmed, history: historyPayload, favorites: favoritesPayload }),
  });
  if (pushRes.status === 401) throw new Error('同步口令不对，请检查后重试');
  if (!pushRes.ok) throw new Error(`同步推送失败（HTTP ${pushRes.status}）`);
  const pushJson = (await pushRes.json()) as { pushed?: number };

  // 墓碑推成功后清除（云端已有删除标记，不用再推）
  if (tombstones.length > 0) {
    await db.syncTombstones.bulkDelete(tombstones.map((t) => t.key));
  }

  // —— 拉：云端合并后的全量，覆盖本机 ——
  const pullRes = await fetch(
    `${SYNC_WORKER_URL}/sync/pull?code=${encodeURIComponent(trimmed)}`
  );
  if (pullRes.status === 401) throw new Error('同步口令不对，请检查后重试');
  if (!pullRes.ok) throw new Error(`同步拉取失败（HTTP ${pullRes.status}）`);
  const pullJson = (await pullRes.json()) as {
    history: RemoteHistoryRow[];
    favorites: RemoteFavoriteRow[];
  };

  const remoteHistory = (pullJson.history || []).map(toHistoryEntry);
  const remoteFavorites = (pullJson.favorites || []).map(toFavoriteEntry);

  // 全量覆盖：云端已按 updated_at 做过 last-write-wins 合并，拉下来就是最新全集
  await db.transaction('rw', db.history, db.favorites, async () => {
    await db.history.clear();
    if (remoteHistory.length > 0) await db.history.bulkPut(remoteHistory);
    await db.favorites.clear();
    if (remoteFavorites.length > 0) await db.favorites.bulkPut(remoteFavorites);
  });

  const at = Date.now();
  setLastSyncAt(at);
  return {
    pushed: pushJson.pushed ?? 0,
    historyCount: remoteHistory.length,
    favoritesCount: remoteFavorites.length,
    at,
  };
}

/**
 * 自动同步（挂在 Providers 里常驻）：打开应用时同步一次，之后切回页面时
 * 若距离上次同步超过 5 分钟再同步一次。失败静默（不弹 toast、不打扰用户），
 * 用户可在「我的」里点「立即同步」看结果。
 */
export function SyncAutoRunner() {
  const running = useRef(false);
  useEffect(() => {
    const maybeSync = () => {
      const code = getSyncCode();
      if (!code || running.current) return;
      if (Date.now() - getLastSyncAt() < AUTO_SYNC_MIN_INTERVAL_MS) return;
      running.current = true;
      syncNow(code)
        .catch(() => {})
        .finally(() => {
          running.current = false;
        });
    };
    // 打开应用即同步一次（节流由 lastSyncAt 控制）
    maybeSync();
    // 切回页面时再试一次（看完别的 App 回来也能拿到最新记录）
    const onVisible = () => {
      if (document.visibilityState === 'visible') maybeSync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return null;
}
