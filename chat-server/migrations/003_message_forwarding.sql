-- P2.3: keep a reference to the original message when forwarding.
ALTER TABLE messages
  ADD COLUMN forwarded_from_message_id BIGINT NULL;

ALTER TABLE messages
  ADD COLUMN forwarded_by_user_id INT NULL;

ALTER TABLE messages
  ADD COLUMN forwarded_at DATETIME NULL;

ALTER TABLE messages
  ADD KEY idx_messages_forwarded_from (forwarded_from_message_id),
  ADD KEY idx_messages_forwarded_by (forwarded_by_user_id);
