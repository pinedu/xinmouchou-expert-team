// 契约自举：从「活站点源码」确定性抽取 API 契约。
// 核心：切出 webpack 拦截器模块（含 signcode 签名逻辑）+ 桩依赖 eval → 活签名器 + appkey；
//       再正则抽取端点路径 / 头规则 / 后端路由。LLM 仅做低频语义补充（见 llm.ts）。
// 逻辑移植自 poc/derive-contract.mjs（已实测全链路跑通）。
import { createHash } from 'node:crypto';
import type { SourceFile } from '../source/fetcher.js';

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

/** 活签名器：拦截器模块 eval 产物。调用 sign(obj, method) → {appkey,timestamp,signcode} */
export interface LiveSigner {
  (obj: Record<string, unknown>, method: string): { appkey: string; timestamp: number; signcode: string };
  appkey: string;
  source: string;
}

export interface BootstrapResult {
  ok: boolean;
  reason?: string;
  signer?: LiveSigner;
  appkey?: string;
  endpointPaths: string[];
  keyEndpoints: string[];
  logininfoRuleBundles: string[];
}

/**
 * 从 bundle 集合里提取「请求拦截器模块」并 eval 自举签名器。
 * 结构性锚点：模块内含 signcode:"" + interceptors.request.use；模块边界 KEY:function + 括号配平。
 * 桩依赖覆盖 webpack 模块 id（5530/53ca/bc3a/5c96/4328/b85c/6821f）；md5 用标准库（站点 6821f 为标准 MD5，已对拍）。
 */
export function bootstrapSigner(bundles: SourceFile[]): { ok: boolean; reason?: string; signer?: LiveSigner; appkey?: string } {
  for (const { name, text } of bundles) {
    const anchor = text.indexOf('signcode:""');
    if (anchor < 0) continue;
    const before = text.slice(0, anchor);
    const keys = [...before.matchAll(/(?:^|[,;})])([0-9a-f]{4,6}|[a-zA-Z_$][\w$]*)\s*:\s*function/g)];
    const m = keys[keys.length - 1];
    if (!m) continue;
    const fnStart = m.index + m[0].lastIndexOf('function');
    const braceStart = text.indexOf('{', fnStart);
    if (braceStart < 0) continue;
    let d = 0;
    let j = braceStart;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === '{') d++;
      else if (ch === '}') {
        d--;
        if (!d) break;
      }
    }
    const fnText = text.slice(fnStart, j + 1);

    let reqInterceptor: ((cfg: RequestInterceptorConfig) => RequestInterceptorConfig) | null = null;
    const axiosInstance = {
      interceptors: {
        request: { use: (fn: (cfg: RequestInterceptorConfig) => RequestInterceptorConfig): void => { reqInterceptor = fn; } },
        response: { use: (): void => {} },
      },
      get(): void {},
      post(): void {},
    };
    const requireStub: WebpackRequire = (id: string) => {
      switch (id) {
        case '5530': return { a: Object.assign } as never;
        case '53ca': return { a: (x: unknown): string => typeof x } as never;
        case 'bc3a': return { create: () => axiosInstance } as never;
        case '5c96': return { Loading: { service: (): { close(): void } => ({ close(): void {} }) }, Message: (): void => {} } as never;
        case '4328': return { a: { stringify: (o: unknown): string => JSON.stringify(o) } } as never;
        case 'b85c': return { a: (o: Iterable<unknown>) => o[Symbol.iterator]() } as never;
        case '6821f': return md5 as never;
        default: return {} as never;
      }
    };
    requireStub.n = (mod: unknown): unknown => {
      const f = (): unknown => mod;
      Object.defineProperty(f, 'a', { get: () => mod });
      return f;
    };
    requireStub.d = (exportsObj: object, k: string, getter: () => unknown): void => {
      Object.defineProperty(exportsObj, k, { get: getter, enumerable: true });
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 刻意 eval 站点模块（受控输入：本地抓取的源码缓存）
      const factory = new Function(`return (${fnText})`)();
      factory({}, {}, requireStub);
    } catch (e) {
      return { ok: false, reason: `模块 ${name} eval 失败: ${(e as Error).message}` };
    }
    if (!reqInterceptor) return { ok: false, reason: '模块 eval 成功但未捕获 request 拦截器' };
    // 闭包内赋值会让 CFA 把 reqInterceptor 收窄成 never；用显式类型中间变量取回声明类型
    const ri: (cfg: RequestInterceptorConfig) => RequestInterceptorConfig = reqInterceptor;

    if (typeof globalThis.localStorage === 'undefined') {
      const store: Record<string, string> = { LOGININFO: '' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).localStorage = {
        getItem: (k: string): string | null => (k in store ? store[k]! : null),
        setItem: (k: string, v: string): void => { store[k] = String(v); },
        removeItem: (k: string): void => { delete store[k]; },
      };
    }

    const probe = ri({ method: 'post', data: {}, headers: {} });
    const appkey = probe.headers?.appkey != null ? String(probe.headers.appkey) : undefined;
    const signcode0 = probe.headers?.signcode != null ? String(probe.headers.signcode) : undefined;
    if (!appkey || !signcode0) {
      return { ok: false, reason: '拦截器调用未产出 appkey/signcode' };
    }
    const signer: LiveSigner = ((obj: Record<string, unknown>, method: string) => {
      const r = ri({
        method,
        data: obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {},
        headers: {},
      });
      return {
        appkey: r.headers!.appkey != null ? String(r.headers.appkey) : '',
        timestamp: Number(r.headers!.timestamp),
        signcode: r.headers!.signcode != null ? String(r.headers.signcode) : '',
      };
    }) as LiveSigner;
    signer.appkey = appkey;
    signer.source = `live:${name}`;
    return { ok: true, signer, appkey };
  }
  return { ok: false, reason: '全部 bundle 未找到 signcode 拦截器模块' };
}

interface RequestInterceptorConfig {
  method?: string;
  data?: unknown;
  params?: unknown;
  url?: string;
  headers: Record<string, string | number>;
  needLoading?: boolean;
}
type WebpackRequire = ((id: string) => unknown) & {
  n: (mod: unknown) => unknown;
  d: (exportsObj: object, k: string, getter: () => unknown) => void;
};

/** 端点路径抽取（全源码树）：字符串字面量里的 /a/b/c 形多段路径 */
export function extractEndpoints(bundles: SourceFile[]): { all: string[]; key: string[] } {
  const allText = bundles.map((b) => b.text).join('\n');
  const paths = new Set<string>();
  const pathRe = /["'](\/[a-zA-Z][a-zA-Z0-9]*(\/[a-zA-Z0-9\-{}]+)+)["']/g;
  let pm: RegExpExecArray | null;
  while ((pm = pathRe.exec(allText))) {
    const p = pm[1]!;
    if (/\.(js|css|png|jpe?g|gif|ico|svg|json|html?|txt|pdf|xlsx?|mp4|webp|wasm)(\?|$)/i.test(p)) continue;
    if (p.length > 6 && p.length < 90) paths.add(p);
  }
  const all = [...paths].sort();
  const key = all.filter((p) =>
    /person|project|salary|attend|third|login|team|contract|ent|statistics|sixIndex|verifyCode|wageAccount|idCard/i.test(p),
  );
  return { all, key };
}

/** Logininfo 头规则定位（哪个 bundle 里设置 e.headers["Logininfo"]） */
export function locateLogininfoRule(bundles: SourceFile[]): string[] {
  return bundles
    .filter((b) => /["']Logininfo["']\]?\s*[:=]|Logininfo\s*[:=]\s*[^,;]*LOGININFO/.test(b.text))
    .map((b) => b.name);
}

export function runBootstrap(bundles: SourceFile[]): BootstrapResult {
  const signerRes = bootstrapSigner(bundles);
  const { all, key } = extractEndpoints(bundles);
  const logininfoRuleBundles = locateLogininfoRule(bundles);
  return {
    ok: signerRes.ok,
    ...(signerRes.reason ? { reason: signerRes.reason } : {}),
    ...(signerRes.signer ? { signer: signerRes.signer } : {}),
    ...(signerRes.appkey ? { appkey: signerRes.appkey } : {}),
    endpointPaths: all,
    keyEndpoints: key,
    logininfoRuleBundles,
  };
}
