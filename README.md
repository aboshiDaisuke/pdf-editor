# PDF Editor

ローカルで動作する Acrobat ライクな PDF 編集デスクトップアプリ。Flask + PyMuPDF。

## 機能

### ファイル
- PDF 読み込み（ネイティブ ファイルダイアログ / ドラッグ&ドロップ）
- **実ファイルへの保存**（上書き保存）・名前を付けて保存（ネイティブ 保存ダイアログ）
- 元に戻す / やり直し（ボタン状態はスタックに同期、⌘Z / ⌘⇧Z）

### 編集
- テキスト編集（既存テキストの書き換え。元の位置＝ベースラインを保持、日本語フォントを埋め込み）
- テキスト追加
- 画像挿入（埋め込み前に自動圧縮・ダウンスケール）
- 図形描画（四角・楕円・直線、色／太さ／塗りつぶし、ドラッグ中ライブプレビュー）

### 注釈・マークアップ（保存後も編集可能な注釈として保持）
- ハイライト / 下線 / 取り消し線（テキストに沿って自動フィット）
- フリーハンド（インク）
- 矢印
- コメント（付箋）

### ページ整理
- ページ追加・削除（複数選択一括）・並べ替え（ドラッグ&ドロップ）
- 90°回転（現在ページ／選択ページ）
- 別 PDF からページ挿入
- 選択ページの書き出し（抽出）

### 検索・フォーム
- 全ページ テキスト検索（ヒット箇所のハイライト・ジャンプ、⌘F）
- フォームフィールド入力（テキスト／チェックボックス／選択）

### 表示
- ズーム（25%〜400%）

## セットアップ

```bash
pip install pymupdf flask pillow pywebview
python server.py
```

ネイティブウィンドウが開きます。

## ビルド（スタンドアロンアプリ）

```bash
pip install pyinstaller
python -m PyInstaller \
  --name "PDF Editor" --onedir --windowed \
  --add-data "app.html:." \
  --hidden-import pymupdf --hidden-import flask --hidden-import PIL \
  --hidden-import webview --hidden-import webview.platforms.cocoa \
  --hidden-import objc --hidden-import Foundation --hidden-import AppKit --hidden-import WebKit \
  --noconfirm server.py
```

`dist/PDF Editor.app` が生成されます。

## 技術構成

- **バックエンド**: Flask + PyMuPDF（全ハンドラを単一ロックで直列化し、PyMuPDF の非スレッドセーフな Document へのアクセスを保護）
- **フロントエンド**: HTML/CSS/JS（単一ファイル）。すべての API 呼び出しは応答の `ok` / `error` を検査
- **デスクトップ表示 / ファイルダイアログ**: pywebview（`js_api` でネイティブの開く／保存ダイアログを提供）
- **日本語フォント**: システムの Unicode フォント（Arial Unicode / ヒラギノ等）を検出して埋め込み、保存時にサブセット化

## 注意事項

- 編集テキスト・追加テキストは埋め込み Unicode フォントで描画されるため、元の書体とは異なる場合があります（位置は保持）。絵文字など一部グリフは未対応。
- ブラウザで直接開いた場合（pywebview 外）は、開く＝アップロード、保存＝ダウンロードにフォールバックします。
