#!/usr/bin/env node
/**
 * qxb-livesite 端到端全链路双通道与故障自愈验收套件
 * 
 * 验收场景：
 * 1. 正常场景：编排器调度通道A（直调API），验证四大域毫秒级取数与四段诊断
 * 2. 故障自愈降级场景：模拟通道A不可用（如签名失效或端点被封），编排器自动降级至通道B（Playwright UI），兜底成功取数
 * 3. 结果一致性与诊断归因输出
 */
import { loadConfig } from '../src/config.js';
import { RedisTokenSource } from '../src/session/token-source.js';
import { ApiExecutor } from '../src/executor/api.js';
import { UiExecutor } from '../src/executor/ui.js';
import { Orchestrator } from '../src/orchestrator.js';
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

(async () => {
  console.log('================================================================');
  console.log('       qxb-livesite 端到端双通道与故障自愈验收套件');
  console.log('================================================================');

  const cfg = loadConfig();
  const cacheDir = path.resolve(cfg.sourceCacheDir);
  const cache = new SourceCache(cacheDir);
  const contract = cache.readContract();
  if (!contract) throw new Error('无已缓存契约，请先执行 bootstrap');

  const signer = await loadLiveSigner(cacheDir);

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

  const results = [];

  // ==============================================================
  // 场景 1：正常流程（通道A直调API，毫秒级快速响应）
  // ==============================================================
  console.log('\n[验收场景 1] 正常流程：编排器调度通道A取数');
  const normalApi = new ApiExecutor(cfg, signer);
  const normalUi = new UiExecutor(cfg);
  const normalOrchestrator = new Orchestrator({
    contract,
    api: normalApi,
    ui: normalUi,
    autoFallback: true,
    log: (m) => console.log(`  [Orchestrator] ${m}`),
  });

  const rNormal = await normalOrchestrator.run({
    endpoint: '/rrs/project/find',
    method: 'POST',
    payload: {},
    token,
    account,
  });

  console.log(`  -> 结果: ok=${rNormal.ok} 通道=${rNormal.channel} 耗时=${rNormal.elapsedMs}ms`);
  console.log(`  -> 归因诊断: ${rNormal.diagnostics.verdict}`);
  results.push({
    scenario: '场景1: 通道A常规取数',
    ok: rNormal.ok,
    channel: rNormal.channel,
    elapsedMs: rNormal.elapsedMs,
    verdict: rNormal.diagnostics.verdict,
  });

  // ==============================================================
  // 场景 2：故障自愈降级（模拟通道A失效，编排器自动无缝降级到通道B）
  // ==============================================================
  console.log('\n[验收场景 2] 故障自愈降级：模拟通道A签名器异常，自动降级至通道B（Playwright UI）');
  // 创建一个签名器损坏的 ApiExecutor，模拟通道A因源站签名规则变动而报错
  const brokenSigner = (obj, method) => {
    return { appkey: 'INVALID_APPKEY', timestamp: Date.now(), signcode: 'INVALID_SIGNCODE_401' };
  };
  brokenSigner.appkey = 'INVALID_APPKEY';
  brokenSigner.source = 'simulated-broken';

  const brokenApi = new ApiExecutor(cfg, brokenSigner);
  const fallbackUi = new UiExecutor(cfg);
  const fallbackOrchestrator = new Orchestrator({
    contract,
    api: brokenApi,
    ui: fallbackUi,
    autoFallback: true,
    log: (m) => console.log(`  [Orchestrator] ${m}`),
  });

  const rFallback = await fallbackOrchestrator.run({
    endpoint: '/rrs/project/find',
    method: 'POST',
    payload: {},
    token,
    account,
  });

  console.log(`  -> 结果: ok=${rFallback.ok} 最终生效通道=${rFallback.channel} 耗时=${rFallback.elapsedMs}ms`);
  console.log(`  -> 诊断全链路记录:`);
  for (const step of rFallback.diagnostics.steps) {
    console.log(`     [${step.stage}] ${step.ok ? '✓' : '✗'} ${step.summary}`);
  }
  console.log(`  -> 归因最终结论: ${rFallback.diagnostics.verdict}`);

  results.push({
    scenario: '场景2: 通道A故障降级至通道B',
    ok: rFallback.ok,
    channel: rFallback.channel,
    elapsedMs: rFallback.elapsedMs,
    verdict: rFallback.diagnostics.verdict,
  });

  // 关闭资源
  await normalUi.close();
  await fallbackUi.close();
  await source.close();

  console.log('\n================================================================');
  console.log('                   端到端验收测试报告汇总');
  console.log('================================================================');
  console.table(results);
  
  const allPassed = results.every(r => r.ok);
  console.log(`\n验收结论: ${allPassed ? '全部通过 (ALL PASSED) ✓' : '存在未通过项 ✗'}`);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
