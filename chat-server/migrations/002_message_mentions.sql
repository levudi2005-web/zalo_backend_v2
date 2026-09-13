-- P2.2: upgrade the existing message_mentions table without dropping rows.
ALTER TABLE message_mentions
  ADD COLUMN username_snapshot VARCHAR(50) NOT NULL;

ALTER TABLE message_mentions
  ADD COLUMN mention_start INT NOT NULL;

ALTER TABLE message_mentions
  ADD COLUMN mention_end INT NOT NULL;

-- Keep a message_id index available while replacing the old unique key because
-- it is also needed by the message foreign key.
ALTER TABLE message_mentions
  ADD KEY fk_mention_message_support (message_id);

ALTER TABLE message_mentions
  DROP INDEX uk_message_mention;

ALTER TABLE message_mentions
  ADD UNIQUE KEY uk_message_mention_position (message_id, mentioned_user_id, mention_start);

ALTER TABLE message_mentions
  DROP INDEX fk_mention_message_support;
