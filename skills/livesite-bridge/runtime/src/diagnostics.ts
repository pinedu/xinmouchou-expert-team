// 四段诊断归因：每次失败都能回答"到底是站点问题、会话问题、通道问题、还是数据问题"。
// 这是 v2 相对固定 API MCP 的核心价值之一——用户不再猜"是站点还是 MCP 的问题"。

export type Stage = 'S1_SOURCE' | 'S2_SESSION' | 'S3_CHANNEL' | 'S4_DATA';

export interface DiagnosticStep {
  stage: Stage;
  ok: boolean;
  /** 人话结论（给最终用户看） */
  summary: string;
  /** 技术细节（给排障看） */
  detail?: string;
}

export interface Diagnostics {
  steps: DiagnosticStep[];
  /** 第一个失败的阶段；全绿为 null */
  firstFailure: Stage | null;
  /** 一句话归因 */
  verdict: string;
}

const STAGE_LABEL: Record<Stage, string> = {
  S1_SOURCE: '站点源',
  S2_SESSION: '会话',
  S3_CHANNEL: '通道',
  S4_DATA: '数据',
};

export function makeDiag(): {
  steps: DiagnosticStep[];
  record: (stage: Stage, ok: boolean, summary: string, detail?: string) => void;
  finish: () => Diagnostics;
} {
  const steps: DiagnosticStep[] = [];
  const record = (stage: Stage, ok: boolean, summary: string, detail?: string): void => {
    steps.push({ stage, ok, summary, ...(detail ? { detail } : {}) });
  };
  const finish = (): Diagnostics => {
    const first = steps.find((s) => !s.ok) ?? null;
    const verdict = first
      ? `${STAGE_LABEL[first.stage]}环节失败：${first.summary}`
      : '全链路正常，取数成功';
    return { steps, firstFailure: first ? first.stage : null, verdict };
  };
  return { steps, record, finish };
}
