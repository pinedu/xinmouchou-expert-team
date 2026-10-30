// 运行时契约 schema —— 由「活站点源码自举」产出（确定性抽取 + LLM 补语义）。
// 这是 qxb-livesite 的"单一事实来源"，替代 qxb-mcp-service 手工维护的 endpoint-registry。

export interface BundleMeta {
  /** 原始文件名（含站点 content-hash，如 app.1d9f0166.js） */
  name: string;
  /** 本地 sha1(前12位) 版本指纹 */
  hash: string;
  size: number;
}

export interface SignerMeta {
  /** 签名器来源：live:<bundle名> | local-cache | null */
  source: string | null;
  /** 盐（旧形态可读；拦截器模块 eval 形态下为内部值，可为 null） */
  salt: string | null;
  appkey: string;
}

export interface EndpointMeta {
  /** 端点路径（如 /rrs/project/find） */
  path: string;
  /** HTTP 方法；未知时省略，由通道A 探测或通道B 学习 */
  method?: 'GET' | 'POST';
  /** 命中的后端：main（主域）| cross（跨域）；双后端不对称时关键 */
  backend?: 'main' | 'cross';
  /** 契约状态：discovered（仅抽到路径）| verified（实测调通）| llm-enriched（LLM 补了语义） */
  contractState: 'discovered' | 'verified' | 'llm-enriched';
  /** LLM 补的语义：入参含义 / 响应结构 / 业务用途（低频、可缺省） */
  semantics?: {
    purpose?: string;
    params?: Record<string, string>;
    responseShape?: string;
  };
  notes?: string;
}

export interface RuntimeContract {
  generatedAt: string;
  site: string;
  bundles: BundleMeta[];
  signer: SignerMeta;
  appkeyFromSource: string | null;
  headers: {
    token: string;
    sign: string;
  };
  endpoints: EndpointMeta[];
  /** 契约是否过期（站点源 hash 变化未重新自举） */
  stale?: boolean;
}
