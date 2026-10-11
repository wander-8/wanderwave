import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const NEEDS_VERIFIED_EMAIL_MESSAGE = '投稿にはメールの登録（1分で終わります）が必要です'

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
  const hasSpoiler = has_spoiler === true

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: '認証が必要です' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) {
    return json({ error: 'サーバー側の設定が未完了です' }, 500)
  }

  // 呼び出しユーザー自身のJWTをそのまま使ってクライアントを作るので、
  // RLS(本人のみ・メール確認済みユーザーのみ・review_countによる表現度ゲート・
  // 投稿レート制限など)はこのエッジ関数を経由しても一切バイパスされない。
  // CAPTCHA検証はその手前に追加される、あくまで「もう1段階のゲート」。
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  })

  const { data: { user }, error: userErr } = await userClient.auth.getUser()
  if (userErr || !user) {
    return json({ error: '認証が必要です' }, 401)
  }

  // メール確認済みユーザー限定。CAPTCHA検証(Cloudflareへの通信)を待たせる前に
  // ここで弾いておく。
  if (user.is_anonymous !== false || !user.email_confirmed_at) {
    return json({ error: NEEDS_VERIFIED_EMAIL_MESSAGE }, 403)
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
