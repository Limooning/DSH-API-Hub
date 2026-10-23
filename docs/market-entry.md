# 上架插件市场（可直接提交的内容）

市场索引来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
**提 PR 加一个 YAML 文件**即可，列表和站点会自动重建（通常一天内）。

## 提交前：仓库需要满足三条

| 要求 | 我们的状态 |
|---|---|
| `package.json` 里声明 `dsh.bundle` 清单 | ✅ 有（`dsh.bundle.patch`） |
| 仓库创建满 1 天 | ⏳ 需要等到明天 |
| 仓库带 `dsh-plugin` topic | ❌ 需要手动加：仓库页 → 右上齿轮 → **Topics** → 输入 `dsh-plugin` |

## 要提交的文件

路径：`data/plugins/Limooning__DSH-API-Hub.yml`

```yaml
url: https://github.com/Limooning/DSH-API-Hub
name: Limooning/DSH-API-Hub
category: tools
description:
  en: Manage local API providers inside DeepSeek Harness - keys, models, balances, connection tests, a request debugger and skill management.
  zh: 在 DeepSeek Harness 里统一管理本地 API 服务商——Key、模型、余额、连通测试、请求调试，并管理技能。
```

`category` 可选值（按现有条目统计）：`ui` `tools` `session` `dev` `workflow` `model`
`usage` `memory` `theme` `notify` `skill` `fun` `remote` `security`。
我们选 `tools`；如果想更贴近“用量/余额”，也可以选 `usage`。

## 提交步骤

1. Fork：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
2. 在 `data/plugins/` 下新建文件 `Limooning__DSH-API-Hub.yml`，粘贴上面的内容
3. 提交 PR，标题写 `Add Limooning/DSH-API-Hub`
4. PR 会自动检查 `dsh.bundle` 是否存在

> README 是自动生成的，**不要手改 README**，否则 PR 会被拒。

## 上架后

市场里的安装命令形如：

```
dsh plugin --profile <profile> add dsh-api-hub
```

（前提是已经 `npm publish` 过；如果只发 GitHub Release，市场仍会显示条目，但一键安装需要 npm 包名可用。）

## 徽章（上架后可选）

```markdown
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
```
