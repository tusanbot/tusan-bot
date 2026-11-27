CREATE TABLE IF NOT EXISTS published_events (
  event_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('processing', 'sent', 'failed')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_published_events_state
  ON published_events(state, created_at);
