# cc-service-status

Claude のサービス稼働状況([status.claude.com](https://status.claude.com))を Claude Code の中で確認する mod です。

## できること

- **ステータスライン**(プロンプトの下)に、いまの状態を常に出します
  - `Claude: 正常`
  - `Claude: 一部障害 — Claude Console`(正常でないサービス名を2件まで。それ以上は「ほか n 件」)
  - 取得に失敗したときは、前回の状態に `(更新失敗)` を付けて出します
- **`/cc-service-status`** を実行すると、その場で最新を取得し、ペインに詳細を出します
  - 全体の状態と取得時刻
  - サービスごとの状態(claude.ai / Console / API / Claude Code など)
  - 進行中の障害と予定メンテナンス(状態・更新時刻・リンク)

## 取得について

- 取得先: `https://status.claude.com/api/v2/summary.json`(公開 API、認証なし)
- セッション開始時に1回、以後5分ごとに取得します
- 組織のポリシーで外部への取得が禁止されている環境では取得できません

## インストール

```
/plugin install cc-service-status --marketplace lu-llc-jp/lu-claude-mods
```
