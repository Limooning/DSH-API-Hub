<img src="assets/icon.svg" width="64" height="64" alt="API Hub icon">

# API Hub

[![npm](https://img.shields.io/npm/v/dsh-api-hub.svg)](https://www.npmjs.com/package/dsh-api-hub)
[![CI](https://github.com/Limooning/DSH-API-Hub/actions/workflows/ci.yml/badge.svg)](https://github.com/Limooning/DSH-API-Hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的**本机 API 与技能管理台**：把散落在各个配置文件里的 API 服务商收进一个面板——看余额、改 Key、选模型、测连通、发调试请求；顺便管理 `~/.dsh/skills` 下的技能。

界面是 DSH 侧边栏里的**原生 React 面板**，后端逻辑跑在 **DSH 进程内**、挂在 DSH 自己的 HTTP 服务 `/api-hub` 路由下：不额外开端口、不启子进程、不加载任何网页。

![API Hub 面板](docs/screenshot.png)

## 功能

**接口页**

- 服务商卡片：名称、类型、端点、Key 掩码、默认模型、**余额徽章**、连通状态点
- **启用 / 停用**：开关切换；停用只淡化卡片正文，标题和开关保持清晰
- **测试连接**：用真实 Key 请求一次模型目录，显示状态码 / 耗时 / 模型数
- **查余额**：按 `balance` 配置查询；没有余额接口的服务商显示 `—`（不编造数字）
- **改 Key**：写回该服务商原来的配置文件（就地更新，保留其它字段）
- **模型**：拉取模型目录、勾选允许的模型、单选默认模型
- **默认**：点一下设为默认，再点一下取消；默认服务商用蓝色标出
- **请求**：GET/POST + JSON 请求体，带 Key 直发，显示状态码、耗时、响应体
- **移除**：确认后移出面板；面板自己管理的 Key 文件会一并删除
- **拖拽排序**：拖动卡片调整顺序，写回 `providers.json` 的数组顺序
- **＋ 添加接口**：填 Base URL 和 Key → 自动探测模型目录 → 每个模型旁标出类型（文本 / 图片 / 视频 / 语音 / 向量）→ 自动判断接口类型（可多选：纯聊天、纯生图，或两种都做）→ 全选 / 取消全选后保存
- **检索本机**：只列出本机已有、面板里还没有的接口与技能。自动扫描只覆盖 DSH 自己的目录，剩下的靠手动添加——
  - **凭据与环境变量**：`~/.dsh/.credentials.yaml` 的 `refs`、进程环境里的 `*_API_KEY` / `*_KEY`；
  - **配置文件**：`~/.dsh` 下的 `.json`、`.toml`、`.env`（深度 4），识别 `apiKey` / `api_key` / `*_API_KEY` / `token` 字段，取同级最近的 URL 作为 Base URL，没有 URL 时按字段名或文件名推断厂商；`.example` / `.sample` / `.template` 这类模板文件跳过；
  - **技能**：DSH 自己的 `~/.dsh/skills`（面板已管理，通常没有新候选）；别的 agent 的技能目录用「添加扫描位置」加一次即可，只要 `SKILL.md` 顶部有 `name` / `description` 就能「复制到 DSH」；`.system` / `.disabled` 这类隐藏目录跳过。

  没有写死任何厂商的文件名：DSH 自己的目录自动识别，放在别处（D 盘、其它工具目录）的用「添加扫描位置」指定路径。Key 留在原文件，导入只记录路径与字段（`.toml` / `.env` 只读不写，改 Key 请直接改原文件）。同一个 Key 写在几个文件里只列一行。「扫描范围」默认折叠成一行，点「展开」才出现说明与添加表单。
- **调通才允许导入**：每一行都会拿它的 Key 真的打一次接口，2xx 才点亮「导入」，调不通的行直接显示原因（`Key 被接口拒绝（HTTP 401）`、`Base URL 不对：…`、`连不上`），服务端写入前还会再验一次。鉴权头同样按实际结果定：`Authorization: Bearer` 被 401/403 拒掉时会改试 `x-api-key` / `api-key`，能通的把这种写法记在 provider 上，之后的测试与请求都照它发。Anthropic 原生（`/v1/messages`）与 Gemini 原生（`models?key=`）协议会被明确告知「面板只调 OpenAI 兼容接口」，而不是假装导入成功。

**技能页**

- 列出 `~/.dsh/skills` 下所有技能（含已停用的）
- **查看** SKILL.md 原文、**启停**（目录在 `skills/` 与 `skills/.disabled/` 之间移动）、**删除**

## 安装

一条命令即可：`dsh plugin` 会把包装进 profile，并**自动把包名登记到 `dsh.profile.bundles`**。

```powershell
# 从 npm（推荐）
dsh plugin --profile desktop add dsh-api-hub

# 从本地 tarball（Release 附件）
dsh plugin --profile desktop add C:\path\dsh-api-hub-0.6.1.tgz

# 从源码（开发态，改动即时生效）
dsh plugin --profile desktop add link:C:\path\to\DSH-API-Hub
```

`--profile` 换成你要装的 profile（`desktop` 是桌面端默认的）。装完**重启 DSH**，左侧边栏「插件」下方会出现 **API Hub**。

Windows 与 macOS 命令一致，只有路径写法不同。代码里没有平台分支，路径都用 `node:path` 拼接，读写位置跟随 `os.homedir()`。

**卸载**：

```powershell
dsh plugin --profile desktop remove dsh-api-hub
# 再从 profile 的 dsh.profile.bundles 里删掉 "dsh-api-hub"，重启
```

> 本插件不依赖设置页，profile 里 `ui-settings` 开着或关着都不影响它。

### 手动安装（不用 CLI）

```powershell
cd ~/.dsh/profiles/desktop
pnpm add link:<仓库路径>        # 或 pnpm add <tgz 路径>
# 再把 "dsh-api-hub" 加进该 profile package.json 的 dsh.profile.bundles
# 重启 DSH
```

首次运行时，后端会在 `~/.dsh/api-hub/` 下自动创建 `providers.json`（从包内的 `providers.example.json` 复制），之后面板的改动都写在这个文件里。

## 配置

### providers.json

面板的注册表，默认在 `~/.dsh/api-hub/providers.json`（**不进版本库**）。首次运行时若文件不存在，会自动从包内的 `providers.example.json` 复制一份；它只有一个 DeepSeek 官方文本服务商，可以照它改：

```jsonc
{
  "defaults": { "llm": "deepseek-api", "image": null },
  "providers": [
    {
      "id": "deepseek-api",
      "name": "DeepSeek 官方",
      "kind": "llm",                          // llm | image
      "tag": "文本",
      "enabled": true,
      "baseURL": "https://api.deepseek.com",
      "protocol": "OpenAI Responses",         // 仅展示用
      "keySource": { "type": "dsh-credentials", "ref": "DEEPSEEK_API_KEY" },
      "test": { "method": "GET", "path": "/models" },
      "defaultModel": "deepseek-flash",
      "balance": {
        "method": "GET",
        "path": "/user/balance",
        "extract": ["balance_infos", 0, "total_balance"],
        "currency": "CNY",
        "label": "账户余额"
      }
    }
  ]
}
```

可选字段：

| 字段 | 含义 |
|---|---|
| `enabled` | 是否启用；缺省视为启用 |
| `selectedModels` | 允许调用的模型 id 数组；不写 = 全部 |
| `defaultModel` | 默认模型，必须在 `selectedModels` 里 |
| `balance` | 余额查询：`extract` 是从响应 JSON 取值的路径 |
| `modelsCache` | 面板拉取模型后的缓存（自动写入） |

### Key 存哪里

由 `keySource.type` 决定，面板只负责读写：

| 类型 | 位置 |
|---|---|
| `dsh-credentials` | DSH 凭据库 `~/.dsh/.credentials.yaml` 的 `refs.<ref>` |
| `json` | 任意 JSON 文件的某个字段（`path` + `jsonPath`） |
| `env` | 环境变量名（`name`），适合从 shell 里传 Key 的场景 |
| 面板添加的接口 | 默认 `~/.dsh/api-hub/keys/<id>.json` 的 `apiKey` |

写入是**就地更新**：`refs` 之外的记录、JSON 的其它字段与缩进风格都保留；值没变时文件逐字节不变。

## 架构

```
DSH 进程
├─ lib/index.js                 宿主半侧
│   ├─ 懒加载 lib/server.mjs 的 handleRequest（文件变更自动重载）
│   ├─ ctx.inject(['webServer']) → register({ kind: 'prefix', path: '/api-hub' })
│   └─ webserver/index-inject   → 注入 window.__API_HUB_ORIGIN__
│
└─ lib/server.mjs 的 handleRequest()   进程内，无子进程

渲染进程（Electron 里跑 React 的那一层，等同于 DSH 自己的界面）
└─ lib/client.js                客户端半侧
    ├─ sidebar.panellist → 侧边栏那一行 + 枢纽图标
    ├─ main              → 点开后的整页
    └─ 后端地址：同源（http 页面）→ 注入的 origin → 相对路径，取第一个可用的
```

界面与宿主之间只通过 `/api-hub/api/*` 这层内部 HTTP 传数据（`state`、`test`、`key`、`models`、`balance`、`enabled`、`default`、`request`、`skills` 等）。这层路由由 DSH 自己的服务提供，不监听任何额外端口。

> `package.json` 里的 `dsh.client.platform: "web"` 是 **DSH 对客户端插件的称呼**，指“跑在渲染进程/Web 运行时里”，不是“这是一个网页”。dshmarket 也是同一个值。插件没有 iframe、没有独立页面、不加载任何 URL。

### 为什么入口在侧边栏，而不是设置页

DSH 的设置页导航图标按分区 id **硬编码**，第三方分区一律回退成齿轮，且 `settings.section` 没有 `icon` 字段；而 `sidebar.panellist` 的第二个参数就是图标组件。所以本插件只注册侧边栏席位，不在设置页留一个带齿轮的重复条目。

上游需求已整理成可直接提交的 issue：[`docs/upstream/settings-section-icon.md`](docs/upstream/settings-section-icon.md)。

## 版本与更新

当前版本：**v0.6.1**。每个版本都打 tag，`git tag -n` 可以看到全部。推一个 `v*` tag 后，GitHub Actions 会自动打包并创建 Release（附 `.tgz`）。

```powershell
# 更新到最新
cd ~/.dsh/api-hub
git pull --ff-only

# 查看有哪些版本 / 某个版本改了什么
git tag -n
git show v0.2.0 --stat
```

想临时跑某个旧版本，用 `worktree` 开一个并行副本，不影响正在用的那份：

```powershell
git worktree add ../api-hub-v0.2.0 v0.2.0
# 把 profile 里的 link 指向 ../api-hub-v0.2.0/plugin，重启 DSH
git worktree remove ../api-hub-v0.2.0    # 用完清理
```

发布新版本的流程（仓库公开后**不要 force push**）：

```powershell
# 1) 改代码、正常提交
git commit -am "feat: ..."

# 2) 改 package.json 的 version，然后打 tag
git tag -a v0.2.1 -m "v0.2.1 — 变更说明"

# 3) 推送提交和 tag
git push
git push origin v0.2.1
```

## 开发

不需要构建，改完按下面的方式生效：

| 改什么 | 生效方式 |
|---|---|
| `lib/server.mjs`（后端） | 宿主按 mtime 自动重新 import，**刷新页面即生效** |
| `lib/client.js`（界面） | 保存后刷新页面；若没变化，重启 DSH（客户端模块图在启动时确定） |
| `lib/index.js`（宿主半侧） | 需要重启 DSH |

改完先做语法检查，再跑冒烟测试：

```powershell
node --check lib/server.mjs
node --check lib/index.js
node --check lib/client.js
npm test          # 用临时 HOME 跑后端：播种、健康检查、404、技能空目录
```

测试不会碰你的 `~/.dsh/api-hub/providers.json`——每个用例在子进程里用一次性 HOME 运行。

CI 在 Windows / macOS / Linux × Node 20/22 上跑同一套检查（`.github/workflows/ci.yml`）。

想在不碰日常环境的前提下试插件，可以复制一个 profile 出来单独跑：

```powershell
# 复制 desktop profile 为 lab，装好插件后：
dsh --profile lab --port 17899 --no-open
```

## 相关文档

- [故障排查](docs/troubleshooting.md) — 面板连不上、侧边栏没入口、安装报错
- [变更记录](CHANGELOG.md)
- [安全说明](SECURITY.md) — 回环/鉴权的取舍，如何私下报告问题
- [发布指引](docs/publish.md) — npm 发布与版本流程（维护者用）
- [上架材料](docs/market-entry.md) — 插件市场 PR 的条目内容与要求
- [上游需求](docs/upstream/settings-section-icon.md) — 让设置分区支持自定义图标

## 目录结构

仓库根目录就是 npm 包，`pnpm add link:<仓库路径>` 直接可用：

```
package.json                插件清单：dsh.bundle.patch + dsh.client
cordis.patch.yml            自带 patch 层，插入 api-hub-plugin 条目
lib/index.js                宿主半侧：挂路由、注入 origin
lib/client.js               客户端半侧：侧边栏入口 + 原生面板
lib/server.mjs              后端：providers / 余额 / 模型 / 技能，全部逻辑
providers.example.json      注册表示例（只含 DeepSeek 官方），首次运行自动复制
assets/icon.svg             枢纽标记（纯色，跟随主题）
docs/upstream/              上游需求文档
.github/workflows/          打 tag 时自动打包并发布 Release
```

运行时数据不在仓库里：`providers.json`、`keys/` 都被 `.gitignore` 挡住。

## 已知限制

- **设置页没有入口**：如上所述，图标只能是齿轮，所以只保留侧边栏入口
- **没有配置 schema**：端口、刷新间隔等目前是代码里的常量，未接入 `cordis.patch.yml` 的 `config`
- **密钥没有走 `ctx.credentials`**：`dsh-credentials` 类型是直接读写凭据文件，不是通过服务 API
- **依赖 `webServer` 服务**：拿不到该服务时面板无法工作（不会退化成子进程）
- **本地回环、无鉴权**：面板只挂在 DSH 的 `127.0.0.1` 上，外部机器连不上；但同一浏览器里的网页可以读取 `/api-hub/api/*` 的响应（CORS 通配）。所以不要为了远程访问把 DSH 绑定到 `0.0.0.0` 后暴露在不可信网络里——那种场景需要额外的 token 校验，目前没有
- **只在 Windows 上实测过**：代码无平台分支，macOS 未验证

遇到“面板打不开 / 显示找不到面板服务”，见 [故障排查](docs/troubleshooting.md)。

## License

MIT
