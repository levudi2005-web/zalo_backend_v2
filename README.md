# Zalo Mini Backend V2

This is the new backend foundation for the clean `chat_test` schema.

## Services

- `chat-server`: REST + Socket.IO + TiDB + Redis. No video processing and no AI HTTP calls.
- `ai-worker`: consumes Redis AI jobs and calls Groq. Stores AI history in `ai_conversations`, `ai_messages`, and `ai_message_usage`.
- `media-server`: receives image/video/file uploads and performs image/video metadata + thumbnail work. Production should use object storage rather than local Render filesystem.

## Canonical process commands

Run each service from its own directory:

- Chat server: `cd chat-server && npm start`
- AI worker: `cd ai-worker && npm start`
- Media server: `cd media-server && npm start`

Only `ai-worker/worker.js` is the queue consumer for `ai:jobs`. The former root implementation is retained as `worker.legacy.js` for reference and must not be started. Running both workers would consume the same queue and can produce duplicate or inconsistent AI results.

## Redis

Redis is the realtime/queue layer. Chat instances publish events to `chat:broadcast`, and AI jobs use `ai:jobs`.

## Disappearing messages

When `conversation_settings.disappearing_enabled=1` and `disappearing_seconds=86400`, the chat server does not INSERT the new message into `messages`. It stores the temporary payload in Redis with a TTL and broadcasts it over Socket.IO. This behavior is application-enforced.

## Important next step

The current Web/Android demo still calls the old `/api/messages` multipart contract and old global Socket.IO behavior. Update the clients to call `/api/bootstrap`, join a conversation room, send JSON messages, and upload media directly to the media service before the old demo is removed.
