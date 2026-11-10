import { describe, expect, it } from 'vitest';
import { buildDownloadDedupKey, findDuplicateDownload } from './download-dedup';
import type { DownloadTaskEntry } from './db';

function entry(overrides: Partial<DownloadTaskEntry>): DownloadTaskEntry {
  return {
    id: 'dl_1',
    url: 'https://example.com/1.m3u8',
    title: '测试剧 第1集',
    format: 'MP4',
    status: 'waiting',
    finished: 0,
    total: 0,
    errorNum: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('buildDownloadDedupKey', () => {
  it('与播放进度 episodeKey 同口径：源:影片:集数', () => {
    expect(buildDownloadDedupKey('360资源', '12345', 0)).toBe('360资源:12345:0');
    expect(buildDownloadDedupKey('360资源', '12345', 2)).toBe('360资源:12345:2');
  });
});

describe('findDuplicateDownload', () => {
  it('无 dedupKey 时不拦截', () => {
    expect(findDuplicateDownload([entry({ dedupKey: 'a:1:0' })], undefined)).toBeNull();
  });

  it('没有同键记录时不拦截', () => {
    expect(findDuplicateDownload([entry({ dedupKey: 'a:1:0' })], 'a:1:1')).toBeNull();
    expect(findDuplicateDownload([], 'a:1:0')).toBeNull();
  });

  it('同一源同一集正在排队/下载中/已暂停时拦截为 downloading', () => {
    for (const status of ['waiting', 'downloading', 'paused'] as const) {
      const dup = findDuplicateDownload([entry({ dedupKey: 'a:1:0', status })], 'a:1:0');
      expect(dup?.state).toBe('downloading');
    }
  });

  it('同一源同一集已下载完成时拦截为 completed', () => {
    const dup = findDuplicateDownload([entry({ dedupKey: 'a:1:0', status: 'completed' })], 'a:1:0');
    expect(dup?.state).toBe('completed');
  });

  it('同一源同一集下载失败时不拦截，允许重试', () => {
    expect(findDuplicateDownload([entry({ dedupKey: 'a:1:0', status: 'error' })], 'a:1:0')).toBeNull();
  });

  it('同一集换源（sourceKey 不同）不拦截', () => {
    expect(findDuplicateDownload([entry({ dedupKey: 'a:1:0' })], 'b:1:0')).toBeNull();
  });

  it('同一源不同集不拦截', () => {
    expect(findDuplicateDownload([entry({ dedupKey: 'a:1:0' })], 'a:1:1')).toBeNull();
  });

  it('改动前已有的旧记录（无 dedupKey）不参与拦截', () => {
    expect(findDuplicateDownload([entry({})], 'a:1:0')).toBeNull();
  });
});
