-- Temporary-inbox storage. Every row is one received message, addressed to a
-- throwaway inbox, and self-destructs at expires_at (a cron sweep deletes the
-- rows; queries also filter on it so an expired message is never shown even if
-- the sweep is late). Nothing here is meant to be kept.
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,   -- random opaque message id
  inbox       TEXT NOT NULL,      -- full recipient address, lowercased
  sender      TEXT,               -- From, display form
  subject     TEXT,
  preview     TEXT,               -- short snippet for the list
  body_text   TEXT,               -- sanitized plain-text body (never live HTML)
  analysis    TEXT,               -- JSON: auth verdict, sender check, trackers
  size        INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,   -- epoch ms
  expires_at  INTEGER NOT NULL    -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (inbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages (expires_at);
