# 引き継ぎメモ(2026-09-27 セッション更新)

前セッションで PLAN.md の Phase 1〜4 をすべて実装・コミット済み。PLAN.md は役目を終えたので参照不要(このファイルが最新)。
2026-07-16 セッションでテキスト選択・コピー機能を追加。
2026-09-27 セッションで既存テキストの Acrobat 風インライン編集を追加(下記「インライン文字編集」参照)。

## 現在の状態

- ブランチ: `main`。直近コミット(新しい順):
  - インライン文字編集(2026-09-27、下記参照)。cache-buster は `?v=3`
  - `4f4ea21` Cache-bust worker + engine imports(古いファイルとの不一致防止)
  - `6b63961` テキスト選択・コピー機能(下記参照)
  - `22d106a` Fix: engine worker hang on startup(重要バグ修正)
  - `6f1c376` Phase 4-2: 連続スクロール表示
  - `1e2a67b` Phase 4-1: 左ツールレール
  - `f129606` Phase 3: 先読み・サムネ遅延・検索中表示
  - `fadaf88` Phase 2: エンジンを Web Worker へ
  - `805fb1e` Phase 1: PNG往復廃止、canvas直描画
- デプロイ: GitHub Pages(`gh-pages` ブランチ)。再デプロイは `git subtree push --prefix=web origin gh-pages`。**上記コミットまで反映済み**(`web/` と `origin/gh-pages` に差分なし)。
- ローカル確認: `cd web && python3 -m http.server 8000` → http://localhost:8000/

## インライン文字編集(2026-09-27)

既存テキストの編集をダイアログ方式から Acrobat 風の「その場で編集」に置き換えた。

- **操作**: 左レールの「編集」は `setTool('editText')` のツールになった。ONにすると各行を
  `.text-layer` の点線ボックスで表示し、クリックでその位置に `.ie`(contenteditable の
  インラインエディタ+上部の書式バー)を開く。ツール未選択時のダブルクリックでも開く。
  Enter=確定 / Shift+Enter=改行 / Esc=取消 / 枠外クリック=確定。IME 変換中の Enter は無視。
  旧 `editTextMode`/`showTextListModal`/`showTextEditDialog` は削除。
- **書体合わせ**: エンジンの `getText` が各 span に `style: {name, bold, italic, serif, mono}`
  を付ける(`fontStyle()`、mupdf のフラグ+フォント名の推定)。UI の `resolveEditFont()` が
  「自動」時に ①元フォントと同名(PostScript名)のローカルフォント → ②日本語なら同系統・同ウェイトの
  ローカル明朝/ゴシック(`LOCAL_CJK`) → ③標準14書体(`b14:Times-Bold` 等)の順で選ぶ。
- **エンジン**: `layoutText()` で、選んだフォントにグリフが無い文字(gid 0)だけ内蔵 CJK
  (`jp`)にフォールバックする複数フォント run で描画(`insertText`/`setTextAppearance`/`addText`)。
  `registerFont(id, label, data, psName)` は .ttc/.otc の name テーブルから `psName` の face
  index を探す(ヒラギノ明朝 W3/W6 など)。スタンプ・透かし等は従来の `encodeLine`/`textMetrics` のまま。
- **注意**: `queryLocalFonts()` は初回にパーミッションプロンプトを出す。エディタはそれを待たずに開き、
  許可後にフォント一覧を追加する(`addEditorFontOptions`)。下記「気になった点」の原因はこれで、解消済み。
  保存・別名保存・undo/redo の前には `flushInlineEdit()` で編集中の内容を確定する。
- **検証**: mupdf で作った複数フォントの PDF(Times-Bold / Helvetica / Courier / Times-Italic /
  ヒラギノ明朝 / 色付き背景)で、編集→書体判定→保存→再読込を Playwright で確認。
- **Playwright の注意**: `local-fonts` 許可を新しい context に `permissions: ['local-fonts']` で
  与えないとプロンプト待ちで固まり、その context ではスクリーンショットも撮れなくなる。
  また、このアプリのページはスクリーンショットがタイムアウトすることがあるので、状態の確認は
  `evaluate` と保存 PDF のレンダリングで行うとよい。
- **未着手**: 段落単位の編集(複数行をまとめて折り返し直す)、縦書き・回転テキストの編集。

## テキスト選択・コピー(2026-07-16、完了)

Acrobat 流に「ツール未選択時のデフォルト動作」として実装した。

- **エンジン側** (`pdf-engine.js`): `selectionInfo(idx, p, q)` を追加。
  `page.toStructuredText().highlight(p, q)` で選択範囲のハイライト矩形(quad→axis-aligned
  bbox に変換)を、`st.copy(p, q)` で選択テキストを取得し、`{rects, text}` を1回のRPCで返す
  (mupdf.js の `StructuredText.highlight`/`copy`/`snap` バインディングを利用。`snap` は
  word/line スナップ用だが今回は未使用 = 将来のダブルクリック単語選択などに使える)。
- **UI側** (`index.html`): `S.mode` が `null`(ツール未選択)のときの `onStageMouseDown/Move/Up`
  のデフォルト分岐として `onTextSelectDown/Move/Up` を実装。ドラッグ中は `selectionInfo` を
  mousemove毎に呼ぶが、二重発火を避けるため `selBusy`/`selDirty` で1件のみ同時実行し、
  最新の位置で再実行するコアレッシング方式。ハイライトは `#overlay` に `.text-sel`
  (`var(--pri-l)` で塗り、新しい色は導入していない)。コピーは `Cmd/Ctrl+C`
  (`navigator.clipboard.writeText`)。選択はツール切替・ページ切替・内容編集
  (`afterContentEdit`/`afterStructural`)・Escape で `clearTextSelection()` によりクリア。
  デフォルトカーソルを `.page-canvas` に `cursor: text` として設定(以前は何もツール未選択時は
  無反応だった)。
- **検証**: Playwright + Chromium の `page.pdf()` で実テキスト入りPDFを生成し、
  ドラッグ選択→ハイライト表示→Cmd+Cでクリップボードに正しいテキストが入ることを確認。
  クリックで選択解除、ズーム変更後もハイライト矩形が正しくスケールされることも確認。
  既存のハイライトツール(DRAG_TOOLS)や連続スクロール・ページ送りとの回帰がないことも確認済み。
- **未着手の関連事項**: ダブルクリックで単語選択(mupdf の `snap` を使えば実装可能)、
  トリプルクリックで行選択、選択中のミニツールバー(Acrobatにある「コピー」ボタン等)は
  今回は追加していない(Cmd/Ctrl+C のみ)。

### 気になった点(→ 2026-09-27 に解消。上記「インライン文字編集」の注意を参照)
既存の「ダブルクリックでテキスト編集」機能について、Playwright(headless Chromium)経由の
自動テストではモーダルが開かなかった(エラーは出ない)。`git stash` で本セッションの変更を
一時的に外して同じテストを行っても同じ結果だったため、**本セッションの変更による regression
ではない**。`ensureFontsLoaded()` 内の `queryLocalFonts()`(Local Font Access API)が
headless環境でパーミッション許可が得られず待機し続けている可能性がある
(`context.grantPermissions(['local-fonts'])` を試しても変化なし)。実ブラウザでの
手動確認を推奨(次回作業時に一度確認を)。

## アーキテクチャ(Phase 2 以降)

- `web/engine-worker.js`(新規): mupdf WASM + `pdf-engine.js` をモジュールWorkerでホスト。`{id, fn, args}` を受けて `engine[fn](...args)` を実行、`{id, ok, result}` を返す。Uint8Array は transfer。
- `web/index.html`: UI からは `call(fn, ...args)`(Promise ベースの RPC)経由でエンジンを呼ぶ。`engine.` 直呼びは全廃。`api(path, body)` は互換レイヤとして残っていて内部で `call()` に振り分ける。
- **起動シーケンス(バグ修正済み・触るとき注意)**: Worker は初期化完了後に `{id: 0, ok: true}` を自分から post する。メインは `pending.set(0, ...)` でそれを待つ。`new Worker()` 直後に postMessage すると Worker 側 onmessage 登録前に届いて**silently drop される**(これが「エンジン読み込みから進まない」の原因だった)。この ready ハンドシェイクを壊さないこと。

## 表示まわり(Phase 1 / 4-2)

- ページは `<canvas id="pageImg">` に `renderPixels(idx, zoom)`(エンジン、3ch RGB を返す)→ UI 側で 4ch RGBA に展開して putImageData。
- **連続スクロール**: `#scrollViewport` 内に全ページ分の `.page-slot`(`data-page` 属性)を並べる。IntersectionObserver(rootMargin 600px)で見えるスロットだけ preview canvas を mount、外れたら破棄。
- **現在ページ(S.cur)だけ**がフル対話型の `page-stage`(#stage / #pageImg / #overlay)を持つ。他ページはプレビューで、クリックすると `activatePage(i)` で切替。ツール類のコードは単一ページ前提のまま無改修 — これは意図的なスコープ判断。
- ズーム: `applyZoom()` が CSS 即時スケール→150ms デバウンス後に本描画+全スロットサイズ再計算。
- キャッシュ: `pixelCache`(idx@zoom キー、LRU 4件)、`textCache`(ページテキスト)。`afterContentEdit`/`afterStructural`/`onOpened` でクリア。
- `onOpened` / `afterStructural` は **async になった**(buildScrollSlots を await するため)。

## 検証環境(構築済み)

Playwright + Chromium がこのマシンに入っている:
- テストスクリプト置き場: scratchpad の `pw-test/`(セッション毎に消えるので、必要なら `npm i playwright` からやり直し。Chromium バイナリは `~/Library/Caches/ms-playwright/` に残っている)
- パターン: `chromium.launch()` → `page.goto('http://localhost:8000/')` → `page.waitForFunction(() => document.querySelector('#engineLoading').classList.contains('hidden'))` → `#fileInput` に setInputFiles で PDF 投入 → `#pageImg` の width>0 を待つ。
- テスト用 PDF は `new mupdf.PDFDocument()` + `addPage` + `insertPage` + `saveToBuffer('')` で生成(手書き PDF バイトは xref 壊れ警告が出る)。

## ユーザーと合意済みの次タスク

優先度順に提案し、ユーザーは前向き:

1. ~~テキスト選択・コピー~~ → 本セッションで実装済み(上記参照)。
2. **Ctrl/Cmd+ホイールズーム & ピンチズーム**(次はこれ): `edArea` の wheel イベント(`e.ctrlKey` 判定、preventDefault)→ `applyZoom()`。マウス位置中心を維持するには zoom 前後で `edArea.scrollTop/Left` を補正する。
3. その他候補(未合意): 最近使ったファイル(File System Access API)、注釈の後編集、しおり編集、OCR(Tesseract.js)、見開き表示、ページ色反転、ダブルクリック単語選択/トリプルクリック行選択(mupdf の `snap` 利用)。

## 注意事項

- 文言は日本語、トースト文体は「〜しました」。色は既存テーマ変数(`--pri` 等)のみ。
- `mupdf.js` / `mupdf-wasm.js` / `mupdf-wasm.wasm` は触らない。
- コミットメッセージは英語、末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`(モデルが変わるなら適宜)。
- 連続スクロール(4-2)はコード検証のみでユーザーの実機確認が済んでいない。**次の作業前に一度スモーク確認を推奨**(50ページ級でのスクロール、ツール操作、検索ジャンプ)。
- `PLAN.md` と `HANDOFF.md` は未追跡ファイル。コミットに含めるかはユーザーに確認。
