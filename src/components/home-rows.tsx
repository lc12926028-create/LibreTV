'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { DoubanItem } from '@/lib/types';
import { DoubanCard } from './video-card';
import { SmartImage } from './smart-image';
import { Icon } from './icon';

/**
 * 首页方案 B「Netflix 式横排」：今日焦点大横幅 + 多行横向滚动榜单。
 * 数据全部走现有接口（豆瓣推荐 + 豆瓣周榜），不新增后端。
 * IMDb 周榜暂无公开免费接口：用豆瓣「欧美」热门近似，行标题下标注数据来源。
 */
export function HomeRows({ onPick }: { onPick: (title: string) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const weekly = useQuery({
    queryKey: ['hot-list', 'douban_movie_weekly'],
    queryFn: ({ signal }) => api.hotList('douban_movie_weekly', signal),
  });
  const imdb = useQuery({
    queryKey: ['douban', 'movie', '欧美'],
    queryFn: ({ signal }) => api.douban('movie', '欧美', 0, 20, signal),
  });
  const koubei = useQuery({
    queryKey: ['douban', 'movie', '豆瓣高分'],
    queryFn: ({ signal }) => api.douban('movie', '豆瓣高分', 0, 20, signal),
  });
  const newest = useQuery({
    queryKey: ['douban', 'movie', '最新'],
    queryFn: ({ signal }) => api.douban('movie', '最新', 0, 20, signal),
  });
  const classic = useQuery({
    queryKey: ['douban', 'movie', '经典'],
    queryFn: ({ signal }) => api.douban('movie', '经典', 0, 20, signal),
  });
  const tvHot = useQuery({
    queryKey: ['douban', 'tv', '热门'],
    queryFn: ({ signal }) => api.douban('tv', '热门', 0, 20, signal),
  });
  const showHot = useQuery({
    queryKey: ['douban', 'tv', '综艺'],
    queryFn: ({ signal }) => api.douban('tv', '综艺', 0, 20, signal),
  });

  if (!doubanEnabled) return null;

  const weeklyItems = weekly.data?.items ?? [];
  const hero = weeklyItems[0] ?? imdb.data?.items[0] ?? koubei.data?.items[0] ?? null;
  const anyError =
    weekly.isError || imdb.isError || koubei.isError || newest.isError || classic.isError || tvHot.isError || showHot.isError;
  const anyLoading =
    weekly.isLoading || imdb.isLoading || koubei.isLoading || newest.isLoading || classic.isLoading || tvHot.isLoading || showHot.isLoading;

  return (
    <div className="space-y-7">
      {/* 今日焦点：本周电影周榜第 1 名 */}
      {hero && (
        <section aria-label="今日焦点" className="relative overflow-hidden rounded-2xl border border-line">
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(100deg, rgba(35,173,229,0.22) 0%, rgba(35,173,229,0.06) 45%, transparent 75%)',
            }}
          />
          <div className="relative flex gap-4 sm:gap-6 p-4 sm:p-6 items-center">
            <div className="w-28 sm:w-36 shrink-0 aspect-[2/3] rounded-lg overflow-hidden bg-chip shadow-lg">
              <SmartImage
                url={hero.cover}
                mode={imageProxyMode}
                customProxy={customImageProxy}
                alt={hero.title}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <span className="inline-block text-xs font-medium text-accent bg-accent/10 rounded-full px-2.5 py-0.5 mb-2">
                今日焦点 · 本周电影周榜第 1 名
              </span>
              <h2 className="text-xl sm:text-3xl font-bold text-content leading-tight truncate">{hero.title}</h2>
              {hero.rating && (
                <p className="mt-1.5 text-sm text-rating font-medium">★ {hero.rating} 分</p>
              )}
              <button
                className="btn-primary mt-4 px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5"
                onClick={() => onPick(hero.title)}
              >
                <Icon name="search" className="w-4 h-4" />
                搜索这部片
              </button>
            </div>
          </div>
        </section>
      )}

      {anyError && !hero && (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      )}
      {anyLoading && !hero && <RowsSkeleton />}

      {/* 今日热门 Top 10：大数字名次 */}
      <Row title="今日热门 Top 10" subtitle="豆瓣电影周榜">
        {weeklyItems.slice(0, 10).map((item, i) => (
          <div key={item.id} className="flex items-end shrink-0">
            <span
              aria-hidden
              className="text-[64px] sm:text-[80px] leading-[0.8] font-black text-transparent select-none -mr-3 sm:-mr-4 mb-1"
              style={{ WebkitTextStroke: '2px rgba(148,163,184,0.55)' }}
            >
              {i + 1}
            </span>
            <div className="w-[110px] sm:w-[130px]">
              <DoubanCard item={item} onClick={() => onPick(item.title)} />
            </div>
          </div>
        ))}
      </Row>

      <Row title="IMDb 周榜" subtitle="海外热门 · 豆瓣数据（IMDb 暂无公开免费接口）">
        {(imdb.data?.items ?? []).map((item) => (
          <div key={item.id} className="w-[110px] sm:w-[130px] shrink-0">
            <DoubanCard item={item} onClick={() => onPick(item.title)} />
          </div>
        ))}
      </Row>

      <Row title="豆瓣一周口碑" subtitle="豆瓣高分">
        {(koubei.data?.items ?? []).map((item) => (
          <div key={item.id} className="w-[110px] sm:w-[130px] shrink-0">
            <DoubanCard item={item} onClick={() => onPick(item.title)} />
          </div>
        ))}
      </Row>

      <Row title="最新上映">
        {(newest.data?.items ?? []).map((item) => (
          <div key={item.id} className="w-[110px] sm:w-[130px] shrink-0">
            <DoubanCard item={item} onClick={() => onPick(item.title)} />
          </div>
        ))}
      </Row>

      <Row title="高分经典">
        {(classic.data?.items ?? []).map((item) => (
          <div key={item.id} className="w-[110px] sm:w-[130px] shrink-0">
            <DoubanCard item={item} onClick={() => onPick(item.title)} />
          </div>
        ))}
      </Row>

      <Row title="热门剧集">
        {(tvHot.data?.items ?? []).map((item) => (
          <div key={item.id} className="w-[110px] sm:w-[130px] shrink-0">
            <DoubanCard item={item} onClick={() => onPick(item.title)} />
          </div>
        ))}
      </Row>

      <Row title="热门综艺">
        {(showHot.data?.items ?? []).map((item) => (
          <div key={item.id} className="w-[110px] sm:w-[130px] shrink-0">
            <DoubanCard item={item} onClick={() => onPick(item.title)} />
          </div>
        ))}
      </Row>
    </div>
  );
}

/** 一行横向滚动：标题 + 可左右滑动的卡片带 */
function Row({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="flex items-baseline gap-2 mb-2.5">
        <h2 className="text-base font-semibold text-content">{title}</h2>
        {subtitle && <span className="text-xs text-faint">{subtitle}</span>}
      </div>
      <div className="flex gap-2.5 overflow-x-auto pb-1 no-scrollbar snap-x">
        {children}
      </div>
    </section>
  );
}

function RowsSkeleton() {
  return (
    <div className="space-y-7">
      {Array.from({ length: 3 }).map((_, r) => (
        <div key={r}>
          <div className="h-5 w-32 rounded bg-chip animate-pulse mb-2.5" />
          <div className="flex gap-2.5 overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="w-[110px] sm:w-[130px] shrink-0">
                <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
                <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
