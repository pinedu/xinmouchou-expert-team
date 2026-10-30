// 干井二标段（GJGZ-2）取数第二遍：全量工资批次 + 最新批次明细 + 离场人员名单。
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './src/config.js';
import { SourceCache } from './src/source/cache.js';
import { RedisTokenSource } from './src/session/token-source.js';
import { ApiExecutor } from './src/executor/api.js';
import { runBootstrap } from './src/contract/bootstrap.js';

const PROJECT_ID = '8db7995d394f4b479329f37a8085342f';
const PROJECT_NUM = '17bcfe09e723291264e1348ce0e6f71a';
const ACCOUNT = 'GJGZ-2';
const OUT_DIR = path.resolve('./data');
const log = (m: string): void => console.log(`[pass2] ${m}`);

async function loadLiveSigner(cfg: ReturnType<typeof loadConfig>) {
  const cacheDir = path.resolve(cfg.sourceCacheDir);
  const appFile = fs
    .readdirSync(path.join(cacheDir, 'bundles'))
    .find((f) => /^app\..*\.js$/.test(f));
  const text = fs.readFileSync(path.join(cacheDir, 'bundles', appFile as string), 'utf8');
  const bs = runBootstrap([{ name: appFile as string, hash: 'x', size: text.length, text, url: 'cache' }]);
  return bs.signer ?? null;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const contract = new SourceCache(path.resolve(cfg.sourceCacheDir)).readContract();
  if (!contract) throw new Error('无契约');
  const signer = await loadLiveSigner(cfg);
  if (!signer) throw new Error('签名器加载失败');
  const api = new ApiExecutor(cfg, signer);
  const crossApi = new ApiExecutor({ ...cfg, mainApiBase: cfg.crossApiBase }, signer);

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
  if (!session) throw new Error('无可用 token');
  const { token } = session;

  const save = (name: string, payload: unknown): string => {
    const fp = path.join(OUT_DIR, name);
    fs.writeFileSync(fp, JSON.stringify(payload, null, 2), 'utf8');
    log(`落盘 ${fp}`);
    return fp;
  };

  // 1) 全量工资批次（130 条）
  const sal = await api.execute({
    endpoint: '/rrs/salary/list',
    token,
    account: ACCOUNT,
    payload: { projectId: PROJECT_ID, pageNum: 1, pageSize: 200 },
  });
  log(`/rrs/salary/list ok=${sal.ok} total=${(sal.data as any)?.total}`);
  save('gjgz2-salaryList-full.json', sal);

  const list: any[] = (sal.data as any)?.list ?? [];
  const sorted = [...list].sort((a, b) => String(b.payDate ?? '').localeCompare(String(a.payDate ?? '')));
  const latest = sorted[0];
  log(`最新批次: payMonth=${latest?.payMonth} payDate=${latest?.payDate} totalPay=${latest?.totalPay} finalPay=${latest?.finalPay} id=${latest?.id}`);

  // 2) 最新批次人员明细
  const detail = await api.execute({
    endpoint: '/rrs/salaryDetail/list',
    token,
    account: ACCOUNT,
    payload: { salaryId: latest.id, pageNum: 1, pageSize: 500 },
  });
  log(
    `/rrs/salaryDetail/list ok=${detail.ok} total=${(detail.data as any)?.total} totalFinalPay=${(detail.data as any)?.totalFinalPay}`,
  );
  save('gjgz2-salaryDetail-latest.json', detail);

  // 3) 离场未结算人员列表（projectNum 变体核验）
  const ex2 = await api.execute({
    endpoint: `/sixIndex/warning/project/${PROJECT_NUM}/exitNoSettlementPersonList`,
    token,
    account: ACCOUNT,
    payload: { currentPage: 1, pageSize: 100 },
  });
  log(`/exitNoSettlementPersonList(projectNum) ok=${ex2.ok} total=${(ex2.data as any)?.total}`);
  save('gjgz2-exitNoSettlement-pnum.json', ex2);

  // 4) 上月工资发放与考勤人员（六项指标联动端点）
  const lastMonth = await api.execute({
    endpoint: `/sixIndex/getLastMonthPayAndAttendPersons/${PROJECT_NUM}`,
    token,
    account: ACCOUNT,
    payload: {},
    method: 'GET',
  });
  log(`/getLastMonthPayAndAttendPersons ok=${lastMonth.ok}`);
  save('gjgz2-lastMonthPayAttend.json', lastMonth);

  // 5) 离场人员名单：person/list 按 state 枚举（0/2 猜测为离场，1 为在职），取含 endDate 的
  for (const st of [0, 2, 3]) {
    const pr = await crossApi.execute({
      endpoint: '/rrs/person/list',
      token,
      account: ACCOUNT,
      payload: { projectId: PROJECT_ID, state: st, pageNum: 1, pageSize: 1000 },
    });
    const d: any = pr.data;
    log(`/rrs/person/list state=${st} ok=${pr.ok} total=${d?.total ?? '-'}`);
    if (pr.ok) save(`gjgz2-person-state${st}.json`, pr);
  }

  // 6) 在职人员对照（state=1）
  const pr1 = await crossApi.execute({
    endpoint: '/rrs/person/list',
    token,
    account: ACCOUNT,
    payload: { projectId: PROJECT_ID, state: 1, pageNum: 1, pageSize: 1000 },
  });
  log(`/rrs/person/list state=1 ok=${pr1.ok} total=${(pr1.data as any)?.total ?? '-'}`);
  if (pr1.ok) save('gjgz2-person-state1.json', pr1);

  await source.close();
  log('pass2 完成');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
