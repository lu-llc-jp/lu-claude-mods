# lu-claude-mods

Claude Code の mod(関数フック形式のプラグイン)を作り、マーケットプレイスとして配布するリポジトリ。

## これは public リポジトリになる
- 顧客名・案件情報・契約条件・単価・個人情報を書かない。コード・コメント・コミットメッセージ・テストデータのすべてで
- 個人事業や趣味の開発の情報を持ち込まない。法人の一般的な成果物だけを置く
- 秘密情報をコミットしない。必要なら値を伏せた `.env.example` を置く
- issue・PR・コメントも public。ここにも上のことを書かない
- GitHub への push は、ユーザーに頼まれたときだけ行う。リポジトリの公開設定の変更はユーザーが行う

## 進め方(issue → ブランチ → PR)
実装は主に Claude Code が行う。そのぶん、人が後から読んで「何をなぜそうしたか」を追えるように、
issue と PR を理解のための記録として残す。

1. **issue を立てる**: 依頼を受けたら、`.github/ISSUE_TEMPLATE/task.md` の形で本文を下書きして見せる。承認をもらってから `gh issue create` する
2. **ブランチを切る**: `main` から `<issue番号>-<短い英語>`(例 `3-pane-refresh-button`)。コミットメッセージに `#<issue番号>` を含める
3. **実装する**: 「#n をやって」と言われたら、ブランチで実装してローカルでコミットするところまで
4. **PR を出す**: 頼まれたら push して `gh pr create`。本文は `.github/pull_request_template.md` の形で、`Closes #n` を入れる
5. **マージ**: ユーザーが行う。`main` に直接 push しない

書き方:
- issue では「背景・目的」「完了条件」を、PR では「判断したこと」「確かめたこと(未確認を含む)」を省かない
- 専門用語(フック名、`$.state` など)には一言で意味を添える
- コード中のコメントは、「なぜ」が自明でない箇所に一言残す

外部からの issue(要望・不具合報告)は、採否をユーザーが決める。Claude は内容の整理と対応案の提示までにとどめる。

## 構成
- `.claude-plugin/marketplace.json` マーケットプレイス定義。mod を足したら `plugins` に1件足す
- `plugins/<mod名>/` mod 1つぶん。形は README の「開発」を参照
- mod の API は Claude Code の `plugin-authoring` スキルと、生成される型ファイルが正。推測で書かず型を grep して確かめる

## mod を足す・直すとき
- mod の名前は `claude-` / `anthropic-` で始められない(予約名)。何をするかで名付ける
- `$.state` を使う mod は `types/index.d.ts` に契約を書き、`plugin.json` の `"types"` で指す
- 振る舞いごとに `*.test.ts` を書く
- 完了の前に `claude plugin validate .`、`claude plugin validate plugins/<mod名>`、`claude plugin test plugins/<mod名>` を通す
- 振る舞いを変えたら `plugin.json` の `version` を上げる(インストール済みの人は `claude plugin update` で受け取る)
- 依存パッケージは原則入れない(mod はエンジン内で動き、Node/npm を使わない)。入れるならライセンスを確認して報告する
