// 编排器：每次数据请求 → 选通道 → 执行 → 失败降级（A→B）→ 统一 schema 返回。
// 选通原则：
//   - 端点命中契约且通道A健康 → 通道A（毫秒级，默认）
//   - 通道A失败（401/超时/业务错）且开启自动降级 → 通道B（浏览器兜底）
//   - 端点未命中契约（站点新接口）→ 直接通道B 探索，成功后回写契约（discovered→verified）
import type { RuntimeContract } from './contract/types.js';
import type { Executor, ExecutorRequest, ExecutorResult, Channel } from './executor/types.js';
import { makeDiag, type Diagnostics } from './diagnostics.js';

export interface OrchestratorDeps {
  contract: RuntimeContract | null;
  api: Executor | null;
  ui: Executor | null;
  autoFallback: boolean;
  /** 通道B 成功后回写契约（端点升级为 verified） */
  onUiVerified?: (endpoint: string) => void;
  log?: (msg: string) => void;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private pickChannel(req: ExecutorRequest): Channel {
    const { contract, api, ui } = this.deps;
    const hit = !!contract?.endpoints.find((e) => e.path === req.endpoint);
    if (api && hit) return 'api';
    if (ui) return 'ui';
    return api ? 'api' : 'ui';
  }

  async run(req: ExecutorRequest): Promise<ExecutorResult> {
    const first = this.pickChannel(req);
    this.deps.log?.(`选通道: ${first}（端点 ${req.endpoint}）`);
    const executor = first === 'api' ? this.deps.api : this.deps.ui;
    if (!executor) {
      const diag = makeDiag();
      diag.record('S3_CHANNEL', false, '无可用通道（API/UI 均未启用）');
      return { ok: false, channel: 'api', data: null, diagnostics: diag.finish(), errorCode: 'E_INTERNAL', elapsedMs: 0 };
    }
    const r1 = await executor.execute(req);
    if (r1.ok) return r1;

    // 降级：A 失败 → B（仅当开启自动降级且 B 可用且首次不是 UI）
    if (this.deps.autoFallback && first === 'api' && this.deps.ui) {
      this.deps.log?.(`通道A 失败（${r1.errorCode}），降级通道B`);
      const r2 = await this.deps.ui.execute(req);
      if (r2.ok) this.deps.onUiVerified?.(req.endpoint);
      // 合并诊断：保留 A 的失败段 + B 的执行段
      return {
        ...r2,
        diagnostics: mergeDiagnostics(r1.diagnostics, r2.diagnostics, 'A→B 自动降级'),
      };
    }
    return r1;
  }
}

function mergeDiagnostics(a: Diagnostics, b: Diagnostics, note: string): Diagnostics {
  const steps = [...a.steps, ...b.steps.map((s) => ({ ...s, summary: `[B] ${s.summary}` }))];
  const first = steps.find((s) => !s.ok && s.stage !== 'S4_DATA') ?? null;
  return { steps, firstFailure: first ? first.stage : null, verdict: `${note}；最终 ${b.verdict}` };
}
