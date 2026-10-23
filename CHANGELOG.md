# Changelog

本文件记录用户可见的变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
每个版本都打了 tag，可用 `git show v0.4.0` 查看当时的完整代码。

## 0.6.2

**目标：类型看得到，跟着勾选的模型走。**

- **接口类型只显示，不能手选**：添加接口对话框里原来那个 文本/图片 下拉框换成一行只读的「类型」——它由当前勾选的模型算出来，取消勾选几个模型它就跟着变（例如把图片模型全取消，`文本 · 图片/视频` 就变回 `文本`）
- **每个模型标出全部能力**：模型行右侧的标签写全，`文本` / `视觉` / `图片` / `视频` / `语音` / `向量`；多模态模型算两种能力，显示 `文本 · 视觉`（`gpt-4o`、`qwen-vl-*`、`glm-4v`、`claude-3*`、`gemini-*`、`llava`、`pixtral` 等）
- 卡片标签是这些能力的并集：`文本`、`视觉`、`图片/视频`、`文本 · 视觉 · 图片/视频`；provider 上新增 `types`（展示用）与 `kinds`（首个决定默认位）
- **全选 / 取消全选**：模型列表顶部给出「从 /models 找到 N 个模型 · 已选 M」和两个批量按钮；取消全选会一并清掉选中的默认模型
- 只按勾选的模型判断：`/api/providers/add`、`/api/models` 保存后都只用 `selected` 里的模型重算类型，探测到的其余模型不参与
- 平票按文本处理（图片/视频模型数严格多于对话模型才判 `image`），避免带一两个生图模型的聊天中转被整体当成生图接口

## 0.6.1

**目标：类型不用手选。**

- **按模型名自动判断接口类型**：探测到模型列表后，服务端按名字分票（`gpt-image-*`、`dall-e-*`、`flux*`、`sd*`、`qwen-image*`、`seedream*`、`sora`、`kling`、`veo` 等算图片/视频，`embedding` / `rerank` / `tts` 这类不算对话），图片/视频模型不少于对话模型就判 `image`，否则 `llm`；添加接口时下拉框自动跟着变，旁边显示依据（`自动判断 · 3 个图片/视频模型，0 个对话模型`）
- 手动改过类型就以手动的为准（provider 上记 `kindSource: 'manual'`）；没手动改过的（`auto`）在「重新拉取」模型后若名字指向另一种类型会自动纠正，原来的默认位一并让出
- 检索导入、`POST /api/providers/add`、`POST /api/models` 三处用同一套判断，`GET /api/models` 会把 `{ kind, source, guessed, reason }` 一起返回，模型对话框顶部显示「类型：图片/视频 · 按模型名自动判断（…）」
- 老数据里没有 `kindSource` 的接口按手动处理，不会被悄悄改类型
- 新增单测：图片端点、对话端点、混合中转（1 图片 + 2 对话 + 1 embedding 仍判文本）、空列表

## 0.6.0

**目标：能接入并真正用得上的接口和技能，都收进来。**

- **能真正调通才允许导入**：检索里每一条候选都会先拿它的 Key 打一次 `/models`（含 `/v1/models`、`/catalog/models` 兜底），2xx 才算通；调不通的行显示红色原因（`Key 被接口拒绝（HTTP 401）`、`Base URL 不对：…`、`连不上`）且「导入」按钮不可点；服务端在写入前会再验一次，绕过界面也写不进去
- 调通后导入的接口顺带把这次探测到的模型列表写进缓存，卡片一进来就有模型可选
- 检测失败的行有「重试」；改 Base URL 后 400ms 自动重测
- **配置文件格式放宽**：除 `.json` 外还认 `.toml` 与 `.env` / `*.env`（以前只在 `.json` 里找 Key）；导入后每次读 Key 都走同一个解析器，TOML / `.env` 里存的 Key 导入后仍然可用
- **`.toml` / `.env` 只读**：面板不会把 JSON 写回这些文件（会毁掉注释与格式），改 Key 时直接提示「请改原文件」
- **技能来源**：默认只看 DSH 自己的 `~/.dsh/skills`（本就是面板在管的目录）；别的 agent 的技能目录改为手动添加一次（`~/.codex/skills`、`~/.claude/skills`、`~/.cc-switch/skills` 等），`SKILL.md` 顶部有 `name` / `description` 就能「复制到 DSH」，列表里标出来自哪个目录；`.system` / `.disabled` 这类隐藏目录跳过
- **鉴权头按实际结果定**：`Authorization: Bearer` 被 401/403 拒掉时改试 `x-api-key` / `api-key`，能通的把写法记在 provider 的 `auth` 上，之后 `/api/test`、余额、模型、请求接口都照它发；原来只会发 Bearer，碰到这类中转一律被当成 Key 无效
- **协议不兼容要说清楚**：Anthropic 原生（`/v1/messages`）与 Gemini 原生（`models?key=`）能验证 Key 有效，但会明确告知「面板只调 OpenAI 兼容接口，未导入」，而不是假装导入成功
- **同一把 Key 只列一行**：Hash 后按值去重，优先保留路径最短的那份（正式配置优先于技能目录或项目里的副本）；已经导入过的 Key 即使又出现在别的文件里也不再重复推荐
- 模板文件（`.env.example`、`*.sample`、`*.template`、`*.dist`）按占位符处理，不进候选
- 删掉写死的厂商配置文件名（`jws-image/config.json`、`88api-image-gen-config.json`）：这些文件现在由通用目录扫描按字段自动发现，不再靠名字匹配
- 检索改为两层来源：**默认只扫 DSH 自己的目录**（`~/.dsh`：凭据库、技能目录、DSH 自己写的配置）+ **用户手动添加的位置**（`~/.dsh/api-hub/scan-sources.json`）；放在别处的配置文件与技能目录用「添加扫描位置」填路径
- 目录扫描遍历 `~/.dsh`，深度 4，识别 `apiKey` / `api_key` / `*_API_KEY` / `token` / `authorization` 等字段；`node_modules`、缓存、会话记录、本面板自己的 `keys/` 跳过
- 检索对话框里的「扫描范围」默认折叠成一行（`自动扫描 ~/.dsh · 已手动导入 N 处` + 「手动导入」按钮），点开才显示扫描说明、已添加的位置与添加表单——展开这一栏的目的就是手动导入接口和技能
- 字段同级或上层带 URL（`baseUrl` / `endpoint` / `host` 等）时自动作为 Base URL；没有 URL 时先按字段名（`DASHSCOPE_API_KEY` → 百炼）再按文件路径推断服务商
- 检索结果新增「其它配置文件」分组；导入只记录文件路径与字段路径，Key 仍留在原文件
- 修正：`token` 这类过于宽泛的字段在没有 URL 时不再当成接口候选
- 技能必须是 DSH 格式：`SKILL.md` 顶部 `name` / `description` 缺一不可，导入接口会直接拒绝，列表里按「已跳过 N 个」提示
- 测试：冒烟用例新增 TOML / `.env` 扫描 → 导入 → 真实调用 → 去重 → 只读拒绝的整条链路

## 0.5.1

- 检索对话框改成四组：已管理、未导入的 Key、其它工具的配置文件、Codex `model_providers`
- 新增对已知第三方配置文件的扫描：`~/.config/jws-image/config.json`、`~/.codex/88api-image-gen-config.json`（导入后仍读原文件，不复制 Key）
- 新增对 `~/.codex/config.toml` 里 `[model_providers.*]` 的识别（`base_url` / `env_key`）
- 已在 `providers.json` 里的接口现在会显示在「已管理」组，不再看起来像“只找到了一个”
## 0.5.0

- 新增「检索」：扫描 DSH 凭据库、环境变量里的 API Key，以及 Codex / Claude / agents 的技能目录
- 识别到的凭据按已知服务商（DeepSeek、OpenAI、百炼、Moonshot、SiliconFlow、OpenRouter、Groq、Gemini）预填 Base URL，一键导入为接口
- 其它 agent 工具的技能可一键复制到 `~/.dsh/skills`（重名会拒绝，路径限定在已知目录内）
- 新增 `keySource.type = "env"`：接口可以直接引用环境变量，Key 不落盘
## 0.4.4

- 「接口」标签显示启用数 / 总数，与「技能」标签一致
- 面板标题下移，与标签栏之间的留白更舒展
## 0.4.3

- 拖拽排序改用落点两侧的竖向高亮：被拖到目标卡片左/右半区时，目标卡和相邻卡相对的那条边同时亮蓝边
- 顶部标题与「接口 / 技能」标签栏左边距对齐到卡片网格（22px）
## 0.4.2

已发布到 npm：`dsh-api-hub@0.4.2`。

- 安装方式简化为一条命令：`dsh plugin --profile desktop add dsh-api-hub`（CLI 会自动登记 bundles）
- 新增 `docs/publish.md`：npm 发布、打 tag、上架插件市场、撤版办法
## 0.4.1

- 增加自动化：`npm test`（冒烟测试）、GitHub Actions 在 Windows / macOS / Linux × Node 20/22 上跑语法检查与测试
- 补充包元数据：`repository`、`homepage`、`bugs`、`engines`、`publishConfig`
- 新增 `CHANGELOG.md`、`SECURITY.md`、`.editorconfig`、issue 模板

## 0.4.0

**破坏性变更**：仓库根目录就是包。

- `package.json`、`cordis.patch.yml`、`lib/`、`assets/`、`providers.example.json` 从 `plugin/` 移到仓库根
- `link:` 安装路径从 `<仓库>/plugin` 改为 `<仓库>`
- 发布流程改为在仓库根执行 `npm pack`

## 0.3.4

- 连不上面板时给出可操作的原因：区分 `HTTP 404/401`（路由没挂）、超时、以及被浏览器拦截的跨域请求
- 空状态提示直接指出两个常见原因：bundle 没注册、装的是旧版

## 0.3.3

- 浏览器（Web 模式）改为同源优先，远程访问时不再去连查看者自己的回环地址
- 规范化通配绑定地址：`0.0.0.0` → `127.0.0.1`，`[::]` → `[::1]`
- 补 `Access-Control-Allow-Private-Network`，避免 Chromium 私有网络预检拦截

## 0.3.2

- `@deepseek-ai/cordis` 改为可选 peer，离线从 tarball 安装不再需要访问 registry

## 0.3.1

- 引入发行工作流：推送 `v*` tag 时自动打包并创建 Release（附 `.tgz`）

## 0.3.0

- 后端移入包内（`lib/server.mjs`），示例注册表一并入包，`npm pack` 产物自包含
- 运行时数据固定为 `~/.dsh/api-hub`，首次运行自动从示例播种 `providers.json`

## 0.2.0

- 原生面板：侧边栏入口（`sidebar.panellist`）+ 主区页面（`main`），去掉 iframe 与独立网页
- 移除设置页席位（DSH 的设置导航图标按 id 硬编码，第三方只能是齿轮）
- 增补：启用开关、默认切换、拖拽排序、余额徽章、技能管理
