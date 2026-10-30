export interface McpClientConfig {
  endpoint: string;
  token: string;
}

export interface McpAuthResult {
  authorized: boolean;
  status: string;
  sessionToken: string | null;
  account: string | null;
  tokenTtlSec: number | null;
  ownedProjectCount: number;
  projects: Array<{ id: string; fullName: string }>;
  apiProbes?: { mainBackend: string; crossBackend: string };
  error?: string;
}

export class McpAuthGateway {
  constructor(private readonly cfg: McpClientConfig) {}

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(this.cfg.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    if (!res.ok) {
      throw new Error(`MCP 服务请求失败: HTTP ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    const jsonStr = line ? line.slice(6) : text;
    const parsed = JSON.parse(jsonStr);

    if (parsed.error) {
      throw new Error(`MCP 拒绝: ${parsed.error.message || JSON.stringify(parsed.error)}`);
    }

    return parsed.result?.structuredContent?.data ?? parsed.result?.data ?? parsed.result;
  }

  /**
   * 纯公网模式：通过 MCP 完成鉴权、获取可用 Session Token 及授权项目白名单
   */
  async authenticate(): Promise<McpAuthResult> {
    // 1. 尝试直接连接/复用会话
    const connectData = await this.callTool('qxb_connection_connect', {});

    // 2. 获取授权项目列表
    const projectsData = await this.callTool('qxb_projects_list', {}).catch(() => ({ projects: [] }));
    const rawProjects = Array.isArray(projectsData.projects) ? projectsData.projects : [];
    const projects = rawProjects.map((p: any) => ({
      id: String(p.id).trim(),
      fullName: p.fullName || p.name || String(p.id),
    }));

    return {
      authorized: connectData.connected === true,
      status: connectData.connected ? 'active' : 'unconnected',
      sessionToken: connectData.sessionToken || null,
      account: connectData.account || null,
      tokenTtlSec: connectData.tokenTtlSec || null,
      ownedProjectCount: projects.length,
      projects,
      apiProbes: connectData.apiProbes,
    };
  }

  /**
   * 刷新会话状态或检查连通性
   */
  async getStatus(): Promise<any> {
    return this.callTool('qxb_connection_status', { deep: true });
  }
}
