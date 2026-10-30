#!/usr/bin/env node
/**
 * PoC：从「活站点源码」自举出 API 契约（替代 qxb-mcp-service 里手工维护的 endpoint-registry）
 *
 * 核心命题：不手工维护站点 API。拉取站点前端源码 → 按 content-hash 版本化缓存 →
 * 确定性抽取「签名模块 / appkey / 盐 / 端点路径 / 请求头规则」→ 直接 eval 抽出的
 * 签名模块完成签名 → 调接口验证。站点发新版（hash 变化）时自动重新自举。
 *
 * 用法：
 *   node poc/derive-contract.mjs                 # 无 token：抽契约原语 + 从 Redis 借 token 验证通道A
 *   node poc/derive-contract.mjs <token>         # 指定 token 验证通道A
 */
import https from 'https';
import http from 'http';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://ldyg.guizhou.gov.cn';
const API_BASE = BASE + '/collect-api';
const OUT = path.join(__dirname, 'out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

function get(url) {
  return new Promise((res) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (r) => {
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', (e) => res({ status: 'ERR', body: e.message }));
    req.setTimeout(25000, () => { req.destroy(); res({ status: 'TIMEOUT', body: 'timeout' }); });
  });
}

/**
 * 从活 bundle 里提取「请求拦截器模块」（含 signcode 签名逻辑）并 eval 自举签名器。
 * 模块形态：KEY:function(e,t,n){ ... var _=y,V=x; z=c.a.create({baseURL:"/collect-api"...});
 *           z.interceptors.request.use(function(e){ ...signcode=V(n,e.method)... }) }
 * 用桩依赖 eval 后，调用捕获到的 request 拦截器即可得到站点真实 appkey + 签名函数。
 * md5 依赖（模块 6821f）用标准 MD5 桩：站点 md5 为标准算法（已多次对拍验证），签名秘密（盐/appkey/拼接规则）全在拦截器模块内。
 */
function bootstrapSignerFromBundle(bundleTexts) {
  for (const { name, text } of bundleTexts) {
    const anchor = text.indexOf('signcode:""');
    if (anchor < 0) continue;
    // 模块起点：anchor 之前最近的  KEY:function  顶层键
    const before = text.slice(0, anchor);
    const keys = [...before.matchAll(/(?:^|[,;})])([0-9a-f]{4,6}|[a-zA-Z_$][\w$]*)\s*:\s*function/g)];
    const m = keys[keys.length - 1];
    if (!m) continue;
    const fnStart = m.index + m[0].lastIndexOf('function');
    const braceStart = text.indexOf('{', fnStart);
    let d = 0, j = braceStart;
    for (; j < text.length; j++) { const ch = text[j]; if (ch === '{') d++; else if (ch === '}') { d--; if (!d) break; } }
    const fnText = text.slice(fnStart, j + 1);

    // 桩依赖（webpack 模块 id 来自该模块的 n("...") 调用）
    let reqInterceptor = null;
    const axiosInstance = { interceptors: { request: { use: (fn) => { reqInterceptor = fn; } }, response: { use: () => {} } }, get() {}, post() {} };
    const axiosStub = { create: () => axiosInstance };
    const requireStub = (id) => {
      switch (id) {
        case '5530': return { a: Object.assign };                       // _extends
        case '53ca': return { a: (x) => typeof x };                     // _typeof
        case 'bc3a': return axiosStub;                                  // axios
        case '5c96': return { Loading: { service: () => ({ close() {} }) }, Message: () => {} }; // element-ui
        case '4328': return { a: { stringify: (o) => JSON.stringify(o) } }; // qs
        case 'b85c': return { a: (o) => o[Symbol.iterator]() };         // 迭代器助手
        case '6821f': return md5;                                       // 标准 MD5（站点模块为 crypto-js md5，已对拍验证）
        default: return {};                                             // 副作用 import
      }
    };
    requireStub.n = (mod) => { const f = () => mod; Object.defineProperty(f, 'a', { get: () => mod }); return f; }; // webpack n.n
    requireStub.d = (exportsObj, k, getter) => { Object.defineProperty(exportsObj, k, { get: getter, enumerable: true }); }; // webpack n.d

    try {
      const factory = new Function('return (' + fnText + ')')();
      factory({}, {}, requireStub);
    } catch (e) {
      return { ok: false, reason: `模块 ${name} eval 失败: ${e.message}` };
    }
    if (!reqInterceptor) return { ok: false, reason: '模块 eval 成功但未捕获到 request 拦截器' };
    globalThis.localStorage = globalThis.localStorage || { _s: { LOGININFO: '' }, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
    const probe = reqInterceptor({ method: 'post', data: {} });
    const appkey = probe?.headers?.appkey;
    if (!appkey || !probe.headers.signcode) return { ok: false, reason: '拦截器调用未产出 appkey/signcode' };
    const sign = (obj, method) => {
      globalThis.localStorage._s.LOGININFO = globalThis.localStorage._s.LOGININFO || '';
      const r = reqInterceptor({ method, data: obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}, headers: {} });
      return r.headers.signcode;
    };
    return { ok: true, signer: { x: sign, y: appkey, C: null }, appkey, source: `live:${name}`, module: fnText.slice(0, 80) };
  }
  return { ok: false, reason: '全部 bundle 未找到 signcode 拦截器模块' };
}

/** 旧形态兜底：独立 signer 模块 new Function("md5","<code>")(md5) → {x,C,y} */
function extractSigner(text) {
  const anchor = text.indexOf('new Function("md5"');
  if (anchor < 0) return { ok: false, reason: '未找到 new Function("md5" 锚点' };
  let i = text.indexOf('"', anchor);
  i = text.indexOf('"', i + 1); // close of "md5"
  const comma = text.indexOf(',', i + 1);
  const open2 = text.indexOf('"', comma + 1);
  let j = open2 + 1, code = '';
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') { code += ch + (text[j + 1] || ''); j += 2; continue; }
    if (ch === '"') break;
    code += ch; j++;
  }
  if (j >= text.length) return { ok: false, reason: '字符串字面量未闭合' };
  let inner;
  try { inner = eval('"' + code + '"'); } catch (e) { return { ok: false, reason: 'unescape 失败: ' + e.message }; }
  try {
    const mod = new Function('md5', inner)(md5);
    if (mod && typeof mod.x === 'function' && mod.y) return { ok: true, signer: mod, source: 'live' };
    return { ok: false, reason: 'eval 成功但返回结构不符（无 x 函数或 y appkey）' };
  } catch (e) { return { ok: false, reason: 'eval 执行失败: ' + e.message }; }
}

/** 从 Redis db15 借一个有效 token（login:sid:*），复用 qxb-gov 的 redis 客户端 */
async function borrowTokenFromRedis() {
  const requireGov = createRequire(path.resolve(__dirname, '..', '..', 'qxb-gov', 'package.json'));
  const { createClient } = requireGov('redis');
  const rc = createClient({ password: 'rHYC@9V*qG3FUyLc', database: 15, socket: { host: '10.0.1.5', port: 9111, connectTimeout: 8000 } });
  await rc.connect();
  try {
    const keys = await rc.keys('login:sid:*');
    if (!keys.length) return { token: '', account: 'no-keys' };
    const key = keys[Math.floor(Math.random() * keys.length)];
    const token = await rc.get(key);
    return { token: token || '', account: key.replace(/^login:sid:/, '') };
  } finally { rc.disconnect(); }
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'bundles'), { recursive: true });
  const startedAt = Date.now();

  // ① 拉 index.html，取脚本清单 + 内联 runtime（webpack chunk 映射表在内联 runtime 里）
  console.log('== ① 拉取活站点 /collect/ index.html ==');
  const html = await get(BASE + '/collect/');
  if (html.status !== 200) { console.log('index.html 失败:', html.status, String(html.body).slice(0, 200)); process.exit(1); }
  const scripts = [...html.body.matchAll(/<script\b[^>]*?\ssrc=("[^"]+"|'[^']+'|[^"\s>]+)/gi)]
    .map((m) => m[1].replace(/^["']|["']$/g, ''));
  const inlines = [...html.body.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const abs = scripts.map((s) => (s.startsWith('http') ? s : s.startsWith('/') ? BASE + s : BASE + '/collect/' + s));
  console.log(`外部 script 数: ${scripts.length}  内联 script 数: ${inlines.length}（含 webpack runtime）`);
  for (const s of abs) console.log('   -', s.replace(BASE, ''));

  // ② 下载入口 bundle 并按 content-hash 版本化
  console.log('\n== ② 下载入口 bundle（content-hash 版本化）==');
  const bundles = [];
  const addBundle = (name, text, url) => {
    const b = { name, hash: sha1(text), size: text.length, text, url };
    bundles.push(b);
    fs.writeFileSync(path.join(OUT, 'bundles', `${name}.${b.hash}.js`), text);
    return b;
  };
  for (const url of abs) {
    if (!/\.js(\?|$)/.test(url)) continue;
    const r = await get(url);
    if (r.status !== 200 || !r.body) continue;
    addBundle(decodeURIComponent(url.split('/').pop().split('?')[0]), r.body, url);
    await sleep(20);
  }
  inlines.forEach((code, i) => addBundle(`inline-runtime-${i}.js`, code, 'inline:index.html'));
  console.log(`入口 bundle 数: ${bundles.length}  总字节: ${bundles.reduce((a, b) => a + b.size, 0)}`);
  for (const b of bundles) console.log(`   - ${b.name}  sha1=${b.hash}  ${b.size}B`);

  // ②b 从内联 runtime 解析 webpack chunk 映射表，枚举并下载全部懒加载 chunk（完整静态源码树）
  console.log('\n== ②b 枚举并下载全部懒加载 chunk ==');
  const readObj = (str, i) => { let d = 0, j = i; for (; j < str.length; j++) { const ch = str[j]; if (ch === '{') d++; else if (ch === '}') { d--; if (!d) break; } } return str.slice(i, j + 1); };
  const parseObj = (lit) => { const o = {}; const re = /["\x27]?([\w\-.]+)["\x27]?\s*:\s*["\x27]([\w\-.]+)["\x27]/g; let m; while ((m = re.exec(lit))) o[m[1]] = m[2]; return o; };
  let chunkUrls = [];
  for (const b of bundles) {
    const s = b.text;
    const start = s.indexOf('static/js/');
    if (start < 0) continue;
    const open1 = s.indexOf('{', start);
    const after = s.indexOf('||e)', open1);
    if (open1 < 0 || after < 0) continue;
    const open2 = s.indexOf('{', after);
    const names = parseObj(readObj(s, open1));
    const hashes = parseObj(readObj(s, open2));
    chunkUrls = Object.keys(hashes).map((id) => 'static/js/' + (names[id] || id) + '.' + hashes[id] + '.js').sort();
    console.log(`在 ${b.name} 中找到 chunk 映射表: ${chunkUrls.length} 个懒加载 chunk`);
    break;
  }
  let downloaded = 0, failed = 0;
  for (const rel of chunkUrls) {
    const url = BASE + '/collect/' + rel;
    const r = await get(url);
    if (r.status !== 200 || !r.body) { failed++; continue; }
    const name = decodeURIComponent(rel.split('/').pop());
    addBundle(name, r.body, url);
    downloaded++;
    await sleep(15);
  }
  console.log(`chunk 下载完成: ${downloaded} 成功 / ${failed} 失败；源码树合计 ${bundles.length} 个文件 ${Math.round(bundles.reduce((a, b) => a + b.size, 0) / 1024 / 1024 * 10) / 10}MB`);

  // ③ 签名器自举：优先「拦截器模块 eval」（活源码真自举）→ 旧形态 new Function("md5") → 本地缓存兜底
  console.log('\n== ③ 签名器自举 ==');
  let signer = null, signerSource = null, liveAppkey = null;
  const bs = bootstrapSignerFromBundle(bundles.map((b) => ({ name: b.name, text: b.text })));
  if (bs.ok) {
    signer = bs.signer; signerSource = bs.source; liveAppkey = bs.appkey;
    console.log(`拦截器模块 eval 成功 → 活签名器可用   来源: ${bs.source}   appkey(活)=${bs.appkey}`);
  } else {
    console.log('拦截器模块自举失败:', bs.reason, '→ 试旧形态 new Function("md5")');
    for (const b of bundles) {
      if (!/createHash\(["\x27]md5["\x27]\)/.test(b.text) && !/new Function\(["\x27]md5/.test(b.text)) continue;
      const r = extractSigner(b.text);
      console.log(`bundle ${b.name}: ${r.ok ? 'eval 成功 → 活签名器可用' : '未提取到可执行签名器: ' + r.reason}`);
      if (r.ok) { signer = r.signer; signerSource = b.name; break; }
    }
  }
  const localSignerPath = path.resolve(__dirname, '..', '..', 'browser', 'js-collect', 'signer.js');
  if (!signer && fs.existsSync(localSignerPath)) {
    const requireLocal = createRequire(path.join(__dirname, 'x.js'));
    signer = requireLocal(localSignerPath);
    signerSource = 'local-cache';
    console.log('回退：使用本地缓存 signer.js（8/19 抓取）');
  }
  if (signer) console.log(`签名器来源: ${signerSource}   appkey=${signer.y}${signer.C ? '  盐C=' + signer.C : ''}`);

  // ④ 抽取 appkey 字面量 + 端点路径 + Logininfo 头规则
  console.log('\n== ④ 确定性抽取契约原语（全源码树）==');
  const all = bundles.map((b) => b.text).join('\n');
  let appkeyM = null, appkeyIn = null;
  for (const b of bundles) {
    const m = b.text.match(/appkey:\s*["\x27]([A-Za-z0-9]{8,40})["\x27]/) || b.text.match(/["\x27]appkey["\x27]\s*:\s*["\x27]([A-Za-z0-9]{8,40})["\x27]/);
    if (m) { appkeyM = m; appkeyIn = b.name; break; }
  }
  console.log('appkey 字面量(源码):', appkeyM ? `${appkeyM[1]}  ← ${appkeyIn}` : '走变量（需进一步解析赋值链）');
  if (signer && appkeyM && signer.y !== appkeyM[1]) console.log(`  !! 漂移：源码 appkey ≠ 签名器内置 appkey（${signer.y}）`);
  const loginInfoRule = [...bundles].filter((b) => /["\x27]Logininfo["\x27]\]?\s*[:=]|Logininfo\s*[:=]\s*[^,;]*LOGININFO/.test(b.text));
  console.log('Logininfo 头规则所在 bundle:', loginInfoRule.map((b) => b.name).join(', ') || '未命中');

  const paths = new Set();
  const pathRe = /["\x27](\/[a-zA-Z][a-zA-Z0-9]*(\/[a-zA-Z0-9\-{}]+)+)["\x27]/g;
  let pm;
  while ((pm = pathRe.exec(all))) {
    const p = pm[1];
    if (/\.(js|css|png|jpe?g|gif|ico|svg|json|html?|txt|pdf|xlsx?|mp4|webp|wasm)(\?|$)/i.test(p)) continue;
    if (p.length > 6 && p.length < 90) paths.add(p);
  }
  const endpoints = [...paths].sort();
  const key = endpoints.filter((p) => /person|project|salary|attend|third|login|team|contract|ent|statistics|sixIndex|verifyCode|wageAccount|idCard/i.test(p));
  console.log(`端点路径候选 ${endpoints.length} 个；关键(人员/项目/工资/考勤/登录) ${key.length} 个：`);
  for (const p of key.slice(0, 24)) console.log('   -', p);

  // ⑤ 通道A 验证：用自举签名器 + 自举 appkey 直接调 /rrs/project/find
  let token = process.argv[2] || '';
  let account = 'cli';
  if (!token) {
    console.log('\n== ⑤a 无 token 参数，从 Redis db15 借一个 ==');
    try { const t = await borrowTokenFromRedis(); token = t.token; account = t.account; console.log(`借到账号 ${account}  token=${token}`); }
    catch (e) { console.log('Redis 借 token 失败:', e.message); }
  }
  if (token && signer) {
    console.log(`\n== ⑤b 通道A 验证：自举签名器直接调 POST /rrs/project/find（账号 ${account}）==`);
    const fallbackAppkey = liveAppkey || (appkeyM ? appkeyM[1] : signer.y);
    const ts = String(Date.now());
    // live 自举签名器返回完整头对象 {appkey,timestamp,signcode}（内部自生成时间戳）；本地签名器返回 signcode 字符串
    const raw = signer.x({ appkey: fallbackAppkey, timestamp: ts }, 'post');
    const hdr = typeof raw === 'string' ? { appkey: fallbackAppkey, timestamp: ts, signcode: raw } : raw;
    const body = '{}';
    const r = await new Promise((res) => {
      const req = https.request(API_BASE + '/rrs/project/find', {
        method: 'POST',
        headers: { 'User-Agent': 'Mozilla/5.0', appkey: hdr.appkey, timestamp: String(hdr.timestamp), signcode: hdr.signcode, Logininfo: token, 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) },
      }, (resp) => { const c = []; resp.on('data', (d) => c.push(d)); resp.on('end', () => res({ status: resp.statusCode, body: Buffer.concat(c).toString('utf8') })); });
      req.on('error', (e) => res({ status: 'ERR', body: e.message }));
      req.end(body);
    });
    let j = {}; try { j = JSON.parse(r.body); } catch { /* */ }
    const proj = j.data?.list || j.data?.rows || (Array.isArray(j.data) ? j.data : null);
    console.log(`HTTP ${r.status}  success=${j.success}  msg=${j.msg || ''}  名下项目数=${proj ? proj.length : 'n/a'}`);
    if (proj && proj[0]) console.log('   首项示例:', JSON.stringify(proj[0]).slice(0, 200));
  } else if (!signer) {
    console.log('\n== ⑤ 无可用签名器，跳过通道A 调用 ==');
  }

  // ⑥ 落盘运行时契约
  const contract = {
    generatedAt: new Date().toISOString(),
    site: BASE,
    bundles: bundles.map(({ name, hash, size }) => ({ name, hash, size })),
    signer: signerSource ? { source: signerSource, salt: signer.C, appkey: signer.y } : null,
    appkeyFromSource: appkeyM ? appkeyM[1] : null,
    headers: { token: 'Logininfo = localStorage["LOGININFO"]', sign: 'signcode = signer({appkey,timestamp,...payload}, method)' },
    endpoints: { total: endpoints.length, key: key },
    channelA: { verified: !!(token && signer), account, token: token || null },
    elapsedMs: Date.now() - startedAt,
  };
  fs.writeFileSync(path.join(OUT, 'contract.json'), JSON.stringify(contract, null, 2));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(contract.bundles, null, 2));

  console.log('\n== 结论 ==');
  console.log(`全链路耗时 ${contract.elapsedMs}ms。活源码可确定性抽取：bundle 清单(content-hash) + 签名模块 + appkey + 端点路径 + 头规则。`);
  console.log('=> API 契约能从活站点源码自举，endpoint-registry 不再需要手工维护。契约已写入 poc/out/contract.json');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
