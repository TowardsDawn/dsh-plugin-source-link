[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)
[![DSH Market 收录徽章](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

# dsh-plugin-source-link

给 DSH Web 的**插件面板**（侧栏「插件」，即管理第三方插件的面板）加一块「插件来源」：
在**每个插件详情页**底部显示该插件的 GitHub 仓库 URL（可点击超链接）或本地仓库路径；
数据目录里提取不到时，提供一个输入框让你自己填，并持久保存。

## 目录结构

```
dsh-plugin-source-link/
├─ package.json          清单：main=host 半，exports["./client"]=浏览器半，dsh.client 声明
├─ cordis.patch.yml      bundle patch：insert 一行 id=plugin-source-link
├─ index.js              host 半：只读推断 + 手动值持久化（注册 /api/plugin-source-link/*）
├─ lib/repo-source.js    纯函数层：spec / 清单 / git 远端 → URL 或本地路径
├─ client.js             浏览器半：注册 plugins.detail.section 席位并渲染区块
├─ tests/verify.mjs      离线自检：纯函数 + 用假 ctx/req/res 驱动 4 条路由
└─ README.md
```

## 功能

- **自动提取**（按优先级）：
  1. profile `package.json` 里的依赖 spec —— `github:owner/repo`、`git+https://…`、`git+ssh://…`、`git@host:owner/repo.git` 归一化成 `https://…`；`file:` / `link:` 解析成本地绝对路径；
  2. `node_modules/<包>/package.json` 的 `repository` / `homepage` / `bugs.url`；
  3. 本地源码目录 `.git/config` 的 `origin`（覆盖 `link:` 依赖、本地开发中的插件；`.git` 为 worktree 文件时同样处理）。
- **渲染**：URL 是 `<a target="_blank">` 超链接（附「复制」按钮）；本地路径是等宽文本（附「复制」按钮），完整路径放在 `title` 里。
- **手动填写**：区块内「没有？我自己填」展开两个输入框（仓库 URL / 本地路径），保存后覆盖自动结果并显示「手动填写」徽标；「清除手动值」回到自动推断。
- **持久化**：手动值写在 `<profile 目录>/plugin-source-links.json`，换浏览器也保留。
- **安全**：`/api/plugin-source-link/*` 只接受 loopback 来源（socket 远端 + Host 头双重校验）；URL 只接受 http/https/git 形态，`javascript:` / `data:` / `file:` 一律拒绝；包名严格校验后才拼进 `node_modules` 路径。

## 安装（由你自己执行）

```powershell

dsh plugin --profile web add "github:TowardsDawn/dsh-plugin-source-link"
```

安装后重启 DSH Web（或让它热重组），侧栏「插件」→ 点开任一插件详情页，底部即出现「插件来源」。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/plugin-source-link/one?name=<包名>` | 解析单个包 |
| GET | `/api/plugin-source-link/list` | profile 全部依赖的解析结果（预取用） |
| POST | `/api/plugin-source-link/set` | `{ name, url?, path? }` 保存手动值（空串 = 清除该项） |
| POST | `/api/plugin-source-link/clear` | `{ name }` 清除该包全部手动值 |

返回形如 `{ ok: true, entry: { name, version, spec, url, path, resolvedFrom, manual, auto, installed, profileDir } }`。

## 已知限制

- 只能在本机浏览器里用：从 LAN 打开 Web GUI 时 host 端返回 403，区块显示「仅在本机浏览器中可用」（与官方插件面板的安装/启停同样的限制）。
- 官方随附的 bundle（`@deepseek-ai/dsh-*`）通常没有 `repository` 字段也没有依赖 spec，会显示「数据目录里没有找到仓库地址」——这时用手动填写。
- 只读推断：插件不改动任何被管理插件的文件，唯一写入是 `<profile>/plugin-source-links.json`。

## 卸载

```powershell
dsh plugin --profile web remove dsh-plugin-source-link
```

手动值文件 `<profile>/plugin-source-links.json` 不会被自动删除，需要的话自行移除。

## License

[MIT](LICENSE)
