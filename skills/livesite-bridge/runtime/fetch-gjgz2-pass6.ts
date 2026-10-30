// pass6: 修正——批次明细分页（服务器单页上限100），重建 202608/202609 聚合与 payroll-latest.json
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

  async function fetchAllDetails(salaryId: string): Promise<any[]> {
    const rows: any[] = [];
    let total = -1;
    let page = 1;
    while (total === -1 || rows.length < total) {
      const r = await api.execute({
        endpoint: '/rrs/salaryDetail/list', token: s.token, account: ACCOUNT,
        payload: { salaryId, pageNum: page, pageSize: 100 },
      });
      if (!r.ok) throw new Error(`detail ${salaryId} page ${page} 失败: ${r.errorCode}`);
      const d: any = r.data;
      total = d.total;
      rows.push(...(d.list ?? []));
      if (!d.list?.length) break;
      page++;
    }
    return rows;
  }

  const full = JSON.parse(fs.readFileSync('./data/gjgz2-salaryList-full.json', 'utf8')).data;
  const batches: any[] = full.list;
  const months = ['202608', '202609'];
  const monthAgg: Record<string, any> = {};
  for (const m of months) {
    const bs2 = batches.filter((b) => b.payMonth === m);
    const details: any[] = [];
    const perBatch: any[] = [];
    for (const b of bs2) {
      const rows = await fetchAllDetails(b.id);
      details.push(...rows);
      const sp = rows.reduce((x, d) => x + Number(d.shouldPay ?? 0), 0);
      perBatch.push({ id: b.id, payDate: b.payDate, batchTotalPay: b.totalPay, rows: rows.length, detailShouldPaySum: Number(sp.toFixed(2)) });
      console.log(m, b.id.slice(0, 8), b.payDate, 'rows', rows.length, 'sp', sp.toFixed(2), '/ batch', b.totalPay);
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
      batchTotalPaySum: Number(bs2.reduce((x, b) => x + Number(b.totalPay ?? 0), 0).toFixed(2)),
      batchFinalPaySum: Number(bs2.reduce((x, b) => x + Number(b.finalPay ?? 0), 0).toFixed(2)),
      payDateRange: [bs2.map((b) => b.payDate).sort()[0], bs2.map((b) => b.payDate).sort().pop()],
      batches: perBatch,
    };
    console.log(m, '聚合:', JSON.stringify({ ...monthAgg[m], batches: `${bs2.length}个` }));
    fs.writeFileSync(`./data/gjgz2-salaryDetail-${m}.json`, JSON.stringify({ payMonth: m, ...monthAgg[m], detailRows: details }, null, 2));
  }

  // 重建 payroll-latest.json
  const latestByPayDate = [...batches].sort((a, b) => String(b.payDate).localeCompare(String(a.payDate)))[0];
  const latestRows = await fetchAllDetails(latestByPayDate.id);
  const latestDistinct = new Set(latestRows.map((d) => d.personId ?? d.idCardNo));
  const acc = JSON.parse(fs.readFileSync('./data/gjgz2-wageAccount.json', 'utf8'));
  const six = JSON.parse(fs.readFileSync('./data/gjgz2-sixIndicators.json', 'utf8')).data;
  const summary = {
    projectId: PROJECT_ID,
    projectName: six.projectName,
    specialAccount: {
      accountName: acc.data?.list?.[0]?.accountName ?? null,
      accountNum: acc.data?.list?.[0]?.accountNum ?? six.accountNum,
      accountBank: acc.data?.list?.[0]?.accountBank ?? null,
      bankCode: acc.data?.list?.[0]?.bankCode ?? null,
      salaryPayChannel: acc.data?.list?.[0]?.salaryPayChannel ?? null,
      isOpenSpecialAccount: six.isOpenSpecialAccount,
      isAgentPayment: six.isAgentPayment,
      isAgentPaymentFailReason: six.isAgentPaymentFailReason,
      accountTripartiteAgreement: six.accountTripartiteAgreement,
    },
    latestIssuedBatchByPayDate: latestByPayDate,
    latestIssuedBatchDetail: {
      personRows: latestRows.length,
      distinctPersonCount: latestDistinct.size,
      shouldPaySum: Number(latestRows.reduce((x, d) => x + Number(d.shouldPay ?? 0), 0).toFixed(2)),
      finalPaySum: Number(latestRows.reduce((x, d) => x + Number(d.finalPay ?? 0), 0).toFixed(2)),
      list: latestRows,
    },
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
    bankSerialsEndpointStatus: 'NOT_AVAILABLE（/bankserialsinfo/listPage 主域与跨域均 HTTP 404；活站点前端源码中该端点仅有定义、无调用方）',
    fetchedAt: new Date().toISOString(),
  };
  fs.writeFileSync('./data/gjgz2-payroll-latest.json', JSON.stringify(summary, null, 2));
  console.log('重建落盘 ./data/gjgz2-payroll-latest.json');
  await src.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
