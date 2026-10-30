#!/usr/bin/env node
/**
 * 验证四大高频域（项目/人员/工资/考勤）通道A（直调API）数据获取
 */
import { loadConfig } from '../src/config.js';
import { RedisTokenSource } from '../src/session/token-source.js';
import { ApiExecutor } from '../src/executor/api.js';
import { SourceCache } from '../src/source/cache.js';
import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function loadLiveSigner(cacheDir) {
  const appFile = fs.readdirSync(path.join(cacheDir, 'bundles')).find((f) => /^app\..*\.js$/.test(f));
  if (!appFile) throw new Error('未找到 app bundle 缓存');
  const text = fs.readFileSync(path.join(cacheDir, 'bundles', appFile), 'utf8');
  const { runBootstrap } = await import('../src/contract/bootstrap.js');
  const bs = runBootstrap([{ name: appFile, hash: 'x', size: text.length, text, url: 'cache' }]);
  if (!bs.signer) throw new Error('签名器 eval 失败: ' + bs.reason);
  return bs.signer;
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

(async () => {
  const cfg = loadConfig();
  const cacheDir = path.resolve(cfg.sourceCacheDir);
  const signer = await loadLiveSigner(cacheDir);
  const api = new ApiExecutor(cfg, signer);

  const srcCfg = {
    url: process.env.QXB_SID_REDIS_URL ?? null,
    host: process.env.QXB_SID_REDIS_HOST ?? '10.0.1.5',
    port: Number(process.env.QXB_SID_REDIS_PORT ?? 9111),
    password: process.env.QXB_SID_REDIS_PASSWORD ?? 'rHYC@9V*qG3FUyLc',
    db: Number(process.env.QXB_SID_REDIS_DB ?? 15),
    keyPrefix: process.env.QXB_SID_KEY_PREFIX ?? 'login:sid:',
    accounts: (process.env.QXB_SID_ACCOUNTS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  };

  const source = new RedisTokenSource(srcCfg);
  const { account, token } = await source.borrow();
  console.log(`[Token] 借到账号 ${account} (token: ${token.slice(0, 8)}...)`);

  const report = {};

  const targetProjectId = 'ad0c6a67ed5f4560b248bc1ab2b44167'; // 贵阳市民族中学新建学生宿舍项目

  // 1. 项目看板 / 项目查找
  console.log('\n--- 1. 验证【项目看板域】---');
  const rProject = await api.execute({
    endpoint: '/rrs/project/find',
    method: 'POST',
    payload: {},
    token,
    account,
  });
  console.log(`项目查找: ok=${rProject.ok} httpStatus=${rProject.httpStatus} 耗时=${rProject.elapsedMs}ms`);
  const projects = rProject.data?.list ?? [];
  console.log(`名下项目数量: ${projects.length}`);
  const activeProject = projects.find(p => p.id === targetProjectId) || projects[0] || null;
  if (activeProject) {
    console.log(`目标项目: ID=${activeProject.id} 名称=${activeProject.fullName}`);
    console.log('目标项目完整画像:', JSON.stringify(activeProject));
  }
  report.project = {
    ok: rProject.ok,
    count: projects.length,
    activeProjectId: activeProject?.id,
    activeProjectName: activeProject?.fullName,
    details: activeProject,
    elapsedMs: rProject.elapsedMs,
  };

  const projectId = targetProjectId;

  // 2. 人员列表（自动走跨域）
  console.log('\n--- 2. 验证【人员管理域】---');
  const rPerson = await api.execute({
    endpoint: '/rrs/person/list',
    method: 'POST',
    payload: { projectId, pageNum: 1, pageSize: 20 },
    token,
    account,
  });
  console.log(`人员列表(跨域): ok=${rPerson.ok} httpStatus=${rPerson.httpStatus} 耗时=${rPerson.elapsedMs}ms`);
  const personList = rPerson.data?.list ?? [];
  const personTotal = rPerson.data?.total ?? personList.length;
  console.log(`项目总人数: ${personTotal} 本页条数: ${personList.length}`);
  report.person = {
    ok: rPerson.ok,
    total: personTotal,
    list: personList,
    elapsedMs: rPerson.elapsedMs,
  };

  // 3. 考勤记录（主域）
  console.log('\n--- 3. 验证【考勤管理域】---');
  const now = new Date();
  const past60 = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
  const rAttend = await api.execute({
    endpoint: '/attend/list',
    method: 'POST',
    payload: {
      projectId,
      begin: formatDate(past60),
      end: formatDate(now),
      pageNum: 1,
      pageSize: 20,
    },
    token,
    account,
  });
  console.log(`考勤记录: ok=${rAttend.ok} httpStatus=${rAttend.httpStatus} 耗时=${rAttend.elapsedMs}ms`);
  const attendList = rAttend.data?.list ?? [];
  const attendTotal = rAttend.data?.total ?? attendList.length;
  console.log(`近60天打卡记录总数: ${attendTotal} 本页条数: ${attendList.length}`);
  report.attendance = {
    ok: rAttend.ok,
    total: attendTotal,
    list: attendList,
    elapsedMs: rAttend.elapsedMs,
  };

  // 4. 工资册列表（主域）
  console.log('\n--- 4. 验证【工资册域】---');
  const rSalary = await api.execute({
    endpoint: '/rrs/salary/list',
    method: 'POST',
    payload: { projectId, pageNum: 1, pageSize: 20 },
    token,
    account,
  });
  console.log(`工资册列表: ok=${rSalary.ok} httpStatus=${rSalary.httpStatus} 耗时=${rSalary.elapsedMs}ms`);
  const salaryList = rSalary.data?.list ?? [];
  const salaryTotal = rSalary.data?.total ?? salaryList.length;
  console.log(`工资批次总数: ${salaryTotal} 本页条数: ${salaryList.length}`);
  report.salary = {
    ok: rSalary.ok,
    total: salaryTotal,
    list: salaryList,
    elapsedMs: rSalary.elapsedMs,
  };

  // 保存数据为本地快照供专家团分析
  fs.writeFileSync('data/project-school-audit.json', JSON.stringify(report, null, 2), 'utf8');
  console.log('\n✓ 目标项目全域数据已写入 data/project-school-audit.json');

  console.log('\n=== 四大高频域 通道A 验证总结 ===');
  console.log(JSON.stringify(report, null, 2));

  await source.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
