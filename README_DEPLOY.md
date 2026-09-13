# Render deployment plan

1. Deploy `chat-server` as the Web Service.
2. Deploy `ai-worker` as a Background Worker.
3. Deploy `media-server` as a separate Web Service (or replace it with direct object-storage upload when production storage is configured).
4. Add Redis and TiDB connection environment variables.
5. For chat scaling, run multiple instances of `chat-server`; all instances must share Redis and TiDB.
6. Do not put `GROQ_API_KEY` in chat-server. Keep it only in `ai-worker`.

The canonical AI queue consumer is `ai-worker/worker.js`, started with `npm start` from `ai-worker`. Do not start the retained root legacy copy (`worker.legacy.js`); only one process may consume `ai:jobs`.
