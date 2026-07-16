# PDF Editor — アプリ本体

**ブラウザ内だけで完結**する PDF 編集アプリです。
PDF はあなたの PC の外に出ず、すべてブラウザの中で処理されます（アップロード無し・ネット不要）。
エンジンは **MuPDF** の公式 WebAssembly 版（`mupdf.js`）。

機能一覧はリポジトリルートの [README](../README.md) を参照。

## 動かし方（ローカル）

ES モジュールと WASM を使うため、**HTTP 経由で開く必要があります**（`index.html` を `file://` で直接開くと動きません）。

```bash
cd web
python3 -m http.server 8000      # もしくは:  npx serve .
```

ブラウザで <http://localhost:8000> を開く。

## 公開（デプロイ）

`web/` フォルダ一式を任意の静的ホスティングに置くだけです（ビルド不要）。

- **GitHub Pages** … gh-pages ブランチで公開中: `git subtree push --prefix=web origin gh-pages`
- **Vercel / Netlify / Cloudflare Pages** … 出力ディレクトリを `web/` に指定

> WASM はストリーミングコンパイルを使わないので、`.wasm` の MIME 設定は不要です。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | UI 一式（HTML/CSS/JS）。ライト/ダーク切替つき |
| `pdf-engine.js` | `mupdf.js` をラップした PDF エンジン（編集・注釈・透かし・墨消し・暗号化保存など） |
| `mupdf.js` / `mupdf-wasm.js` / `mupdf-wasm.wasm` | MuPDF 公式 WebAssembly ランタイム |

## 使い方のポイント

- **開く**: 「開く」ボタン、またはページ上へ PDF をドラッグ&ドロップ（パスワード付きPDFは入力を求められます）
- **編集**: 文字はダブルクリックで直接編集。画像・図形・追加文字・スタンプは「オブジェクト」ツールで移動/リサイズ
- **文書メニュー**: 透かし・ページ番号・プロパティ・パスワード保護・最適化・PNG書き出し・印刷
- **保存**: 「保存」「別名で保存」→ 編集済み PDF をダウンロード
- **注意**: 墨消しは保存後は復元できません（セッション内なら ⌘Z 可）

## ライセンス注意

`mupdf*` は Artifex の **MuPDF**（AGPL / 商用デュアルライセンス）です。公開配布する場合は AGPL の条件に留意してください。
