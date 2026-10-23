# 上架插件市场

市场索引来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
**提一个 PR，加一个 YAML 文件**即可，列表和站点会自动重建（通常一天内）。

## 当前状态

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle`（含 `cordis.patch.yml`） | ✅ |
| 仓库有真实可用代码 | ✅ |
| 已发布到 npm（`dsh-api-hub@0.4.2`） | ✅ 可跳过 `allowBuilds` 构建授权 |
| 仓库公开 | ✅ |
| 仓库创建满 **1 天** | ⏳ 创建于 2026-10-23 15:05（北京），**10-24 15:05 之后**再提交 |
| 仓库带 `dsh-plugin` topic | ❌ 需要手动加（见下） |
| 提交 PR | ❌ 待做 |

## 1. 加 topic（30 秒）

仓库页 → 右上 **⚙** → **Topics** → 输入 `dsh-plugin` → 保存。

（顺手可以把仓库描述从 `DSH-API-Hub` 改成一句话，市场以外的场景也会用到。）

## 2. 要提交的文件

Fork [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
新建 `data/plugins/Limooning__DSH-API-Hub.yml`：

```yaml
url: https://github.com/Limooning/DSH-API-Hub
name: Limooning/DSH-API-Hub
category: tools
description:
  en: Manage local API providers inside DeepSeek Harness — keys, models, balances, connection tests, a request debugger and skill management.
  zh: 在 DeepSeek Harness 里统一管理本地 API 服务商——Key、模型、余额、连通测试、请求调试，并管理技能。
icon: https://raw.githubusercontent.com/Limooning/DSH-API-Hub/main/assets/icon-180.png
```

要点：

- **`description.en` 必填**，中文可选（缺了维护者会补）
- 描述里如果出现「英文冒号 + 空格」，整行必须加引号；我们的句子没有，安全
- `icon` 是可选的店面图，必须是 GitHub 托管的**位图**（`assets/icon-180.png` 已随仓库提供）
- 选贴合实际功能的分类，选偏了维护者会直接改，不会打回

`category` 可选值（来自官方 contributing.md）：

```
agi  ui  usage  theme  model  identity  session  memory  tools  wsl  browser
vision  voice  docs  skill  workflow  git  notify  dev  security  remote  market  fun
```

## 3. 提 PR

- 标题：`Add Limooning/DSH-API-Hub`
- 只加那一个文件，**不要手改 README**（README 是生成的，改了会被拒）
- CI 会自动校验 `dsh.bundle`、仓库年龄、YAML 格式、README 能否重新生成

## 评审会看什么

CI 通过只是前置条件，维护者还会读仓库：

1. 代码是否真的做了条目里说的事（描述里的数字、API 名会被核对）
2. 分类是否合理（不因此打回）
3. 是否是真代码而非占位
4. 是否与已有条目重复
5. 源码里有没有可疑行为（混淆、外传凭据、异常安装）
6. PR 有没有动别人的条目

## 上架后

市场里的安装命令：

```
dsh plugin --profile <profile> add dsh-api-hub
```

可选徽章：

```markdown
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
```
