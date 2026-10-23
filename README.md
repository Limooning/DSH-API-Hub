<img src="plugin/assets/icon.svg" width="64" height="64" alt="API Hub icon">

# API Hub

一个跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的**本机 API 与技能管理台**：把散落在各个配置文件里的 API 服务商收进一个面板——看余额、改 Key、选模型、测连通、发调试请求；顺便管理 `~/.dsh/skills` 下的技能。

界面是 DSH 侧边栏里的**原生 React 面板**，后端逻辑跑在 **DSH 进程内**、挂在 DSH 自己的 HTTP 服务 `/api-hub` 路由下：不额外开端口、不启子进程、不加载任何网页。

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
- **＋ 添加接口**：填 Base URL 和 Key → 自动探测模型目录 → 勾选模型 → 保存

**技能页**

- 列出 `~/.dsh/skills` 下所有技能（含已停用的）
- **查看** SKILL.md 原文、**启停**（目录在 `skills/` 与 `skills/.disabled/` 之间移动）、**删除**

## 安装

插件以标准 bundle 形式打包（自带 `cordis.patch.yml`），装进 profile 的 bundles 列表即可：

```powershell
# 1) 把包链进 profile（<仓库路径> 换成你的实际路径）
cd ~/.dsh/profiles/desktop
pnpm add link:<仓库路径>/plugin

# 2) 在 profile 的 package.json 里把包名加进 bundles
#    "dsh": { "profile": { "bundles": [ ..., "dsh-api-hub" ] } }

# 3) 重启 DSH 客户端
```

Windows 与 macOS 的步骤一致，只有路径写法不同（`D:\...\plugin` / `/Users/.../plugin`）。代码里没有平台分支，路径都用 `node:path` 拼接，读写位置跟随 `os.homedir()`。

重启后，左侧边栏「插件」下方会出现 **API Hub**，点开就是面板。

**卸载**：从 bundles 里删掉 `dsh-api-hub`，`pnpm remove dsh-api-hub`，重启。

> 本插件不依赖设置页，profile 里 `ui-settings` 开着或关着都不影响它。

### 从打包好的 tarball 安装

不想 clone 仓库也可以直接装包（`plugin/` 是自包含的：后端、示例注册表、图标都在里面）：

```powershell
cd <仓库>/plugin
pnpm pack --pack-destination .            # 生成 dsh-api-hub-0.3.2.tgz
cd ~/.dsh/profiles/desktop
pnpm add <上面 tgz 的绝对路径>
```

首次运行时，后端会在 `~/.dsh/api-hub/` 下自动创建 `providers.json`（从包内的 `providers.example.json` 复制），之后面板的改动都写在这个文件里。

## 配置

### providers.json

面板的注册表，默认在 `~/.dsh/api-hub/providers.json`（**不进版本库**）。首次运行时若文件不存在，会自动从包内的 `plugin/providers.example.json` 复制一份；它只有一个 DeepSeek 官方文本服务商，可以照它改：

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
| 面板添加的接口 | 默认 `~/.dsh/api-hub/keys/<id>.json` 的 `apiKey` |

写入是**就地更新**：`refs` 之外的记录、JSON 的其它字段与缩进风格都保留；值没变时文件逐字节不变。

## 架构

```
DSH 进程
├─ plugin/lib/index.js          宿主半侧
│   ├─ 懒加载 lib/server.mjs 的 handleRequest（文件变更自动重载）
│   ├─ ctx.inject(['webServer']) → register({ kind: 'prefix', path: '/api-hub' })
│   └─ webserver/index-inject   → 注入 window.__API_HUB_ORIGIN__
│
└─ plugin/lib/server.mjs 的 handleRequest()   进程内，无子进程

浏览器页面
└─ plugin/lib/client.js         客户端半侧
    ├─ sidebar.panellist → 侧边栏那一行 + 枢纽图标
    ├─ main              → 点开后的整页
    └─ 后端地址：注入的 origin → 页面 origin → 相对路径，取第一个可用的
```

界面与宿主之间只通过 `/api-hub/api/*` 这层内部 HTTP 传数据（`state`、`test`、`key`、`models`、`balance`、`enabled`、`default`、`request`、`skills` 等）。这层路由由 DSH 自己的服务提供，不监听任何额外端口。

### 为什么入口在侧边栏，而不是设置页

DSH 的设置页导航图标按分区 id **硬编码**，第三方分区一律回退成齿轮，且 `settings.section` 没有 `icon` 字段；而 `sidebar.panellist` 的第二个参数就是图标组件。所以本插件只注册侧边栏席位，不在设置页留一个带齿轮的重复条目。

上游需求已整理成可直接提交的 issue：[`docs/upstream/settings-section-icon.md`](docs/upstream/settings-section-icon.md)。

## 版本与更新

当前版本：**v0.3.2**。每个版本都打 tag，`git tag -n` 可以看到全部。推一个 `v*` tag 后，GitHub Actions 会自动打包并创建 Release（附 `.tgz`）。

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

# 2) 改 plugin/package.json 的 version，然后打 tag
git tag -a v0.2.1 -m "v0.2.1 — 变更说明"

# 3) 推送提交和 tag
git push
git push origin v0.2.1
```

## 开发

不需要构建，改完按下面的方式生效：

| 改什么 | 生效方式 |
|---|---|
| `plugin/lib/server.mjs`（后端） | 宿主按 mtime 自动重新 import，**刷新页面即生效** |
| `plugin/lib/client.js`（界面） | 保存后刷新页面；若没变化，重启 DSH（客户端模块图在启动时确定） |
| `plugin/lib/index.js`（宿主半侧） | 需要重启 DSH |

改完先做语法检查：

```powershell
node --check plugin/lib/server.mjs
node --check plugin/lib/index.js
node --check plugin/lib/client.js
```

想在不碰日常环境的前提下试插件，可以复制一个 profile 出来单独跑：

```powershell
# 复制 desktop profile 为 lab，装好插件后：
dsh --profile lab --port 17899 --no-open
```

## 目录结构

```
plugin/                      整个包，可独立打包安装
  package.json              插件清单：dsh.bundle.patch + dsh.client
  cordis.patch.yml          自带 patch 层，插入 api-hub-plugin 条目
  lib/index.js              宿主半侧：挂路由、注入 origin
  lib/client.js             客户端半侧：侧边栏入口 + 原生面板
  lib/server.mjs            后端：providers / 余额 / 模型 / 技能，全部逻辑
  providers.example.json    注册表示例（只含 DeepSeek 官方），首次运行自动复制
  assets/icon.svg           枢纽标记（纯色，跟随主题）
docs/upstream/              上游需求文档
```

## 已知限制

- **设置页没有入口**：如上所述，图标只能是齿轮，所以只保留侧边栏入口
- **没有配置 schema**：端口、刷新间隔等目前是代码里的常量，未接入 `cordis.patch.yml` 的 `config`
- **密钥没有走 `ctx.credentials`**：`dsh-credentials` 类型是直接读写凭据文件，不是通过服务 API
- **依赖 `webServer` 服务**：拿不到该服务时面板无法工作（不会退化成子进程）

## License

MIT
