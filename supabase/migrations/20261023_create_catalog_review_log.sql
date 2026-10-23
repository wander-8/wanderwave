-- Create catalog review log table for manga/book expansion tracking
CREATE TABLE public.catalog_review_log (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('anilist', 'myanimelist', 'ndl', 'google_books')),
  type TEXT NOT NULL CHECK (type IN ('manga', 'book')),
  title TEXT NOT NULL,
  title_en TEXT,
  country TEXT,
  language TEXT,
  judgment TEXT NOT NULL CHECK (judgment IN ('accept', 'reject', 'manual_review')),
  judgment_reason TEXT,
  judgment_confidence FLOAT CHECK (judgment_confidence >= 0 AND judgment_confidence <= 1),
  approved_at TIMESTAMP,
  approved_by TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_catalog_review_judgment ON public.catalog_review_log(judgment, created_at DESC);
CREATE INDEX idx_catalog_review_type_source ON public.catalog_review_log(type, source);
CREATE INDEX idx_catalog_review_created_at ON public.catalog_review_log(created_at DESC);

ALTER TABLE public.catalog_review_log ENABLE ROW LEVEL SECURITY;
