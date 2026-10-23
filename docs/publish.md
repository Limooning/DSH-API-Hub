# 发布指引

面向维护者。目标：发一个版本 → 别人能一键装 → 出现在插件市场。

## 0. 前置

- npm 账号（有 2FA 的话手边要有验证器）
- 本机需要能访问 `registry.npmjs.org`；如果被阻断，在能上网的机器上执行发布，或先 `npm login` 后把仓库同步过去

## 1. 发布前检查

```powershell
cd <仓库>

# 1) 语法 + 冒烟测试
node --check lib/server.mjs
node --check lib/index.js
node --check lib/client.js
npm test

# 2) 打包内容（确认 test/、docs/ 没被打进去）
npm pack --dry-run
```

预期打包内容只有：

```
assets/icon.svg  cordis.patch.yml  lib/client.js
lib/index.js     lib/server.mjs    providers.example.json
LICENSE          package.json      README.md
```

## 2. 升版本

遵循语义化版本：

| 改动 | 版本 |
|---|---|
| 修 bug、改文案 | patch（0.4.x） |
| 加功能、不破坏兼容 | minor（0.5.0） |
| 目录结构、安装方式、配置格式变更 | major（1.0.0） |

同时更新三处：

1. `package.json` 的 `version`
2. `README.md` 的「当前版本」和 tarball 文件名示例
3. `CHANGELOG.md` 顶部加一节

## 3. 发布到 npm

```powershell
npm login                      # 只需一次
npm publish                    # package.json 里已有 publishConfig.access = public
```

> PowerShell 里如果报「禁止运行脚本」，用 `npm.cmd` 代替 `npm`，或一次性放开：
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### 发布时会要求浏览器确认（EOTP）

npm 现在要求每次发布在浏览器里授权一次。终端会打印：

```
npm error code EOTP
npm error Open this URL in your browser to authenticate:
npm error   https://www.npmjs.com/auth/cli/<id>
```

**在能打开浏览器的地方运行发布命令**，点链接 → Authorize，终端会自动继续并打印 `+ dsh-api-hub@<version>`。

如果链接显示成 `***`（非交互终端会遮掉），改用验证码方式：先在账号上启用 2FA，然后

```powershell
npm publish --otp=123456
```

**验证发布成功**：

```powershell
npm view dsh-api-hub version          # 期望是刚发的版本
dsh plugin --profile test add dsh-api-hub
```

首次发布后到 <https://www.npmjs.com/package/dsh-api-hub> 确认：

- 版本号正确
- README 渲染正常
- 「Install」命令是 `npm i dsh-api-hub`

验证安装：

```powershell
dsh plugin --profile test add dsh-api-hub
dsh --profile test --port 17890 --no-open
# 另开终端
Invoke-WebRequest http://127.0.0.1:17890/api-hub/api/health -UseBasicParsing
```

`dsh plugin add` 会自动把包名写进 profile 的 `dsh.profile.bundles`，不用手改。

## 4. 打 tag，让 CI 建 Release

```powershell
git commit -am "release: v0.4.2"
git tag -a v0.4.2 -m "v0.4.2 — 变更说明"
git push && git push origin v0.4.2
```

`.github/workflows/release.yml` 会自动：语法检查 → `npm pack` → 创建 Release 并附 `.tgz`。

如果只想补建某个已存在 tag 的 Release：Actions → **release** → **Run workflow** → 填入 tag。

## 5. 上架插件市场

市场（dshmarket）的列表来自精选仓库 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，**提 PR 即可**，站点和客户端会自动收录（通常一天内）。

条目需要的字段（参考线上 `plugins.json` 的结构）：

| 字段 | 说明 |
|---|---|
| `name` | 仓库名 `DSH-API-Hub` |
| `owner` | GitHub 用户名 `Limooning` |
| `url` | `https://github.com/Limooning/DSH-API-Hub` |
| `category` | 建议 `productivity` / `developer-tools` |
| `description.en` / `description.zh` | 一句话说明（中英各一） |
| `npm` | `dsh-api-hub` |

参考文案：

```
en: API Hub — manage local API providers inside DeepSeek Harness: keys, models, balances, connection tests and a request debugger, plus skill management.
zh: API Hub — 在 DeepSeek Harness 里统一管理本地 API 服务商：Key、模型、余额、连通测试与请求调试，并管理技能。
```

收录后市场里的安装命令形如：

```
dsh plugin --profile <profile> add dsh-api-hub
```

## 6. 发布后

- 在 README 顶部把安装方式切换到 npm（现在写的是 link / tarball）
- 打不开 GitHub 的机器上，可以用镜像读 README：
  `https://gh-proxy.com/https://raw.githubusercontent.com/...`（只对公开仓库有效）
- 需要撤版：`npm deprecate dsh-api-hub@0.4.2 "reason"`；**不要**轻易 `unpublish`，已经安装的人会断

## 7. 兼容性声明

市场会读 `engines.dsh` 或同版本线的 `@deepseek-ai/dsh-*` peer 来判断宿主兼容性。如果后续要声明支持的 DSH 版本范围，在 `package.json` 里加：

```json
"engines": { "dsh": ">=0.2.0" }
```

不声明也能上架，只是市场无法判断兼容性（会保持可见）。
