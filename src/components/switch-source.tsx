'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import { PROXY_BASE, isProxiedUri } from '@/lib/m3u8';
import type { SourceConfig, SearchResultItem } from '@/lib/types';
import { buildWatchUrl, cn } from '@/lib/utils';
import { useAppStore, resolveSource } from '@/lib/store';
import { useToast } from './toast';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { EmptyState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';

/**
 * 换源面板：跨源按标题搜索 → 匹配同名/同前缀资源 → 并发测速（详情接口耗时）→ 按速度排序展示。
 * 切换时保留当前集数索引（旧版 switchToResource 逻辑的去 DOM 化重写）。
 *
 * 可下载优先（2026-11-09 用户要求）：详情接口耗时只反映源站 API 快慢，
 * 反映不了视频流本身通不通——iKun 源接口 685ms 最快，但其 CDN 域名已挂，
 * 播不了也下不了。所以每源再探一次当集播放地址：经本站代理拉取，能拿到
 * 有效 m3u8（或 MP4 响应头 200）才算可下载；排序时可下载的排前面。
 */

/** 单源下载探测死线：与服务端画质探测同量级，避免一个慢源拖住整批 */
const DOWNLOAD_PROBE_TIMEOUT_MS = 8000;

/**
 * 探指定集的播放地址是否可下载：经本站代理拉取（与下载器同款 toProxyUrl）。
 * m3u8：读文本，含 #EXTM3U 才算有效；MP4 等直链：响应头 200 即算，不读 body。
 * 超时/失败/无地址一律视为不可下载（不抛错，由调用方降级）。
 */
async function probeDownloadable(episodeUrl: string | undefined, signal: AbortSignal): Promise<boolean> {
  if (!episodeUrl) return false;
  const target = isProxiedUri(episodeUrl) ? episodeUrl : PROXY_BASE + encodeURIComponent(episodeUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(target, { signal: AbortSignal.any([controller.signal, signal]) });
    if (!res.ok) return false;
    if (episodeUrl.toLowerCase().includes('.m3u8')) {
      const text = await res.text();
      return text.includes('#EXTM3U');
    }
    try { await res.body?.cancel(); } catch { /* 忽略 */ }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface Candidate {
  source: SourceConfig;
  result: SearchResultItem;
  ms?: number;
  ok?: boolean;
  episodes?: number;
  /** 当集播放地址经代理可拉取（m3u8 有效 / MP4 响应头 200） */
  downloadable?: boolean;
}

export function SwitchSourceModal({
  currentTitle,
  currentSourceKey,
  currentVodId,
  currentIndex,
  onClose,
}: {
  currentTitle: string;
  currentSourceKey: string;
  currentVodId: string;
  currentIndex: number;
  onClose: () => void;
}) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [phase, setPhase] = useState<'searching' | 'testing' | 'done'>('searching');
  /** 封面加载失败记录（按卡片 key）；失败后降级为占位图标，避免破图 */
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开时把焦点移入弹窗、Tab 圈闭在弹窗内、关闭后归还焦点
  useFocusTrap(true, panelRef);

  const sources = useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索/测速与 React key 撞车
    const seen = new Set<string>();
    return store.selectedKeys
      .map((key) => resolveSource(store, key))
      .filter((s): s is SourceConfig => {
        if (!s || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      });
  }, [store]);

  useEffect(() => {
    // 弹窗打开期间锁定背景滚动；Esc 关闭（与其它弹窗一致）
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    // 关闭弹窗时中止在途请求：否则 N 个源的搜索 + N 个详情测速会继续占用网络与后端
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      // 1) 并行搜索所有选中源
      setPhase('searching');
      try {
        const { list } = await api.search(currentTitle, sources, store.yellowFilter, { signal: controller.signal });
        if (cancelled) return;

        // 匹配口径：优先完全同名，其次名称以标题开头（兼容「小偷 HD」「小偷[电影解说]」这类修饰名）。
        // 都没有则不展示该源——不再兜底取搜索第一条，避免把搜到的其他影片（如搜「小偷」
        // 命中的《宝贝 小偷与大盗》）误当成换源目标。
        const title = currentTitle.trim();
        const matched: Candidate[] = [];
        for (const s of sources) {
          const hits = list.filter((r) => r.sourceKey === s.key);
          const exact =
            hits.find((r) => (r.name || '').trim() === title) ??
            hits.find((r) => (r.name || '').trim().startsWith(title));
          if (exact) matched.push({ source: s, result: exact });
        }

        // 2) 并发测速（详情接口耗时）并获取集数，同时探当集是否可下载
        setPhase('testing');
        await Promise.all(
          matched.map(async (c) => {
            const r = await api.detailSpeed(c.result.vodId, c.source, controller.signal);
            if (cancelled) return;
            c.ok = r.ok;
            c.ms = r.ms;
            c.episodes = r.detail?.episodes.length ?? 0;
            // 可下载探测：只探当集（currentIndex 超界则探第 1 集），与测速并行，
            // 8 秒死线内无结果即判不可下载，不拖住整批。
            const eps = r.detail?.episodes ?? [];
            const epUrl = eps[currentIndex] ?? eps[0];
            c.downloadable = await probeDownloadable(epUrl, controller.signal);
            if (cancelled) return;
          })
        );
        if (cancelled) return;
        setCandidates(matched);
        setPhase('done');
      } catch (err) {
        // 主动中止不算失败，不提示
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (!cancelled && !aborted) {
          toast(err instanceof Error ? err.message : '换源搜索失败', 'error');
          setPhase('done');
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTitle, store.yellowFilter]);

  const sorted = [...candidates].sort((a, b) => {
    const aCurrent = a.source.key === currentSourceKey && String(a.result.vodId) === String(currentVodId);
    const bCurrent = b.source.key === currentSourceKey && String(b.result.vodId) === String(currentVodId);
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    // 可下载优先：接口快慢反映不了视频流通不通，可下载的排前面；
    // 同组内再按接口耗时排序，接口失败的沉底。
    const aDl = a.downloadable === true ? 0 : 1;
    const bDl = b.downloadable === true ? 0 : 1;
    if (aDl !== bDl) return aDl - bDl;
    const msA = a.ok ? a.ms ?? 99_999 : 99_999;
    const msB = b.ok ? b.ms ?? 99_999 : 99_999;
    return msA - msB;
  });

  const switchTo = (c: Candidate) => {
    if (!c.episodes) {
      toast('该源无可用播放资源', 'warning');
      return;
    }
    const targetIndex = currentIndex < c.episodes ? currentIndex : 0;
    onClose(); // 先关闭面板，避免路由参数变化后弹窗残留旧数据
    router.push(
      buildWatchUrl({
        sourceKey: c.source.key,
        vodId: c.result.vodId,
        index: targetIndex,
        title: c.result.name || currentTitle,
        sourceUrl: c.source.url,
        detail: c.source.detail,
      })
    );
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto bg-black/80 py-10 px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-surface-raised rounded-xl w-full max-w-3xl shadow-2xl p-5 animate-slide-up outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={`换源：${currentTitle}`}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content truncate" title={currentTitle}>
              {currentTitle}
            </h2>
            <p className="text-xs text-faint">
              {phase === 'searching'
                ? '正在搜索各资源...'
                : phase === 'testing'
                  ? '正在测试各资源速率...'
                  : `共 ${sorted.length} 个来源 · ${sorted.filter((c) => c.ok).length} 个可用 · ${sorted.filter((c) => c.downloadable).length} 个可下载`}
            </p>
          </div>
          <button className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover" onClick={onClose} aria-label="关闭">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {phase !== 'done' ? (
          <LoadingState label={phase === 'searching' ? '搜索各资源中...' : '测速中...'} />
        ) : sorted.length === 0 ? (
          <EmptyState variant="plain" title="其他点播源未找到同名资源" />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {sorted.map((c) => {
              const isCurrent = c.source.key === currentSourceKey && String(c.result.vodId) === String(currentVodId);
              const cardKey = `${c.source.key}_${c.result.vodId}`;
              const img = c.result.pic;
              const coverFailed = imgFailed[cardKey] ?? false;
              return (
                <button
                  key={`${c.source.key}_${c.result.vodId}`}
                  className={cn('text-left group relative rounded-lg overflow-hidden bg-card transition-transform', !isCurrent && 'hover:scale-[1.03] cursor-pointer', isCurrent && 'cursor-default')}
                  onClick={() => !isCurrent && switchTo(c)}
                  disabled={isCurrent}
                >
                  <div className="relative aspect-[2/3] bg-chip">
                    {img && !coverFailed ? (
                      <SmartImage
                        url={c.result.pic}
                        mode={store.imageProxyMode}
                        customProxy={store.customImageProxy}
                        alt={c.result.name}
                        className="w-full h-full object-cover"
                        onExhausted={() => setImgFailed((prev) => ({ ...prev, [cardKey]: true }))}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-faint">
                        <Icon name="link" className="w-6 h-6" />
                      </div>
                    )}
                    <span
                      className={cn(
                        'absolute top-1.5 right-1.5 tag',
                        !c.ok ? 'bg-danger-solid/85 text-white' : c.ms! > 2000 ? 'bg-warning-solid/85 text-white' : 'bg-success-solid/85 text-white'
                      )}
                    >
                      {!c.ok ? '失败' : `${c.ms}ms`}
                    </span>
                    {isCurrent && (
                      <span className="absolute inset-x-0 bottom-0 bg-accent/90 text-on-accent text-xs text-center py-1">当前播放</span>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-medium text-content truncate" title={c.source.name}>
                      {c.source.name}
                    </div>
                    <div className="text-xs text-faint mt-0.5 flex items-center gap-1.5">
                      <span>{c.episodes ? `${c.episodes} 集` : '无资源'}</span>
                      {c.downloadable && (
                        <span className="bg-success-solid/85 text-white rounded px-1 py-px text-[10px] leading-none">可下载</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
