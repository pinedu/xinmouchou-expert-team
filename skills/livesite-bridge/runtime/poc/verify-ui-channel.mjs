#!/usr/bin/env node
/**
 * 验证通道B（Playwright 浏览器UI点击与网络响应拦截）
 */
import { loadConfig } from '../src/config.js';
import { RedisTokenSource } from '../src/session/token-source.js';
import { UiExecutor } from '../src/executor/ui.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

(async () => {
  const cfg = loadConfig();
  // 强制启用 UI
  cfg.enableUiChannel = true;
  cfg.browserHeadless = true;

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

  const ui = new UiExecutor(cfg);

  try {
    console.log('\n--- 1. 验证 通道B 打开看板并拦截 /rrs/project/find ---');
    const r1 = await ui.execute({
      endpoint: '/rrs/project/find',
      token,
      account,
    });
    console.log(`看板拦截结果: ok=${r1.ok} channel=${r1.channel} 耗时=${r1.elapsedMs}ms`);
    console.log('数据概览:', JSON.stringify(r1.data).slice(0, 300));
    console.log('诊断:', JSON.stringify(r1.diagnostics, null, 2));

    console.log('\n--- 2. 验证 通道B 导航至人员页 #/person 并拦截 /rrs/person/list ---');
    const r2 = await ui.execute({
      endpoint: '/rrs/person/list',
      token,
      account,
    });
    console.log(`人员列表拦截结果: ok=${r2.ok} channel=${r2.channel} 耗时=${r2.elapsedMs}ms`);
    console.log('数据概览:', JSON.stringify(r2.data).slice(0, 300));
    console.log('诊断:', JSON.stringify(r2.diagnostics, null, 2));

    console.log('\n=== 通道B 验证完成 ===');
  } finally {
    await ui.close();
    await source.close();
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
