import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const NEEDS_VERIFIED_EMAIL_MESSAGE = '通報にはメールの登録（1分で終わります）が必要です'
const ALREADY_REPORTED_MESSAGE = 'このレビューは既に通報済みです'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// submit-review/index.tsと同じ構成(呼び出しユーザー自身のJWTでクライアントを
// 作るので、RLS(本人のみ・メール確認済みユーザーのみ・review_idごとに1回まで)
// はこのエッジ関数を経由しても一切バイパスされない。CAPTCHA検証はその手前の
// 追加ゲート)。自動非表示(しきい値到達でmovie_reviews.is_hiddenを立てる)は
// DBトリガー側(handle_review_report)で行うため、ここではreview_reportsへの
// INSERTだけに専念する。
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  let payload: { review_id?: number; reason?: string; captcha_token?: string }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'リクエストの形式が正しくありません' }, 400)
  }

  const { review_id, reason, captcha_token } = payload

  if (typeof review_id !== 'number') {
    return json({ error: 'review_idが必要です' }, 400)
  }
  const reasonText = typeof reason === 'string' ? reason.trim().slice(0, 100) : null

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: '認証が必要です' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) {
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

  const { error: insertErr } = await userClient
    .from('review_reports')
    .insert({ review_id, reporter_user_id: user.id, reason: reasonText })

  if (insertErr) {
    // review_reports(review_id, reporter_user_id)のUNIQUE制約違反
    // (postgresのエラーコード23505)は「既に通報済み」として、
    // エラーというより案内として返す。
    if (insertErr.code === '23505' || /duplicate key/i.test(insertErr.message || '')) {
      return json({ error: ALREADY_REPORTED_MESSAGE }, 409)
    }
    const message = insertErr.message && insertErr.message.includes('row-level security')
      ? NEEDS_VERIFIED_EMAIL_MESSAGE
      : insertErr.message
    return json({ error: message }, 400)
  }

  return json({ success: true })
})
