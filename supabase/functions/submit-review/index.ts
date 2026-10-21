import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const NEEDS_VERIFIED_EMAIL_MESSAGE = '投稿にはメールの登録（1分で終わります）が必要です'
const SUSPENDED_MESSAGE = 'このアカウントは投稿を停止されています'

// オーナー指摘(2026-10-21):「レビューは使っちゃいけない単語まとめてそれを見ながら
// その単語を出したユーザーにはどう対処するか考えるべきだと思う。自由なのはいいけど、
// 例えばえっちって言葉は使い方によってはそこまで大きく問題ではない。でも...明らかな
// 貶めなどを考えるとどうなのかと思う」。
// 「えっち」のような作品描写語(状況によって正当な批評になる)は対象外にし、
// 対象は「人への直接的な攻撃・脅迫」に絞る(作品やキャラクターへの酷評は
// 表現の自由として許容し、通報システム(review_reports→3回で停止)を安全網とする)。
// BLOCKED_WORDSは単純な脅迫語、PERSON_ATTACK_PATTERNは「役職(監督/キャスト等)+
// 侮辱語」の組み合わせだけを狙い撃ちする(侮辱語だけを広く弾くと「気持ち悪い
// 怪物」のような作品描写まで誤検出するため)。
const BLOCKED_WORDS = ['死ね', '殺すぞ', '殺してやる', '消えろ']
const PERSON_ATTACK_PATTERN = /(監督|キャスト|演者|俳優|女優|声優|作者|脚本家|原作者)[^。！？\n]{0,12}(気持ち悪い|きもい|キモい|頭がおかしい|ブサイク|クズ|バカ|死ね)/

// オーナー追加指摘(2026-10-21):「違法視聴・違法アップロードの示唆」「確定していない
// 噂・事実無根のゴシップ」は「これらが出たらまず投稿させないでほしい」とのことで、
// 人への攻撃と同じ扱い(投稿自体を止める)にする。盗作/パクリは「事実確認の取れて
// いない著作権侵害の主張」に当たるため対象にするが、作品そのものへの酷評
// (「ひどい映画だ」等)は引き続き許容する。
const ILLEGAL_OR_DEFAMATION_WORDS = ['海賊版', '割れ', '違法アップ', '違法視聴', '盗作', 'パクリ']
const ILLEGAL_VIEWING_PATTERN = /(youtube|ユーチューブ)\s*(で|にて)\s*(観|見)た/i
const RUMOR_PATTERN = /(制作現場|現場)[^。！？\n]{0,15}(揉め事|トラブル)/

function findBlockedWord(text: string): string | null {
  const hit = BLOCKED_WORDS.find((w) => text.includes(w))
  if (hit) return hit
  const illegalHit = ILLEGAL_OR_DEFAMATION_WORDS.find((w) => text.includes(w))
  if (illegalHit) return illegalHit
  const personAttack = text.match(PERSON_ATTACK_PATTERN)
  if (personAttack) return personAttack[0]
  const illegalViewing = text.match(ILLEGAL_VIEWING_PATTERN)
  if (illegalViewing) return illegalViewing[0]
  const rumor = text.match(RUMOR_PATTERN)
  return rumor ? rumor[0] : null
}

// オーナー追加指摘:「結末・重要ギミックの暴露」「未公開・先行情報」は投稿を止める
// のではなく「これらが出たら自動でネタバレ扱いされるようにしてほしい」との
// ことなので、has_spoilerを強制的にtrueにするだけに留める(投稿自体は許可する)。
// 「死ぬ」は「死ぬほど面白かった」のような強調表現で頻出するため単独では使わず、
// 「主役/主人公/ヒロインが(死ぬ|死亡|殺される)」の組み合わせに限定する。
const SPOILER_INDICATOR_WORDS = ['犯人', '黒幕', '夢オチ', '叙述トリック', 'リーク情報', '試写会で観た', '試写会で見た']
const SPOILER_DEATH_PATTERN = /(主役|主人公|ヒロイン|ヒーロー)が?(死ぬ|死亡する|殺される)/

function containsSpoilerIndicator(text: string): boolean {
  if (SPOILER_INDICATOR_WORDS.some((w) => text.includes(w))) return true
  return SPOILER_DEATH_PATTERN.test(text)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  let payload: { movie_id?: number; review_text?: string; captcha_token?: string; has_spoiler?: boolean }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'リクエストの形式が正しくありません' }, 400)
  }

  const { movie_id, review_text, captcha_token, has_spoiler } = payload

  if (typeof movie_id !== 'number') {
    return json({ error: 'movie_idが必要です' }, 400)
  }
  const text = typeof review_text === 'string' ? review_text.trim() : ''
  if (!text) {
    return json({ error: 'レビュー内容を入力してください' }, 400)
  }
  if (text.length > 200) {
    return json({ error: 'レビューは200字以内で入力してください' }, 400)
  }
  const blockedHit = findBlockedWord(text)
  if (blockedHit) {
    return json({ error: `投稿できない内容が含まれています（${blockedHit}）。作品への感想は自由ですが、人への攻撃的な表現・違法視聴の言及・未確認のうわさは避けてください` }, 400)
  }
  const hasSpoiler = has_spoiler === true || containsSpoilerIndicator(text)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: '認証が必要です' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: 'サーバー側の設定が未完了です' }, 500)
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  })

  const { data: { user }, error: userErr } = await userClient.auth.getUser()
  if (userErr || !user) {
    return json({ error: '認証が必要です' }, 401)
  }

  if (user.is_anonymous !== false || !user.email_confirmed_at) {
    return json({ error: NEEDS_VERIFIED_EMAIL_MESSAGE }, 403)
  }

  // オーナー指摘:「通報3回された同じ人はアカウント停止でもいいと思う。同じメアド
  // 使ってたら記録しておいて二度と使えないようにしてほしい」。停止済みアカウント・
  // 停止済みメール(別アカウントで再登録した場合も含む)からの投稿を止める。
  // RLS越しのanonクライアントではprofiles/banned_emailsの内部状態を見られないため、
  // service_roleで確認する。
  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const { data: profile } = await adminClient.from('profiles').select('is_suspended').eq('id', user.id).maybeSingle()
  if (profile?.is_suspended) {
    return json({ error: SUSPENDED_MESSAGE }, 403)
  }
  if (user.email) {
    const { data: banned } = await adminClient.from('banned_emails').select('email').eq('email', user.email.toLowerCase()).maybeSingle()
    if (banned) {
      return json({ error: SUSPENDED_MESSAGE }, 403)
    }
  }

  if (!captcha_token) {
    return json({ error: 'CAPTCHA認証を完了してください' }, 400)
  }

  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')
  if (!secret) {
    console.error('TURNSTILE_SECRET_KEY is not configured')
    return json({ error: 'サーバー側の設定が未完了です。管理者にお問い合わせください' }, 500)
  }

  const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: captcha_token })
  })
  const verifyJson = await verifyRes.json().catch(() => ({ success: false }))
  if (!verifyJson.success) {
    return json({ error: 'CAPTCHA認証に失敗しました。もう一度お試しください' }, 400)
  }

  const { error: upsertErr } = await userClient
    .from('movie_reviews')
    .upsert({ movie_id, user_id: user.id, review_text: text, has_spoiler: hasSpoiler }, { onConflict: 'movie_id,user_id' })

  if (upsertErr) {
    const message = upsertErr.message && upsertErr.message.includes('row-level security')
      ? NEEDS_VERIFIED_EMAIL_MESSAGE
      : upsertErr.message
    return json({ error: message }, 400)
  }

  return json({ success: true })
})
