-- ユーザーブロック機能
create table if not exists blocked_users (
  id bigserial primary key,
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  reason text,
  created_at timestamp with time zone default now(),
  unique(blocker_id, blocked_user_id)
);

-- モデレーション判定ログ
create table if not exists review_moderation_logs (
  id bigserial primary key,
  movie_review_id bigint not null references movie_reviews(id) on delete cascade,
  review_text text,
  severity text check (severity in ('none', 'warn', 'block')),
  ai_verdict text,
  spam_score numeric,
  violation_type text,
  flagged_words text[],
  created_at timestamp with time zone default now()
);

-- ユーザー違反履歴
create table if not exists user_violations (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  violation_type text check (violation_type in ('severe_content', 'harassment', 'spam', 'discrimination', 'misleading')),
  review_id bigint references movie_reviews(id) on delete set null,
  admin_note text,
  created_at timestamp with time zone default now()
);

-- スパム検出ログ
create table if not exists spam_detection_logs (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  movie_id bigint,
  spam_indicators text[],
  confidence numeric,
  created_at timestamp with time zone default now()
);

-- インデックス
create index if not exists idx_blocked_users_blocker on blocked_users(blocker_id);
create index if not exists idx_blocked_users_blocked on blocked_users(blocked_user_id);
create index if not exists idx_review_moderation_logs_severity on review_moderation_logs(severity);
create index if not exists idx_user_violations_user on user_violations(user_id);
create index if not exists idx_spam_detection_logs_user on spam_detection_logs(user_id);

-- RLS ポリシー
alter table blocked_users enable row level security;
create policy "ユーザーは自分がブロックした一覧を見られる" on blocked_users for select
  using (auth.uid() = blocker_id);
create policy "ユーザーは自分のブロック一覧を操作できる" on blocked_users for insert
  with check (auth.uid() = blocker_id);
create policy "ユーザーはブロック解除できる" on blocked_users for delete
  using (auth.uid() = blocker_id);

alter table review_moderation_logs enable row level security;
create policy "管理者のみモデレーションログを見られる" on review_moderation_logs for select
  using (auth.jwt() ->> 'role' = 'admin');

alter table user_violations enable row level security;
create policy "管理者のみ違反ログを見られる" on user_violations for select
  using (auth.jwt() ->> 'role' = 'admin');

alter table spam_detection_logs enable row level security;
create policy "管理者のみスパムログを見られる" on spam_detection_logs for select
  using (auth.jwt() ->> 'role' = 'admin');
