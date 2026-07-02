# PocketClaude

從**手機 / 任何瀏覽器遠端監看並操控你電腦上的 Claude Code session** 的自架 PWA。
用你本機已登入的 `claude` CLI 跑（吃 Max/Pro 訂閱，**不額外花 API 費用**），再透過 Cloudflare 通道從外面連進來。

- 即時看所有 Claude Code 對話的進度
- 從手機送指令繼續某個對話、或開新對話
- **逐項核准**：Claude 要動任何工具前，推播到手機讓你按允許/拒絕
- 密鑰登入保護（首次啟動自動生成）
- 漂亮的 Markdown 渲染（DOMPurify 消毒）、程式碼高亮、貼圖/選圖
- 看 Claude 產出的圖片/音樂/影片/PDF、一鍵在手機開 dev server 預覽
- 可裝成 App、任務完成時推播通知

> ⚠️ **它控制的是「跑它的那台機器」。** 在 A 電腦跑，就只能控制 A 電腦的 Claude。它讀本機的 `~/.claude` 並呼叫本機的 `claude` CLI。

---

## 需求

- **Node.js 18+**
- **Claude Code / Claude Desktop 已安裝並登入**（有 Max 或 Pro 訂閱）
  - 終端機打 `claude` 能跑就沒問題
- （遠端連線用）**cloudflared** — 不用先裝，下面用 `npx` 直接跑

支援 **Windows / macOS / Linux**（CLI 路徑與資料目錄會自動依系統判斷）。

---

## 安裝

```bash
git clone https://github.com/SakuraNeco/PocketClaude.git
cd PocketClaude
npm install
```

## 啟動

```bash
npm start
```

看到這幾行就成功了：

```
PocketClaude server → http://localhost:3000
login key:   xxxxxxxxxxxxxxxxxxxxxxxx
claude CLI:  /path/to/claude
```

電腦本機開 <http://localhost:3000>，輸入啟動訊息裡的 **login key** 登入（每台裝置只要輸入一次）。

> 密鑰保存在專案根目錄的 `.auth-token`（gitignored），刪掉重啟會換新的一組；也可用環境變數 `CC_AUTH_TOKEN` 自訂。
>
> 若 `claude CLI` 那行偵測錯了，複製 `.env.example` 成 `.env`，把 `CLAUDE_PATH` 指到你的 `claude`（終端機打 `which claude` / Windows 用 `where claude` 查）。

## 從手機 / 外面連（Cloudflare 通道）

最快的方式，另開一個終端機：

```bash
npm run tunnel
```

會印出一組 `https://xxxx.trycloudflare.com` 網址，手機開那個、輸入 login key 就連到你電腦了（HTTPS，推播才能用）。

想要固定網址，請改用 Cloudflare 的[具名通道](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)，把 ingress 指到 `http://localhost:3000`。

## 裝成 App + 開推播

1. 手機瀏覽器打開上面的 https 網址
2. 「加入主畫面 / Add to Home Screen」
3. 從主畫面圖示開啟，點畫面上的**啟用推播通知**
   - iOS 的 Web 推播**只有在「加到主畫面」後**才能用

---

## 使用

- 上方「**傳送至**」選你要操控的對話，輸入訊息送出。
- **權限模式**（輸入框下方）：
  | 模式 | 行為 |
  |------|------|
  | 逐項核准 `interactive` | 每個工具呼叫都推播到手機，你按允許/拒絕（120 秒沒回應自動拒絕） |
  | 自動編輯 `acceptEdits`（預設） | 自動允許改檔 |
  | 完全自動 `bypassPermissions` | 全部放行，最能用但最不設防 |
  | 規劃模式 `plan` | 只規劃不動手 |
- **模型**：預設 / Fable 5 / Opus / Sonnet / Haiku（別名自動對到各級最新版）。

### 注意事項 / 已知限制

- **一次跑一個任務**：有任務進行中時再送會被擋下，先按「停止」。
- **不能用網頁操控 PocketClaude 自己那個對話**：會把伺服器重啟殺掉，已自動擋下。
- 對「**此刻正開在桌面**的對話」送訊息，內容會寫進檔案、但不會即時跳進那個桌面視窗，要重開才看得到。
- **伺服器沒有自動重啟**：關終端機 / 重開機 / 當掉就停了。要常駐請自行用 `pm2`、`launchd`(mac)、工作排程器(win) 等顧著。

## 安全設計

- 除了 PWA 外殼，**所有 API / WebSocket / 檔案串流 / 代理都要密鑰**（timing-safe 比對；憑證是 HttpOnly cookie）。
- `/media` 檔案串流限制在使用者家目錄內（含路徑邊界檢查）。
- 逐項核准的橋接是 **fail-closed**：伺服器連不上一律拒絕，不會放行。
- 所有 Markdown 輸出經 DOMPurify 消毒。
- 系統暫存目錄下的 session 不會被列為可操控目標。

## 環境變數（皆選填，見 `.env.example`）

| 變數 | 說明 |
|------|------|
| `PORT` | 伺服器埠（預設 3000） |
| `CLAUDE_PATH` | `claude` CLI 路徑（留空自動偵測） |
| `CC_AUTH_TOKEN` | 登入密鑰（留空自動生成到 `.auth-token`） |
| `VAPID_SUBJECT` | Web Push 聯絡信箱 `mailto:`（預設 placeholder） |

VAPID 金鑰、登入密鑰、推播訂閱、上傳圖片都是**每台安裝各自產生**的，已被 `.gitignore` 排除、不會進版控。

## License

MIT
