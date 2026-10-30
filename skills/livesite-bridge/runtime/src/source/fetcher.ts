// 源抓取器：拉活站点 index.html → 解析 script 清单 + 内联 runtime（webpack chunk 映射表）
// → 枚举并下载全量懒加载 chunk → content-hash（sha1-12）版本化落盘。
// 逻辑移植自 poc/derive-contract.mjs（已实测：190/190 chunk 下载成功）。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BundleMeta } from '../contract/types.js';

export interface SourceFile extends BundleMeta {
  text: string;
  url: string;
}

export interface FetchResult {
  /** index.html 外部 script 数 */
  entryCount: number;
  /** 内联 script 数（含 webpack runtime） */
  inlineCount: number;
  /** 懒加载 chunk 下载 成功/失败 数 */
  chunkOk: number;
  chunkFail: number;
  /** 全量源码树（入口 + 内联 + 懒加载 chunk） */
  bundles: SourceFile[];
  totalBytes: number;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);

async function get(url: string, timeoutMs = 25_000): Promise<{ status: number | string; body: string }> {
  return new Promise((res) => {
    const req = new Request(url, { headers: { 'User-Agent': UA } });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(req, { signal: ctrl.signal, redirect: 'follow' })
      .then(async (r) => {
        const body = await r.text();
        res({ status: r.status, body });
      })
      .catch((e) => res({ status: 'ERR', body: String(e) }))
      .finally(() => clearTimeout(timer));
  });
}

/** 括号配平读对象字面量（str[i] === '{'） */
function readObj(str: string, i: number): string {
  let d = 0;
  let j = i;
  for (; j < str.length; j++) {
    const ch = str[j]!;
    if (ch === '{') d++;
    else if (ch === '}') {
      d--;
      if (!d) break;
    }
  }
  return str.slice(i, j + 1);
}
function parseObj(lit: string): Record<string, string> {
  const o: Record<string, string> = {};
  const re = /["']?([\w\-.]+)["']?\s*:\s*["']([\w\-.]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lit))) o[m[1]!] = m[2]!;
  return o;
}

/** 从内联 runtime 解析 webpack chunk 名/哈希双映射 → 全量 chunk 相对路径 */
function enumerateChunkUrls(runtimeText: string): string[] {
  const start = runtimeText.indexOf('static/js/');
  if (start < 0) return [];
  const open1 = runtimeText.indexOf('{', start);
  const after = runtimeText.indexOf('||e)', open1);
  if (open1 < 0 || after < 0) return [];
  const open2 = runtimeText.indexOf('{', after);
  const names = parseObj(readObj(runtimeText, open1));
  const hashes = parseObj(readObj(runtimeText, open2));
  return Object.keys(hashes)
    .map((id) => `static/js/${names[id] ?? id}.${hashes[id]}.js`)
    .sort();
}

export interface FetcherOptions {
  siteBase: string;
  collectPath: string;
  cacheDir: string;
  /** 并发下载间隔（毫秒），温和限速 */
  delayMs?: number;
  log?: (msg: string) => void;
}

export class SourceFetcher {
  constructor(private readonly opt: FetcherOptions) {}

  async fetchAll(): Promise<FetchResult> {
    const { siteBase, collectPath, cacheDir, log } = this.opt;
    const delay = this.opt.delayMs ?? 15;
    const bundlesDir = path.join(cacheDir, 'bundles');
    fs.mkdirSync(bundlesDir, { recursive: true });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const bundles: SourceFile[] = [];
    const addBundle = (name: string, text: string, url: string): void => {
      const b: SourceFile = { name, hash: sha1(text), size: text.length, text, url };
      bundles.push(b);
      fs.writeFileSync(path.join(bundlesDir, `${name}.${b.hash}.js`), text);
    };

    // ① index.html
    const html = await get(siteBase + collectPath);
    if (html.status !== 200) throw new Error(`index.html 抓取失败: ${html.status} ${html.body.slice(0, 120)}`);
    // 兼容 无引号 / 单引号 / 双引号 src
    const scripts = [...html.body.matchAll(/<script\b[^>]*?\ssrc=("[^"]+"|'[^']+'|[^"\s>]+)/gi)]
      .map((m) => m[1]!.replace(/^["']|["']$/g, ''));
    const inlines = [...html.body.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!);
    const abs = scripts.map((s) => (s.startsWith('http') ? s : s.startsWith('/') ? siteBase + s : siteBase + collectPath + s));
    log?.(`index.html: 外部 script ${scripts.length} / 内联 ${inlines.length}`);

    // ② 入口 bundle
    for (const url of abs) {
      if (!/\.js(\?|$)/.test(url)) continue;
      const r = await get(url);
      if (r.status !== 200 || !r.body) continue;
      addBundle(decodeURIComponent(url.split('/').pop()!.split('?')[0]!), r.body, url);
      await sleep(delay);
    }
    inlines.forEach((code, i) => addBundle(`inline-runtime-${i}.js`, code, 'inline:index.html'));

    // ②b 懒加载 chunk（映射表在内联 runtime）
    let chunkUrls: string[] = [];
    for (const b of bundles) {
      chunkUrls = enumerateChunkUrls(b.text);
      if (chunkUrls.length) {
        log?.(`chunk 映射表命中于 ${b.name}: ${chunkUrls.length} 个懒加载 chunk`);
        break;
      }
    }
    let chunkOk = 0;
    let chunkFail = 0;
    for (const rel of chunkUrls) {
      const url = siteBase + collectPath + rel;
      const r = await get(url);
      if (r.status !== 200 || !r.body) {
        chunkFail++;
        continue;
      }
      addBundle(decodeURIComponent(rel.split('/').pop()!), r.body, url);
      chunkOk++;
      await sleep(delay);
    }

    const totalBytes = bundles.reduce((a, b) => a + b.size, 0);
    log?.(`源码树: ${bundles.length} 文件 ${(totalBytes / 1048576).toFixed(1)}MB（chunk ${chunkOk}/${chunkOk + chunkFail}）`);
    return { entryCount: scripts.length, inlineCount: inlines.length, chunkOk, chunkFail, bundles, totalBytes };
  }
}
