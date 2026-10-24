// Wanderの作品データからnote記事を自動生成し、noteの下書きとして保存するスクリプト。
//
// 【前提】./note_session.json が必要。先に `npm run note:login`
// (scripts/save_session.js)を一度実行し、あなた自身の手でnote.comに手動
// ログインしてセッションを保存しておくこと。
// (note.comのログインフォームはreCAPTCHA保護されているため、このスクリプトは
//  ログインそのものは自動化しない。note_session.jsonを読み込んで使うだけ)
//
// 【処理の流れ】
//   1. Supabaseから感情タグ付きの作品を3件取得し、note用の記事文面を組み立てる
//   2. 保存済みセッション(note_session.json)でPlaywrightを起動し、
//      note.comの投稿画面に直行
//   3. タイトル欄・本文欄に生成した文面を入力する
//   4. 「下書き保存」ボタンを押して終了する
//
// 実行方法: npm run note:draft
//
// 【注意】noteの編集画面は未ログインだと開けず、この場で実データを見ながら
// セレクタを検証できなかった。タイトル欄・本文欄・下書き保存ボタンは
// role/placeholder等のアクセシビリティ情報を優先して探すようにしてあるが、
// 初回実行時は失敗したら scripts/debug/ に保存されるスクリーンショットと
// エラーメッセージを見て、報告してほしい。

import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = './note_session.json';
const DEBUG_DIR = path.join(__dirname, 'debug');
const NEW_NOTE_URL = 'https://note.com/notes/new';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const WANDER_SITE_URL = process.env.WANDER_SITE_URL || 'https://wander-8.site';

function assertEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (missing.length) {
    console.error(`.envに${missing.join(', ')}が設定されていません。.env.exampleを参考に.envを作成してください。`);
    process.exit(1);
  }
  if (!fs.existsSync(AUTH_FILE)) {
    console.error(`${AUTH_FILE} が見つかりません。先に \`npm run note:login\` を実行してnote.comに手動ログインしてください。`);
    process.exit(1);
  }
}

const MEDIA_LABELS = {
  movie: '映画',
  anime: 'アニメ',
  drama: 'ドラマ',
  manga: '漫画',
  novel: '本',
  music: '音楽',
};

function mediaLabel(row) {
  if (row.is_anime) return MEDIA_LABELS.anime;
  if (row.is_drama) return MEDIA_LABELS.drama;
  if (row.is_manga) return MEDIA_LABELS.manga;
  if (row.is_novel) return MEDIA_LABELS.novel;
  if (row.is_music) return MEDIA_LABELS.music;
  return MEDIA_LABELS.movie;
}

const MOVIE_SELECT_COLUMNS = 'id, title, emotion_tags, synopsis_excerpt, synopsis, is_anime, is_drama, is_manga, is_novel, is_music';

async function fetchFeaturedMovies(supabase, count = 3) {
  // 感情タグ(emotion_tags)が付いている作品の中からランダムに選ぶ。
  //
  // 当初はcount()で総件数を数えてから大きいOFFSETでページングしていたが、
  // 実機で検証したところ両方ともこのDBでは問題が起きた:
  //   - count:'exact'は9万件超のフィルタ済み行を正確に数えるクエリが
  //     サーバー側で500エラーになる
  //   - 大きいOFFSET(数万単位)はそれだけでstatement timeout(57014)になる
  // 代わりに、movies.idの主キーインデックスが効く「ランダムなid以上を
  // idの昇順でLIMIT件数ぶん読む」方式にする(OFFSETを使わないので
  // idがどれだけ大きくても高速)。
  const { data: maxRow, error: maxErr } = await supabase
    .from('movies')
    .select('id')
    .order('id', { ascending: false })
    .limit(1)
    .single();
  if (maxErr) throw maxErr;
  const maxId = maxRow.id;

  const randomStart = Math.floor(Math.random() * maxId) + 1;
  const { data, error } = await supabase
    .from('movies')
    .select(MOVIE_SELECT_COLUMNS)
    .not('emotion_tags', 'is', null)
    .gte('id', randomStart)
    .order('id', { ascending: true })
    .limit(count * 10);
  if (error) throw error;

  let withTags = (data || []).filter((row) => row.emotion_tags && row.emotion_tags.length);

  // ランダムな開始点がidの末尾付近だった場合に備え、不足していたら先頭から
  // 読み直す(id範囲全体のうち95%近くにemotion_tagsが付いているので、
  // 通常はこのフォールバックには入らない)。
  if (withTags.length < count) {
    const { data: fallbackData, error: fallbackErr } = await supabase
      .from('movies')
      .select(MOVIE_SELECT_COLUMNS)
      .not('emotion_tags', 'is', null)
      .order('id', { ascending: true })
      .limit(count * 10);
    if (fallbackErr) throw fallbackErr;
    withTags = (fallbackData || []).filter((row) => row.emotion_tags && row.emotion_tags.length);
  }

  // Fisher-Yatesで軽くシャッフルしてから先頭count件を採用する。
  for (let i = withTags.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [withTags[i], withTags[j]] = [withTags[j], withTags[i]];
  }
  return withTags.slice(0, count);
}

function buildArticle(movies) {
  const today = new Date();
  const dateLabel = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const title = `${dateLabel}、気分で選ぶ3本 - Wanderのおすすめ`;

  const intro = [
    '映画・アニメ・ドラマ・漫画・小説・音楽を「今の気分」から探せるサイト「Wander」から、',
    '感情タグが付いている作品の中からランダムに3本を選んでみました。',
    '',
  ].join('\n');

  const body = movies
    .map((m, i) => {
      const label = mediaLabel(m);
      const tags = (m.emotion_tags || []).join('、');
      const synopsis = (m.synopsis_excerpt || m.synopsis || '').trim();
      const lines = [`## ${i + 1}. ${m.title}(${label})`];
      if (tags) lines.push(`気分タグ: ${tags}`);
      if (synopsis) lines.push(synopsis);
      return lines.join('\n');
    })
    .join('\n\n');

  // 注意: Wanderは作品ごとの固有URL(ディープリンク)を持っていないため、
  // トップページのリンクのみ案内する(存在しないURLをでっち上げない)。
  const outro = [
    '',
    `Wanderでは、こんな風に気分から作品を探せます → ${WANDER_SITE_URL}`,
    '気になった作品はサイト内の検索で探してみてください。',
  ].join('\n');

  const bodyText = `${intro}${body}${outro}`;
  return { title, bodyText };
}

// セレクタはnote.comの実データ(ログイン後の編集画面)を見て検証できていない
// ため、複数候補を順番に試す。見つからなければ例外を投げる。
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
  assertEnv();

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('Supabaseから作品を3件取得しています…');
  const movies = await fetchFeaturedMovies(supabase, 3);
  if (movies.length < 3) {
    console.error(`感情タグ付きの作品が${movies.length}件しか見つかりませんでした。処理を中止します。`);
    process.exit(1);
  }
  const { title, bodyText } = buildArticle(movies);
  console.log('--- 生成した記事 ---');
  console.log(`タイトル: ${title}`);
  console.log(bodyText);
  console.log('--------------------');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  console.log(`${NEW_NOTE_URL} を開いています…`);
  await page.goto(NEW_NOTE_URL, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('/login')) {
    console.error('保存済みセッションでログインできませんでした(期限切れの可能性)。');
    console.error('`npm run note:login` をもう一度実行してセッションを更新してください。');
    await browser.close();
    process.exit(1);
  }

  // タイトル欄。note.comのタイトル欄はtextareaで、プレースホルダーが
  // 「記事タイトル」であることが多い(一般公開情報ベース、未検証)。
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

  // 本文欄。note.comの本文はリッチテキストエディタ(contenteditable)。
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
  // contenteditableへの複数行入力は.fill()が効かないことがあるため、
  // pressSequentiallyで1行ずつ入力しEnterで改行する。
  const lines = bodyText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    await bodyField.pressSequentially(lines[i], { delay: 5 });
    if (i < lines.length - 1) await page.keyboard.press('Enter');
  }

  // 下書き保存ボタン。アクセシブルネーム(ボタンのテキスト)で探すのが
  // 一番クラス名の変化に強い。
  const draftButton = await findFirst(page, [
    () => page.getByRole('button', { name: '下書き保存' }),
    () => page.getByText('下書き保存', { exact: true }),
  ]);
  if (!draftButton) {
    console.error('「下書き保存」ボタンが見つかりませんでした。入力まではできているので、手動で保存してください。');
    await saveDebugScreenshot(page, 'draft-button-not-found');
    // ここでは閉じずにブラウザを残し、手動保存できるようにする。
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
