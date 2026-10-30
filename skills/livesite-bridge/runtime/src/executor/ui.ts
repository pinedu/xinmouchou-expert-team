// 通道B：浏览器 UI 兜底（Playwright 持久上下文 + 网络拦截/DOM 抽取）。
// 站点自己怎么点，我们就怎么点 → 永远"跟得上"站点改版。
// 免扫码起站：goto <loginThirdPath>?info=<token> → 自动落 /collect/#/dashboard。
import path from 'node:path';
import fs from 'node:fs';
import { makeDiag } from '../diagnostics.js';
import type { LivesiteConfig } from '../config.js';
import type { Executor, ExecutorRequest, ExecutorResult } from './types.js';

export class UiExecutor implements Executor {
  readonly channel = 'ui' as const;
  private context: import('playwright-core').BrowserContext | null = null;
  private currentToken: string | null = null;

  constructor(private readonly cfg: LivesiteConfig) {}

  /** 端点与页面 hash 路由映射 */
  private resolveRoute(endpoint: string): string {
    if (endpoint.includes('/project/find') || endpoint.includes('/dashboard')) return '#/dashboard';
    if (endpoint.includes('/person/list') || endpoint.includes('/person/')) return '#/person';
    if (endpoint.includes('/attend/list') || endpoint.includes('/attend/')) return '#/attend';
    if (endpoint.includes('/salary/list') || endpoint.includes('/salary/')) return '#/salary';
    return '#/dashboard';
  }

  /** 起一个已登录的浏览器持久上下文（免扫码：用 token 走 /login/third?info=） */
  private async ensureSession(token: string): Promise<{ context: import('playwright-core').BrowserContext; page: import('playwright-core').Page }> {
    const { chromium } = await import('playwright-core');
    const profileDir = path.resolve(this.cfg.sourceCacheDir, '..', 'browser-profile');
    fs.mkdirSync(profileDir, { recursive: true });

    // 如果上下文尚未启动，或者 token 变了，则重新创建
    if (!this.context || this.currentToken !== token) {
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }

      const persistentOptions: Record<string, unknown> = {
        headless: this.cfg.browserHeadless,
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'],
      };
      if (this.cfg.browserExecutable) {
        persistentOptions.executablePath = this.cfg.browserExecutable;
      }

      this.context = await chromium.launchPersistentContext(profileDir, persistentOptions as any);
      this.currentToken = token;

      const page = this.context.pages()[0] ?? (await this.context.newPage());
      const target = `${this.cfg.siteBase}${this.cfg.loginThirdPath}?info=${encodeURIComponent(token)}`;
      const maskedToken = `${token.slice(0, 8)}...${token.slice(-4)}`;
      console.log(`[UI] 打开免扫码登录地址 (token: ${maskedToken})`);

      page.on('response', async (res) => {
        const u = res.url();
        if (/third\/getUserInfo|login|rrs/.test(u)) {
          console.log(`[UI-Net] ${res.status()} ${u.slice(0, 100)}`);
        }
      });

      await page.goto(target, { waitUntil: 'load', timeout: this.cfg.uiTimeoutMs }).catch((e) => {
        console.log(`[UI] goto 异常: ${(e as Error).message}`);
      });

      // 预留足够时间让前端 Third 组件执行 API 调用与页面跳转
      await page.waitForTimeout(6000);
      console.log(`[UI] 登录阶段结束，当前 URL: ${page.url()}`);
      return { context: this.context, page };
    }

    const pages = this.context.pages();
    const page = pages[0] ?? (await this.context.newPage());
    return { context: this.context, page };
  }

  async execute(req: ExecutorRequest): Promise<ExecutorResult> {
    const t0 = Date.now();
    const diag = makeDiag();
    diag.record('S1_SOURCE', true, 'UI 通道与站点同源，不依赖静态契约');

    try {
      const { page } = await this.ensureSession(req.token);
      const curUrl = page.url();

      // 会话有效性判断
      if (curUrl.includes('/screen/#/login')) {
        diag.record('S2_SESSION', false, '会话 token 已过期或无效，被弹回扫码登录网关', curUrl);
        return {
          ok: false,
          channel: 'ui',
          data: null,
          diagnostics: diag.finish(),
          errorCode: 'S2_TOKEN_EXPIRED',
          elapsedMs: Date.now() - t0,
        };
      }
      diag.record('S2_SESSION', true, '浏览器免扫码会话建立成功');

      const targetRoute = this.resolveRoute(req.endpoint);
      const targetUrl = `${this.cfg.siteBase}${this.cfg.collectPath}${targetRoute}`;

      let interceptedData: unknown = null;
      let interceptedStatus = 200;

      // 注册响应监听器（网络 Hook：直接拦截前端收到的真实 API 响应）
      const onResponse = async (resp: import('playwright-core').Response) => {
        try {
          const u = resp.url();
          const cleanEndpoint = req.endpoint.startsWith('/') ? req.endpoint.slice(1) : req.endpoint;
          if (u.includes(cleanEndpoint)) {
            interceptedStatus = resp.status();
            const text = await resp.text();
            try {
              const j = JSON.parse(text);
              interceptedData = j.data ?? j;
            } catch {
              interceptedData = text;
            }
          }
        } catch {
          /* 忽略非文本或流式中断 */
        }
      };

      page.on('response', onResponse);

      try {
        // SPA 内部 Hash 路由切换
        if (!page.url().includes(targetRoute)) {
          await page.evaluate((r) => {
            window.location.hash = r;
          }, targetRoute);
          await page.waitForTimeout(1000);
          if (!page.url().includes(targetRoute)) {
            await page.goto(targetUrl, { waitUntil: 'load', timeout: this.cfg.uiTimeoutMs }).catch(() => {});
          }
        } else {
          await page.reload({ waitUntil: 'load', timeout: this.cfg.uiTimeoutMs }).catch(() => {});
        }

        // 等待页面表格渲染或网络完成
        await page.waitForSelector('.el-table__body tr, .el-table__row, .el-table__empty-block', { timeout: 8000 }).catch(() => {});

        if (!interceptedData) {
          await page.waitForTimeout(2000);
        }
      } finally {
        page.off('response', onResponse);
      }

      if (interceptedData) {
        diag.record('S3_CHANNEL', true, `UI 自动化触发网络响应拦截成功（${req.endpoint}）`);
        diag.record('S4_DATA', true, '已从站点响应流中提取到业务数据载荷');
        return {
          ok: true,
          channel: 'ui',
          data: interceptedData,
          httpStatus: interceptedStatus,
          diagnostics: diag.finish(),
          elapsedMs: Date.now() - t0,
        };
      }

      // 如果未截获到对应端点，兜底：抓取页面可见的表格或文本结构
      const domData = await page.evaluate(() => {
        const rows: Record<string, string>[] = [];
        const table = document.querySelector('.el-table__body');
        if (table) {
          const trs = table.querySelectorAll('tr');
          trs.forEach((tr) => {
            const row: Record<string, string> = {};
            const tds = tr.querySelectorAll('td');
            tds.forEach((td, idx) => {
              const text = td.textContent?.trim() || '';
              if (text) row[`col_${idx}`] = text;
            });
            if (Object.keys(row).length) rows.push(row);
          });
        }
        return {
          title: document.title,
          url: location.href,
          tableRows: rows.slice(0, 10),
        };
      });

      if (domData.tableRows.length > 0) {
        diag.record('S3_CHANNEL', true, 'UI 通道已渲染表格（DOM 兜底抽取）');
        diag.record('S4_DATA', true, `已从表格渲染中提取 ${domData.tableRows.length} 条数据`);
        return {
          ok: true,
          channel: 'ui',
          data: domData,
          diagnostics: diag.finish(),
          elapsedMs: Date.now() - t0,
        };
      }

      diag.record('S3_CHANNEL', true, 'UI 通道页面已加载');
      diag.record('S4_DATA', true, '页面已加载但无表格数据', domData.title);
      return {
        ok: true,
        channel: 'ui',
        data: domData,
        diagnostics: diag.finish(),
        elapsedMs: Date.now() - t0,
      };
    } catch (e) {
      const msg = (e as Error).message;
      const isTimeout = /timeout/i.test(msg);
      diag.record('S3_CHANNEL', false, isTimeout ? 'UI 操作超时' : 'UI 执行异常', msg);
      return {
        ok: false,
        channel: 'ui',
        data: null,
        diagnostics: diag.finish(),
        errorCode: isTimeout ? 'S3_UI_TIMEOUT' : 'S3_UI_ELEMENT_NOT_FOUND',
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this.currentToken = null;
  }
}
