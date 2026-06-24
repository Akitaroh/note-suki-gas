# note-suki (GAS)

note.com の**公開スキ数**を Google スプレッドシートに日次集計する [Google Apps Script](https://developers.google.com/apps-script)。Apps Script 単体で動き、外部サービス・ライブラリ・サーバーは不要。記事ごとのスキ数推移、並べ替え、前日比、Slack 通知（任意）まで Google だけで完結する。

---

## ⚠️ Disclaimer / 免責

**This is an unofficial, community project. It is not affiliated with, authorized, sponsored, or endorsed by note (note, Inc.) or any of its affiliates.**

- It accesses only **publicly available data** through note's **undocumented internal API** — **read-only, no authentication, no writes or modifications**.
- These endpoints are undocumented and **may change or break at any time without notice**.
- **Use at your own risk.** The authors are not responsible for any consequences of use. Ensure your use complies with [note's Terms of Service](https://note.com/terms) and applicable laws.
- Intended for **personal, research, and educational** use. Please don't make excessive requests that could burden note's infrastructure.

> 日本語: これは非公式の個人プロジェクトで、note 社とは一切関係ありません。**公開データを読み取るだけ**（認証なし・投稿や改変はしない）。非公式 API のため予告なく壊れます。**利用は自己責任**で、note の利用規約と法令を各自確認してください。高頻度アクセスは避けてください。

*note is a trademark of its respective owner. The name is used here only to identify what this tool works with, and does not imply endorsement.*

---

## できること

毎日（時間主導トリガー）、指定した公開クリエイターの記事メトリクスを取得し、スプレッドシートに次のシートを生成・更新する:

- **サマリ** — 総スキ／総コメント／記事数／フォロワー＋前日比
- **記事** — 順位・♡スキ・💬コメント・タイトル・推移(スパークライン)・公開日。見出しの▾で並べ替え
- **記事推移** — プルダウンで記事を選ぶと、その記事のスキ数の日時推移が折れ線チャートにライブで切り替わる
- **日次履歴** — 日付ごとの総数＋総スキの折れ線チャート
- **Slack 通知**（任意）— 集計ダイジェストを Slack へ

取得するのはスキ数・コメント数・公開日・フォロワー数といった**誰でもページ上で見られる公開値のみ**。PV や売上などログインが要る指標は対象外。

## セットアップ

1. Google スプレッドシートを新規作成
2. **拡張機能 → Apps Script** を開き、`Code.gs` を貼り付けて保存
3. **プロジェクトの設定（⚙️）→ タイムゾーン** を `Asia/Tokyo` に（毎朝6時 = JST にするため）
4. 同じ画面の **スクリプト プロパティ** に追加して「保存」:
   - `NOTE_URLNAME` = 追跡したい公開クリエイターの urlname（`note.com/xxxx` の `xxxx`）
   - （任意）`SLACK_WEBHOOK_URL` = Slack Incoming Webhook
5. スプレッドシートをリロード → メニュー **note-suki → 今すぐ集計**（初回は権限承認。自作スクリプトなので「確認されていません」警告は正常）
6. **note-suki → 毎日6時に自動実行を設定**

`appsscript.json` 同梱なので [clasp](https://github.com/google/clasp) でも `clasp push` できる。

## 取得の作法（レート制限）

- ページ取得のあいだに `Utilities.sleep(600)` の待機を入れている（負荷配慮）。**この値を短くしすぎない**こと
- ブラウザ相当の User-Agent を正直に名乗る
- note 側の `robots.txt` は `/api/*` を Disallow している。本ツールはその内部 API を読む。**規約・robots は各自で確認**し、低頻度・自分用の範囲で使うこと
- 大量収集・取得データの再配布・スパム的自動化は用途外

## 制限

- GAS の 1 実行は最大 6 分。数百記事までは余裕。数千記事の超大型アカウントはページ分割実行の改造が要る
- 非公式 API なので note の仕様変更で壊れることがある
- 記事ごとの推移は集計を始めた日からたまる（公開日まで遡れない）。2 日分たまってから線になる

## ライセンス

[MIT](LICENSE)

> MIT の NO WARRANTY は作者と利用者の間の責任配分。第三者（サービス運営・データ著作権・規約違反）からの請求はカバーしない。上の Disclaimer と合わせて読むこと。
