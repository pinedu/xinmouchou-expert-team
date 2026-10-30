// pass3: 离场人员名单（person/list state=-1）
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
  const r = await crossApi.execute({
    endpoint: '/rrs/person/list', token: s.token, account: ACCOUNT,
    payload: { projectId: PROJECT_ID, state: -1, pageNum: 1, pageSize: 2000 },
  });
  console.log('state=-1 ok=', r.ok, 'total=', (r.data as any)?.total);
  if (r.ok) {
    fs.writeFileSync('./data/gjgz2-person-state-1.json', JSON.stringify(r, null, 2));
    const list: any[] = (r.data as any)?.list ?? [];
    const withExitDate = list.filter((p) => p.endDate);
    console.log('名单条数=', list.length, '含退场时间(endDate)=', withExitDate.length);
    if (list[0]) console.log('字段样例:', Object.keys(list[0]).join(','));
  }
  await src.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
