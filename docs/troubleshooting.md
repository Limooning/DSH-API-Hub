# 故障排查

面板出问题时，先确认版本：`~/.dsh/profiles/desktop/node_modules/dsh-api-hub/package.json` 里的 `version`，或仓库里 `git describe --tags`。

## 侧边栏没有「API Hub」

插件没被加载。按顺序查：

1. **bundle 没注册**（最常见）：profile 的 `package.json` 里 `dsh.profile.bundles` 必须包含 `"dsh-api-hub"`。只 `pnpm add` 而没加这一项，不会报错，只是安静地不出现。
2. **link 指错目录**：v0.4.0 起仓库根目录就是包，应该 `link:<仓库路径>`；旧写法 `link:<仓库>/plugin` 在 0.4.0 之后不存在了。
3. **没重启**：宿主半侧只在 DSH 启动时加载，装完必须重启。

## 侧边栏有入口，但显示「连不上面板服务」

界面加载了、后端路由没响应。面板会列出每个候选地址和失败原因，按原因区分：

| 面板显示 | 含义 | 处理 |
|---|---|---|
| `... → HTTP 404` | 路由没挂上，宿主半侧没加载 | 确认版本 ≥ v0.3.0（`server.mjs` 从 0.3.0 起在包内），重启 DSH |
| `... → HTTP 500` | 路由在，但后端文件缺失或抛错 | 多半是 `lib/server.mjs` 不在包里：重装 ≥ v0.4.0 |
| `... → 超时` | 地址不可达 | 检查 DSH 是否换了端口，重启 |
| `... → 连接被拒绝或被浏览器拦截` | 跨域/私有网络被拦 | 确认插件 ≥ v0.3.3（补了 CORS 私有网络响应头） |
| `页面协议 app:` + 只有 `/api-hub` | 宿主没注入 origin | `webServer` 服务不可用，重启 DSH 或换 profile 试 |

自己不进界面也能测：

```powershell
# 端口换成 DSH 实际监听的（重启会变）
Invoke-WebRequest http://127.0.0.1:<端口>/api-hub/api/health -UseBasicParsing
```

- 200 `{"ok":true,...}` → 后端正常，问题在客户端
- 401 → 你访问的是 DSH 自己的 `/api`，不是 `/api-hub`
- 404 → 路由没挂载
- 500 → 后端文件缺失/报错

## 安装时报错

### `ERR_PNPM_NO_OFFLINE_META: Failed to resolve @deepseek-ai/cordis`

v0.3.2 之前的包把 `@deepseek-ai/cordis` 声明为必需 peer，离线安装会去 registry 解析。升级到 ≥ v0.3.2（已标记为 optional）。

### registry 连不上

这台机器访问 `registry.npmjs.org` 被阻断时，`pnpm add` 任何包都会失败。用本地 tarball 安装可以完全离线：

```powershell
pnpm add <路径>/dsh-api-hub-0.4.0.tgz --offline
```

### 装完 `node_modules/dsh-api-hub` 是符号链接

那是 `link:` 安装的正常表现（junction/symlink），指向你的仓库目录。改仓库代码会立刻生效；想固定版本就改用 tarball。

## 数据在哪

| 内容 | 位置 |
|---|---|
| 服务商注册表 | `~/.dsh/api-hub/providers.json`（不存在时会从包内 `providers.example.json` 复制一份） |
| 面板自己管的 Key | `~/.dsh/api-hub/keys/<id>.json` |
| DSH 凭据库的 Key | `~/.dsh/.credentials.yaml` 的 `refs.<ref>` |
| 修改前的备份 | 仓库里 `git tag`，或本地 `git show v0.3.0:lib/client.js` |

## 升级

```powershell
cd ~/.dsh/api-hub
git pull --ff-only          # 或重新装新 tarball
# 重启 DSH
```

v0.3.x → v0.4.0 是破坏性的：包从 `plugin/` 挪到了仓库根目录，`link:` 路径要跟着改。
