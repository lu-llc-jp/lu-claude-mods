# lu-claude-mods

lu-llc が配布する [Claude Code](https://claude.com/claude-code) の mod(関数フック形式のプラグイン)集です。
このリポジトリ自体がプラグインのマーケットプレイスになっています。

## mod 一覧

| mod | 内容 |
| --- | --- |
| [cc-service-status](plugins/cc-service-status/) | Claude のサービス稼働状況(status.claude.com)をステータスラインとペインに出す |
| [cc-work-log](plugins/cc-work-log/) | エージェントとサブエージェントの作業を日本語の短い文でペインに流す |

## インストール

ターミナルの Claude Code のプロンプトで次を実行します。

```
/plugin install cc-service-status --marketplace lu-llc-jp/lu-claude-mods
```

他の mod も、`cc-service-status` の部分をその mod 名に変えて同じように入れます。

マーケットプレイスの追加を聞かれたら `y`、続いてスコープ(通常はユーザー)を選びます。
デスクトップアプリの Code タブではこのコマンドは使えません。ターミナルでユーザースコープに入れれば、そちらでも読み込まれます。

## 要望・不具合の報告

[issue](https://github.com/lu-llc-jp/lu-claude-mods/issues/new/choose) から、テンプレートを選んで送ってください。

- **mod の要望**: こういう mod がほしい、この mod にこの機能がほしい
- **不具合の報告**: mod が期待どおりに動かない

## 開発

作業は issue → ブランチ → PR で進めます。詳しくは [CLAUDE.md](CLAUDE.md) の「進め方」を参照してください。

mod は `plugins/<mod名>/` に1つずつ置きます。

```
plugins/<mod名>/
├── .claude-plugin/plugin.json   # name / version / description / author
├── hooks/hooks.json             # { "modules": ["./register.ts"] }
├── hooks/register.ts(x)         # export const register: Register = (on, options) => { ... }
├── hooks/register.test.ts       # claude plugin test で動くテスト
├── types/index.d.ts             # $.state を使うときの型契約(plugin.json の "types" で指す)
└── README.md
```

追加の手順:

0. 名前を決める。`claude-` で始まる名前などは Anthropic の予約名で使えない(`claude plugin validate` が弾く)

1. `plugins/<mod名>/` を上の形で作る
2. `.claude-plugin/marketplace.json` の `plugins` に1件足し、この README の一覧にも足す
3. 検査とテスト
   ```sh
   claude plugin validate .
   claude plugin validate plugins/<mod名>
   claude plugin test plugins/<mod名>
   ```
4. 手元で動かす: `claude --plugin-dir plugins/<mod名>`(保存すると読み直される)

型は Claude Code が `plugins/<mod名>/.claude-plugin/types/` に生成します(git 管理外)。
一度読み込ませた後は `tsc -p plugins/<mod名>` で型検査できます。

関数フックの API は早期提供(early access)で、Claude Code のリリース間で変わることがあります。

## ライセンス

[MIT](LICENSE)
