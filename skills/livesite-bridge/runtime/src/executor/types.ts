// 双通道执行器的统一返回 schema：无论通道A（API）还是通道B（UI），都产出同结构结果，
// 让上层（编排器/调用方/LLM agent）无需关心数据是怎么拿的。
import type { Diagnostics } from '../diagnostics.js';

export type Channel = 'api' | 'ui';

export interface ExecutorRequest {
  /** 端点路径（通道A 用；通道B 用作定位线索/校验） */
  endpoint: string;
  method?: 'GET' | 'POST';
  /** 请求体/查询参数 */
  payload?: Record<string, unknown>;
  /** 会话 token（Logininfo 头） */
  token: string;
  account: string;
  /** 后端路由提示（缺省时由编排器按契约/探测决定） */
  backend?: 'main' | 'cross';
}

export interface ExecutorResult {
  ok: boolean;
  channel: Channel;
  /** 统一数据载荷（API 为解析后的 JSON；UI 为从页面/DOM 抽取的结构化数据） */
  data: unknown;
  httpStatus?: number;
  elapsedMs: number;
  diagnostics: Diagnostics;
  /** 错误归类后的稳定错误码（供上层决策重试/降级/上报） */
  errorCode?:
    | 'S1_CONTRACT_STALE'
    | 'S2_TOKEN_EXPIRED'
    | 'S3_API_401'
    | 'S3_API_HTTP_ERROR'
    | 'S3_API_TIMEOUT'
    | 'S3_UI_TIMEOUT'
    | 'S3_UI_ELEMENT_NOT_FOUND'
    | 'S4_EMPTY_RESULT'
    | 'S4_SHAPE_CHANGED'
    | 'E_INTERNAL';
}

export interface Executor {
  readonly channel: Channel;
  execute(req: ExecutorRequest): Promise<ExecutorResult>;
}
