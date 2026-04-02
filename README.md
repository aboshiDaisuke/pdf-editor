# PDF Editor

ローカルで動作するPDF編集アプリ。PyMuPDFによるテキスト書き換え、画像挿入、図形描画などに対応。

## 機能

- PDF読み込み（ドラッグ&ドロップ対応）
- テキスト編集（既存テキストの書き換え）
- テキスト追加
- 画像挿入
- 図形描画（四角・楕円・直線）
- ページ追加・削除（複数選択一括削除対応）・並べ替え（ドラッグ&ドロップ）
- ズーム
- 元に戻す / やり直し
- 上書き保存 / 名前を付けて保存

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

- **バックエンド**: Flask + PyMuPDF（テキスト編集はredaction APIで実現）
- **フロントエンド**: HTML/CSS/JS（単一ファイル）
- **デスクトップ表示**: pywebview
