// pass5: 专户信息 + 202608/202609 月度批次人员明细聚合 → 汇总落盘 gjgz2-payroll-latest.json
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
  const api = new ApiExecutor(cfg, bs.signer);
  const src = new RedisTokenSource({
    url: null, host: '10.0.1.5', port: 9111, password: 'rHYC@9V*qG3FUyLc',
    db: 15, keyPrefix: 'login:sid:', accounts: [ACCOUNT],
  });
  const s = await src.borrowAccount(ACCOUNT);
  if (!s) throw new Error('无 token');

  // 1) 工资专户（代发银行）
  const acc = await api.execute({
    endpoint: '/project/wageAccount/list', token: s.token, account: ACCOUNT,
    payload: { projectId: PROJECT_ID, pageNum: 1, pageSize: 20 },
  });
  console.log('wageAccount ok=', acc.ok, 'total=', (acc.data as any)?.total);
  fs.writeFileSync('./data/gjgz2-wageAccount.json', JSON.stringify(acc, null, 2));

  // 2) 全量批次 → 取 payMonth in (202608, 202609) 的批次明细
  const full = JSON.parse(fs.readFileSync('./data/gjgz2-salaryList-full.json', 'utf8')).data;
  const batches: any[] = full.list;
  const months = ['202608', '202609'];
  const monthAgg: Record<string, any> = {};
  for (const m of months) {
    const bs2 = batches.filter((b) => b.payMonth === m);
    const details: any[] = [];
    for (const b of bs2) {
      const r = await api.execute({
        endpoint: '/rrs/salaryDetail/list', token: s.token, account: ACCOUNT,
        payload: { salaryId: b.id, pageNum: 1, pageSize: 1000 },
      });
      if (!r.ok) { console.error(`detail ${b.id} (${m}) 失败:`, r.errorCode); continue; }
      details.push(...(((r.data as any)?.list ?? []) as any[]));
    }
    const distinct = new Map<string, any>();
    for (const d of details) distinct.set(d.personId ?? d.idCardNo, d);
    const shouldPay = details.reduce((x, d) => x + Number(d.shouldPay ?? 0), 0);
    const finalPay = details.reduce((x, d) => x + Number(d.finalPay ?? 0), 0);
    monthAgg[m] = {
      batchCount: bs2.length,
      personDetailRows: details.length,
      distinctPersonCount: distinct.size,
      shouldPaySum: Number(shouldPay.toFixed(2)),
      finalPaySum: Number(finalPay.toFixed(2)),
      payDateRange: [bs2.map((b) => b.payDate).sort()[0], bs2.map((b) => b.payDate).sort().pop()],
      batches: bs2.map((b) => ({ id: b.id, payDate: b.payDate, totalPay: b.totalPay, finalPay: b.finalPay, payWay: b.payWay, channel: b.channel, auditStatus: b.auditStatus, isBackPay: b.isBackPay })),
    };
    console.log(m, JSON.stringify({ ...monthAgg[m], batches: `${bs2.length}个` }));
    fs.writeFileSync(`./data/gjgz2-salaryDetail-${m}.json`, JSON.stringify({ payMonth: m, ...monthAgg[m], detailRows: details }, null, 2));
  }

  // 3) 汇总 gjgz2-payroll-latest.json
  const latestByPayDate = [...batches].sort((a, b) => String(b.payDate).localeCompare(String(a.payDate)))[0];
  const latestDetail = JSON.parse(fs.readFileSync('./data/gjgz2-salaryDetail-latest.json', 'utf8'));
  const six = JSON.parse(fs.readFileSync('./data/gjgz2-sixIndicators.json', 'utf8')).data;
  const summary = {
    projectId: PROJECT_ID,
    projectName: six.projectName,
    specialAccount: {
      accountNum: six.accountNum,
      isOpenSpecialAccount: six.isOpenSpecialAccount,
      isAgentPayment: six.isAgentPayment,
      isAgentPaymentFailReason: six.isAgentPaymentFailReason,
      accountTripartiteAgreement: six.accountTripartiteAgreement,
      wageAccountList: acc.ok ? acc.data : null,
    },
    latestIssuedBatchByPayDate: latestByPayDate,
    latestIssuedBatchDetail: { total: latestDetail.data.total, totalFinalPay: latestDetail.data.totalFinalPay, list: latestDetail.data.list },
    monthAggregates: monthAgg,
    salaryBatchesTotalCount: full.total,
    monthlySummary: Object.entries(
      batches.reduce((acc2: Record<string, any>, b) => {
        (acc2[b.payMonth] = acc2[b.payMonth] || { batchCount: 0, totalPay: 0, finalPay: 0 });
        acc2[b.payMonth].batchCount++;
        acc2[b.payMonth].totalPay = Number((acc2[b.payMonth].totalPay + Number(b.totalPay || 0)).toFixed(2));
        acc2[b.payMonth].finalPay = Number((acc2[b.payMonth].finalPay + Number(b.finalPay || 0)).toFixed(2));
        return acc2;
      }, {}),
    ).map(([payMonth, v]) => ({ payMonth, ...v })).sort((a, b) => a.payMonth.localeCompare(b.payMonth)),
    bankSerialsEndpointStatus: 'NOT_AVAILABLE（/bankserialsinfo/listPage 主域与跨域均 HTTP 404，活站点前端亦未实际调用该端点）',
    fetchedAt: new Date().toISOString(),
  };
  fs.writeFileSync('./data/gjgz2-payroll-latest.json', JSON.stringify(summary, null, 2));
  console.log('落盘 ./data/gjgz2-payroll-latest.json');
  await src.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
