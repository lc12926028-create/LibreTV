import { parseM3u8Playlist, type ParsedPlaylist } from './m3u8-parse';
import { PROXY_BASE, isProxiedUri, makeAbsolute } from './m3u8';
import { StreamingTransmuxer } from './mp4-transmuxer';

/**
 * 把下载地址改写为经本站代理的地址（兜底通道）。
 * 2026-11-18 起下载改为「直连优先、代理兜底」：实测主要片源 CDN 均返回
 * Access-Control-Allow-Origin: *，直连可行；而全量走代理时一集要打 1600+
 * 次 Netlify 函数调用、约 700MB 流量全走免费额度，下到一半被限流打死
 * （三源分片直连实测全通，失败只发生在代理链路）。
 * 因此解析与分片拉取先直连源站，仅网络/CORS 失败才回退代理；
 * 对 CORS 封闭的源，回退后行为与旧版全程代理一致。
 * 注意：经代理拉到的播放列表已被代理重写（分片/key 均指回代理，见
 * proxy-handlers），解析出的地址本身就是代理地址，不会再被直连逻辑改动。
 */
function toProxyUrl(url: string): string {
  if (isProxiedUri(url)) return url;
  return PROXY_BASE + encodeURIComponent(url);
}

/** 直连已证实失败（CORS/网络层）的源站 origin：本页会话内后续请求直接走代理，避免每片都先撞一次墙 */
const directFailedOrigins = new Set<string>();

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * 从播放页 HTML 中提取 m3u8 直链。
 * 部分源（如金鹰点播）的分集地址是播放页而非 m3u8：页面里以 JS 变量形式
 * 内嵌真正的列表地址（<播放页>/index.m3u8）。优先取引号内的完整地址，
 * 其次裸写的绝对/相对地址；提取不到返回 undefined，由调用方走原报错路径。
 */
export function extractM3u8Url(html: string, pageUrl: string): string | undefined {
  const quoted = html.match(/["']([^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)["']/i);
  const bare =
    quoted ??
    html.match(/(?:https?:)?\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/i) ??
    html.match(/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/i);
  let found = quoted ? quoted[1] : bare?.[0];
  if (!found) return undefined;
  if (found.startsWith('//')) found = `https:${found}`;
  return makeAbsolute(found, pageUrl);
}

/**
 * 分集地址归一：不是 .m3u8 结尾时按播放页处理——经代理取页面并提取其中
 * 的 m3u8 直链；取不到/提取失败则原样返回（后续解析会按原路径报错）。
 */
async function resolveEntryUrl(url: string, signal: AbortSignal): Promise<string> {
  if (isProxiedUri(url)) return url;
  const path = url.split(/[?#]/)[0];
  if (path.toLowerCase().endsWith('.m3u8')) return url;
  try {
    const res = await fetch(toProxyUrl(url), { signal, headers: { Accept: 'text/html,*/*' } });
    if (!res.ok) return url;
    const html = await res.text();
    return extractM3u8Url(html, url) ?? url;
  } catch {
    return url;
  }
}

/**
 * 整集离线下载：
 * - 分片并发下载（默认 8），单分片 3 次重试，已下载分片写入 Cache Storage
 *   （`libretv-dl-v1` 桶）实现网络层断点——中断后续传不再耗流量；
 * - AES-128 解密用 WebCrypto AES-CBC（HLS 标准），不引入 CryptoJS；
 * - 输出：TS 直接顺序拼接；MP4 经 mux.js 流式转封装（边下边写，不聚整集）；
 * - 保存目标（FS Access / 内存）由调用方在用户手势内选好传入，本模块只管写。
 *
 * 文件层断点的现实约束：FS Access 句柄与内存 Blob 都活不过页面刷新，
 * 因此「断点续传」指网络层——刷新后重试同一任务会跳过已下载的分片，
 * 但需要用户重新选择保存位置。
 */

const DL_CACHE_NAME = 'libretv-dl-v1';
const SEGMENT_TIMEOUT_MS = 20_000;
const SEGMENT_STALL_MS = 60_000;
const MAX_SEGMENT_RETRIES = 3;

export class PauseResumeController {
  private paused = false;
  private waiters: Array<() => void> = [];

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }

  getPaused(): boolean {
    return this.paused;
  }

  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  destroy(): void {
    this.resume();
  }
}

export interface DownloadProgress {
  current: number;
  total: number;
  percentage: number;
  status: 'downloading' | 'processing' | 'done' | 'error';
  message?: string;
}

/**
 * 分片缓存 key。Cache Storage 的 put/match 只接受 http(s) scheme——
 * 自定义字符串（如 `libretv-dl-v1:dl:...`）会被 URL 解析成同名自定义协议，
 * put 直接抛 "Request scheme ... is unsupported"。因此用一段不会被真实
 * 请求的保留域名构造合法 URL，仅作缓存 key 使用；taskId 经编码避免歧义。
 */
const DL_CHUNK_ORIGIN = 'https://dl.libretv.local';

function dlChunkKey(taskId: string, index: number): string {
  return `${DL_CHUNK_ORIGIN}/${encodeURIComponent(taskId)}/${index}`;
}

export async function clearDownloadChunks(taskId: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(DL_CACHE_NAME);
    const keys = await cache.keys();
    const prefix = `${DL_CHUNK_ORIGIN}/${encodeURIComponent(taskId)}/`;
    await Promise.all(keys.filter((r) => r.url.startsWith(prefix)).map((r) => cache.delete(r)));
  } catch { /* 忽略 */ }
}

/** Retry-After / 退避等待上限：再久不如让任务失败、由用户重试 */
const RETRY_AFTER_CAP_MS = 30_000;
const SEGMENT_RETRY_BASE_MS = 1000;

/** 分片拉取失败：HTTP 失败时携带状态码与上游 Retry-After，供重试退避决策 */
export class SegmentFetchError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'SegmentFetchError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 解析 Retry-After 头（秒数或 HTTP 日期），并夹到上限内 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(parseInt(trimmed, 10) * 1000, RETRY_AFTER_CAP_MS);
  }
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) {
    return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_CAP_MS);
  }
  return undefined;
}

/**
 * 分片重试等待：指数退避（1s → 2s → 4s…）与上游 Retry-After 取大者。
 * 旧实现固定 1/2/3 秒且不看 Retry-After，撞上游 429 时越重试越被限。
 */
export function segmentRetryDelayMs(retryIndex: number, err: unknown): number {
  const backoff = SEGMENT_RETRY_BASE_MS * 2 ** retryIndex;
  const retryAfter = err instanceof SegmentFetchError ? err.retryAfterMs ?? 0 : 0;
  return Math.min(Math.max(backoff, retryAfter), RETRY_AFTER_CAP_MS);
}

async function fetchSegmentOnce(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  // 仅对「响应头等待」限时 20s：拿到响应头后清除计时器，body 不再受固定整段时限。
  // 之前 AbortSignal.timeout(20s) 作用于整个 fetch + arrayBuffer()，分片稍大/网稍慢
  // 就 20 秒切断，重试 3 次也一样失败——「开头快、过会儿分片下载失败」就是这个原因。
  // 与服务端 /api/proxy 的 header-only 超时同款。
  const headerController = new AbortController();
  const headerTimer = setTimeout(() => headerController.abort(), SEGMENT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.any([headerController.signal, signal]),
      headers: { Accept: '*/*' },
    });
  } finally {
    clearTimeout(headerTimer);
  }
  if (!res.ok) {
    throw new SegmentFetchError(
      `分片 HTTP ${res.status}`,
      res.status,
      parseRetryAfterMs(res.headers.get('retry-after'))
    );
  }
  // body 流式读：无固定整段时限，只在 60 秒无数据时判定为停滞并中断。
  const reader = res.body?.getReader();
  if (!reader) return res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onOuterAbort = () => { try { reader.cancel(); } catch { /* 忽略 */ } };
  signal.addEventListener('abort', onOuterAbort, { once: true });
  try {
    for (;;) {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => reject(new Error('分片读取停滞超过 60 秒')), SEGMENT_STALL_MS);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), stall]);
        clearTimeout(stallTimer);
        if (done) break;
        if (value) { chunks.push(value); total += value.byteLength; }
      } catch (err) {
        clearTimeout(stallTimer);
        throw err;
      }
    }
  } finally {
    signal.removeEventListener('abort', onOuterAbort);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out.buffer;
}

/**
 * 分片拉取（直连优先、代理兜底）：
 * - 地址已是代理形态，或该 origin 本次会话内已证实直连不通 → 直接走代理；
 * - 直连在网络/CORS 层失败（fetch 以 TypeError 拒绝）→ 记下 origin 并回退代理；
 * - HTTP 错误（SegmentFetchError）与读取停滞不回退：连接本身是通的，
 *   交给上层重试退避处理，回退代理只会重复同样的上游错误。
 */
async function fetchSegment(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  if (isProxiedUri(url)) return fetchSegmentOnce(url, signal);
  const origin = originOf(url);
  if (directFailedOrigins.has(origin)) return fetchSegmentOnce(toProxyUrl(url), signal);
  try {
    return await fetchSegmentOnce(url, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof TypeError) {
      directFailedOrigins.add(origin);
      return fetchSegmentOnce(toProxyUrl(url), signal);
    }
    throw err;
  }
}

/** AES 密钥拉取：与分片同一口径（直连网络/CORS 失败才回退代理） */
async function fetchAesKey(uri: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const attempt = async (u: string): Promise<ArrayBuffer> => {
    const res = await fetch(u, { signal });
    if (!res.ok) throw new Error(`解密密钥加载失败：HTTP ${res.status}`);
    return res.arrayBuffer();
  };
  try {
    return await attempt(uri);
  } catch (err) {
    if (!isProxiedUri(uri) && err instanceof TypeError && !signal.aborted) {
      return attempt(toProxyUrl(uri));
    }
    throw err;
  }
}

/**
 * HLS AES-128 分片解密（AES-CBC / PKCS7）。
 * IV 规则（RFC 8216 §4.3.2.4）：KEY 带IV 属性时全部分片共用；**无 IV 属性时
 * IV = 分片的媒体序列号（16 字节大端）**，逐分片递增——恒用零向量会导致
 * 首片恰好正确、后续全部解密失败。
 */
function ivForSegment(mediaSequence: number, segmentIndexZeroBased: number): Uint8Array {
  const seq = BigInt(mediaSequence + segmentIndexZeroBased);
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    iv[15 - i] = Number((seq >> BigInt(8 * i)) & 0xffn);
  }
  return iv;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.padStart(32, '0').slice(0, 32).match(/.{2}/g)!.map((h) => parseInt(h, 16)));
}

export async function decryptSegment(
  data: ArrayBuffer,
  key: BufferSource,
  ivHex: string | undefined,
  mediaSequence: number,
  segmentIndexZeroBased: number
): Promise<ArrayBuffer> {
  const iv = ivHex ? hexToBytes(ivHex) : ivForSegment(mediaSequence, segmentIndexZeroBased);
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, cryptoKey, data);
}

export interface DownloadJobOptions {
  taskId: string;
  url: string;
  title: string;
  format: 'TS' | 'MP4';
  concurrency?: number;
  signal: AbortSignal;
  pause: PauseResumeController;
  onProgress: (p: DownloadProgress) => void;
  /** 在用户手势内选好的保存目标 */
  target: import('./download-saver').SaveTarget;
}

/**
 * 执行一次整集下载。调用方（DownloadManager）负责：
 * 在用户手势内 pickSaveTarget、构造 AbortSignal/PauseResumeController、
 * 更新 Dexie 任务状态；本函数只负责解析 → 并发下载 → 顺序写出。
 */
export async function runDownloadJob(opts: DownloadJobOptions): Promise<void> {
  const { taskId, url, format, signal, pause, onProgress, target } = opts;
  const concurrency = Math.min(Math.max(opts.concurrency ?? 8, 1), 16);

  const report = (current: number, total: number, status: DownloadProgress['status'], message?: string) => {
    onProgress({
      current,
      total,
      percentage: total > 0 ? Math.round((current / total) * 100) : 0,
      status,
      message,
    });
  };

  // —— 解析（直连优先、代理兜底） ——
  // 先把播放页地址归一成 m3u8 直链（见 resolveEntryUrl），再直连解析；
  // 直连失败（CORS/网络/上游错误）才回退本站代理——代理会对列表做重写，
  // 回退解析出的分片/key 地址即代理形态，后续拉取自动全程走代理。
  // 两次尝试之间留等待：429 限流时立即重试只会再吃 429。
  const entryUrl = await resolveEntryUrl(url, signal);
  const candidates = isProxiedUri(entryUrl) ? [entryUrl] : [entryUrl, toProxyUrl(entryUrl)];
  let parsed: ParsedPlaylist | undefined;
  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    try {
      parsed = await parseM3u8Playlist(candidates[i], 0, undefined, { stripLeadAd: true });
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (i < candidates.length - 1) {
        const is429 = err instanceof Error && err.message.includes('429');
        await new Promise((r) => setTimeout(r, is429 ? 4000 : 1000));
      }
    }
  }
  if (lastErr || !parsed) {
    throw new Error(`播放列表解析失败：${lastErr instanceof Error ? lastErr.message : '未知错误'}`);
  }
  if (parsed.byterange) throw new Error('该集使用 BYTERANGE 分片，暂不支持下载');

  const total = parsed.segments.length;
  report(0, total, 'downloading');

  // —— AES key 预取 ——
  let aesKey: ArrayBuffer | undefined;
  if (parsed.aesConf) {
    aesKey = await fetchAesKey(parsed.aesConf.uri, signal);
  }

  // —— 并发下载分片（Cache Storage 断点） ——
  const cache = await caches.open(DL_CACHE_NAME);
  const chunkKey = (index: number) => dlChunkKey(taskId, index);
  let cursor = 0;
  // 恢复：统计已有分片数作为起点
  let current = 0;
  for (let i = 1; i <= total; i++) {
    if (await cache.match(new Request(chunkKey(i)))) current += 1;
  }
  report(current, total, 'downloading');

  const worker = async (): Promise<void> => {
    while (cursor < total) {
      if (signal.aborted) return;
      await pause.waitIfPaused();
      const index = ++cursor; // 1 基
      // 多个 worker 会在 waitIfPaused 的让行点扎堆通过 while 检查再依次自增，
      // cursor 可冲过 total：越界 worker 没有对应分片，直接退出，
      // 否则会在重试后误报「分片 N 下载失败」把整集拖死（小集数必现、大集数尾部偶现）
      if (index > total) return;
      if (signal.aborted) return;
      await pause.waitIfPaused();
      const cached = await cache.match(new Request(chunkKey(index)));
      if (cached) {
        // 已在恢复预统计里计入，不再累加——否则续传时进度重复计数超过 100%
        continue;
      }
      const seg = parsed.segments[index - 1];
      let buffer: ArrayBuffer | undefined;
      for (let retry = 0; retry < MAX_SEGMENT_RETRIES; retry++) {
        if (signal.aborted) return;
        try {
          buffer = await fetchSegment(seg.url, signal);
          break;
        } catch (err) {
          if (signal.aborted) return;
          // 指数退避 + 尊重上游 Retry-After（见 segmentRetryDelayMs）
          if (retry < MAX_SEGMENT_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, segmentRetryDelayMs(retry, err)));
          }
        }
      }
      if (!buffer) {
        throw new Error(`分片 ${index} 下载失败（已重试 ${MAX_SEGMENT_RETRIES} 次）`);
      }
      await cache.put(
        new Request(chunkKey(index)),
        new Response(buffer.slice(0), { headers: { 'Content-Type': 'video/mp2t' } })
      );
      current += 1;
      report(current, total, 'downloading');
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (signal.aborted) return;

  // —— 顺序写出（转封装 / 拼接） ——
  report(total, total, 'processing');
  if (format === 'MP4') {
    // 传入整集时长：mux.js 恒把 moov 时长写成 0xFFFFFFFF（timescale 90000
    // → 播放器显示 13:15:21），必须在写出 initSegment 前回填真实值
    const transmuxer = new StreamingTransmuxer(target, { durationSeconds: parsed.totalDuration });
    for (let i = 1; i <= total; i++) {
      if (signal.aborted) return;
      await pause.waitIfPaused();
      const resp = await cache.match(new Request(chunkKey(i)));
      if (!resp) throw new Error(`分片 ${i} 缓存丢失，请重试`);
      let data = await resp.arrayBuffer();
      if (aesKey && parsed.aesConf) {
        data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
      }
      await transmuxer.pushAndTransmux(new Uint8Array(data));
    }
    await transmuxer.finish();
  } else {
    for (let i = 1; i <= total; i++) {
      if (signal.aborted) return;
      await pause.waitIfPaused();
      const resp = await cache.match(new Request(chunkKey(i)));
      if (!resp) throw new Error(`分片 ${i} 缓存丢失，请重试`);
      let data = await resp.arrayBuffer();
      if (aesKey && parsed.aesConf) {
        data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
      }
      await target.write(new Uint8Array(data));
    }
    await target.close();
  }
  report(total, total, 'done');
}
