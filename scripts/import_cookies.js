// Cookie-Editor拡張(https://cookie-editor.com/)でエクスポートしたnote.comの
// CookieのJSONを、Playwrightのstorage state形式(./note_session.json)に
// 変換するスクリプト。
//
// 【背景】Playwright(自動化ブラウザ)でnote.comにログインしようとすると、
// 本物のChromeを使っていてもreCAPTCHAが自動化ブラウザとして検知して
// 通らないことが実際に確認された。そこで、ログインそのものは普段使いの
// 普通のChrome(自動化なし、reCAPTCHAも普通に解ける)で行い、ログイン後の
// Cookieだけをここで取り込む方式にする。
//
// 【手順】
//   1. Chromeに拡張機能「Cookie-Editor」を入れる
//   2. 普段のChromeでnote.comに普通にログインする
//   3. note.comを開いた状態でCookie-Editorのアイコンをクリック→
//      「Export」→「Export as JSON」でクリップボードにコピーされる
//      (または画面の案内に従ってファイル保存する)
//   4. コピーした内容を1つのファイル(例: note_cookies_export.json)に保存する
//   5. 実行: node scripts/import_cookies.js note_cookies_export.json
//      → ./note_session.json が生成される
//   6. npm run note:draft でログイン操作なしに投稿できる
//
// note.com以外のサイトのCookieが混ざっていても、note.comドメインのものだけ
// 抽出するので安全(誤って広い範囲をエクスポートしてしまっても問題ない)。

import fs from 'node:fs';
import path from 'node:path';

const SESSION_FILE = './note_session.json';

function convertSameSite(raw) {
  const v = (raw || '').toString().toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'no_restriction' || v === 'none') return 'None';
  // "lax" / "unspecified" / 不明な値はLax扱いにする(Playwrightは
  // Strict/Lax/Noneの3種類しか受け付けないため)。
  return 'Lax';
}

function convertCookie(c) {
  const expires = c.session || c.expirationDate == null ? -1 : Math.round(c.expirationDate);
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: convertSameSite(c.sameSite),
  };
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('使い方: node scripts/import_cookies.js <Cookie-Editorで書き出したJSONファイル>');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`${inputPath} が見つかりません。`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  } catch (err) {
    console.error('JSONとして読み込めませんでした。Cookie-Editorの「Export as JSON」の内容をそのまま保存したファイルを指定してください。', err.message);
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error('配列(Cookieのリスト)ではないファイルです。Cookie-Editorの「Export as JSON」の出力をそのまま使ってください。');
    process.exit(1);
  }

  const noteCookies = raw.filter((c) => (c.domain || '').includes('note.com'));
  if (!noteCookies.length) {
    console.error('note.comドメインのCookieが見つかりませんでした。note.comを開いた状態でエクスポートし直してください。');
    process.exit(1);
  }

  const storageState = {
    cookies: noteCookies.map(convertCookie),
    origins: [],
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
  console.log(`note.comのCookie ${noteCookies.length}件を ${SESSION_FILE} に書き出しました。`);
  console.log('このファイルはログイン情報そのものなので、Gitには絶対にコミットしないでください(.gitignore済み)。');
  console.log('次は `npm run note:draft` を実行してください。');
}

main();
