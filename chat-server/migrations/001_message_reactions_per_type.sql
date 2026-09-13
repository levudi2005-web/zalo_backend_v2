-- P2.1: allow one reaction per type for each user and message.
-- Existing rows are preserved. The temporary message_id index keeps the
-- message foreign key valid while the old index is rebuilt.
ALTER TABLE message_reactions
  ADD UNIQUE KEY uk_reaction_migration (message_id, user_id, reaction_type),
  ADD KEY fk_reaction_message_support (message_id);

ALTER TABLE message_reactions
  DROP INDEX uk_message_reaction,
  DROP INDEX uk_reaction_migration;

ALTER TABLE message_reactions
  MODIFY reaction_type VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

ALTER TABLE message_reactions
  ADD UNIQUE KEY uk_message_reaction (message_id, user_id, reaction_type),
  DROP INDEX fk_reaction_message_support;
