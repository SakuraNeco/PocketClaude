# PocketClaude

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**PC 上で動いている Claude Code セッションをスマホや任意のブラウザから遠隔監視・操作**できるセルフホスト PWA。
ログイン済みのローカル `claude` CLI を使うため（Max/Pro サブスクリプションで動作、**API 追加費用なし**）、Cloudflare トンネル経由で外出先からアクセスできます。

- すべての Claude Code 会話の進行をリアルタイム表示
- スマホからプロンプトを送って会話を再開、または新規チャット開始
- **毎回承認**：Claude がツールを使う前にプッシュ通知が届き、許可/拒否をタップ
- **逐次ストリーミング + 途中追記**：返信が逐次リアルタイム表示。実行中でも指示を追記でき、追加質問もコールドスタート不要。別セッションは並列
- キー認証ログイン（初回起動時に自動生成）
- きれいな Markdown レンダリング（DOMPurify サニタイズ）、シンタックスハイライト、画像貼り付け/添付
- Claude が生成した画像/音声/動画/PDF の閲覧、dev server をスマホでプレビュー; **静的 HTML プロトタイプをスマホで直接レンダリング**（サンドボックス化、自分でサーバーを立てる必要なし）
- **ツールパネル**：使用量/コスト統計 · 生成メディアギャラリー · 複数サーバーをワンタップ切り替え
- セッションは**ピン留め / アーカイブ**可能 — リストが長くても見つけやすい
- 内蔵ファイルブラウザ + Markdown リーダー
- **8 つの UI 言語**、ライト/ダークテーマ、思考深度調整、音声入力
- アプリとしてインストール可、タスク完了時のプッシュ通知（端末の言語で）
- オフライン / ファイアウォール内でも動作（アセット全て自己ホスト）

> ⚠️ **操作できるのは「それが動いているマシン」だけです。** PC A で動かせば A の Claude のみ操作できます。ローカルの `~/.claude` を読み、ローカルの `claude` CLI を呼び出します。

---

## 必要環境

- **Node.js 18+**
- **Claude Code / Claude Desktop がインストール・ログイン済み**（Max または Pro）— ターミナルで `claude` が動けば OK
- （リモート接続用）**cloudflared** — 事前インストール不要、`npx` で実行

**Windows / macOS / Linux** 対応（CLI パスとデータディレクトリは OS ごとに自動検出）。

## インストール

```bash
git clone https://github.com/SakuraNeco/PocketClaude.git
cd PocketClaude
npm install
```

## 起動

```bash
npm start
```

以下が表示されれば成功：

```
PocketClaude server → http://localhost:3000
login key:   xxxxxxxxxxxxxxxxxxxxxxxx
claude CLI:  /path/to/claude
```

<http://localhost:3000> を開き、起動ログの **login key** を入力（端末ごとに一度だけ）。

> キーは `.auth-token`（gitignore 済み）に保存。削除して再起動すると新しいキーになります。`CC_AUTH_TOKEN` 環境変数でも指定可。`claude CLI` の検出が間違っている場合は `.env.example` を `.env` にコピーし `CLAUDE_PATH` を設定してください。

## スマホ / 外部からのアクセス（Cloudflare トンネル）

```bash
npm run tunnel
```

`https://xxxx.trycloudflare.com` の URL が表示されます — スマホで開いて login key を入力。固定 URL が欲しい場合は Cloudflare の[名前付きトンネル](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)で ingress を `http://localhost:3000` に向けてください。

> ⚠️ **独自ドメイン（名前付きトンネル）を使う場合**：Cloudflare のマネージド WAF ルールが `/node_modules/…` などを 403 にし、Vite dev server の `/proxy` プレビューが壊れます。Cloudflare ダッシュボードでカスタムルールを追加してください：Hostname がサブドメインに等しい → アクション **Skip**（全マネージドルール＋残りの全カスタムルールにチェック）。PocketClaude 自身がキー認証を持つため WAF には依存しません。

## アプリとしてインストール + プッシュ通知

1. スマホのブラウザで https の URL を開く
2. 「ホーム画面に追加」
3. ホーム画面のアイコンから開き、**通知を有効にする**をタップ（iOS の Web プッシュはホーム画面追加後のみ）

---

## 使い方

- 上部の「**送信先**」で操作する会話を選び、メッセージを送信。
- **権限モード**：
  | モード | 動作 |
  |------|------|
  | 毎回承認 `interactive` | 全ツール呼び出しをスマホにプッシュ、許可/拒否をタップ（120 秒無応答で自動拒否） |
  | 自動編集 `acceptEdits`（デフォルト） | ファイル編集を自動許可 |
  | 全自動 `bypassPermissions` | 全て許可 — 最も強力だが最も無防備 |
  | プランモード `plan` | 計画のみ、変更なし |
- **モデル**：デフォルト / Fable 5 / Opus / Sonnet / Haiku · **思考深度**：デフォルト / 低 / 中 / 高 / 超高 / 最大
- 右上で **UI 言語**（8 種）と**テーマ**を切替。入力欄の横に**音声入力**ボタン。
- サイドバーの**ファイル**ボタンでセッションのフォルダを閲覧、`.md` は内蔵リーダーで開き、`.html` はスマホ上で**ウェブページとしてレンダリング**（サンドボックス化）します。
- 右上の **⊞ ツール**：**使用量**（各プロジェクトのコスト · PocketClaude 経由で送信したやり取りのみ集計）、**ギャラリー**（全セッションで生成した画像/音声/動画の一覧の壁）、**サーバー**（複数の PocketClaude を保存し、キーを持ってワンタップ切り替え）。
- セッション行は**ピン留め**（最上部へ）や**アーカイブ**（最下部へ+淡色化）が可能。これらの設定はブラウザにローカル保存されます。

### 注意事項 / 既知の制限

- **永続ストリーミングセッション**：返信を逐次表示。実行中セッションへの送信はライブプロセスに流し込まれ、現在のターンの後に実行されます（コールドスタートなし）。別セッションは並列、各プロセスは 5 分アイドルで終了。
- **PocketClaude 自身のセッションはウェブから操作不可**（サーバーが再起動して落ちるため）— 自動でブロックされます。
- **デスクトップで開いている会話**への送信はファイルには書かれますが、そのウィンドウには再オープンまで表示されません。
- **自動再起動はありません**：ターミナルを閉じる / 再起動 / クラッシュで停止します。常駐させるには `pm2`、`launchd`(mac)、タスクスケジューラ(win) を使ってください。

## セキュリティ

- PWA シェル以外の**全 API / WebSocket / ファイル配信 / プロキシにキーが必要**（timing-safe 比較、HttpOnly cookie）。
- `/media`、`/files` はホームディレクトリ内に制限（パス境界チェックあり）。
- 毎回承認のブリッジは **fail-closed**：サーバーに繋がらなければ拒否。
- Markdown 出力は全て DOMPurify でサニタイズ。`/media` はテキストファイル（HTML 含む）を `text/plain` で配信。`.html` を実際のページとしてプレビューするには `/html` を使用——**`sandbox` CSP**（opaque origin）でレンダリング：自身の JS は動くが、認証 cookie に触れられず、同一オリジン API にも到達できません。
- `/proxy` はセッションに登場したポートのみ接続可（`CC_PROXY_ALLOW` で追加可）。
- `/auth` にブルートフォース抑制あり。OS 一時ディレクトリ配下のセッションは対象外。
- `.audit.log` にログイン・送信・停止・権限決定を記録。

## 環境変数（すべて任意 — `.env.example` 参照）

| 変数 | 説明 |
|------|------|
| `PORT` | サーバーポート（デフォルト 3000） |
| `CLAUDE_PATH` | `claude` CLI のパス（未設定なら自動検出） |
| `CC_AUTH_TOKEN` | ログインキー（未設定なら `.auth-token` に自動生成） |
| `CC_PROXY_ALLOW` | `/proxy` が追加で許可するポート（カンマ区切り） |
| `VAPID_SUBJECT` | Web Push 連絡先 `mailto:` |

VAPID キー、ログインキー、プッシュ購読、アップロードは**インストールごとに生成**され、gitignore されています。

## 開発

```bash
npm test        # node --test — ピュア関数のユニットテスト
node --check server.js
```

CI は Node 18/20/22 で構文チェック + テストを実行。

## License

MIT
