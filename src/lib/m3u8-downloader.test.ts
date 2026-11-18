import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptSegment,
  extractM3u8Url,
  parseRetryAfterMs,
  runDownloadJob,
  segmentRetryDelayMs,
  PauseResumeController,
  SegmentFetchError,
  type DownloadProgress,
} from './m3u8-downloader';
import { parseM3u8Playlist } from './m3u8-parse';
import type { SaveTarget } from './download-saver';

const KEY = crypto.getRandomValues(new Uint8Array(16));
const asBuf = (v: Uint8Array): BufferSource => v.buffer as ArrayBuffer;
const PLAINTEXT = crypto.getRandomValues(new Uint8Array(188 * 3));

async function encryptForIv(plaintext: BufferSource, iv: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', asBuf(KEY), 'AES-CBC', false, ['encrypt']);
  return crypto.subtle.encrypt({ name: 'AES-CBC', iv: asBuf(iv) }, cryptoKey, plaintext);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decryptSegment', () => {
  it('显式 IV：密文往返还原明文', async () => {
    const cipher = await encryptForIv(PLAINTEXT, new Uint8Array(16).fill(0xab));
    const out = await decryptSegment(cipher, asBuf(KEY), 'ab'.repeat(16), 0, 0);
    expect(new Uint8Array(out)).toEqual(PLAINTEXT);
  });

  it('无 IV 属性：IV = mediaSequence + 分片序号（16 字节大端），逐分片递增', async () => {
    // 分片 0（媒体序列号 5 → IV=5）与分片 1（IV=6）用各自正确的 IV 加密
    const ivOf = (seq: number) => {
      const iv = new Uint8Array(16);
      iv[15] = seq;
      return iv;
    };
    const cipher0 = await encryptForIv(PLAINTEXT, ivOf(5));
    const cipher1 = await encryptForIv(PLAINTEXT, ivOf(6));

    const out0 = await decryptSegment(cipher0, asBuf(KEY), undefined, 5, 0);
    expect(new Uint8Array(out0)).toEqual(PLAINTEXT);
    const out1 = await decryptSegment(cipher1, asBuf(KEY), undefined, 5, 1);
    expect(new Uint8Array(out1)).toEqual(PLAINTEXT);
  });

  it('回归：旧实现恒用零向量 IV——对非零序列号分片解密必然失败', async () => {
    // 分片按正确 IV=6 加密；旧实现对无 IV 属性的 KEY 恒用零向量 → 解不出明文
    const cipher = await encryptForIv(PLAINTEXT, ivOf6());
    const zeroIv = '00'.repeat(16);
    const out = await decryptSegment(cipher, asBuf(KEY), zeroIv, 5, 1).catch(
      () => new ArrayBuffer(0)
    );
    const same =
      out.byteLength === PLAINTEXT.byteLength &&
      new Uint8Array(out).every((b, i) => b === PLAINTEXT[i]);
    expect(same).toBe(false);
  });
});

function ivOf6(): Uint8Array {
  const iv = new Uint8Array(16);
  iv[15] = 6;
  return iv;
}

describe('parseM3u8Playlist · mediaSequence 与 AES URI 绝对化', () => {
  it('解析 EXT-X-MEDIA-SEQUENCE，AES key 相对地址转绝对', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:15',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4,',
      'seg0.ts',
      '#EXTINF:4,',
      'seg1.ts',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(playlist, { status: 200 }))
    );

    const parsed = await parseM3u8Playlist('https://cdn.example.com/live/index.m3u8');
    expect(parsed.mediaSequence).toBe(15);
    expect(parsed.aesConf?.uri).toBe('https://cdn.example.com/live/key.bin');
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].url).toBe('https://cdn.example.com/live/seg0.ts');
  });

  it('缺省 MEDIA-SEQUENCE 时为 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('#EXTM3U\n#EXTINF:4,\nseg.ts', { status: 200 }))
    );
    const parsed = await parseM3u8Playlist('https://cdn.example.com/a.m3u8');
    expect(parsed.mediaSequence).toBe(0);
  });
});

describe('extractM3u8Url · 播放页提取 m3u8 直链', () => {
  const PAGE = 'https://hd.kuktxu.com/play/aQWNkRLd';

  it('金鹰实页形态：JS 变量里引号内嵌的绝对地址', () => {
    const html = `<script>const vid = 'https://hd.kuktxu.com/play/aQWNkRLd/index.m3u8';</script>`;
    expect(extractM3u8Url(html, PAGE)).toBe('https://hd.kuktxu.com/play/aQWNkRLd/index.m3u8');
  });

  it('引号内相对地址：按播放页地址绝对化', () => {
    const html = `<script>var u = "/play/aQWNkRLd/index.m3u8";</script>`;
    expect(extractM3u8Url(html, PAGE)).toBe('https://hd.kuktxu.com/play/aQWNkRLd/index.m3u8');
  });

  it('协议相对地址补 https', () => {
    const html = `<script>var u = '//cdn.example.com/v/index.m3u8';</script>`;
    expect(extractM3u8Url(html, PAGE)).toBe('https://cdn.example.com/v/index.m3u8');
  });

  it('带查询串的地址保留查询串', () => {
    const html = `<script>var u = 'https://cdn.example.com/v/index.m3u8?token=abc';</script>`;
    expect(extractM3u8Url(html, PAGE)).toBe('https://cdn.example.com/v/index.m3u8?token=abc');
  });

  it('页面里没有 m3u8 时返回 undefined（走原报错路径）', () => {
    expect(extractM3u8Url('<html><body>no video</body></html>', PAGE)).toBeUndefined();
  });
});

describe('parseRetryAfterMs', () => {
  it('秒数形式', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
  });

  it('超上限夹到 30s', () => {
    expect(parseRetryAfterMs('120')).toBe(30_000);
  });

  it('缺失/无法解析返回 undefined', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });

  it('HTTP 日期形式', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(10_000);
  });
});

describe('segmentRetryDelayMs · 指数退避 + Retry-After', () => {
  it('普通错误：1s → 2s → 4s 指数退避', () => {
    const err = new Error('boom');
    expect(segmentRetryDelayMs(0, err)).toBe(1000);
    expect(segmentRetryDelayMs(1, err)).toBe(2000);
    expect(segmentRetryDelayMs(2, err)).toBe(4000);
  });

  it('Retry-After 大于退避时取 Retry-After', () => {
    const err = new SegmentFetchError('分片 HTTP 429', 429, 5000);
    expect(segmentRetryDelayMs(0, err)).toBe(5000);
  });

  it('Retry-After 小于退避时取退避', () => {
    const err = new SegmentFetchError('分片 HTTP 429', 429, 500);
    expect(segmentRetryDelayMs(2, err)).toBe(4000);
  });

  it('等待封顶 30s', () => {
    const err = new SegmentFetchError('分片 HTTP 429', 429, 30_000);
    expect(segmentRetryDelayMs(10, err)).toBe(30_000);
  });
});

/** 内存版 Cache Storage 替身：只实现 runDownloadJob 用到的 open/match/put */
function stubCacheStorage() {
  const store = new Map<string, ArrayBuffer>();
  const cache = {
    match: async (req: Request) => {
      const buf = store.get(req.url);
      return buf ? new Response(buf.slice(0)) : undefined;
    },
    put: async (req: Request, res: Response) => {
      store.set(req.url, await res.arrayBuffer());
    },
    keys: async () => [...store.keys()].map((url) => new Request(url)),
    delete: async (req: Request) => store.delete(req.url),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  return store;
}

function memoryTarget(collected: Uint8Array[]): SaveTarget {
  return {
    kind: 'memory',
    write: async (data) => {
      collected.push(data.slice());
    },
    close: async () => {},
    abort: async () => {},
  };
}

const MEDIA_PLAYLIST = ['#EXTM3U', '#EXTINF:4,', 'seg0.ts', '#EXTINF:4,', 'seg1.ts', '#EXT-X-ENDLIST'].join('\n');

describe('runDownloadJob · 直连优先 / 代理兜底 / 播放页', () => {
  it('分片直连网络失败 → 回退代理并完成下载', async () => {
    stubCacheStorage();
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        fetched.push(url);
        if (url === 'https://cdn-a.example.com/v/index.m3u8') {
          return new Response(MEDIA_PLAYLIST, { status: 200 });
        }
        if (url.startsWith('https://cdn-a.example.com/v/seg')) {
          throw new TypeError('Failed to fetch'); // 模拟 CORS/网络层失败
        }
        if (url.startsWith('/api/proxy?url=')) {
          const target = decodeURIComponent(url.slice('/api/proxy?url='.length));
          if (target === 'https://cdn-a.example.com/v/seg0.ts') {
            return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
          }
          if (target === 'https://cdn-a.example.com/v/seg1.ts') {
            return new Response(new Uint8Array([4, 5]), { status: 200 });
          }
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const collected: Uint8Array[] = [];
    const progresses: DownloadProgress[] = [];
    await runDownloadJob({
      taskId: 'test-a',
      url: 'https://cdn-a.example.com/v/index.m3u8',
      title: 't',
      format: 'TS',
      signal: new AbortController().signal,
      pause: new PauseResumeController(),
      onProgress: (p) => progresses.push(p),
      target: memoryTarget(collected),
    });

    const bytes = collected.flatMap((c) => [...c]);
    expect(bytes).toEqual([1, 2, 3, 4, 5]);
    // 兜底证据：分片最终经代理拉到
    expect(fetched.some((u) => u.startsWith('/api/proxy?url='))).toBe(true);
    expect(progresses.at(-1)?.status).toBe('done');
  });

  it('播放页地址 → 提取 m3u8 直链后直连下载', async () => {
    stubCacheStorage();
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        fetched.push(url);
        if (url.startsWith('/api/proxy?url=')) {
          const target = decodeURIComponent(url.slice('/api/proxy?url='.length));
          if (target === 'https://play.example.com/play/xyz') {
            return new Response(
              `<script>const vid = 'https://cdn-b.example.com/v/index.m3u8';</script>`,
              { status: 200 }
            );
          }
        }
        if (url === 'https://cdn-b.example.com/v/index.m3u8') {
          return new Response(MEDIA_PLAYLIST, { status: 200 });
        }
        if (url === 'https://cdn-b.example.com/v/seg0.ts') {
          return new Response(new Uint8Array([9]), { status: 200 });
        }
        if (url === 'https://cdn-b.example.com/v/seg1.ts') {
          return new Response(new Uint8Array([8]), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const collected: Uint8Array[] = [];
    await runDownloadJob({
      taskId: 'test-b',
      url: 'https://play.example.com/play/xyz',
      title: 't',
      format: 'TS',
      signal: new AbortController().signal,
      pause: new PauseResumeController(),
      onProgress: () => {},
      target: memoryTarget(collected),
    });

    expect(collected.flatMap((c) => [...c])).toEqual([9, 8]);
    expect(fetched).toContain('https://cdn-b.example.com/v/index.m3u8');
  });

  it('分片直连 HTTP 错误（403）→ 回退代理并完成下载', async () => {
    stubCacheStorage();
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        fetched.push(url);
        if (url === 'https://cdn-c.example.com/v/index.m3u8') {
          return new Response(MEDIA_PLAYLIST, { status: 200 });
        }
        if (url.startsWith('https://cdn-c.example.com/v/seg')) {
          // 直连被拒：HTTP 错误（SegmentFetchError），不是 TypeError——
          // 旧口径不回退代理、原地重试到失败，金鹰分片全灭即此形态
          return new Response('Forbidden', { status: 403 });
        }
        if (url.startsWith('/api/proxy?url=')) {
          const target = decodeURIComponent(url.slice('/api/proxy?url='.length));
          if (target === 'https://cdn-c.example.com/v/seg0.ts') {
            return new Response(new Uint8Array([7, 7]), { status: 200 });
          }
          if (target === 'https://cdn-c.example.com/v/seg1.ts') {
            return new Response(new Uint8Array([6]), { status: 200 });
          }
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const collected: Uint8Array[] = [];
    await runDownloadJob({
      taskId: 'test-c',
      url: 'https://cdn-c.example.com/v/index.m3u8',
      title: 't',
      format: 'TS',
      signal: new AbortController().signal,
      pause: new PauseResumeController(),
      onProgress: () => {},
      target: memoryTarget(collected),
    });

    expect(collected.flatMap((c) => [...c])).toEqual([7, 7, 6]);
    expect(fetched.some((u) => u.startsWith('/api/proxy?url='))).toBe(true);
  });

  it('分片直连头超时停滞（AbortError）→ 回退代理并完成下载', async () => {
    stubCacheStorage();
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        fetched.push(url);
        if (url === 'https://cdn-d.example.com/v/index.m3u8') {
          return new Response(MEDIA_PLAYLIST, { status: 200 });
        }
        if (url.startsWith('https://cdn-d.example.com/v/seg')) {
          // 非标端口宿主在浏览器侧停滞 → 头超时 abort，fetch 以 AbortError 拒绝
          const err = new Error('The user aborted a request.');
          err.name = 'AbortError';
          throw err;
        }
        if (url.startsWith('/api/proxy?url=')) {
          const target = decodeURIComponent(url.slice('/api/proxy?url='.length));
          if (target === 'https://cdn-d.example.com/v/seg0.ts') {
            return new Response(new Uint8Array([5]), { status: 200 });
          }
          if (target === 'https://cdn-d.example.com/v/seg1.ts') {
            return new Response(new Uint8Array([4]), { status: 200 });
          }
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const collected: Uint8Array[] = [];
    await runDownloadJob({
      taskId: 'test-d',
      url: 'https://cdn-d.example.com/v/index.m3u8',
      title: 't',
      format: 'TS',
      signal: new AbortController().signal,
      pause: new PauseResumeController(),
      onProgress: () => {},
      target: memoryTarget(collected),
    });

    expect(collected.flatMap((c) => [...c])).toEqual([5, 4]);
    expect(fetched.some((u) => u.startsWith('/api/proxy?url='))).toBe(true);
  });

  it('代理把 HTML 当 200 返回 → 视为分片失败，绝不当分片写入缓存', async () => {
    const store = stubCacheStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === 'https://cdn-e.example.com/v/index.m3u8') {
          return new Response(MEDIA_PLAYLIST, { status: 200 });
        }
        if (url.startsWith('https://cdn-e.example.com/v/seg')) {
          throw new TypeError('Failed to fetch');
        }
        if (url.startsWith('/api/proxy?url=')) {
          // 代理缓存投毒形态：任何目标都回同一份 HTML + 200
          return new Response('<html><body>play page</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await expect(
      runDownloadJob({
        taskId: 'test-e',
        url: 'https://cdn-e.example.com/v/index.m3u8',
        title: 't',
        format: 'TS',
        signal: new AbortController().signal,
        pause: new PauseResumeController(),
        onProgress: () => {},
        target: memoryTarget([]),
      })
    ).rejects.toThrow(/分片 \d 下载失败/);
    // HTML 没被当成分片存进断点缓存
    expect([...store.keys()].filter((k) => k.includes('test-e'))).toHaveLength(0);
  }, 15_000);
});
