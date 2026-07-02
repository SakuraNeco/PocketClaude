# PocketClaude

[繁體中文](README.md) · **简体中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

从**手机 / 任何浏览器远程监看并操控你电脑上的 Claude Code 会话**的自托管 PWA。
用你本机已登录的 `claude` CLI 运行（吃 Max/Pro 订阅，**不额外花 API 费用**），再通过 Cloudflare 隧道从外面连进来。

- 实时查看所有 Claude Code 对话的进度
- 从手机发指令接续某个对话、或开新对话
- **逐项批准**：Claude 要动任何工具前，推送到手机让你按允许/拒绝
- **多任务并行**：不同会话可同时跑；忙碌中的会话会把后续消息排队
- 密钥登录保护（首次启动自动生成）
- 漂亮的 Markdown 渲染（DOMPurify 消毒）、代码高亮、贴图/选图
- 查看 Claude 产出的图片/音乐/视频/PDF、一键在手机预览 dev server
- 内置文件浏览器 + Markdown 阅读视图
- **8 种界面语言**、明暗主题、思考深度调整、语音输入
- 可安装为 App、任务完成时推送通知（按设备语言）
- 离线 / 防火墙内也能用（资源全部自托管，不依赖 CDN）

> ⚠️ **它控制的是「运行它的那台机器」。** 在 A 电脑运行，就只能控制 A 电脑的 Claude。它读取本机的 `~/.claude` 并调用本机的 `claude` CLI。

---

## 需求

- **Node.js 18+**
- **Claude Code / Claude Desktop 已安装并登录**（有 Max 或 Pro 订阅）— 终端能跑 `claude` 就行
- （远程连接用）**cloudflared** — 不用先装，下面用 `npx` 直接跑

支持 **Windows / macOS / Linux**（CLI 路径与数据目录自动按系统判断）。

## 安装

```bash
git clone https://github.com/SakuraNeco/PocketClaude.git
cd PocketClaude
npm install
```

## 启动

```bash
npm start
```

看到这几行就成功了：

```
PocketClaude server → http://localhost:3000
login key:   xxxxxxxxxxxxxxxxxxxxxxxx
claude CLI:  /path/to/claude
```

本机打开 <http://localhost:3000>，输入启动信息里的 **login key** 登录（每台设备只需输入一次）。

> 密钥保存在项目根目录的 `.auth-token`（已 gitignore），删掉重启会换新的一组；也可用环境变量 `CC_AUTH_TOKEN` 自定义。若 `claude CLI` 那行检测错了，复制 `.env.example` 为 `.env`，把 `CLAUDE_PATH` 指向你的 `claude`。

## 从手机 / 外面连接（Cloudflare 隧道）

```bash
npm run tunnel
```

会打印一组 `https://xxxx.trycloudflare.com` 地址 — 手机打开、输入 login key 即可。想要固定地址，请改用 Cloudflare 的[命名隧道](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)，把 ingress 指到 `http://localhost:3000`。

> ⚠️ **用自己域名（命名隧道）时**：Cloudflare 的托管 WAF 规则会 403 `/node_modules/…` 等路径，弄坏 `/proxy` 预览 Vite dev server。请在 Cloudflare 面板加一条自定义规则：Hostname 等于你的子域名 → 动作 **Skip**（勾选所有托管规则＋所有剩余自定义规则）。PocketClaude 自身有密钥验证，不依赖 WAF。

## 安装为 App + 开启推送

1. 手机浏览器打开上面的 https 地址
2. 「添加到主屏幕」
3. 从主屏幕图标打开，点**启用推送通知**（iOS 的 Web 推送只有添加到主屏幕后才能用）

---

## 使用

- 顶部「**发送至**」选择要操控的对话，输入消息发送。
- **权限模式**：
  | 模式 | 行为 |
  |------|------|
  | 逐项批准 `interactive` | 每个工具调用都推送到手机，你按允许/拒绝（120 秒未回应自动拒绝） |
  | 自动编辑 `acceptEdits`（默认） | 自动允许改文件 |
  | 完全自动 `bypassPermissions` | 全部放行，最能干但最不设防 |
  | 规划模式 `plan` | 只规划不动手 |
- **模型**：默认 / Fable 5 / Opus / Sonnet / Haiku · **思考深度**：默认 / 低 / 中 / 高 / 极高 / 最大
- 右上角可切换**界面语言**（8 种）与**明暗主题**；输入框旁有**语音输入**按钮。
- 侧栏的**文件**按钮可浏览会话目录，`.md` 用内置阅读视图打开。

### 注意事项 / 已知限制

- **每个会话一次跑一个任务**：忙碌中再发会自动排队，任务结束后接续发送；不同会话可并行。
- **不能用网页操控 PocketClaude 自己那个对话**（会把服务器重启杀掉），已自动拦截。
- 对「**正开在桌面**的对话」发消息，内容写进文件、但那个桌面窗口要重开才看得到。
- **服务器没有自动重启**：关终端 / 重启机器 / 崩溃就停了。要常驻请自行用 `pm2`、`launchd`(mac)、任务计划程序(win)。

## 安全设计

- 除 PWA 外壳外，**所有 API / WebSocket / 文件流 / 代理都要密钥**（timing-safe 比对；凭证是 HttpOnly cookie）。
- `/media`、`/files` 限制在用户主目录内（含路径边界检查）。
- 逐项批准的桥接是 **fail-closed**：服务器连不上一律拒绝。
- 所有 Markdown 输出经 DOMPurify 消毒；文本文件（含 HTML）一律以 `text/plain` 提供。
- `/proxy` 只能连到会话内容出现过的端口（可用 `CC_PROXY_ALLOW` 追加）。
- `/auth` 有暴力尝试节流；系统临时目录下的会话不会被列为可操控目标。
- `.audit.log` 记录登录、发送、停止、权限决定等操作。

## 环境变量（均可选，见 `.env.example`）

| 变量 | 说明 |
|------|------|
| `PORT` | 服务器端口（默认 3000） |
| `CLAUDE_PATH` | `claude` CLI 路径（留空自动检测） |
| `CC_AUTH_TOKEN` | 登录密钥（留空自动生成到 `.auth-token`） |
| `CC_PROXY_ALLOW` | `/proxy` 额外允许的端口（逗号分隔） |
| `VAPID_SUBJECT` | Web Push 联系邮箱 `mailto:` |

VAPID 密钥、登录密钥、推送订阅、上传图片都是**每台安装各自生成**的，已被 `.gitignore` 排除。

## 开发

```bash
npm test        # node --test — 纯函数单元测试
node --check server.js
```

CI 在 Node 18/20/22 上跑语法检查 + 测试。

## License

MIT
