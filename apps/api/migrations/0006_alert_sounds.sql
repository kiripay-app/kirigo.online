-- Phones running a KiriGo Driver app that has KiriGo's own alert sounds (res/raw/kirigo_offer, kirigo_job) and the
-- channels that use them ("kirigo_offers", "kirigo_jobs"). Older copies of the app keep getting the old channels,
-- so their alerts never go silent.
ALTER TABLE push_tokens ADD COLUMN sounds INTEGER NOT NULL DEFAULT 0;
