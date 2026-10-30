// 快速验证：从已下载的活 bundle 里 eval b775 拦截器模块
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

const dir = path.join(__dirname, 'out', 'bundles');
const appText = fs.readFileSync(path.join(dir, 'app.1d9f0166.js.8829a3a28f8b.js'), 'utf8');

const anchor = appText.indexOf('signcode:""');
console.log('anchor:', anchor);
const before = appText.slice(0, anchor);
const keys = [...before.matchAll(/(?:^|[,;})])([0-9a-f]{4,6}|[a-zA-Z_$][\w$]*)\s*:\s*function/g)];
const m = keys[keys.length - 1];
console.log('module key:', m[1], '@', m.index);
const fnStart = m.index + m[0].lastIndexOf('function');
const braceStart = appText.indexOf('{', fnStart);
let d = 0, j = braceStart;
for (; j < appText.length; j++) { const ch = appText[j]; if (ch === '{') d++; else if (ch === '}') { d--; if (!d) break; } }
const fnText = appText.slice(fnStart, j + 1);
console.log('fnText head:', JSON.stringify(fnText.slice(0, 80)), 'len:', fnText.length);

let reqInterceptor = null;
const axiosInstance = { interceptors: { request: { use: (fn) => { reqInterceptor = fn; } }, response: { use: () => {} } }, get() {}, post() {} };
const requireStub = (id) => {
  switch (id) {
    case '5530': return { a: Object.assign };
    case '53ca': return { a: (x) => typeof x };
    case 'bc3a': return { create: () => axiosInstance };
    case '5c96': return { Loading: { service: () => ({ close() {} }) }, Message: () => {} };
    case '4328': return { a: { stringify: (o) => JSON.stringify(o) } };
    case 'b85c': return { a: (o) => o[Symbol.iterator]() };
    case '6821f': return md5;
    default: return {};
  }
};
requireStub.n = (mod) => { const f = () => mod; Object.defineProperty(f, 'a', { get: () => mod }); return f; };
requireStub.d = (exportsObj, k, getter) => { Object.defineProperty(exportsObj, k, { get: getter, enumerable: true }); };

try {
  const factory = new Function('return (' + fnText + ')')();
  factory({}, {}, requireStub);
  console.log('EVAL OK');
  globalThis.localStorage = { _s: { LOGININFO: 'test-token' }, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
  const probe = reqInterceptor({ method: 'post', data: {} });
  console.log('headers:', JSON.stringify(probe.headers));
  // 对拍：payload 参与签名
  const probe2 = reqInterceptor({ method: 'post', data: { projectId: 'abc123', pageNum: 1 }, headers: {} });
  console.log('with payload signcode:', probe2.headers.signcode);
} catch (e) {
  console.log('EVAL FAIL:', e.message);
  console.log(e.stack.split('\n').slice(0, 4).join('\n'));
}
