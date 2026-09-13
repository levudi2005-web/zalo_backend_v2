-- P2 Friend PIN: public, unique friend identifier for each user.
-- Apply once after checking the live users schema; existing rows are backfilled by the server migration script.
ALTER TABLE users ADD COLUMN friend_code VARCHAR(9) NULL;
ALTER TABLE users ADD UNIQUE KEY uk_users_friend_code (friend_code);
