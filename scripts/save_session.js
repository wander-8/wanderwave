// note.comへのログインは一度だけ、ここで"あなた自身の手で"行う。
//
// note.comのログインフォーム(https://note.com/login)はreCAPTCHAで保護されて
// いるため、スクリプトでメールアドレス・パスワードを自動入力してログインまで
// 突破する作りにはしていない(ボット対策を回避する実装はしない方針)。
//
// 【実際に使ってみて詰まった2点への対応】
// 1. reCAPTCHAが解けない/反応しない:
//    実機のGoogle Chrome(channel:'chrome')に切り替えても、Playwrightが
//    Chrome DevTools Protocol経由で操作していること自体をreCAPTCHAが検知し、
//    チェック/画像選択が何度やっても通らないことを確認済み(ブラウザの種類を
//    変えても直らない)。この場合は本スクリプトではなく
//    scripts/import_cookies.js を使ってほしい(普段使いの自動化なしの
//    Chromeでログインし、Cookieだけを取り込む方式。詳しくはそちらの
//    コメント参照)。本スクリプトはreCAPTCHAがたまたま通る環境向けに残す。
// 2. 「Googleでログイン」ボタンが使えない:
//    これは上記の対策では直らない。GoogleはOAuthログインを「自動化ツール
//    (CDP)から操作されているブラウザ」からは意図的にブロックするポリシーを
//    持っており(ブラウザの種類やフラグを偽装しても回避できない、回避する
//    実装もしない)、Playwrightに限らずどんな自動化ツールでも原理的に通らない。
//    note側にメールアドレス+パスワードでのログイン手段があるなら、今回の
//    自動化用にはそちらを使ってほしい(「パスワードを忘れた方」からパス
//    ワードを設定できる場合がある)。
//
// このスクリプトは:
//   1. 普通のブラウザ(ヘッドあり)でnote.comのログイン画面を開く
//   2. あなたが画面上で手動でログインする(reCAPTCHAも自分で解く)
//   3. ターミナルでEnterを押すと、ログイン済みセッション(Cookie等)を
//      ./note_session.json に保存して終了する
//
// 以降は auto_note_draft.js が note_session.json を読み込むだけで、ログイン
// 操作なしに投稿画面へ直行できる(セッションの有効期限が切れたら、また
// このスクリプトを実行し直せばよい)。
//
// 実行方法: npm run note:login

import { chromium } from 'playwright';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const SESSION_FILE = './note_session.json';
const LOGIN_URL = 'https://note.com/login';

async function launchRealChromeIfAvailable() {
  const launchArgs = {
    headless: false,
    // "Chromeは自動テストソフトウェアによって制御されています"バーの原因に
    // なるフラグを切り、reCAPTCHA側の自動化判定を少しでも減らす。
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    // 実機の本物のGoogle Chromeを使う(Playwright同梱のChromium for Testing
    // より自動化ブラウザとして検知されにくい)。
    return await chromium.launch({ ...launchArgs, channel: 'chrome' });
  } catch (err) {
    console.warn('実機のGoogle Chromeが見つからなかったため、Playwright同梱のChromiumで起動します。');
    console.warn('(reCAPTCHAが通りにくい場合はGoogle Chromeをインストールしてから再試行してください)');
    return await chromium.launch(launchArgs);
  }
}

async function main() {
  const browser = await launchRealChromeIfAvailable();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(LOGIN_URL);

  const rl = readline.createInterface({ input, output });
  await rl.question(
    '\nブラウザ画面で手動でログインを完了し、完了したらターミナルでEnterを押してください\n' +
    '(「Googleでログイン」はこの仕組みでは使えません。メールアドレス+パスワードでログインしてください)\n',
  );
  rl.close();

  await context.storageState({ path: SESSION_FILE });
  console.log(`セッションを ${SESSION_FILE} に保存しました。`);
  console.log('このファイルはログイン情報そのものなので、Gitには絶対にコミットしないでください(.gitignore済み)。');

  await browser.close();
}

main().catch((err) => {
  console.error('ログインセットアップ中にエラーが発生しました:', err);
  process.exit(1);
});
