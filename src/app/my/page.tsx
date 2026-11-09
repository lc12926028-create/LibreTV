'use client';

import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, LoadingState } from '@/components/states';
import { Icon } from '@/components/icon';
import { SmartImage } from '@/components/smart-image';
import {
  db,
  clearAllFavorites,
  clearAllHistory,
  removeFavorite,
  removeHistory,
  upsertHistory,
  MAX_HISTORY,
  type FavoriteEntry,
  type HistoryEntry,
} from '@/lib/db';
import {
  clearSyncCode,
  getLastSyncAt,
  getSyncCode,
  setSyncCode,
  syncNow,
} from '@/lib/sync';
import { buildWatchUrl, cn, formatRelativeTime, formatTime } from '@/lib/utils';
import { resolveSource, useAppStore } from '@/lib/store';
import { useToast } from '@/components/toast';

/**
 * 「我的」页面：观看历史 + 我的收藏。
 * 数据默认只存本机 IndexedDB；输同步口令后可与云端同步，手机/iPad/Mac 共用同一份记录。
 * 同步后端是 Cloudflare Worker + D1（sync.moontvplus.top），口令鉴权。
 */

type Tab = 'history' | 'favorites';

export default function MyPage() {
  const [tab, setTab] = useState<Tab>('history');
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const { toast } = useToast();

  // —— 跨设备同步 ——
  const [syncCode, setSyncCodeState] = useState(() => getSyncCode() ?? '');
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(() => getLastSyncAt());
  const hasSyncCode = syncCode.trim().length > 0;

  const doSync = async () => {
    const code = syncCode.trim();
    if (!code) {
      toast('请先输入同步口令', 'warning');
      return;
    }
    setSyncing(true);
    try {
      const r = await syncNow(code);
      setSyncCode(code);
      setLastSyncAt(r.at);
      toast(`同步完成：历史 ${r.historyCount} 条，收藏 ${r.favoritesCount} 条`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '同步失败', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const history = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(MAX_HISTORY).toArray(),
    []
  );
  const favorites = useLiveQuery(
    () => db.favorites.orderBy('timestamp').reverse().toArray(),
    []
  );

  const keyword = query.trim().toLowerCase();
  const visibleHistory = useMemo(() => {
    const all = history ?? [];
    if (!keyword) return all;
    return all.filter((h) => h.title.toLowerCase().includes(keyword));
  }, [history, keyword]);
  const visibleFavorites = useMemo(() => {
    const all = favorites ?? [];
    if (!keyword) return all;
    return all.filter((f) => f.title.toLowerCase().includes(keyword));
  }, [favorites, keyword]);

  const totalHistory = history?.length ?? 0;
  const totalFavorites = favorites?.length ?? 0;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-6">
        <h1 className="text-xl font-bold text-content mb-1">我的</h1>
        <p className="text-xs text-faint mb-5">
          观看历史与收藏默认只保存在本机浏览器；输同步口令后可与云端同步，手机、iPad、Mac 共用同一份记录。
        </p>

        {/* 跨设备同步 */}
        <section className="card p-3 mb-5 space-y-2">
          <div className="text-sm font-medium text-content">跨设备同步</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              className="input flex-1 h-9 text-sm"
              placeholder="输入同步口令（8 位）"
              value={syncCode}
              maxLength={32}
              onChange={(e) => setSyncCodeState(e.target.value)}
              aria-label="同步口令"
            />
            <button
              className="btn-primary btn-sm shrink-0"
              onClick={doSync}
              disabled={syncing || !hasSyncCode}
            >
              {syncing ? '同步中...' : '立即同步'}
            </button>
            {hasSyncCode && (
              <button
                className="btn-ghost btn-sm shrink-0"
                onClick={() => {
                  clearSyncCode();
                  setSyncCodeState('');
                  setLastSyncAt(0);
                  toast('已清除同步口令，本机记录保留', 'info');
                }}
              >
                清除口令
              </button>
            )}
          </div>
          <p className="text-xs text-faint">
            {lastSyncAt > 0
              ? `上次同步：${formatRelativeTime(lastSyncAt)}`
              : '还没同步过。口令在三台设备上输一次即可，同步后各设备的历史与收藏会合并。'}
          </p>
        </section>

        <div className="flex items-center gap-2 mb-4">
          <button
            className={cn(
              'px-3 py-1.5 rounded-full text-sm transition-colors',
              tab === 'history' ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content'
            )}
            onClick={() => setTab('history')}
          >
            观看历史{totalHistory > 0 ? ` (${totalHistory})` : ''}
          </button>
          <button
            className={cn(
              'px-3 py-1.5 rounded-full text-sm transition-colors',
              tab === 'favorites' ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content'
            )}
            onClick={() => setTab('favorites')}
          >
            我的收藏{totalFavorites > 0 ? ` (${totalFavorites})` : ''}
          </button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1">
            <Icon
              name="search"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none"
            />
            <input
              type="text"
              className="w-full h-9 pl-8 pr-8 rounded-lg border border-line bg-chip text-sm text-content placeholder:text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
              placeholder={tab === 'history' ? '搜索观看历史...' : '搜索收藏...'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索"
            />
            {query && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-faint hover:text-content hover:bg-hover transition-colors"
                onClick={() => setQuery('')}
                aria-label="清空搜索"
              >
                <Icon name="close" className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {tab === 'history' && totalHistory > 0 && (
            <button
              className="shrink-0 px-2 py-1.5 rounded-md text-xs text-faint hover:text-danger hover:bg-hover transition-colors"
              onClick={() => setConfirmClear(true)}
            >
              清空历史
            </button>
          )}
          {tab === 'favorites' && totalFavorites > 0 && (
            <button
              className="shrink-0 px-2 py-1.5 rounded-md text-xs text-faint hover:text-danger hover:bg-hover transition-colors"
              onClick={() => setConfirmClear(true)}
            >
              清空收藏
            </button>
          )}
        </div>

        {tab === 'history' ? (
          !history ? (
            <LoadingState />
          ) : totalHistory === 0 ? (
            <EmptyState variant="plain" title="暂无观看记录" />
          ) : visibleHistory.length === 0 ? (
            <EmptyState variant="plain" title={`没有匹配「${query.trim()}」的观看记录`} />
          ) : (
            <ul className="space-y-2">
              {visibleHistory.map((item) => (
                <HistoryItem key={`${item.sourceKey}_${item.vodId}`} item={item} />
              ))}
            </ul>
          )
        ) : !favorites ? (
          <LoadingState />
        ) : totalFavorites === 0 ? (
          <EmptyState variant="plain" title="暂无收藏" />
        ) : visibleFavorites.length === 0 ? (
          <EmptyState variant="plain" title={`没有匹配「${query.trim()}」的收藏`} />
        ) : (
          <ul className="space-y-2">
            {visibleFavorites.map((item) => (
              <FavoriteItem key={`${item.sourceKey}_${item.vodId}`} item={item} />
            ))}
          </ul>
        )}

        <p className="text-xs text-faint mt-6">
          {tab === 'history'
            ? '点开一部影片会回到上次看到的那一集；进度条是上次的播放位置。'
            : '收藏在播放页点「☆ 收藏」加入；取消收藏也在播放页点「★ 已收藏」。'}
        </p>
      </main>
      <SiteFooter />

      <ConfirmDialog
        open={confirmClear}
        danger
        title={tab === 'history' ? '清空全部观看历史？' : '清空全部收藏？'}
        message={
          tab === 'history'
            ? `将删除 ${totalHistory} 条观看记录，此操作不可撤销。`
            : `将删除 ${totalFavorites} 条收藏，此操作不可撤销。`
        }
        confirmLabel="清空"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          if (tab === 'history') {
            void clearAllHistory().then(() => toast('观看历史已清空', 'success'));
          } else {
            void clearAllFavorites().then(() => toast('收藏已清空', 'success'));
          }
          setConfirmClear(false);
        }}
      />
    </div>
  );
}

function useWatchLink(sourceKey: string, vodId: string, index: number, title: string) {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const source = resolveSource({ customAPIs, envSources }, sourceKey);
  return buildWatchUrl({
    sourceKey,
    vodId,
    index,
    title,
    sourceUrl: source?.url,
    detail: source?.detail,
  });
}

function HistoryItem({ item }: { item: HistoryEntry }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const { toast } = useToast();
  const [imgFailed, setImgFailed] = useState(false);
  const href = useWatchLink(item.sourceKey, item.vodId, item.episodeIndex, item.title);

  const hasPercent =
    item.playbackPosition > 10 && item.duration > 0 && item.playbackPosition < item.duration * 0.95;
  const percent = hasPercent ? Math.round((item.playbackPosition / item.duration) * 100) : 0;

  const remove = () => {
    void removeHistory(item.sourceKey, item.vodId).then(() => {
      toast('已删除该记录', 'info', {
        action: {
          label: '撤销',
          onClick: () => {
            void upsertHistory({ ...item, timestamp: Date.now() }).then(() => toast('已恢复', 'success'));
          },
        },
      });
    });
  };

  return (
    <li className="relative group">
      <Link
        href={href}
        onClick={() => {
          upsertHistory({ ...item, timestamp: Date.now() }).catch(() => {});
        }}
        className="block bg-card hover:bg-hover rounded-lg p-3 pr-10 transition-colors"
      >
        <div className="flex items-center gap-3">
          {item.pic && !imgFailed ? (
            <SmartImage
              url={item.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              className="w-10 h-14 object-cover rounded bg-chip"
              onExhausted={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-10 h-14 rounded bg-chip flex items-center justify-center shrink-0">
              <Icon name="link" className="w-4 h-4 text-faint" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-content truncate">{item.title}</div>
            <div className="text-xs text-faint mt-0.5 flex items-center gap-1.5 flex-wrap">
              {item.totalEpisodes > 0 && <span>第 {item.episodeIndex + 1}/{item.totalEpisodes} 集</span>}
              {hasPercent && <span>· {formatTime(item.playbackPosition)}</span>}
              <span>· {formatRelativeTime(item.timestamp)}</span>
            </div>
            {hasPercent && (
              <div className="mt-1.5 h-1 bg-hover rounded-full overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        </div>
      </Link>
      <button
        className={cn(
          'absolute right-2 top-2 p-2 rounded-full text-faint hover:text-danger',
          'opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity'
        )}
        aria-label="删除记录"
        title="删除记录（可在提示中撤销）"
        onClick={remove}
      >
        <Icon name="close" className="w-4 h-4" />
      </button>
    </li>
  );
}

function FavoriteItem({ item }: { item: FavoriteEntry }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const { toast } = useToast();
  const [imgFailed, setImgFailed] = useState(false);
  const href = useWatchLink(item.sourceKey, item.vodId, 0, item.title);

  const remove = () => {
    void removeFavorite(item.sourceKey, item.vodId).then(() => {
      toast('已取消收藏', 'info', {
        action: {
          label: '撤销',
          onClick: () => {
            void db.favorites
              .put({ ...item, timestamp: Date.now() })
              .then(() => toast('已恢复收藏', 'success'));
          },
        },
      });
    });
  };

  return (
    <li className="relative group">
      <Link
        href={href}
        className="block bg-card hover:bg-hover rounded-lg p-3 pr-10 transition-colors"
      >
        <div className="flex items-center gap-3">
          {item.pic && !imgFailed ? (
            <SmartImage
              url={item.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              className="w-10 h-14 object-cover rounded bg-chip"
              onExhausted={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-10 h-14 rounded bg-chip flex items-center justify-center shrink-0">
              <Icon name="link" className="w-4 h-4 text-faint" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-content truncate">{item.title}</div>
            <div className="text-xs text-faint mt-0.5 flex items-center gap-1.5 flex-wrap">
              {item.totalEpisodes ? <span>{item.totalEpisodes} 集</span> : null}
              <span>· {formatRelativeTime(item.timestamp)}</span>
            </div>
          </div>
        </div>
      </Link>
      <button
        className={cn(
          'absolute right-2 top-2 p-2 rounded-full text-faint hover:text-danger',
          'opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity'
        )}
        aria-label="取消收藏"
        title="取消收藏（可在提示中撤销）"
        onClick={remove}
      >
        <Icon name="close" className="w-4 h-4" />
      </button>
    </li>
  );
}
