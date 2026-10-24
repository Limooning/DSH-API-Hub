# AGENTS.md

给接手这个仓库的 agent 看的规矩。违反了就是返工。

## 发布纪律（用户明确要求，优先级最高）

1. **不主动推送。** 只有用户明确说「推 / 发 / 存 GitHub / 传 npm」时才执行 `git push`、打 tag、`npm publish`。改完代码先本地提交，等指令。
2. **每次推送前重写 README。** 不是改一行版本号：对着这次的现状通读一遍 `README.md`，把新增/变化的入口、行为、限制写进去，删掉已经不对的说法。README 里不写死版本号（版本交给徽章和 Releases），也不写死文件名。
3. **多次改动后只推最新版。** 一轮里可能连做了 0.7.9、0.8.0、0.8.1、0.8.2，推送时只推 `main` 一次 + 只给最新的那个版本打 tag，旧的补 tag、补发版都不要做。

## 发布步骤（用户说「推」之后才走）

```powershell
# 1. 重写 README（见规矩 2），升版本：package.json + CHANGELOG.md 两处
# 2. 本地验证
npm test
npm run check:dsh
# 3. 提交
git add -A; git commit -F .git/commit-msg.txt
# 4. 推 main，然后只推这一个 tag
git push origin main
git tag v<新版本>; git push origin v<新版本>
# 5. 发 npm —— 需要浏览器一次性授权（EOTP），必须开一个可见的控制台跑
Start-Process cmd -ArgumentList '/k', 'cd /d <仓库路径> && npm publish'
# 6. 核对：releases/latest 是这个 tag、npm dist-tags.latest 是这个版本
```

- tag 一定**一条一条推**：一条命令推多个 tag 时 GitHub 不会为它们触发 release 工作流，结果是「有 tag 没 Release」。
- `npm publish` 在非交互终端里 EOTP 授权链接会被打成 `***`，用户点不到，所以必须开可见控制台。
- 发完核对三处：GitHub Releases 里的 **Latest**、npm 的 `dist-tags.latest`、`git status` 是否干净。

## 交付习惯

- 改完代码先跑 `npm test`（当前 11 条）与 `node --check`；动到界面时额外做一次 stub-React 渲染检查。
- 提交信息用 `type(scope): 一句话`，正文说清「为什么」而不只是「改了什么」。
- 用户的数据文件（`providers.json`、`keys/`、`skill-tags.json`、`skill-order.json`、`dsh-routes.json`、`scan-sources.json`）一律不进版本库，`.gitignore` 兜住；别用 `git add -A` 把它们带进来（踩过两次）。
- 动真实用户的注册表或技能目录前先备份，改完还原，并在回答里说清动了什么。
