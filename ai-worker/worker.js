const path = require('path');
const http = require('http');
const mysql = require('mysql2/promise');
const axios = require('axios');
const { createClient } = require('redis');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// =========================
// DATABASE
// =========================
const dbPort = Number(process.env.DB_PORT || 3306);
const dbSsl = process.env.DB_SSL === 'true' || dbPort === 4000;
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'chat_test',
    port: dbPort,
    waitForConnections: true,
    connectionLimit: 5,
    charset: 'utf8mb4',
    ...(dbSsl
        ? { ssl: { minVersion: 'TLSv1.2' } }
        : {})
});

// =========================
// REDIS
// =========================
const redis = createClient({
    url: process.env.REDIS_URL,
    socket: {
        reconnectStrategy: retries => Math.min(retries * 200, 5000),
    },
});

redis.on('error', (err) => {
    console.error('Redis error:', err.message);
});

const QUEUE = process.env.AI_QUEUE_KEY || 'ai:jobs';
const CHANNEL = process.env.CHAT_CHANNEL || 'chat:broadcast';
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 30000);
const GROQ_MAX_ATTEMPTS = 3;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function retryBackoff(attempt) {
    return Math.min(750 * Math.pow(2, attempt - 1), 4000);
}

redis.on('error', (err) => {
    console.error('[AI] Redis error:', err && err.message ? err.message : String(err));
});

redis.on('end', () => {
    console.warn('[AI] Redis connection ended; worker will reconnect when queue polling resumes.');
});

function startHealthServer() {
    const port = Number(process.env.PORT || 3000);
    const server = http.createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/health') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ok: true }));
            return;
        }

        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`[AI WORKER] HTTP health server listening on port ${port}`);
    });
}

const COMPANION_SYSTEM_PROMPT = `Bạn là một người bạn trò chuyện trong ứng dụng nhắn tin.

Mục tiêu của bạn là lắng nghe, hiểu ngữ cảnh, phản hồi tự nhiên và duy trì cuộc trò chuyện. Bạn không phải là chatbot kiểu ChatGPT luôn phải đưa ra câu trả lời hoàn chỉnh, và không biến mọi cuộc trò chuyện thành một bài phân tích.

Tên của bạn là Dodo. Hãy tự xưng là “Dodo” khi phù hợp, ví dụ “Dodo nghe nè”, “Dodo đang nghe” hoặc “Dodo nghĩ...”. Không tự xưng là AI, trợ lý AI, assistant hay chatbot. Không giả vờ là người thật.

Nguyên tắc:
- Lắng nghe trước khi đưa lời khuyên.
- Hiểu điều người dùng thực sự muốn trước khi trả lời.
- Phản hồi tự nhiên, gần gũi, nhẹ nhàng và vừa đủ.
- Tôn trọng cảm xúc và trạng thái của người dùng.
- Không biến mọi tin nhắn thành một vấn đề cần giải quyết.

Khi người dùng buồn, mệt, chán, áp lực, thất vọng hoặc cô đơn, hãy phản hồi như một người bạn đang lắng nghe. Có thể hỏi một câu ngắn như “Có chuyện gì vậy?” hoặc “Muốn kể tôi nghe không?”. Không tự động đưa ra danh sách lời khuyên hay phân tích tâm lý trừ khi người dùng yêu cầu.

Khi người dùng chỉ muốn nói chuyện, hãy trò chuyện lại tự nhiên. Có thể hỏi một câu ngắn để tiếp tục câu chuyện, nhưng không hỏi dồn hoặc biến người dùng thành một bảng câu hỏi.

Nếu người dùng không muốn chia sẻ, hãy tôn trọng điều đó và không hỏi tiếp. Nếu người dùng muốn lời khuyên, hãy đưa lời khuyên tự nhiên, thực tế và vừa đủ. Nếu người dùng hỏi thông tin, hãy trả lời chính xác và trực tiếp.

Mặc định trả lời ngắn: câu đơn giản từ 1 đến 3 câu, hội thoại từ 1 đến 4 câu. Chỉ trả lời dài hơn khi người dùng yêu cầu chi tiết, phân tích hoặc giải thích kỹ. Không tự động dùng bảng, checklist, heading, danh sách dài, markdown phức tạp hoặc bài luận.

Duy trì ngữ cảnh của conversation hiện tại và sử dụng những gì người dùng đã nói trước đó khi phù hợp. Không tự động biến mọi tin nhắn thành câu hỏi. Không cố giữ cuộc trò chuyện bằng mọi giá khi nó đã tự nhiên kết thúc.

Không khoe khả năng, không nói như tài liệu kỹ thuật và không giả vờ có trải nghiệm, ký ức cá nhân hoặc cảm xúc con người. Có thể dùng emoji vừa phải, không dùng trong mọi câu.

Trước mỗi câu trả lời, hãy xác định người dùng đang muốn trò chuyện, chia sẻ cảm xúc, cần được lắng nghe, cần lời khuyên hay cần thông tin. Nếu không chắc, hãy hỏi một câu ngắn và tự nhiên.

Ưu tiên: lắng nghe hơn giải quyết, ngữ cảnh hơn câu trả lời độc lập, tự nhiên hơn trang trọng, vừa đủ hơn dài dòng, hội thoại hơn bài luận.`;

const QUICK_SYSTEM_PROMPT = `Bạn là Dodo, một người bạn AI thân thiện trong ứng dụng nhắn tin.
Trả lời ngắn gọn, tự nhiên và đúng yêu cầu. Với tóm tắt, viết lại hoặc dịch, chỉ trả về kết quả cần dùng, không mở đầu dài dòng và không thêm lời mời tiếp tục. Mặc định chỉ 1-3 câu.`;

// =========================
// LẤY CONTEXT CHAT
// =========================
async function getContext(
    conversationId,
    userId,
    currentMessageId,
    includeAIHistory
) {
    const [userRows] = await db.query(
        `
        SELECT
            u.username,
            m.text_content,
            m.created_at,
            m.id
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE
            m.conversation_id = ?
            AND m.is_deleted = 0
            AND m.text_content IS NOT NULL
            AND m.id <> ?
        `,
        [conversationId, currentMessageId || 0]
    );

    let history = userRows.map(row => ({
        role: 'user',
        content: `${row.username}: ${row.text_content}`,
        createdAt: row.created_at,
        id: Number(row.id)
    }));

    if (includeAIHistory) {
        const [aiRows] = await db.query(
            `
            SELECT
                am.content,
                am.created_at,
                am.id
            FROM ai_messages am
            JOIN ai_conversations ac
                ON ac.id = am.ai_conversation_id
            WHERE
                ac.user_id = ?
                AND ac.status = 'active'
                AND am.content IS NOT NULL
            `,
            [userId]
        );

        history.push(...aiRows.map(row => ({
            role: 'assistant',
            content: row.content,
            createdAt: row.created_at,
            id: Number(row.id)
        })));
    }

    return history
        .sort((left, right) => {
            const time = new Date(left.createdAt) - new Date(right.createdAt);
            return time || left.id - right.id;
        })
        .slice(-15)
        .map(({ role, content }) => ({ role, content }));
}

// =========================
// LẤY / TẠO AI AGENT
// =========================
async function ensureAgent() {
    const [rows] = await db.query(
        `
        SELECT *
        FROM ai_agents
        WHERE is_active = 1
        ORDER BY id
        LIMIT 1
        `
    );

    if (rows.length > 0) {
        return rows[0];
    }

    const model =
        process.env.AI_MODEL || 'openai/gpt-oss-20b';

    const [result] = await db.query(
        `
        INSERT INTO ai_agents
        (
            name,
            provider,
            model_name,
            system_prompt,
            is_active
        )
        VALUES (?, ?, ?, ?, 1)
        `,
        [
            'AIChat',
            'groq',
            model,
            COMPANION_SYSTEM_PROMPT
        ]
    );

    return {
        id: result.insertId,
        name: 'AIChat',
        provider: 'groq',
        model_name: model
    };
}

async function ensureAIUser() {
    const [rows] = await db.query(
        'SELECT id, username FROM users WHERE username = ? LIMIT 1',
        ['AI']
    );

    if (rows.length > 0) return rows[0];

    const [result] = await db.query(
        `INSERT INTO users
        (username, password_hash, full_name, account_status)
        VALUES (?, ?, ?, ?)`,
        ['AI', 'AI_SYSTEM_ACCOUNT', 'AI Assistant', 'active']
    );

    return { id: result.insertId, username: 'AI' };
}

async function ensureAIMembership(conversationId, aiUserId) {
    const [rows] = await db.query(
        `SELECT id
        FROM conversation_members
        WHERE conversation_id = ? AND user_id = ?
        LIMIT 1`,
        [conversationId, aiUserId]
    );

    if (rows.length > 0) return;

    await db.query(
        `INSERT INTO conversation_members
        (conversation_id, user_id, role)
        VALUES (?, ?, 'member')`,
        [conversationId, aiUserId]
    );
}

// =========================
// GỌI GROQ
// =========================
async function callAI(messages, model, options = {}) {
    if (!process.env.GROQ_API_KEY) {
        console.error('[AI] GROQ_API_KEY missing in environment; skipping Groq request');
        throw new Error('GROQ_API_KEY missing in environment');
    }

    const buildPayload = (withReasoning) => ({
        model,
        messages: [
            {
                role: 'system',
                content: options.systemPrompt || COMPANION_SYSTEM_PROMPT,
            },
            ...messages,
        ],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 650,
        ...(withReasoning ? { reasoning_effort: 'low' } : {}),
    });

    const requestConfig = {
        headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: GROQ_TIMEOUT_MS,
    };

    const tryRequest = async (withReasoning) => {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            buildPayload(withReasoning),
            requestConfig,
        );

        const content = response.data?.choices?.[0]?.message?.content || '';
        return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    };

    let lastError;
    for (let attempt = 1; attempt <= GROQ_MAX_ATTEMPTS; attempt += 1) {
        try {
            try {
                return await tryRequest(true);
            } catch (error) {
                const text = [
                    error.response?.data?.error?.message,
                    error.response?.data?.message,
                    error.message,
                ].filter(Boolean).join(' ');

                const status = error.response?.status;
                const retryWithoutReasoning = (
                    status === 400 ||
                    status === 422
                ) && /reasoning|unsupported|invalid/i.test(text);

                if (!retryWithoutReasoning) {
                    throw error;
                }

                console.warn('[AI] Groq rejected reasoning_effort; retrying without it:', text);
                return await tryRequest(false);
            }
        } catch (error) {
            lastError = error;
            const text = [
                error.response?.data?.error?.message,
                error.response?.data?.message,
                error.message,
            ].filter(Boolean).join(' ');
            const status = error.response?.status;

            const isRetryable = (
                !status ||
                status === 408 ||
                status === 429 ||
                status >= 500
            );

            const isNonRetryable = (
                status === 400 ||
                status === 401 ||
                status === 403 ||
                status === 422
            );

            if (status === 401 || status === 403) {
                console.error('[AI] Groq auth/configuration error: GROQ_API_KEY unauthorized or invalid.');
                throw new Error('GROQ_API_KEY configuration error: unauthorized');
            }

            if (status === 400 || status === 422) {
                console.error('[AI] Groq invalid request:', text);
                throw error;
            }

            if (isNonRetryable) {
                console.error('[AI] Groq non-retryable error:', text);
                throw error;
            }

            if (!isRetryable || attempt >= GROQ_MAX_ATTEMPTS) {
                console.error('[AI] Groq request failed:', text);
                throw error;
            }

            const backoffMs = retryBackoff(attempt);
            console.warn(`[AI] Groq retry ${attempt + 1}/${GROQ_MAX_ATTEMPTS} after ${backoffMs}ms; status=${status || 'network'}; reason=${text}`);
            await wait(backoffMs);
        }
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error('Groq request failed');
}

// =========================
// XỬ LÝ 1 JOB AI
// =========================
async function processJob(job) {
    const started = Date.now();
    const receivedAt = Date.now();
    const enqueuedAt = Number(job.enqueued_at || receivedAt);
    const source = String(job.source || 'sql');

    console.log(
        `[AI] Job received conversation=${job.conversation_id || 'unknown'} message=${job.message_id || job.request_id || 'unknown'} source=${source}`
    );

    try {
        await redis.publish(
            CHANNEL,
            JSON.stringify({
                type: source === 'quick' ? 'ai:quick:processing' : 'ai:processing',
                conversation_id: job.conversation_id,
                user_id: job.user_id,
                request_id: job.request_id,
                message_id: job.message_id,
                timing: source === 'quick' ? {
                    server_received_at: Number(job.server_received_at || 0),
                    worker_received_at: receivedAt,
                    queue_ms: Math.max(0, receivedAt - enqueuedAt),
                } : undefined,
            })
        );
    } catch (publishError) {
        console.error('[AI] Failed to publish processing event:', publishError.message);
    }

    console.log('[AI] Published ai:processing');

    try {
        console.log(
            `[AI] Processing conversation=${job.conversation_id || 'unknown'} source=${source}`
        );

        const agent = source === 'quick'
            ? { model_name: process.env.AI_MODEL || 'openai/gpt-oss-20b' }
            : await ensureAgent();

        const prompt =
            String(job.message || '')
                .replace(/@ai\b/i, '')
                .trim() ||
            'Xin chào, bạn có thể giúp tôi gì?';

        let messages = [];

        if (source === 'quick') {
            messages.push(...(Array.isArray(job.history) ? job.history : []));
        } else if (source === 'sql' || source === 'temporary') {
            const history = await getContext(
                job.conversation_id,
                job.user_id,
                job.message_id,
                job.is_ai_conversation === true
            );
            messages.push(...history);
        }

        messages.push({
            role: 'user',
            content: `${job.username || 'User'}: ${prompt}`
        });

        console.log(`[AI] Calling Groq model=${agent.model_name || model || 'openai/gpt-oss-20b'}`);
        const reply = await callAI(
            messages,
            agent.model_name,
            source === 'quick'
                ? {
                    systemPrompt: QUICK_SYSTEM_PROMPT,
                    maxTokens: 220,
                    temperature: 0.45,
                }
                : undefined,
        );

        if (!reply) {
            throw new Error('AI không trả về nội dung');
        }

        console.log('[AI] Groq success reply_bytes=' + String(reply.length));

        if (source === 'quick') {
            try {
                await redis.publish(
                    CHANNEL,
                    JSON.stringify({
                        type: 'ai:quick:done',
                        user_id: job.user_id,
                        request_id: job.request_id,
                        message_id: job.message_id,
                        timing: {
                            server_received_at: Number(job.server_received_at || 0),
                            enqueued_at: enqueuedAt,
                            worker_received_at: receivedAt,
                            groq_done_at: Date.now(),
                            queue_ms: Math.max(0, receivedAt - enqueuedAt),
                            worker_ms: Date.now() - receivedAt,
                            total_worker_ms: Date.now() - started,
                        },
                        message: {
                            id: `quick-${job.request_id}`,
                            username: 'AI',
                            message: reply,
                            message_type: 'text',
                            created_at: new Date().toISOString(),
                        },
                    })
                );
                console.log(`[AI] Quick job completed in ${Date.now() - started}ms`);
            } catch (publishError) {
                console.error('[AI] Failed to publish quick done:', publishError.message);
            }
            return;
        }

        const [conversationRows] = await db.query(
            `
            SELECT id
            FROM ai_conversations
            WHERE
                user_id = ?
                AND agent_id = ?
                AND status = 'active'
            ORDER BY id DESC
            LIMIT 1
            `,
            [job.user_id, agent.id]
        );

        let aiConversation = conversationRows[0];

        if (!aiConversation) {
            const [result] = await db.query(
                `
                INSERT INTO ai_conversations
                (
                    user_id,
                    agent_id,
                    title,
                    status
                )
                VALUES (?, ?, ?, ?)
                `,
                [job.user_id, agent.id, 'AI Chat', 'active']
            );

            aiConversation = { id: result.insertId };
        }

        const responseMs = Date.now() - started;

        const [messageResult] = await db.query(
            `
            INSERT INTO ai_messages
            (
                ai_conversation_id,
                sender_type,
                content,
                model_name,
                response_ms
            )
            VALUES (?, ?, ?, ?, ?)
            `,
            [aiConversation.id, 'assistant', reply, agent.model_name, responseMs]
        );

        await db.query(
            `
            INSERT INTO ai_message_usage
            (
                ai_message_id,
                provider,
                model_name,
                total_tokens
            )
            VALUES (?, ?, ?, ?)
            `,
            [messageResult.insertId, 'groq', agent.model_name, 0]
        );

        const aiUser = await ensureAIUser();
        await ensureAIMembership(job.conversation_id, aiUser.id);

        const [chatMessageResult] = await db.query(
            `INSERT INTO messages
            (conversation_id, sender_id, message_type, text_content)
            VALUES (?, ?, 'text', ?)`,
            [job.conversation_id, aiUser.id, reply]
        );

        const [chatMessageRows] = await db.query(
            `SELECT m.*, u.username
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.id = ?`,
            [chatMessageResult.insertId]
        );

        const chatMessage = chatMessageRows[0];

        const aiMessage = {
            id: chatMessage.id,
            conversation_id: chatMessage.conversation_id,
            sender_id: chatMessage.sender_id,
            username: chatMessage.username,
            message: chatMessage.text_content,
            message_type: chatMessage.message_type,
            client_message_id: chatMessage.client_message_id,
            is_deleted: chatMessage.is_deleted,
            is_edited: chatMessage.is_edited,
            temporary: false,
            created_at: chatMessage.created_at,
            updated_at: chatMessage.updated_at,
        };

        const doneEvent = {
            type: 'ai:done',
            conversation_id: job.conversation_id,
            message_id: job.message_id,
            message: aiMessage,
        };

        console.log('[AI TRACE] broadcast payload:', doneEvent);
        await redis.publish(CHANNEL, JSON.stringify(doneEvent));
        console.log('[AI] Job completed in ' + String(responseMs) + 'ms');
    } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        console.error('[AI] Job failed:', msg);

        try {
            const terminalEvent = source === 'quick'
                ? {
                    type: 'ai:quick:done',
                    conversation_id: job.conversation_id,
                    user_id: job.user_id,
                    request_id: job.request_id,
                    message_id: job.message_id,
                    error: msg,
                    success: false,
                }
                : {
                    type: 'ai:done',
                    conversation_id: job.conversation_id,
                    user_id: job.user_id,
                    request_id: job.request_id,
                    message_id: job.message_id,
                    error: msg,
                    success: false,
                };

            await redis.publish(CHANNEL, JSON.stringify(terminalEvent));
            console.log('[AI] Published AI error event:', source === 'quick' ? 'ai:quick:done' : 'ai:done');
        } catch (publishError) {
            console.error('[AI] Failed to publish error result:', publishError.message);
        }
    }
}

// =========================
// MAIN WORKER
// =========================
async function main() {
    startHealthServer();

    if (!redis.isOpen) {
        await redis.connect();
    }

    console.log('[AI WORKER] Redis connected');
    console.log(`[AI WORKER] Queue: ${QUEUE}`);
    console.log(`[AI WORKER] Channel: ${CHANNEL}`);

    while (true) {
        try {
            if (!redis.isOpen) {
                await redis.connect();
                console.log('[AI WORKER] Redis connected');
            }

            console.log('[AI WORKER] Waiting for AI jobs...');
            const item =
                await redis.brPop(
                    QUEUE,
                    0
                );

            if (item?.element) {
                let job;

                try {
                    job = JSON.parse(item.element);
                } catch (error) {
                    console.error(
                        '[AI WORKER] Invalid job JSON:',
                        error.message
                    );
                    continue;
                }

                if (!job || typeof job !== 'object' || Array.isArray(job)) {
                    console.error('[AI WORKER] Invalid job: expected an object');
                    continue;
                }

                await processJob(job);
            }

        } catch (error) {
            console.error(
                '[AI WORKER] Queue error:',
                error.message
            );

            await new Promise(
                resolve =>
                    setTimeout(resolve, 1000)
            );
        }
    }
}

// =========================
// START
// =========================
main().catch(error => {
    console.error('[AI] Worker startup error:', error && error.message ? error.message : String(error));
    process.exit(1);
});