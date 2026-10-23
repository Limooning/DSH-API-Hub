# Changelog

本文件记录用户可见的变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
每个版本都打了 tag，可用 `git show v0.4.0` 查看当时的完整代码。

## 0.4.2

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
