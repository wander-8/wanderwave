-- Create bug detection log table
CREATE TABLE public.bug_detection_log (
  id BIGSERIAL PRIMARY KEY,
  detected_at TIMESTAMP DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('security', 'performance', 'edge_function_error', 'data_quality')),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  title TEXT NOT NULL,
  description TEXT,
  remediation_url TEXT,
  is_fixed BOOLEAN DEFAULT FALSE,
  fixed_at TIMESTAMP,
  fixed_by TEXT,
  notes TEXT
);

CREATE INDEX idx_bug_detection_log_detected_at ON public.bug_detection_log(detected_at DESC);
CREATE INDEX idx_bug_detection_log_type_is_fixed ON public.bug_detection_log(type, is_fixed);

-- RLS: No policies (admin read-only, not exposed via Data API)
ALTER TABLE public.bug_detection_log ENABLE ROW LEVEL SECURITY;
