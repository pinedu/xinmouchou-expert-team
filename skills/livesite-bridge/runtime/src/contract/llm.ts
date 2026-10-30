// LLM 语义补充（低频）：给自举出的端点补「响应结构 / 参数含义 / 需求→端点映射」。
// 设计原则：常规取数零 LLM 开销；只在 ① 契约重建 ② 新需求映射 时调用。
// 当前为骨架：未配置 QXB_LLM_BASE_URL 时纯确定性模式（不补语义）。
import type { EndpointMeta } from './types.js';
import type { LlmConfig } from '../config.js';

export interface LlmEnrichResult {
  enriched: EndpointMeta[];
  /** 需求 → 端点+参数的映射（供编排器用） */
  intentMap: Record<string, { endpoint: string; method: 'GET' | 'POST'; params: Record<string, unknown> }>;
}

export class LlmEnricher {
  constructor(private readonly cfg: LlmConfig | null) {}

  get enabled(): boolean {
    return !!this.cfg && !!this.cfg.apiKey;
  }

  /**
   * 给端点列表补语义。
   * 实现要点（落地时）：
   *  - 把「端点路径 + 所在 bundle 的调用上下文（前后 N 字符）」送 LLM，要求输出 JSON：
   *    { purpose, params:{k:含义}, responseShape }
   *  - 分批（每批 ≤ 20 端点）控 token；结果写回 EndpointMeta.semantics + contractState=llm-enriched
   *  - 失败降级：保留 discovered 状态，不阻塞通道A/B
   */
  async enrich(endpoints: EndpointMeta[], bundleContext: string[]): Promise<LlmEnrichResult> {
    if (!this.enabled) return { enriched: endpoints, intentMap: {} };
    // TODO(落地): 调 this.cfg.baseUrl/chat/completions，解析 JSON，写回 semantics
    void bundleContext;
    return { enriched: endpoints, intentMap: {} };
  }

  /**
   * 需求 → 端点映射：把用户自然语言需求（"查某项目人员工资"）映射到
   * 具体端点 + 参数结构。落地时先查 intentMap 缓存，未命中再调 LLM。
   */
  async mapIntent(_intent: string, endpoints: EndpointMeta[]): Promise<{ endpoint: string; method: 'GET' | 'POST'; params: Record<string, unknown> } | null> {
    if (!this.enabled) return null;
    void endpoints;
    // TODO(落地): LLM few-shot（用已 verified 端点做示例）
    return null;
  }
}
