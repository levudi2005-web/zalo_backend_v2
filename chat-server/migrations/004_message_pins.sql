-- P2.4: persist one pin per message without changing message content.
CREATE TABLE message_pins (
  id BIGINT NOT NULL AUTO_INCREMENT,
  message_id BIGINT NOT NULL,
  conversation_id INT NOT NULL,
  pinned_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_message_pin (message_id),
  KEY idx_message_pins_conversation (conversation_id, created_at),
  KEY idx_message_pins_user (pinned_by),
  CONSTRAINT fk_message_pins_message
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_message_pins_conversation
    FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_message_pins_user
    FOREIGN KEY (pinned_by) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
