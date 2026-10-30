# qxb-livesite：黔薪保「活站点实时取数」服务（v2 设计）

> 状态：设计 + PoC 已验证（2026-10-29 全链路跑通）。新项目工作空间，**不改动** `qxb-mcp-service` 既有代码。

## 1. 背景与目标

### 痛点（现状 `qxb-mcp-service`）
1. **固定 API 手工维护**：`endpoint-registry.ts` 约 55 个端点大多停留在 `discovered` 状态；站点前端一改版（路由、签名算法、请求头），整个 MCP 跟着报错。签名算法已在 2026-09-22、2026-10-12 两次变更导致 401，每次都要人工重新对拍。
2. **问题归因困难**：用户报"取数失败"时，分不清是站点变了、token 过期、还是 MCP 自身 bug。
3. **实时性缺口**：纯 API 通道拿不到"页面上有但 API 没暴露/没接"的数据；纯 UI 通道（浏览器点击）又太慢、太脆。

### 目标
- **免维护**：API 契约不再手工写死，从**活站点前端源码**自举；站点发新版（bundle hash 变化）自动重新自举。
- **快**：常规取数走直接 API 调用（毫秒级），不是每次开浏览器。
- **稳**：API 通道失败/未知时，自动降级到浏览器 UI 通道兜底（站点自己怎么点，我们就怎么点，永远"跟得上"）。
- **可归因**：每次失败输出四段诊断（站点源/会话/通道/数据），用户一眼看出是谁的问题。

## 2. 核心命题（v2 架构一句话）

**免扫码起站 → 拉站点源码按 content-hash 版本化缓存 → 确定性抽取 + LLM 补语义生成"运行时契约" → 编排器选通道（A 直调 API / B 点击 UI）→ 同 schema 返回 + 四段诊断归因 + 契约漂移自愈。**

```
┌─────────────┐   ①免扫码    ┌──────────────────────────────────────┐
│ Redis db15  │  login:sid:* │        活站点 ldyg.guizhou.gov.cn    │
└─────────────┘──────────────▶   /collect/（Vue hash 路由）          │
      ②token 探活                └──────────────────────────────────────┘
              │                                   │ ③源码抓取（index.html + 内联 runtime
              ▼                                   │    + 190 懒加载 chunk，content-hash 版本化）
      ┌───────────────┐   ④契约自举   ┌───────────────────────────────────────────┐
      │  源缓存(本地)  │◀──────────────│ 确定性抽取：签名模块eval→appkey/盐/签名    │
      │ bundles/      │              │ 端点路径 361 个 / 头规则 / 后端路由         │
      │ contract.json │   ⑤LLM 补语义 │ LLM：响应结构 / 参数语义 / 需求→端点映射    │
      └───────────────┘              └───────────────────────────────────────────┘
              │
              ▼  ⑥编排器（每次请求）
      ┌───────────────┐     命中契约&通道A健康    ┌────────────────────────┐
      │  用户数据需求  │────────────────────────▶│ 通道A：直调 API（毫秒级）│──┐
      └───────────────┘                          └────────────────────────┘  │
              │ 通道A失败/未命中          ┌────────────────────────┐          │
              └────────────────────────▶│ 通道B：浏览器 UI 点击    │          │
                                        │ （Playwright 持久会话， │          ▼
                                        │  与站点同源，永远兜底）   │   ┌─────────────┐
                                        └────────────────────────┘   │ 统一 schema  │
                                                                      │ +四段诊断   │
                                                                      └─────────────┘
```

## 3. PoC 实测结果（2026-10-29，全链路真实跑通）

`poc/derive-contract.mjs`：`node poc/derive-contract.mjs [token]`（不带 token 时自动从 Redis db15 随机借一个）

| 步骤 | 结果 |
|---|---|
| ① 拉活站点 `/collect/` | 4 个外部 script + **1 个内联 webpack runtime**（chunk 映射表在内联 runtime 里，不在 app 包里） |
| ② 入口 bundle 下载 | 5 文件 4.08MB，全部 content-hash（sha1-12）版本化落盘 `poc/out/bundles/` |
| ②b 懒加载 chunk 枚举 | 解析内联 runtime 的 name/hash 双映射 → **190/190 下载成功**，源码树合计 **195 文件 9MB** |
| ③ 签名器自举 | **拦截器模块（webpack `b775`）整体切出 + 桩依赖 eval 成功** → 活源码直接产出 `appkey=368480924A6C78E2E8681551A7CF4C21` + 签名函数（与本地 8/19 缓存一致，当前无漂移） |
| ④ 契约原语抽取 | 端点路径候选 **361 个**（现有手工 registry 仅 ~55）；关键域 216 个；`Logininfo` 头规则定位到 `app.1d9f0166.js` |
| ⑤ 通道A 验证 | 借 Redis token（账号 gshcyxx）→ 活签名器签 `POST /rrs/project/find` → **HTTP 200 success=1**，返回名下项目 |
| 全链路耗时 | **14.5s**（含 190 chunk 下载；命中缓存后只拉 index.html 比对 hash，<2s） |

### 关键技术事实（源码级）
- **双应用**：screen（登录网关）+ collect（数据端）；免扫码入口 `/collect/#/login/third?info=<token>`（见 `.workbuddy/memory/2026-10-29.md`）。
- **双后端不对称**：主域 `https://ldyg.guizhou.gov.cn/collect-api`（多数接口）+ 跨域 `https://collect-api.gzldyg.com/collect-api`（person 列表/详情/导出、出勤表、third/getUserInfo）；`third/getUserInfo` 主域返回"账号异常"，**只能打跨域**。
- **签名**：请求拦截器（webpack 模块 `b775`，javascript-obfuscator 数组混淆）内联：`signcode = md5((盐 + Σsorted(k+v) + 盐).toUpperCase())`，md5 来自独立模块 `6821f`（标准 MD5，已对拍）；`/lwp/auth/sheBaoKa/QrCode|result` 两端点豁免 `Logininfo` 头。
- **懒加载**：端点分布在 190 个按需 chunk 里——只抓 index.html 引用的 4 个入口 bundle 会漏掉大部分端点（首版 PoC 只抽到 22 个），**必须解析 chunk 映射表枚举全量**（这是 v2 相对"只下入口 JS"的本质优势）。

### 残余风险（诚实评估）
1. **混淆形态漂移**：签名器提取依赖"模块内含 `signcode:""` 锚点 + `KEY:function` 模块边界"两个结构性特征。若站点换打包器/混淆器（webpack→vite、obfuscator 换库），锚点可能失效 → 降级策略：① 用本地缓存契约 + 标记 `stale`；② LLM 读源码重新定位（需一次人工确认）；③ 通道B UI 兜底不断服。
2. **md5 用标准库桩**：站点自带 md5 模块（`6821f`）未整体 eval（其依赖链在 chunk-libs 内），PoC 用 Node 标准 MD5 替代——算法标准、已多次对拍；若要 100% 源码级，可再把 `6821f` 及其依赖一并切出 eval（工作量小，列为后续）。
3. **验证码/反爬**：API 通道目前未见图形验证码；若站点加 WAF/频控，通道B 浏览器会话是天然兜底（真实浏览器指纹）。
4. **content-hash 缓存失效检测**：以 index.html 的 script 清单 hash + 内联 runtime hash 为触发器；站内 chunk 单独变更（入口未变）检测不到——用"周期全量重抓"（如每日）兜底，成本 9MB。
5. **LLM 成本**：只在契约重建/新需求映射时调用（低频），常规取数零 LLM 开销。

## 4. 模块设计（src/ 分层）

| 模块 | 职责 | 状态 |
|---|---|---|
| `config.ts` | 环境变量注入：站点基址、双 API 基址、Redis（token 源）、源缓存目录、LLM 网关、开关 | 骨架 |
| `session/token-source.ts` | 从 Redis `login:sid:*` 借 token + 双后端探活（复用 qxb-mcp-service 已验证逻辑，独立实现不引用其代码） | 骨架 |
| `source/fetcher.ts` | 拉 index.html → 解析 script 清单 + 内联 runtime → 解析 chunk 映射表 → 全量下载 → content-hash 版本化落盘 | PoC 已实现，待工程化 |
| `source/cache.ts` | 源缓存读写 + 失效检测（入口清单 hash / runtime hash / 周期全量） | 骨架 |
| `contract/bootstrap.ts` | 确定性抽取：拦截器模块切出+eval（签名器/appkey）、端点路径、头规则、后端路由 | PoC 已实现，待工程化 |
| `contract/llm.ts` | LLM 补语义：响应结构、参数含义、"需求→端点+参数"映射；产出物写回 `contract.json` | 骨架（可后置） |
| `contract/types.ts` | 运行时契约 schema（bundle 清单/签名器/端点/头规则/语义注解） | 已定（contract.json） |
| `executor/api.ts` | 通道A：按契约直调 API（签名、双后端路由、超时、401 识别） | PoC 已验证 |
| `executor/ui.ts` | 通道B：Playwright 持久上下文，免扫码起站（`/login/third?info=`）+ 点击/抓取 | 已验证可行（browser/_skipsq-third.cjs） |
| `orchestrator.ts` | 每次请求：选通道 → 执行 → 失败降级 A→B → 统一 schema | 骨架 |
| `diagnostics.ts` | 四段诊断归因：S1 站点源（契约 stale？）/ S2 会话（token 过期？）/ S3 通道（API 401？UI 超时？）/ S4 数据（空集？结构变？） | 骨架 |

## 5. 与现有 `qxb-mcp-service` 的关系

- **平行共存**：新项目独立文件夹、独立包名、独立进程；`qxb-mcp-service` 一行不改。
- **可复用（思想级）**：SID 复用、双后端探活、四段归因思路均源自其已验证实践；代码各自独立（避免耦合）。
- **迁移路径（可选，后期）**：v2 稳定后，`qxb-mcp-service` 的 `endpoint-registry` 可替换为 `contract.json` 的加载器，届时再议。

## 6. 待龙哥拍板项

1. **LLM 选型与调用网关**：走 `model.rhzy.ai`（现有 Codex 网关）还是别的？视觉（通道B 截图理解）是否启用？
2. **PoC 数据域范围**：先做到"项目看板 + 人员 + 工资 + 考勤"四个高频域，还是全量 216 个关键端点？
3. **自愈自动化程度**：契约漂移后"LLM 重新定位签名器"是自动生效，还是生成 PR 式报告待人工确认？
4. **并发/实时性预期**：多账号轮换（Redis 32 个 token 池）够用吗？有没有"秒级准实时"的硬需求（影响是否做轮询缓存层）？
5. **对外形态**：先做成 CLI + 本地 MCP，还是直接出 HTTP API？

## 7. 目录结构

```
qxb-livesite/
├── DESIGN.md              # 本文档
├── package.json
├── tsconfig.json
├── .env.example
├── poc/
│   ├── derive-contract.mjs   # 契约自举 PoC（已跑通）
│   ├── _debug-eval.cjs       # b775 模块 eval 独立验证
│   ├── out/                  # PoC 产物：bundles/ contract.json manifest.json
│   └── module-b775-live.js   # 切出的活站点拦截器模块（证据）
└── src/
    ├── config.ts
    ├── index.ts
    ├── session/token-source.ts
    ├── source/fetcher.ts
    ├── source/cache.ts
    ├── contract/types.ts
    ├── contract/bootstrap.ts
    ├── contract/llm.ts
    ├── executor/types.ts
    ├── executor/api.ts
    ├── executor/ui.ts
    ├── orchestrator.ts
    └── diagnostics.ts
```
