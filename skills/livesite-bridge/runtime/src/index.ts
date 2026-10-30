// qxb-livesite CLI 入口（纯净版：零外部数据库，零 Redis 依赖）
//   - 鉴权与获取 Token：完全沿用公网统一 MCP 服务
//   - 核心任务：本地活站点契约自举 + API直连取数 + UI 内部浏览器可视
import path from 'node:path';
import fs from 'node:fs';
import {
  loadConfig,
  getStoredUserMcpToken,
  saveUserMcpToken,
  getStoredUserAuthProfile,
  type AuthorizedProject,
} from './config.js';
import { SourceFetcher } from './source/fetcher.js';
import { SourceCache } from './source/cache.js';
import { runBootstrap } from './contract/bootstrap.js';
import { McpAuthGateway } from './session/mcp-auth.js';
import { ApiExecutor } from './executor/api.js';
import { UiExecutor } from './executor/ui.js';
import { Orchestrator } from './orchestrator.js';
import type { EndpointMeta, RuntimeContract } from './contract/types.js';

const log = (m: string): void => console.log(`[qxb-livesite] ${m}`);

async function cmdBootstrap(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const cacheDir = path.resolve(cfg.sourceCacheDir);
  const cache = new SourceCache(cacheDir);
  const fetcher = new SourceFetcher({
    siteBase: cfg.siteBase,
    collectPath: cfg.collectPath,
    cacheDir,
    log,
  });
  log('① 拉取活站点源码…');
  const res = await fetcher.fetchAll();
  const bundles = res.bundles.map(({ name, hash, size }) => ({ name, hash, size }));
  cache.writeManifest(bundles as RuntimeContract['bundles']);

  log('② 自举契约（签名器 + 端点 + 头规则）…');
  const bs = runBootstrap(res.bundles);
  if (!bs.ok) {
    log(`签名器自举失败：${bs.reason ?? '未知'}（allowStale=${cfg.allowStaleContract}）`);
    if (!cfg.allowStaleContract) throw new Error('契约自举失败且未允许 stale，退出');
  }
  const endpoints: EndpointMeta[] = bs.endpointPaths.map((p) => ({
    path: p,
    contractState: 'discovered',
    ...(bs.keyEndpoints.includes(p) ? { notes: '关键域（人员/项目/工资/考勤/登录）' } : {}),
  }));
  const contract: RuntimeContract = {
    generatedAt: new Date().toISOString(),
    site: cfg.siteBase,
    bundles,
    signer: {
      source: bs.signer?.source ?? null,
      salt: null,
      appkey: bs.appkey ?? '',
    },
    appkeyFromSource: bs.appkey ?? null,
    headers: {
      token: 'Logininfo = localStorage["LOGININFO"]',
      sign: 'signcode = liveSigner({appkey,timestamp,...payload}, method)',
    },
    endpoints,
    ...(bs.ok ? {} : { stale: true }),
  };
  cache.writeContract(contract);
  log(`③ 契约已落盘：${path.join(cacheDir, 'contract.json')}`);
  log(`   端点 ${endpoints.length} 个（关键 ${bs.keyEndpoints.length}）；签名器 ${bs.signer?.source ?? '无'}；appkey ${bs.appkey ?? '-'}`);
}

/**
 * 确保具备当前可用的会话 Token（优先从本地档案读取，没有或失效则自动通过 MCP/扫码补全）
 */
async function ensureSessionToken(
  cfg: ReturnType<typeof loadConfig>,
  targetProjectId?: string,
): Promise<{ account: string; token: string }> {
  const profile = getStoredUserAuthProfile();
  if (!profile || !profile.userMcpToken) {
    throw new Error('未检测到 MCP 授权令牌，请先运行: tsx src/index.ts auth <你的MCP令牌>');
  }

  // 租户校验：如果指定了 projectId，校验是否在当前用户授权范围内
  if (targetProjectId) {
    const cleanPid = targetProjectId.trim();
    if (profile.authorizedProjects.length > 0) {
      const match = profile.authorizedProjects.find((p) => p.id === cleanPid);
      if (!match) {
        throw new Error(`[租户拦截] 越权拒绝！当前主体授权范围不包含项目 ID: ${cleanPid}，严禁越权访问！`);
      }
    }
  }

  // 如果本地档案中已存有活动 Token，直接沿用
  if (profile.sessionToken && profile.sessionAccount) {
    return {
      account: profile.sessionAccount,
      token: profile.sessionToken,
    };
  }

  // 否则，调用前台浏览器扫码获取并存盘
  log(`[会话就绪] 本地暂存会话不存在，唤起前台浏览器引导登录…`);
  const scanned = await performInteractiveLogin(cfg);
  saveUserMcpToken(
    profile.userMcpToken,
    profile.authorizedProjects,
    { sessionToken: scanned.token, sessionAccount: scanned.account },
    profile.metadata,
  );
  return scanned;
}

async function cmdProbe(
  cfg: ReturnType<typeof loadConfig>,
  endpoint: string,
  targetProjectId?: string,
): Promise<void> {
  const cacheDir = path.resolve(cfg.sourceCacheDir);
  const cache = new SourceCache(cacheDir);
  const contract = cache.readContract();
  if (!contract) throw new Error('无已缓存契约，先运行 bootstrap');

  const { account, token } = await ensureSessionToken(cfg, targetProjectId);
  const tokenMasked = `${token.slice(0, 8)}...${token.slice(-4)}`;
  log(`使用会话账号 ${account}（token: ${tokenMasked}）发起活站取数…`);

  const api = cfg.enableApiChannel
    ? new ApiExecutor(cfg, contract.signer.source?.startsWith('live:') ? await loadLiveSigner(cfg) : null)
    : null;
  const ui = cfg.enableUiChannel ? new UiExecutor(cfg) : null;
  const orch = new Orchestrator({ contract, api, ui, autoFallback: cfg.autoFallback, log });

  const payload: Record<string, unknown> = targetProjectId ? { projectId: targetProjectId } : {};
  let r = await orch.run({ endpoint, token, account, payload });

  // 如果执行返回 S2_TOKEN_EXPIRED（401 / 会话失效），触发扫码自愈并重试 1 次
  if (!r.ok && r.errorCode === 'S2_TOKEN_EXPIRED') {
    log(`[会话自愈] 接口返回会话已过期 (${r.errorCode})，唤起前台扫码重新建立会话…`);
    const refreshed = await performInteractiveLogin(cfg, account);
    const profile = getStoredUserAuthProfile();
    if (profile) {
      saveUserMcpToken(
        profile.userMcpToken,
        profile.authorizedProjects,
        { sessionToken: refreshed.token, sessionAccount: refreshed.account },
        profile.metadata,
      );
    }
    log(`[会话自愈] 扫码已完成，正在使用新 Token 重试原请求…`);
    r = await orch.run({ endpoint, token: refreshed.token, account: refreshed.account, payload });
  }

  log(`结果 ok=${r.ok} channel=${r.channel} elapsed=${r.elapsedMs}ms errorCode=${r.errorCode ?? '-'}`);
  console.log(JSON.stringify({ data: r.data, diagnostics: r.diagnostics }, null, 2));
  await ui?.close();
}

/**
 * 纯公网 MCP 鉴权与获取 Token：
 * 向 MCP 发送请求验证令牌，获取授权项目画像；无需本地连任何数据库
 */
async function cmdAuth(cfg: ReturnType<typeof loadConfig>, userMcpToken?: string): Promise<void> {
  const effectiveToken = userMcpToken || getStoredUserMcpToken();
  if (!effectiveToken) {
    throw new Error('未提供 MCP 接入令牌，且本地无保存记录。请运行: tsx src/index.ts auth <qat_...>');
  }

  const cleanToken = effectiveToken.replace(/^Bearer\s+/i, '').trim();
  const mcpEndpoint = process.env.QXB_MCP_URL || 'https://xbmcp.gshbzw.com/mcp';
  log(`正在向 MCP 服务（${mcpEndpoint}）发起鉴权…${userMcpToken ? '（新提供）' : '（读取自持久化记忆）'}`);

  const gateway = new McpAuthGateway({ endpoint: mcpEndpoint, token: cleanToken });

  try {
    const authRes = await gateway.authenticate();
    const tokenMasked = `${cleanToken.slice(0, 8)}...${cleanToken.slice(-4)}`;

    // 保存授权画像
    saveUserMcpToken(
      cleanToken,
      authRes.projects,
      { sessionToken: authRes.sessionToken, sessionAccount: authRes.account },
      {
        ownedProjectCount: authRes.ownedProjectCount,
        verifiedAt: new Date().toISOString(),
      },
    );

    const output = {
      authorized: authRes.authorized,
      authMode: 'mcp_gateway',
      tokenMasked,
      status: authRes.status,
      sessionAccount: authRes.account,
      ownedProjectCount: authRes.ownedProjectCount,
      projects: authRes.projects.slice(0, 10),
      apiProbes: authRes.apiProbes,
      timestamp: new Date().toISOString(),
    };

    log(`✓ 用户 MCP 令牌鉴权通过！关联授权项目: ${authRes.ownedProjectCount} 个（完全脱敏纯公网模式）`);
    console.log(JSON.stringify(output, null, 2));
  } catch (e) {
    log(`✗ 用户 MCP 令牌鉴权未通过: ${(e as Error).message}`);
    console.log(
      JSON.stringify(
        {
          authorized: false,
          error: (e as Error).message,
          tokenMasked: `${cleanToken.slice(0, 8)}...`,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
}

/**
 * 唤起前台 Chrome 打开项目端二维码，扫码后捕获新 Token
 */
async function performInteractiveLogin(
  cfg: ReturnType<typeof loadConfig>,
  targetAccount?: string,
): Promise<{ account: string; token: string }> {
  const { chromium } = await import('playwright-core');
  const profileDir = path.resolve(cfg.sourceCacheDir, '..', 'browser-profile-interactive');
  fs.mkdirSync(profileDir, { recursive: true });

  log(`[扫码登录] 正在启动前台内部浏览器打开登录门户并切换至项目端卡片…`);
  const persistentOptions: Record<string, unknown> = {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'],
  };
  if (cfg.browserExecutable) persistentOptions.executablePath = cfg.browserExecutable;

  const context = await chromium.launchPersistentContext(profileDir, persistentOptions as any);
  const page = context.pages()[0] ?? (await context.newPage());

  const loginPortal = `${cfg.siteBase}/screen/#/login?tag=2`;
  await page.goto(loginPortal, { waitUntil: 'load', timeout: 60000 }).catch(() => {});

  log(`----------------------------------------------------------------`);
  log(`已打开项目端登录门户：${loginPortal}`);
  if (targetAccount) log(`目标绑定账号: ${targetAccount}`);
  log(`请在打开的浏览器窗口中使用微信/电子社保卡扫描二维码完成登录`);
  log(`等待用户扫码中…（扫码成功后系统将自动捕获新 Token）`);
  log(`----------------------------------------------------------------`);

  let capturedToken: string | null = null;
  let capturedAccount: string | null = null;

  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (u.includes('third/getUserInfo')) {
        const text = await res.text();
        const j = JSON.parse(text);
        if (j.success === 1 && j.data && j.data.username) {
          capturedAccount = j.data.username;
        }
      }
    } catch {
      /* 忽略 */
    }
  });

  const t0 = Date.now();
  const maxWaitMs = 180000; // 最多等待 3 分钟扫码
  while (Date.now() - t0 < maxWaitMs) {
    try {
      const state = await page.evaluate(() => {
        const token = localStorage.getItem('LOGININFO');
        const userStr = localStorage.getItem('userInfo');
        let username = '';
        if (userStr) {
          try {
            username = JSON.parse(userStr).username || '';
          } catch {
            /* */
          }
        }
        return { token, username, url: location.href };
      });

      if (state.token && state.token.length > 10) {
        capturedToken = state.token;
        if (state.username) capturedAccount = state.username;
        log(`✓ 检测到登录凭据注入：token=${capturedToken.slice(0, 8)}...`);
        break;
      }
    } catch {
      /* 页面可能在刷新或跳转 */
    }
    await page.waitForTimeout(2000);
  }

  if (!capturedToken) {
    await context.close().catch(() => {});
    throw new Error('扫码等待超时（3分钟），未检测到有效登录令牌');
  }

  const finalAccount = capturedAccount || targetAccount;
  if (!finalAccount) {
    await context.close().catch(() => {});
    throw new Error('扫码成功但未提取到明确的用户名（username 为空），拒绝写入！');
  }

  const tokenMasked = `${capturedToken.slice(0, 8)}...${capturedToken.slice(-4)}`;
  log(`✓ 登录成功！账号: ${finalAccount}  Token: ${tokenMasked}`);

  await context.close().catch(() => {});
  return { account: finalAccount, token: capturedToken };
}

async function cmdInteractiveLogin(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const res = await performInteractiveLogin(cfg);
  const profile = getStoredUserAuthProfile();
  if (profile) {
    saveUserMcpToken(
      profile.userMcpToken,
      profile.authorizedProjects,
      { sessionToken: res.token, sessionAccount: res.account },
      profile.metadata,
    );
  }
  const tokenMasked = `${res.token.slice(0, 8)}...${res.token.slice(-4)}`;
  console.log(
    JSON.stringify(
      {
        success: true,
        account: res.account,
        tokenMasked,
        message: '用户已扫码登录成功，实时会话令牌已成功获取并持久化！',
      },
      null,
      2,
    ),
  );
}

async function cmdLaunchBrowser(
  cfg: ReturnType<typeof loadConfig>,
  targetRoute = '#/dashboard',
  targetProjectId?: string,
): Promise<void> {
  const { account, token } = await ensureSessionToken(cfg, targetProjectId);
  const tokenMasked = `${token.slice(0, 8)}...${token.slice(-4)}`;
  log(`[可视模式] 使用账号 ${account}（token: ${tokenMasked}），正在启动前台内部浏览器并免扫码登录…`);

  // 强制前台模式
  cfg.browserHeadless = false;
  const ui = new UiExecutor(cfg);
  const res = await ui.execute({
    endpoint: targetRoute,
    token,
    account,
  });
  log(`[可视模式] 浏览器已导航至 ${targetRoute}，登录会话状态: ${res.ok ? '成功' : '失败'}`);
  console.log(JSON.stringify({ ok: res.ok, diagnostics: res.diagnostics }, null, 2));

  // 保持窗口打开，避免退出导致浏览器闪退
  log(`[可视模式] 窗口已保持打开，如需关闭请按 Ctrl+C`);
  await new Promise(() => {});
}

// 重新 eval 活签名器（从缓存的 app bundle 里，避免 bootstrap 与 probe 不一致）
async function loadLiveSigner(cfg: ReturnType<typeof loadConfig>): Promise<import('./contract/bootstrap.js').LiveSigner | null> {
  try {
    const cacheDir = path.resolve(cfg.sourceCacheDir);
    const appFile = fs.readdirSync(path.join(cacheDir, 'bundles')).find((f) => /^app\..*\.js$/.test(f));
    if (!appFile) return null;
    const text = fs.readFileSync(path.join(cacheDir, 'bundles', appFile), 'utf8');
    const { runBootstrap } = await import('./contract/bootstrap.js');
    const bs = runBootstrap([{ name: appFile, hash: 'x', size: text.length, text, url: 'cache' }]);
    return bs.signer ?? null;
  } catch (e) {
    log(`签名器重载失败：${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const [cmd, arg, optArg] = process.argv.slice(2);
  const cfg = loadConfig();
  if (cmd === 'bootstrap') await cmdBootstrap(cfg);
  else if (cmd === 'auth') await cmdAuth(cfg, arg);
  else if (cmd === 'interactive-login') await cmdInteractiveLogin(cfg);
  else if (cmd === 'launch-browser') await cmdLaunchBrowser(cfg, arg, optArg);
  else if (cmd === 'probe' && arg) await cmdProbe(cfg, arg, optArg);
  else {
    console.log('用法:');
    console.log('  tsx src/index.ts auth [mcpToken]                        # 纯公网 MCP 授权校验与项目同步');
    console.log('  tsx src/index.ts interactive-login                      # 前台打开项目端扫码并保存会话');
    console.log('  tsx src/index.ts launch-browser [路由] [projectId]      # 前台唤起内部浏览器免扫码自动登录');
    console.log('  tsx src/index.ts probe <端点> [projectId]               # 活站双通道取数 + 租户拦截');
    console.log('  tsx src/index.ts bootstrap                              # 拉活源码 + 自举契约');
    console.log('示例: tsx src/index.ts probe /rrs/project/find 8db7995d394f4b479329f37a8085342f');
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
