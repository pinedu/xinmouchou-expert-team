# LiveSite Bridge — 黔薪保活站点数据桥梁

本 Skill 为薪莫愁专家团（尤其是实时通道接入师 `tong-bida` 和主理人 `xinmouchou-team-lead`）提供与内置活站点编排器的直接交互通道。

本插件为**自包含架构（Self-contained）**，内置执行引擎位于本 Skill 的 `runtime` 目录中。
执行时按以下顺序自适应定位：
1. 本插件内置运行目录：`$PLUGIN_DIR/skills/livesite-bridge/runtime`
2. 用户工作区同级目录：`./xmc-livesite` 或环境变量 `XMC_LIVESITE_DIR`

自适应执行前导命令：
```bash
if [ -d "$PLUGIN_DIR/skills/livesite-bridge/runtime" ]; then
  LIVESITE_DIR="$PLUGIN_DIR/skills/livesite-bridge/runtime"
elif [ -n "$XMC_LIVESITE_DIR" ]; then
  LIVESITE_DIR="$XMC_LIVESITE_DIR"
elif [ -d "./xmc-livesite" ]; then
  LIVESITE_DIR="./xmc-livesite"
else
  LIVESITE_DIR="C:/Users/Administrator/Desktop/黔薪保/qxb-livesite"
fi
```

---

## 一、授权与会话机制（直接沿用 MCP 鉴权）

在每次执行具体的用工合规分析或数据查询之前，专家团引导用户将与 MCP 相同的接入令牌放入对话，调用 MCP 接口完成鉴权与数据范围授权：

### 1. 验证用户提供的 MCP 令牌（首次存入，下次自动沿用）
- **首次使用**：用户将 MCP 令牌（形如 `qat_...`）放入对话后，调用底层进行校验并自动持久化写入本地配置：
```bash
LIVESITE_DIR="${XMC_LIVESITE_DIR:-./xmc-livesite}"
cd "$LIVESITE_DIR" && MSYS_NO_PATHCONV=1 npx tsx src/index.ts auth <用户提供的MCP令牌>
```
- **复访使用（免重复提供）**：系统自动从本地持久化记忆中读取该令牌发起鉴权：
```bash
LIVESITE_DIR="${XMC_LIVESITE_DIR:-./xmc-livesite}"
cd "$LIVESITE_DIR" && MSYS_NO_PATHCONV=1 npx tsx src/index.ts auth
```
- **输出回执**：
  - `authorized: true`
  - `tokenMasked`: 脱敏令牌
  - `ownedProjectCount`: 该用户被授权的项目数量
  - `projects`: 已授权项目清单（名称与 ID）
  - `apiProbes`: 主/跨双后端 API 连通性状态

### 2. 租户隔离与越权拦截
获取到授权项目列表后，系统在执行具体业务查询时严格限制只能访问 `projects` 清单内的项目，严禁越权查询未授权项目。

### 3. 异常自愈闭环：若无有效 Token 或授权失效
如果 `auth` 报告 `"authorized": false` 或用户需要重新绑定账号，主理人将立即唤起前台扫码登录与自愈流程：
```bash
LIVESITE_DIR="${XMC_LIVESITE_DIR:-./xmc-livesite}"
cd "$LIVESITE_DIR" && MSYS_NO_PATHCONV=1 npx tsx src/index.ts interactive-login
```
- **工作机制**：
  1. 弹出内部真实 Chrome 浏览器，直接定位到项目端扫码网关（`/screen/#/login?tag=2`）；
  2. 提示用户使用微信/电子社保卡扫码；
  3. 用户扫码完成并确认后，系统自动捕获最新产生的 `token` 与关联账号 `account`；
  4. 自动持久化保存到本地档案，无需连接任何外部数据库；
  5. 链路无缝切换回已授权状态，直接推进后续分析！

---

## 二、使用前用户交互选择（必须主动询问）

获取到有效授权后，主理人必须向用户明确展示当前已授权账号及项目，并**主动询问用户希望以哪种方式执行本次专家团任务**：

- **方式一（推荐：后台无感极速分析 / 通道A为主）**：
  直接在后台通过直调 API 高速获取全量数据（毫秒级响应），通道异常时自动静默降级为后台浏览器兜底，不打扰用户当前桌面。
- **方式二（可视沉浸模式 / 内部浏览器免扫码自动登录）**：
  自动在前台唤起本地真实 Chrome 浏览器，携带实时令牌免扫码自动登录进入项目看板（`#/dashboard` 或相关页面），用户可直观看到网页跳转和图表，专家团同步进行数据采集与报告生成。

---

## 三、两种方式的执行命令

### 方式一：后台极速数据探针（Probe 命令）
```bash
LIVESITE_DIR="${XMC_LIVESITE_DIR:-./xmc-livesite}"
cd "$LIVESITE_DIR" && MSYS_NO_PATHCONV=1 npx tsx src/index.ts probe <端点路径> [projectId]
```
常用业务端点：
- `/rrs/project/find`：项目基础信息（加 projectId 精准锁定专属账号）
- `/rrs/person/list`：实名制人员列表（自动跨域）
- `/attend/list`：打卡考勤流水
- `/rrs/salary/list`：月度工资发放批次

### 方式二：前台内部浏览器免扫码自动登录（Launch Browser）
```bash
LIVESITE_DIR="${XMC_LIVESITE_DIR:-./xmc-livesite}"
cd "$LIVESITE_DIR" && MSYS_NO_PATHCONV=1 npx tsx src/index.ts launch-browser [目标路由，如 #/dashboard 或 #/person]
```
前台浏览器启动后，自动跳过扫码进入系统并保持打开状态。

---

## 四、Word 文档规范与生成命令

分析报告在对话呈现的同时，最终必须生成一份标准 Word 文档交付给用户：

### Word 规范排版标准：
- **一级大标题**：宋体、二号（22pt）、黑色字体（居中加粗）
- **二级标题**：黑体、三号（16pt）、黑色字体（加粗）
- **正文段落**：仿宋、三号（16pt）、黑色字体（首行缩进 2 字符即 32pt，行距 1.3 倍）

### 编译生成脚本：
```bash
python3 "C:/Users/Administrator/Desktop/黔薪保/qxb-livesite/src/report/export-word.py" <markdown报告路径> <输出docx文档路径>
```
生成后通过 `present_files` 提供给用户卡片展示与直接下载。
