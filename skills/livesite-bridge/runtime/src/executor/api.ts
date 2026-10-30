// 通道A：按运行时契约直调 API（毫秒级）。签名用「活源码自举签名器」，
// 双后端路由（main/cross）按契约；401/success:0 识别为会话失效 → 触发 S2 诊断。
// 逻辑移植自 poc/derive-contract.mjs ⑤b（已实测 success=1）。
import { makeDiag } from '../diagnostics.js';
import type { LiveSigner } from '../contract/bootstrap.js';
import type { LivesiteConfig } from '../config.js';
import type { Executor, ExecutorRequest, ExecutorResult } from './types.js';

export class ApiExecutor implements Executor {
  readonly channel = 'api' as const;

  constructor(
    private readonly cfg: LivesiteConfig,
    private readonly signer: LiveSigner | null,
  ) {}

  /** 自动解析后端路由：跨域白名单走 crossApiBase，其余走 mainApiBase */
  private resolveBackend(endpoint: string, explicitBackend?: 'main' | 'cross'): 'main' | 'cross' {
    if (explicitBackend) return explicitBackend;
    const isCross = /^\/(rrs\/person\/(list|getById|excel)|attend\/attendTable|extend\/verifyCode|third\/getUserInfo)/.test(endpoint);
    return isCross ? 'cross' : 'main';
  }

  async execute(req: ExecutorRequest): Promise<ExecutorResult> {
    const t0 = Date.now();
    const diag = makeDiag();
    const backend = this.resolveBackend(req.endpoint, req.backend);
    const base = backend === 'cross' ? this.cfg.crossApiBase : this.cfg.mainApiBase;
    const method = (req.method ?? 'POST').toUpperCase();
    const payload = req.payload ?? {};

    // S1：契约/签名器可用性
    if (!this.signer) {
      diag.record('S1_SOURCE', false, '无可用签名器（契约未自举或已过期）');
      const d = diag.finish();
      return { ok: false, channel: 'api', data: null, diagnostics: d, errorCode: 'S1_CONTRACT_STALE', elapsedMs: Date.now() - t0 };
    }
    diag.record('S1_SOURCE', true, `签名器可用（${this.signer.source}）`);

    // 签名（活签名器内部自生成 appkey/timestamp，必须用其产出的全套头）
    const hdr = this.signer({ ...payload, appkey: this.signer.appkey, timestamp: Date.now() }, method.toLowerCase());

    const url =
      method === 'GET'
        ? base + req.endpoint + (Object.keys(payload).length ? '?' + new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)] as [string, string])).toString() : '')
        : base + req.endpoint;

    let status: number | string = 'ERR';
    let body = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.apiTimeoutMs);
      const init: RequestInit = {
        method,
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          appkey: hdr.appkey,
          timestamp: String(hdr.timestamp),
          signcode: hdr.signcode,
          Logininfo: req.token,
          'Content-Type': 'application/json;charset=UTF-8',
        },
      };
      if (method === 'POST') init.body = JSON.stringify(payload);
      const res = await fetch(url, init);
      clearTimeout(timer);
      status = res.status;
      body = await res.text();
    } catch (e) {
      diag.record('S3_CHANNEL', false, `API 请求异常: ${(e as Error).message}`);
      const d = diag.finish();
      const statusNum = typeof status === 'number' ? status : undefined;
      return { ok: false, channel: 'api', data: null, ...(statusNum !== undefined ? { httpStatus: statusNum } : {}), diagnostics: d, errorCode: 'S3_API_TIMEOUT', elapsedMs: Date.now() - t0 };
    }

    let j: { success?: number; msg?: string; data?: unknown } = {};
    try {
      j = JSON.parse(body);
    } catch {
      // 非 JSON（可能是网关错误页）
    }

    if (status === 401) {
      diag.record('S2_SESSION', false, 'token 失效（HTTP 401）', '需换新 token 重新自举会话');
      const d = diag.finish();
      return { ok: false, channel: 'api', data: null, httpStatus: 401, diagnostics: d, errorCode: 'S2_TOKEN_EXPIRED', elapsedMs: Date.now() - t0 };
    }
    if (status !== 200) {
      diag.record('S3_CHANNEL', false, `HTTP ${status}`, body.slice(0, 200));
      const d = diag.finish();
      return { ok: false, channel: 'api', data: null, httpStatus: status as number, diagnostics: d, errorCode: 'S3_API_HTTP_ERROR', elapsedMs: Date.now() - t0 };
    }
    if (j.success === 0) {
      const msg = j.msg ?? '';
      const isSession = /账号异常|身份|过期|登录/.test(msg);
      if (isSession) diag.record('S2_SESSION', false, `会话态错误：${msg}`, '主/跨域不对称时注意 third/getUserInfo 只能打跨域');
      else diag.record('S4_DATA', false, `业务错误：${msg}`);
      const d = diag.finish();
      return { ok: false, channel: 'api', data: j.data ?? null, httpStatus: 200, diagnostics: d, errorCode: isSession ? 'S2_TOKEN_EXPIRED' : 'S4_EMPTY_RESULT', elapsedMs: Date.now() - t0 };
    }

    diag.record('S2_SESSION', true, 'token 有效');
    diag.record('S3_CHANNEL', true, `API 调通（HTTP ${status}）`);
    const empty = j.data === null || j.data === undefined || j.data === '' || (Array.isArray(j.data) && j.data.length === 0);
    diag.record('S4_DATA', !empty, empty ? '结果集为空（可能是查询条件无数据，非故障）' : '数据已返回');
    const d = diag.finish();
    return { ok: true, channel: 'api', data: j.data ?? null, httpStatus: 200, diagnostics: d, elapsedMs: Date.now() - t0 };
  }
}
