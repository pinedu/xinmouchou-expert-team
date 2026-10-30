// pass4: 分页拉取全量离场人员（state=-1，单页上限100）并落盘合并文件
import fs from 'node:fs';
import { loadConfig } from './src/config.js';
import { RedisTokenSource } from './src/session/token-source.js';
import { ApiExecutor } from './src/executor/api.js';
import { runBootstrap } from './src/contract/bootstrap.js';

const PROJECT_ID = '8db7995d394f4b479329f37a8085342f';
const ACCOUNT = 'GJGZ-2';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const appFile = fs.readdirSync('./data/source/bundles').find((f) => /^app\..*\.js$/.test(f));
  const text = fs.readFileSync('./data/source/bundles/' + appFile, 'utf8');
  const bs = runBootstrap([{ name: appFile as string, hash: 'x', size: text.length, text, url: 'cache' }]);
  const crossApi = new ApiExecutor({ ...cfg, mainApiBase: cfg.crossApiBase }, bs.signer);
  const src = new RedisTokenSource({
    url: null, host: '10.0.1.5', port: 9111, password: 'rHYC@9V*qG3FUyLc',
    db: 15, keyPrefix: 'login:sid:', accounts: [ACCOUNT],
  });
  const s = await src.borrowAccount(ACCOUNT);
  if (!s) throw new Error('无 token');

  const all: any[] = [];
  let total = -1;
  let page = 1;
  while (total === -1 || all.length < total) {
    const r = await crossApi.execute({
      endpoint: '/rrs/person/list', token: s.token, account: ACCOUNT,
      payload: { projectId: PROJECT_ID, state: -1, pageNum: page, pageSize: 100 },
    });
    if (!r.ok) { console.error(`page ${page} 失败:`, r.errorCode); break; }
    const d: any = r.data;
    total = d.total;
    all.push(...(d.list ?? []));
    console.log(`page ${page}: +${d.list?.length ?? 0} 累计 ${all.length}/${total}`);
    if (!d.list?.length) break;
    page++;
  }

  const unsettled = all.filter((p) => !p.exitUrls || (Array.isArray(p.exitUrls) && p.exitUrls.length === 0));
  const settled = all.length - unsettled.length;
  const summary = {
    projectId: PROJECT_ID,
    state: -1,
    total: all.length,
    serverTotal: total,
    settledCount: settled,
    unsettledCount: unsettled.length,
    fetchedAt: new Date().toISOString(),
    list: all,
  };
  fs.writeFileSync('./data/gjgz2-leave-settlement.json', JSON.stringify(summary, null, 2));
  console.log(`落盘 ./data/gjgz2-leave-settlement.json 共 ${all.length} 人，含离场结算单 ${settled}，未含 ${unsettled.length}`);
  await src.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
