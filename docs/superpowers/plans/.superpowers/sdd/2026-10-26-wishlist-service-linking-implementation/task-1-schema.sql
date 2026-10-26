-- Task 1: Supabase テーブル + RLS 設定

-- Step 1: user_service_subscriptions テーブル作成
CREATE TABLE IF NOT EXISTS user_service_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(user_id, service_name)
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_user_service_subscriptions_user_id
  ON user_service_subscriptions(user_id);

-- Step 2: RLS 有効化
ALTER TABLE user_service_subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS ポリシー 1: SELECT（自分のデータのみ読み取り）
CREATE POLICY "Users can read their own service subscriptions"
  ON user_service_subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

-- RLS ポリシー 2: INSERT（自分のデータのみ挿入）
CREATE POLICY "Users can insert their own service subscriptions"
  ON user_service_subscriptions
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS ポリシー 3: UPDATE（自分のデータのみ更新）
CREATE POLICY "Users can update their own service subscriptions"
  ON user_service_subscriptions
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- RLS ポリシー 4: DELETE（自分のデータのみ削除）
CREATE POLICY "Users can delete their own service subscriptions"
  ON user_service_subscriptions
  FOR DELETE
  USING (auth.uid() = user_id);