// 干井二标段（GJGZ-2）专户发放与离场结算取数脚本。
// 复用 qxb-livesite 通道A（ApiExecutor + 活签名器 + Redis token 借用），
// 仅做取数与落盘，不做专业分析。原始 JSON 落盘 data/ 目录。
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './src/config.js';
import { SourceCache } from './src/source/cache.js';
import { RedisTokenSource } from './src/session/token-source.js';
import { ApiExecutor } from './src/executor/api.js';
import { runBootstrap } from './src/contract/bootstrap.js';

const PROJECT_ID = '8db7995d394f4b479329f37a8085342f';
const ACCOUNT = 'GJGZ-2';
const OUT_DIR = path.resolve('./data');
const log = (m: string): void => console.log(`[fetch-gjgz2] ${m}`);

async function loadLiveSigner(cfg: ReturnType<typeof loadConfig>) {
  const cacheDir = path.resolve(cfg.sourceCacheDir);
  const appFile = fs
    .readdirSync(path.join(cacheDir, 'bundles'))
    .find((f) => /^app\..*\.js$/.test(f));
  if (!appFile) return null;
  const text = fs.readFileSync(path.join(cacheDir, 'bundles', appFile), 'utf8');
  const { runBootstrap } = await import('./src/contract/bootstrap.js');
  const bs = runBootstrap([{ name: appFile, hash: 'x', size: text.length, text, url: 'cache' }]);
  return bs.signer ?? null;
}

type CallResult = { ok: boolean; data: unknown; diag: unknown; elapsed: number; code?: string };

async function call(
  api: ApiExecutor,
  token: string,
  endpoint: string,
  payload: Record<string, unknown>,
  method: 'GET' | 'POST' = 'POST',
): Promise<CallResult> {
  const r = await api.execute({ endpoint, token, account: ACCOUNT, payload, method });
  log(
    `${method} ${endpoint} → ok=${r.ok} elapsed=${r.elapsedMs}ms code=${r.errorCode ?? '-'}`,
  );
  if (!r.ok) {
    const failStep = (r.diagnostics as any)?.steps?.find((s: any) => !s.ok);
    log(`  失败归因: ${(failStep as any)?.stage} ${(failStep as any)?.summary} ${(failStep as any)?.detail ?? ''}`.slice(0, 300));
  }
  return { ok: r.ok, data: r.data, diag: r.diagnostics, elapsed: r.elapsedMs, code: r.errorCode };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const cache = new SourceCache(path.resolve(cfg.sourceCacheDir));
  const contract = cache.readContract();
  if (!contract) throw new Error('无契约，先 bootstrap');
  const signer = await loadLiveSigner(cfg);
  if (!signer) throw new Error('签名器加载失败');
  const api = new ApiExecutor(cfg, signer);

  const srcCfg = {
    url: process.env.QXB_SID_REDIS_URL ?? null,
    host: process.env.QXB_SID_REDIS_HOST ?? '10.0.1.5',
    port: Number(process.env.QXB_SID_REDIS_PORT ?? 9111),
    password: process.env.QXB_SID_REDIS_PASSWORD ?? 'rHYC@9V*qG3FUyLc',
    db: Number(process.env.QXB_SID_REDIS_DB ?? 15),
    keyPrefix: process.env.QXB_SID_KEY_PREFIX ?? 'login:sid:',
    accounts: [ACCOUNT],
  };
  const source = new RedisTokenSource(srcCfg);
  const session = await source.borrowAccount(ACCOUNT);
  if (!session) throw new Error(`账号 ${ACCOUNT} 无可用 token`);
  const { token } = session;
  log(`借到账号 ${ACCOUNT}（token: ${token.slice(0, 8)}...${token.slice(-4)}）`);

  const out: Record<string, CallResult> = {};

  // 0) 项目信息（取 zfProjectNum/projectNum 等字段）
  out.project = await call(api, token, '/rrs/project/find', {});

  // 1) 六项指标（含 工资银行代发 isAgentPayment / 离场结算 isExitSettlement、离场(未)结算人数）
  out.sixIndicators = await call(
    api,
    token,
    `/sixIndex/newIndicators/getIndicator/${PROJECT_ID}`,
    {},
    'GET',
  );

  // 2) 工资册批次列表（最近一个月度批次：应发/实发/人数/代发编号/发放日期）
  out.salaryList = await call(api, token, '/rrs/salary/list', {
    projectId: PROJECT_ID,
    pageNum: 1,
    pageSize: 50,
  });

  // 3) 离场未结算人员列表（六项指标详情页同款端点，projectNum 先取 projectId）
  out.exitNoSettlement = await call(
    api,
    token,
    `/sixIndex/warning/project/${PROJECT_ID}/exitNoSettlementPersonList`,
    { currentPage: 1, pageSize: 100 },
  );

  // 4) 项目备案记录（recordId，用于离场结算单文件列表）
  out.noAuthRecords = await call(api, token, '/noAuthProject/getRecords', {}, 'GET');

  // 从 project 数据中提取可能的 zfProjectNum / recordId
  let zfNum: string | null = null;
  let recordId: string | null = null;
  const pdata: any = out.project.data;
  const candidates: any[] = Array.isArray(pdata) ? pdata : pdata?.list ?? pdata?.data ?? [];
  const proj =
    candidates.find((p) => p?.id === PROJECT_ID) ??
    (pdata && !Array.isArray(pdata) && pdata?.id === PROJECT_ID ? pdata : null);
  if (proj) {
    zfNum = proj.zfProjectNum ?? proj.projectNum ?? null;
    recordId = proj.recordId ?? null;
    log(`项目字段: zfProjectNum=${zfNum ?? '-'} recordId=${recordId ?? '-'}`);
  }

  // 5) 离场结算单列表（noAuthProject/exit/file，recordId 优先取项目字段）
  const exitFileRecordId = recordId ?? zfNum;
  if (exitFileRecordId) {
    out.exitFileList = await call(api, token, '/noAuthProject/exit/file', {
      currentPage: 1,
      pageSize: 50,
      recordId: exitFileRecordId,
    });
  } else {
    log('未取得 recordId，跳过 /noAuthProject/exit/file');
  }

  // 6) 银行代发流水（bankserialsinfo，主域 404 时尝试跨域后端）
  out.bankSerialsMain = await call(api, token, '/bankserialsinfo/listPage', {
    projectId: PROJECT_ID,
    pageNum: 1,
    pageSize: 50,
  });
  if (!out.bankSerialsMain.ok) {
    const crossApi = new ApiExecutor(
      { ...cfg, mainApiBase: cfg.crossApiBase },
      signer,
    );
    out.bankSerialsCross = await call(crossApi, token, '/bankserialsinfo/listPage', {
      projectId: PROJECT_ID,
      pageNum: 1,
      pageSize: 50,
    });
  }

  // 落盘
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [key, r] of Object.entries(out)) {
    const fp = path.join(OUT_DIR, `gjgz2-${key}.json`);
    fs.writeFileSync(fp, JSON.stringify(r, null, 2), 'utf8');
    log(`落盘 ${fp}`);
  }

  await source.close();
  log('完成');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
