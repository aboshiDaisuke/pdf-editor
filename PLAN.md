# 高速化 + デザイン改善プラン

対象: `web/index.html`(UI)と `web/pdf-engine.js`(エンジン)。
フェーズ順に実装する。**各フェーズ完了ごとにコミット**し、下の「検証」を必ず実行すること。

前提知識:
- UI からエンジンへの呼び出しはほぼすべて `api(path, body)`(async)経由。ただし
  **直接 `engine.*` を同期呼び出ししている箇所**が5つある: `save()` / `showSaveNameDialog()` /
  `passwordSaveDialog()` / `optimizeSave()` / `exportPagePng()` / `printPdf()` / `pngBlobUrl()`。
  Phase 2 でこれらを async 化する。
- 座標系: エンジンは「表示スペース(回転適用済み・ポイント単位)」。UI は `S.zoom` 倍で描画。
- 検証用スクリプトの書き方は git 履歴のコミット `ce81d82` 時点のテスト
  (`node` + `import mupdf.js` + `createEngine`)を参考にする。

---

## Phase 1: PNG 往復をやめて canvas 直描画(最優先・効果大)

### 1-1. エンジンに生ピクセル取得を追加(`pdf-engine.js`)

`renderPNG` の隣に追加:

```js
// Raw RGBA pixels for direct canvas drawing (no PNG encode/decode round-trip).
function renderPixels(idx, zoom) {
  return withPage(idx, (page) => {
    const pix = page.toPixmap(mupdf.Matrix.scale(clampZoom(zoom), clampZoom(zoom)),
      mupdf.ColorSpace.DeviceRGB, true, true);   // alpha=true → RGBA
    const w = pix.getWidth(), h = pix.getHeight();
    const pixels = pix.getPixels().slice();       // copy out of WASM memory
    pix.destroy();
    return { w, h, pixels };
  });
}
```

注意: `getPixels()` は WASM メモリへのビュー。**必ず `.slice()` でコピー**してから
`pix.destroy()` すること(renderPNG の `asPNG().slice()` と同じ理由)。
alpha=true で RGBA 4ch になることを確認する(RGB 3ch だと ImageData に使えない)。
もし `toPixmap` の alpha=true で背景が透明になる場合は、UI 側 canvas を白で塗ってから
putImageData ではなく drawImage する方式に変える(下記 1-2 の実装を参照)。

`return { ... }` のエクスポートに `renderPixels` を追加。

### 1-2. メインページ表示を `<img>` から `<canvas>` へ(`index.html`)

`renderPage()` を変更:
- `img.src = pngBlobUrl(...)` をやめ、`<canvas class="page-canvas" id="pageImg">` を生成し:

```js
const { w, h, pixels } = engine.renderPixels(S.cur, S.zoom);
const canvas = el;                     // id=pageImg のまま
canvas.width = w; canvas.height = h;
// CSSサイズは devicePixelRatio を考慮せず従来どおり naturalサイズ表示
const ctx = canvas.getContext('2d');
const imgData = new ImageData(new Uint8ClampedArray(pixels.buffer || pixels), w, h);
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);   // alpha付きでも白背景を保証
ctx.putImageData(imgData, 0, 0);
```

putImageData は背景を上書きするため白背景にしたい場合は、
`createImageBitmap(imgData).then(bm => ctx.drawImage(bm, 0, 0))` を使うか、
エンジン側で alpha=false(RGB)にして UI 側で RGBA に展開する。
**まず alpha=false + 3ch→4ch 展開のほうが確実**:

```js
// 3ch RGB → 4ch RGBA 展開(エンジンが alpha=false の場合)
const rgba = new Uint8ClampedArray(w * h * 4);
for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
  rgba[j] = pixels[i]; rgba[j+1] = pixels[i+1]; rgba[j+2] = pixels[i+2]; rgba[j+3] = 255;
}
```

どちらを採用するかは実測(下の検証スクリプト)で決める。

- `sizeOverlay()` は `img.naturalWidth` 参照を `canvas.width` に変更。
  `img.addEventListener('load', ...)` は不要になる(同期で描けるため直接呼ぶ)。
- `img.complete && img.naturalWidth` の分岐も削除。
- `pickColorAt()`(スポイト)は `<img>` を canvas に描き直しているが、
  ページがもう canvas なので `$('#pageImg').getContext('2d').getImageData(px,py,1,1)` に簡略化。
- `fitWidth()` の `img.naturalWidth` → `canvas.width` に変更。
- `mainUrl` 変数と revoke 処理は不要になるので削除。
- `page-canvas` の CSS はそのまま使える(box-shadow 等)。
- サムネイルは既存の PNG 方式のまま(小さいので影響小。触らない)。

### 1-3. ズームの体感高速化(`index.html`)

`zoomIn()` / `zoomOut()` / `fitWidth()` で:
1. 既存 canvas に `style.width = (canvas.width / oldZoom * newZoom) + 'px'` を即適用
   (CSS スケールで即時反映、`style.height` も同様)。overlay も同じ倍率で
   `transform: scale()` するか、いったん `overlay.innerHTML` を消す(選択・検索ハイライトは
   本レンダリング後に再描画されるので消えてよい)。
2. 150ms のデバウンス後に `renderPage()` で本レンダリング。

実装は共通関数にする:

```js
let zoomTimer = null;
function applyZoom(newZoom) {
  const canvas = $('#pageImg');
  if (canvas) { /* CSS 即時スケール */ }
  S.zoom = newZoom; setZoomLabel();
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => { if (S.pages) renderPage(); }, 150);
}
```

`renderPage()` の先頭で `canvas.style.width/height` をクリア。

### 1-4. テキスト抽出キャッシュ(`index.html` または `pdf-engine.js`)

`onStageDblClick` と `editTextMode` は毎回 `/api/text/` を呼ぶ。
UI 側にキャッシュを持つ:

```js
const textCache = new Map();   // page idx -> spans
async function getPageText(idx) {
  if (!textCache.has(idx)) textCache.set(idx, (await api(`/api/text/${idx}`)).spans || []);
  return textCache.get(idx);
}
```

- `afterContentEdit()` で `textCache.delete(S.cur)`、`afterStructural()` で `textCache.clear()`。
- `onOpened()` でも `textCache.clear()`。

### Phase 1 検証

```bash
cd web && python3 -m http.server 8000
```
- PDF を開いて表示が従来どおり(白背景・ぼやけない・回転ページも正常)
- ズーム連打時に即座に拡大縮小して見え、止めた後に鮮明化する
- スポイト・ダブルクリック編集・検索ハイライト・オブジェクト選択が動く
- Node での renderPixels 単体テスト(コミット ce81d82 のテストスクリプト方式で
  `renderPixels(0,2)` が `w*h*4`(または *3)長の配列を返すこと)

---

## Phase 2: エンジンを Web Worker へ移動(UI フリーズ解消)

### 2-1. ワーカーファイル新規作成: `web/engine-worker.js`

```js
// Module worker: hosts mupdf WASM + the engine so heavy ops don't block the UI.
import * as mupdf from "./mupdf.js";
import { createEngine } from "./pdf-engine.js";

const engine = createEngine(mupdf);

self.onmessage = (e) => {
  const { id, fn, args } = e.data;
  try {
    const result = engine[fn](...args);
    // Transfer large binaries instead of copying
    const transfers = [];
    collectTransfers(result, transfers);
    self.postMessage({ id, ok: true, result }, transfers);
  } catch (err) {
    self.postMessage({ id, ok: false, message: String(err && err.message || err),
      needPassword: !!(err && err.needPassword) });
  }
};
function collectTransfers(v, out) {
  if (!v) return;
  if (v instanceof Uint8Array) { out.push(v.buffer); return; }
  if (typeof v === 'object') for (const k in v) collectTransfers(v[k], out);
}
```

### 2-2. UI 側プロキシ(`index.html`)

`engineReady` ブロックを差し替え:

```js
let worker = null;
let rpcId = 0;
const pending = new Map();
const engineReady = (async () => {
  if (location.protocol === 'file:') { $('#fileWarning')?.classList.add('show'); }
  worker = new Worker('./engine-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, result, message, needPassword } = e.data;
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result);
    else { const err = new Error(message); err.needPassword = needPassword; p.reject(err); }
  };
  // ワーカー起動失敗(file:// 等)を検出
  await call('status');       // 起動確認 ping
})();
function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    const transfers = [];
    for (const a of args) if (a instanceof Uint8Array) transfers.push(a.buffer);
    worker.postMessage({ id, fn, args }, transfers);
  });
}
```

注意:
- **Uint8Array を transfer すると呼び出し側の配列は空になる**。`loadPdf` で
  open に渡した bytes を後で使い回している箇所がないか確認(現状ない)。
- `api()` 内の `engine.xxx(...)` を全部 `call('xxx', ...)` に置換。
- 直接呼び出し箇所を async 化:
  - `save()` / `showSaveNameDialog()` / `passwordSaveDialog()`:
    `const bytes = await call('save', opts)` + `applyStatus(await call('status'))`
  - `optimizeSave()`: 2回 save していたのを1回にし、返り値サイズだけ toast
    (`before` 計測はやめる。「◯◯KBで保存しました」だけでよい)
  - `exportPagePng()` / `printPdf()` / `pngBlobUrl()` / `renderThumbNow()`:
    `await call('renderPNG', idx, zoom)`。`renderThumbNow` は async 化し、
    呼び出し元(observer コールバック)はそのままで良い(fire-and-forget)。
  - `renderPage()`: `await call('renderPixels', S.cur, S.zoom)` — async になるので
    呼び出し元との整合を確認(古い呼び出しの結果が新しい呼び出しの後に届く
    レースを防ぐため、`renderPage` に世代カウンタを持たせ、描画前に
    `if (gen !== renderGen) return;` で破棄する)。
  - `engine.registerFont(...)` → `await call('registerFont', ...)`
- `hasNative()` や `needEngine()` の `if (!engine)` チェックは
  `worker` の存在チェックに置き換える。
- **queryLocalFonts はメインスレッドのみ**。既存の `prepareTextFont` は
  blob 取得後に `call('registerFont', ...)` へバイト列を渡す形にする(構造は既に対応済み)。

### 2-3. 印刷・重い一括処理の進捗表示

`printPdf()` はワーカー化により UI は固まらなくなるが、ページごとに
`toast` ではなくヘッダー下に簡易プログレスバー(`#progressBar`、幅%を更新)を出す。
透かし・ページ番号適用中も同様に表示(処理前に表示、完了後に隠す)。

### Phase 2 検証

- 100ページ級の PDF を開いてもタブが固まらない(開くのに時間はかかってよい。
  スピナーが回り続けること)
- 全機能スモークテスト: 開く→編集→注釈→スタンプ→透かし→保存→
  パスワード保存→再オープン→undo/redo→印刷→PNG書き出し
- `file://` で開いたときのエラーメッセージが引き続き出る

---

## Phase 3: 細かい体感改善

- **隣接ページの先読み**: `renderPage()` 完了後、`requestIdleCallback` で
  cur±1 ページの `renderPixels` 結果を `Map`(キー `idx@zoom`、最大4件、LRU)に
  キャッシュ。`gotoPage` でキャッシュヒットしたら即描画。
  `afterContentEdit`/`afterStructural` でキャッシュ全クリア。
- **サムネ更新の遅延**: `afterContentEdit` 内の `updateThumb(S.cur)` を
  `requestIdleCallback`(fallback: `setTimeout 300ms`)に包む。
- **検索のインクリメンタル化はしない**(エンジン全ページ走査のため)。
  代わりに検索実行中はボタンを「検索中...」表示にする。

### Phase 3 検証
ページ送り(←→ボタン連打)が明確に速くなること。編集後のページ表示が遅くならないこと。

---

## Phase 4: デザイン改善(左ツールレール + 連続スクロール表示)

### 4-1. 左ツールレール(Acrobat 風)

現状ヘッダーにツールが13個並び、1440px 以下でラベルが消えて窮屈。
- 編集/マークアップ/図形/Acrobat 系ツール(`edit-tools` `markup-tools` `shape-tools`
  `acro-tools` の4グループ)をヘッダーから**左端の縦レール**(幅48px、アイコンのみ、
  ホバーでツールチップ)へ移動する。サイドバー(ページ/しおり)のさらに左に置く。
- ヘッダーに残すのは: ロゴ / 開く・保存系 / undo・redo / ページナビ / ズーム /
  文書メニュー / 検索 / フォーム / テーマ。
- ツールレールにもグループ区切り線を入れる。`--pri` のアクティブ表示は現行踏襲。
- `@media (max-width: 1440px)` の縮小ルールは大幅に簡素化できるはず。

### 4-2. 連続スクロール表示(大きめの変更・最後に)

単ページ表示をやめ、Acrobat 同様**全ページを縦に連続表示**:
- `.editor-area` 内に全ページ分の `page-stage` プレースホルダ(正しい高さ・幅を
  `pageSizePts` から計算して確保)を縦に並べる。
- IntersectionObserver で「見えているページ ±1」だけ `renderPixels` して canvas に描画、
  画面外に出たら canvas を破棄(メモリ節約。プレースホルダの高さは維持)。
- `S.cur` は「ビューポート中央にあるページ」に追従(scroll イベント + throttle)。
  ページインジケータ・サムネのアクティブ表示も追従。
- ツール操作(クリック/ドラッグ)は各 page-stage のローカル座標で従来どおり動く。
  `stageCoord` は event.currentTarget 基準に変更。
- 検索ジャンプ・しおりジャンプは `scrollIntoView`。
- ズームは全プレースホルダのサイズ再計算 + 表示中ページ再描画。
- **既存の単ページ実装を壊さないよう、この項だけ別コミットにする。**

### Phase 4 検証
- 全ツールがレールから起動でき、アクティブ状態が見える
- 連続スクロールで 50ページ級 PDF がスムーズにスクロールできる(メモリ暴走しない)
- 各ツール・検索・しおり・フォームが連続表示でも正しいページに作用する

---

## 全フェーズ共通の注意

- 文言はすべて日本語、既存のトースト文体(〜しました)に合わせる。
- 既存のテーマ変数(`--pri` 等)を使い、新しい色を導入しない。
- コミットは Phase ごと(4-2 のみ独立コミット)。メッセージは英語、
  末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 触らないもの: `mupdf.js` / `mupdf-wasm.js` / `mupdf-wasm.wasm`、undo スナップショット方式、
  デプロイ構成(`web/` を静的配信)。
