ALTER TABLE published_events ADD COLUMN telegram_message_id INTEGER;
ALTER TABLE published_events ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_published_events_expiry
  ON published_events(state, expires_at);
