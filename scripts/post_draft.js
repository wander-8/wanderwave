// 手書き(またはAIが個別に書いた)のMarkdown記事ファイルを、noteの下書きとして
// 投稿するスクリプト。auto_note_draft.jsがSupabaseから機械的に記事を組み立てる
// のに対し、こちらは完成済みの記事ファイルをそのまま流し込むためのもの。
//
// 【前提】./note_session.json が必要(npm run note:login または
// scripts/import_cookies.js で作成する)。
//
// 使い方: node scripts/post_draft.js scripts/drafts/記事ファイル.md [見出し画像のパス]
// 見出し画像を省略した場合は画像なしで下書き保存する。
//
// Markdownの一行目「# タイトル」をタイトル欄に、それ以降を本文欄に入れる。
// note.comの本文入力欄はplaywrightで1行ずつ文字として打ち込む作りのため、
// Markdownの見出し記号(#, ##)や区切り線(---)はそのまま記号として入力
// されてしまう。読みやすさのため、simpleMarkdownToPlainで記号を取り除いた
// 上で入力する(note側の見出し書式そのものは付かず、プレーンな改行区切りに
// なる。見た目を整えたい場合は下書き保存後にnoteの編集画面で見出しを
// 設定し直してほしい)。

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const AUTH_FILE = './note_session.json';
const NEW_NOTE_URL = 'https://note.com/notes/new';
const DEBUG_DIR = './scripts/debug';

function parseMarkdown(raw) {
  const lines = raw.split('\n');
  const titleLineIdx = lines.findIndex((l) => l.trim().startsWith('# '));
  if (titleLineIdx === -1) {
    throw new Error('1行目(または先頭付近)に "# タイトル" の形式でタイトルが見当たりません。');
  }
  const title = lines[titleLineIdx].replace(/^#\s+/, '').trim();
  const bodyLines = lines.slice(titleLineIdx + 1);
  return { title, bodyLines };
}

// Markdownの見出し記号・区切り線を取り除き、プレーンな行の配列にする。
function simpleMarkdownToPlain(bodyLines) {
  const out = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (line === '---') {
      out.push(''); // 区切り線は空行に置き換える
      continue;
    }
    out.push(line.replace(/^#{1,6}\s+/, '')); // "## 見出し" -> "見出し"
  }
  // 連続する空行を1つにまとめる
  const collapsed = [];
  for (const l of out) {
    if (l === '' && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(l);
  }
  // 先頭・末尾の空行を削る
  while (collapsed[0] === '') collapsed.shift();
  while (collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed;
}

async function findFirst(page, locators) {
  for (const make of locators) {
    const loc = make();
    try {
      await loc.first().waitFor({ state: 'visible', timeout: 4000 });
      return loc.first();
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

async function saveDebugScreenshot(page, name) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.error(`デバッグ用スクリーンショットを保存しました: ${file}`);
  } catch (err) {
    console.error('スクリーンショットの保存にも失敗しました', err);
  }
}

async function main() {
  const inputPath = process.argv[2];
  const imagePath = process.argv[3] || null;
  if (!inputPath) {
    console.error('使い方: node scripts/post_draft.js <Markdownファイルパス> [見出し画像のパス]');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`${inputPath} が見つかりません。`);
    process.exit(1);
  }
  if (imagePath && !fs.existsSync(imagePath)) {
    console.error(`見出し画像 ${imagePath} が見つかりません。`);
    process.exit(1);
  }
  if (!fs.existsSync(AUTH_FILE)) {
    console.error(`${AUTH_FILE} が見つかりません。先にログイン情報を用意してください(npm run note:login またはscripts/import_cookies.js)。`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf-8');
  const { title, bodyLines } = parseMarkdown(raw);
  const plainLines = simpleMarkdownToPlain(bodyLines);

  console.log(`タイトル: ${title}`);
  console.log(`本文: ${plainLines.length}行`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  console.log(`${NEW_NOTE_URL} を開いています…`);
  await page.goto(NEW_NOTE_URL, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('/login')) {
    console.error('保存済みセッションでログインできませんでした(期限切れの可能性)。');
    console.error('セッションを更新してもう一度実行してください。');
    await browser.close();
    process.exit(1);
  }

  // 見出し画像(アイキャッチ)。エディタ左上の「画像を追加」アイコンを押すと
  // 「画像をアップロード/記事にあう画像を選ぶ/Adobe Expressで画像をつくる」の
  // 3択メニューが出る(noteのUI調査で確認済み、推奨サイズ1280×670px)。
  // 「画像をアップロード」を押すとinput[type=file]が現れるので、そこへ直接
  // setInputFilesする(OSのネイティブファイル選択ダイアログは経由しない)。
  if (imagePath) {
    try {
      await page.locator('[aria-label="画像を追加"]').first().click();
      await page.getByText('画像をアップロード').click();
      const fileInput = page.locator('input[type="file"]');
      await fileInput.waitFor({ state: 'attached', timeout: 5000 });
      await fileInput.setInputFiles(imagePath);
      // アップロード後、トリミング確認のモーダルが出ることがある
      // (「設定する」のようなボタン)。出ていれば押して確定する。
      const confirmBtn = await findFirst(page, [
        () => page.getByRole('button', { name: '設定する' }),
        () => page.getByRole('button', { name: '保存' }),
      ]);
      if (confirmBtn) await confirmBtn.click();
      await page.waitForTimeout(1000);
      console.log('見出し画像をアップロードしました。');
    } catch (err) {
      console.error('見出し画像のアップロードに失敗しました(本文の投稿は続行します)', err);
      await saveDebugScreenshot(page, 'eyecatch-upload-failed');
    }
  }

  const titleField = await findFirst(page, [
    () => page.getByPlaceholder('記事タイトル'),
    () => page.getByRole('textbox', { name: /タイトル/ }),
    () => page.locator('textarea').first(),
  ]);
  if (!titleField) {
    console.error('タイトル入力欄が見つかりませんでした。');
    await saveDebugScreenshot(page, 'title-not-found');
    await browser.close();
    process.exit(1);
  }
  await titleField.click();
  await titleField.fill(title);

  const bodyField = await findFirst(page, [
    () => page.locator('.ProseMirror[contenteditable="true"]'),
    () => page.getByRole('textbox', { name: /本文|note本文/ }),
    () => page.locator('[contenteditable="true"]').last(),
  ]);
  if (!bodyField) {
    console.error('本文入力欄が見つかりませんでした。');
    await saveDebugScreenshot(page, 'body-not-found');
    await browser.close();
    process.exit(1);
  }
  await bodyField.click();
  for (let i = 0; i < plainLines.length; i++) {
    await bodyField.pressSequentially(plainLines[i], { delay: 5 });
    if (i < plainLines.length - 1) await page.keyboard.press('Enter');
  }

  const draftButton = await findFirst(page, [
    () => page.getByRole('button', { name: '下書き保存' }),
    () => page.getByText('下書き保存', { exact: true }),
  ]);
  if (!draftButton) {
    console.error('「下書き保存」ボタンが見つかりませんでした。入力まではできているので、手動で保存してください。');
    await saveDebugScreenshot(page, 'draft-button-not-found');
    console.log('ブラウザは開いたままにしてあります。確認後、手動で閉じてください。');
    return;
  }
  await draftButton.click();
  await page.waitForTimeout(1500);

  console.log('下書き保存を実行しました。noteのマイページで内容を確認してください。');
  await browser.close();
}

main().catch(async (err) => {
  console.error('エラーが発生しました:', err);
  process.exit(1);
});
