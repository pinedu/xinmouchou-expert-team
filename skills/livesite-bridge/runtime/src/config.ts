import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LivesiteConfig {
  siteBase: string;
  collectPath: string;
  mainApiBase: string;
  crossApiBase: string;
  loginThirdPath: string;
  sourceCacheDir: string;
  /** 周期全量重抓间隔（分钟） */
  sourceRefreshMin: number;
  allowStaleContract: boolean;
  enableApiChannel: boolean;
  enableUiChannel: boolean;
  autoFallback: boolean;
  apiTimeoutMs: number;
  maxResponseBytes: number;
  browserExecutable: string;
  browserHeadless: boolean;
  uiTimeoutMs: number;
  llm: LlmConfig | null;
  diagnostics: 'off' | 'brief' | 'full';
  logLevel: string;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : fallback;
}
function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v !== '0' && v !== 'false';
}

export function loadConfig(): LivesiteConfig {
  const llmBaseUrl = process.env.QXB_LLM_BASE_URL ?? '';
  const llm: LlmConfig | null = llmBaseUrl
    ? {
        baseUrl: llmBaseUrl,
        apiKey: process.env.QXB_LLM_API_KEY ?? '',
        model: process.env.QXB_LLM_MODEL ?? 'gpt-5.6-sol',
      }
    : null;

  const diagRaw = process.env.QXB_DIAGNOSTICS ?? 'full';
  const diagnostics: 'off' | 'brief' | 'full' =
    diagRaw === 'off' || diagRaw === 'brief' ? diagRaw : 'full';

  const defaultChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browserExecutable = process.env.QXB_BROWSER_EXECUTABLE || defaultChrome;

  return {
    siteBase: process.env.QXB_SITE_BASE ?? 'https://ldyg.guizhou.gov.cn',
    collectPath: process.env.QXB_COLLECT_PATH ?? '/collect/',
    mainApiBase: process.env.QXB_MAIN_API_BASE ?? 'https://ldyg.guizhou.gov.cn/collect-api',
    crossApiBase: process.env.QXB_CROSS_API_BASE ?? 'https://collect-api.gzldyg.com/collect-api',
    loginThirdPath: process.env.QXB_LOGIN_THIRD_PATH ?? '/collect/#/login/third',
    sourceCacheDir: process.env.QXB_SOURCE_CACHE_DIR ?? './data/source',
    sourceRefreshMin: intEnv('QXB_SOURCE_REFRESH_MIN', 1440),
    allowStaleContract: boolEnv('QXB_ALLOW_STALE_CONTRACT', true),
    enableApiChannel: boolEnv('QXB_ENABLE_API_CHANNEL', true),
    enableUiChannel: boolEnv('QXB_ENABLE_UI_CHANNEL', true),
    autoFallback: boolEnv('QXB_AUTO_FALLBACK', true),
    apiTimeoutMs: intEnv('QXB_API_TIMEOUT_MS', 15_000),
    maxResponseBytes: intEnv('QXB_MAX_RESPONSE_BYTES', 8 * 1024 * 1024),
    browserExecutable,
    browserHeadless: boolEnv('QXB_BROWSER_HEADLESS', true),
    uiTimeoutMs: intEnv('QXB_UI_TIMEOUT_MS', 30_000),
    llm,
    diagnostics,
    logLevel: process.env.QXB_LOG_LEVEL ?? 'info',
  };
}

export interface AuthorizedProject {
  id: string;
  fullName: string;
  account?: string | null;
}

export interface UserAuthProfile {
  userMcpToken: string;
  updatedAt: string;
  sessionToken?: string | null;
  sessionAccount?: string | null;
  authorizedProjects: AuthorizedProject[];
  metadata?: Record<string, unknown>;
}

const AUTH_FILE = path.resolve(__dirname, '../data/qxb-user-auth.json');

/** 获取用户持久化保存的完整认证档案 */
export function getStoredUserAuthProfile(): UserAuthProfile | null {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (j.userMcpToken) {
        return {
          userMcpToken: String(j.userMcpToken).trim(),
          updatedAt: j.updatedAt || new Date().toISOString(),
          sessionToken: j.sessionToken ? String(j.sessionToken).trim() : null,
          sessionAccount: j.sessionAccount ? String(j.sessionAccount).trim() : null,
          authorizedProjects: Array.isArray(j.authorizedProjects) ? j.authorizedProjects : [],
          metadata: j.metadata || {},
        };
      }
    }
  } catch {
    /* 忽略读取错误 */
  }
  return null;
}

/** 获取用户持久化保存的 MCP 接入令牌（优先环境变量，其次本地持久化文件） */
export function getStoredUserMcpToken(): string | null {
  if (process.env.QXB_USER_MCP_TOKEN) return process.env.QXB_USER_MCP_TOKEN.trim();
  const profile = getStoredUserAuthProfile();
  return profile?.userMcpToken ?? null;
}

/** 首次鉴权通过后持久化保存用户 MCP 令牌、会话 Token 与授权项目 */
export function saveUserMcpToken(
  token: string,
  authorizedProjects: AuthorizedProject[] = [],
  sessionData?: { sessionToken?: string | null; sessionAccount?: string | null },
  metadata?: Record<string, unknown>,
): void {
  try {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(
      AUTH_FILE,
      JSON.stringify(
        {
          userMcpToken: token.trim(),
          updatedAt: new Date().toISOString(),
          sessionToken: sessionData?.sessionToken ?? null,
          sessionAccount: sessionData?.sessionAccount ?? null,
          authorizedProjects,
          metadata: metadata || {},
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(`持久化保存 MCP 令牌失败: ${(e as Error).message}`);
  }
}
