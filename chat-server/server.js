const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');
const { createClient } = require('redis');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));

const dbPort = Number(process.env.DB_PORT || 3306);
const dbSsl = process.env.DB_SSL === 'true' || dbPort === 4000;
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'chat_test',
  port: dbPort,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  ...(dbSsl ? { ssl: { minVersion: 'TLSv1.2' } } : {})
});

const redis = createClient({ url: process.env.REDIS_URL });
const redisSub = redis.duplicate();
const AI_QUEUE_KEY = process.env.AI_QUEUE_KEY || 'ai:jobs';
const CHAT_CHANNEL = process.env.CHAT_CHANNEL || 'chat:broadcast';
const AI_CONVERSATION_ID = Number(process.env.AI_CONVERSATION_ID || 30001);
const ALLOWED_REACTIONS = new Set(['❤️', '👍', '😂', '😮', '😢']);
const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const socketsByUser = new Map();
const AI_ENQUEUE_DEDUPE = new Map();
const SESSION_COOKIE = 'zalo_session';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;
const configuredOrigins = String(process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins.includes('*')
  ? [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://zalo-backend-v2.onrender.com',
    ]
  : configuredOrigins;
if (!allowedOrigins.includes('https://zalo-backend-v2.onrender.com')) {
  allowedOrigins.push('https://zalo-backend-v2.onrender.com');
}

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
});

function corsOrigin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) {
    return callback(null, true);
  }
  return callback(new Error('Origin không được phép'));
}

function room(conversationId) { return `conversation:${conversationId}`; }
function nowIso() { return new Date().toISOString(); }
async function isAIConversation(conversationId) {
  if (Number(conversationId) === AI_CONVERSATION_ID) return true;
  const [rows] = await db.query(
    `SELECT 1
     FROM conversation_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ?
       AND cm.left_at IS NULL
       AND u.username = 'AI'
     LIMIT 1`,
    [conversationId],
  );
  return rows.length > 0;
}

function publicUser(user) {
  return { id: user.id, username: user.username, full_name: user.full_name, account_status: user.account_status, friend_code: user.friend_code || null };
}

function generateFriendCode() {
  const bytes = crypto.randomBytes(8);
  let raw = '';
  for (let index = 0; index < 8; index += 1) raw += FRIEND_CODE_ALPHABET[bytes[index] % FRIEND_CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('='))
    .filter(([key, value]) => key && value)
    .map(([key, value]) => [key, decodeURIComponent(value)]));
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt.toString('base64')}:${derivedKey.toString('base64')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [saltText, hashText] = String(stored || '').split(':');
    if (!saltText || !hashText) return resolve(false);
    const salt = Buffer.from(saltText, 'base64');
    const expected = Buffer.from(hashText, 'base64');
    crypto.scrypt(password, salt, expected.length, (error, actual) => {
      if (error) return reject(error);
      resolve(actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
    });
  });
}

async function getUserById(userId) {
  const [rows] = await db.query(
    'SELECT id, username, full_name, account_status, password_hash, friend_code FROM users WHERE id = ? LIMIT 1',
    [userId],
  );
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const [rows] = await db.query(
    'SELECT id, username, full_name, account_status, password_hash, friend_code FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  return rows[0] || null;
}

async function ensureFriendCode(userId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [current] = await db.query('SELECT friend_code FROM users WHERE id = ? LIMIT 1', [userId]);
    if (current[0]?.friend_code) return current[0].friend_code;
    const code = generateFriendCode();
    try {
      await db.query('UPDATE users SET friend_code = ? WHERE id = ? AND friend_code IS NULL', [code, userId]);
      const [saved] = await db.query('SELECT friend_code FROM users WHERE id = ? LIMIT 1', [userId]);
      if (saved[0]?.friend_code) return saved[0].friend_code;
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }
  }
  throw new Error('Không thể tạo mã kết bạn duy nhất');
}

async function backfillFriendCodes() {
  const [rows] = await db.query('SELECT id FROM users WHERE friend_code IS NULL OR friend_code = ""');
  for (const row of rows) await ensureFriendCode(row.id);
}

async function createSession(userId, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO user_sessions (user_id, access_token, ip_address, expires_at)
     VALUES (?, ?, ?, ?)`,
    [userId, crypto.createHash('sha256').update(token).digest('hex'), req.ip, expiresAt],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

async function userFromSession(req) {
  const cookieToken = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  const authHeader = String(req.headers.authorization || '');
  const headerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const token = headerToken || cookieToken;
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [rows] = await db.query(
    `SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.access_token = ? AND s.is_active = 1 AND (s.expires_at IS NULL OR s.expires_at > NOW())
     LIMIT 1`,
    [tokenHash],
  );
  if (!rows[0]) return null;
  await db.query('UPDATE user_sessions SET last_active_at = NOW() WHERE access_token = ?', [tokenHash]);
  return rows[0];
}

async function requireAuth(req, res, next) {
  try {
    const user = await userFromSession(req);
    if (!user || user.account_status !== 'active') return res.status(401).json({ error: 'Chưa đăng nhập' });
    req.user = user;
    return next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ' });
  }
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
  });
}

io.use(async (socket, next) => {
  try {
    const user = await userFromSession({ headers: { cookie: socket.handshake.headers.cookie || '' }, ip: socket.handshake.address });
    if (!user || user.account_status !== 'active') return next(new Error('UNAUTHORIZED'));
    socket.user = user;
    return next();
  } catch (error) {
    return next(new Error('UNAUTHORIZED'));
  }
});

async function ensureAIConversationMembership(userId) {
  await db.query(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE left_at = NULL, role = VALUES(role)',
    [AI_CONVERSATION_ID, userId, 'member'],
  );
}

async function ensureMembership(userId, conversationId) {
  const targetConversationId = Number(conversationId);
  const [rows] = await db.query(
    'SELECT id, role FROM conversation_members WHERE conversation_id=? AND user_id=? AND left_at IS NULL LIMIT 1',
    [targetConversationId, userId],
  );
  if (rows[0]) return rows[0];

  if (targetConversationId === AI_CONVERSATION_ID) {
    await ensureAIConversationMembership(userId);
    const [freshRows] = await db.query(
      'SELECT id, role FROM conversation_members WHERE conversation_id=? AND user_id=? AND left_at IS NULL LIMIT 1',
      [targetConversationId, userId],
    );
    return freshRows[0] || null;
  }

  return null;
}

async function getOrCreatePrivateConversation(userA, userB) {
  const connection = await db.getConnection();
  const lockName = `private-conversation:${Math.min(Number(userA), Number(userB))}:${Math.max(Number(userA), Number(userB))}`;
  try {
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, 5) AS locked', [lockName]);
    if (Number(lockRows[0]?.locked) !== 1) throw new Error('Không thể khóa cuộc trò chuyện riêng tư');
    const [existing] = await connection.query(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members cm_a ON cm_a.conversation_id = c.id AND cm_a.user_id = ? AND cm_a.left_at IS NULL
       JOIN conversation_members cm_b ON cm_b.conversation_id = c.id AND cm_b.user_id = ? AND cm_b.left_at IS NULL
       WHERE c.conversation_type IN ('private', 'direct')
       GROUP BY c.id
       HAVING (SELECT COUNT(*) FROM conversation_members cm_count WHERE cm_count.conversation_id = c.id AND cm_count.left_at IS NULL) = 2
       LIMIT 1`,
      [userA, userB],
    );
    if (existing[0]) return Number(existing[0].id);
    const [created] = await connection.query(
      'INSERT INTO conversations (conversation_type, name, created_by) VALUES (?, ?, ?)',
      ['private', null, userA],
    );
    const conversationId = Number(created.insertId);
    await connection.query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)', [conversationId, userA, 'member']);
    await connection.query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)', [conversationId, userB, 'member']);
    await connection.query('INSERT INTO conversation_settings (conversation_id) VALUES (?) ON DUPLICATE KEY UPDATE conversation_id = conversation_id', [conversationId]);
    await connection.query('INSERT INTO conversation_user_settings (user_id, conversation_id) VALUES (?, ?), (?, ?) ON DUPLICATE KEY UPDATE updated_at = NOW()', [userA, conversationId, userB, conversationId]);
    await publish({ type: 'conversation:created', conversation_id: conversationId, user_id: userA, members: [userA, userB], conversation_type: 'private' });
    return conversationId;
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    connection.release();
  }
}

async function getConversationSetting(conversationId) {
  const [rows] = await db.query('SELECT * FROM conversation_settings WHERE conversation_id=? LIMIT 1', [conversationId]);
  return rows[0] || { disappearing_enabled: 0, disappearing_seconds: 0 };
}

async function getConversationUserSettings(userId, conversationId) {
  const [rows] = await db.query(
    'SELECT * FROM conversation_user_settings WHERE user_id = ? AND conversation_id = ? LIMIT 1',
    [userId, conversationId],
  );
  if (rows[0]) return rows[0];
  await db.query(
    'INSERT INTO conversation_user_settings (user_id, conversation_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE updated_at = NOW()',
    [userId, conversationId],
  );
  const [fresh] = await db.query(
    'SELECT * FROM conversation_user_settings WHERE user_id = ? AND conversation_id = ? LIMIT 1',
    [userId, conversationId],
  );
  return fresh[0] || {
    user_id: Number(userId),
    conversation_id: Number(conversationId),
    is_muted: 0,
    is_pinned: 0,
    is_hidden: 0,
    hide_chat_history: 0,
    clear_chat_history_at: null,
  };
}

async function setConversationUserSettings(userId, conversationId, patch = {}) {
  const current = await getConversationUserSettings(userId, conversationId);
  const updates = {
    is_muted: patch.is_muted !== undefined ? Number(Boolean(patch.is_muted)) : Number(Boolean(current.is_muted)),
    is_pinned: patch.is_pinned !== undefined ? Number(Boolean(patch.is_pinned)) : Number(Boolean(current.is_pinned)),
    is_hidden: patch.is_hidden !== undefined ? Number(Boolean(patch.is_hidden)) : Number(Boolean(current.is_hidden)),
    hide_chat_history: patch.hide_chat_history !== undefined ? Number(Boolean(patch.hide_chat_history)) : Number(Boolean(current.hide_chat_history)),
  };
  await db.query(
    `INSERT INTO conversation_user_settings (user_id, conversation_id, is_muted, is_pinned, is_hidden, hide_chat_history)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       is_muted = VALUES(is_muted),
       is_pinned = VALUES(is_pinned),
       is_hidden = VALUES(is_hidden),
       hide_chat_history = VALUES(hide_chat_history),
       updated_at = NOW()`,
    [userId, conversationId, updates.is_muted, updates.is_pinned, updates.is_hidden, updates.hide_chat_history],
  );
  return getConversationUserSettings(userId, conversationId);
}

async function saveUserProfileField(userId, data = {}) {
  const updates = [];
  const params = [];
  const allowed = ['display_name', 'bio', 'avatar_url', 'theme', 'show_online_status', 'notification_preference'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      updates.push(`${key} = ?`);
      params.push(data[key]);
    }
  }
  if (!updates.length) return null;
  params.push(userId);
  await db.query(`UPDATE user_profiles SET ${updates.join(', ')} WHERE user_id = ?`, params);
  if (data.show_online_status !== undefined) {
    await db.query('UPDATE user_settings SET show_online_status = ? WHERE user_id = ?', [Number(Boolean(data.show_online_status)), userId]);
  }
  return true;
}

async function createNotification(userId, type, title, message, referenceId = null, metadata = null) {
  const [r] = await db.query(
    'INSERT INTO notifications (user_id, notification_type, reference_type, reference_id, title, content, is_read) VALUES (?, ?, ?, ?, ?, ?, 0)',
    [userId, type, 'app', referenceId, title, message],
  );
  const [rows] = await db.query('SELECT * FROM notifications WHERE id = ? LIMIT 1', [r.insertId]);
  await publish({ type: 'notification:new', user_id: userId, notification: { ...rows[0], type: rows[0].notification_type, message: rows[0].content, metadata } });
  return rows[0] || null;
}

async function getUnreadConversationCount(userId, conversationId) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS unread_count
     FROM messages m
     LEFT JOIN message_status ms ON ms.message_id = m.id AND ms.user_id = ?
     WHERE m.conversation_id = ?
       AND m.sender_id <> ?
       AND m.is_deleted = 0
       AND (ms.status_type IS NULL OR ms.status_type <> 'read')`,
    [userId, conversationId, userId],
  );
  return Number(rows[0]?.unread_count || 0);
}

async function getConversationSummaryForUser(userId, conversationId) {
  const member = await ensureMembership(userId, conversationId);
  if (!member) return null;
  const settings = await getConversationUserSettings(userId, conversationId);
  const [conversationRows] = await db.query('SELECT id, name, conversation_type, avatar_url FROM conversations WHERE id = ? LIMIT 1', [conversationId]);
  const [memberRows] = await db.query('SELECT COUNT(*) AS member_count FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL', [conversationId]);
  const [messageRows] = await db.query(
    `SELECT m.id AS last_message_id, m.text_content AS last_message_text, m.message_type AS last_message_type,
            m.created_at AS last_message_at, m.sender_id AS last_message_sender_id, u.username AS last_message_sender_username
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? AND m.is_deleted = 0
     ORDER BY m.id DESC LIMIT 1`,
    [conversationId],
  );
  const [unreadRows] = await db.query(
    `SELECT COUNT(*) AS unread_count
     FROM messages msg
     LEFT JOIN message_status st ON st.message_id = msg.id AND st.user_id = ?
     LEFT JOIN message_visibility hidden_msg ON hidden_msg.message_id = msg.id AND hidden_msg.user_id = ?
     WHERE msg.conversation_id = ? AND msg.sender_id <> ? AND msg.is_deleted = 0
       AND hidden_msg.id IS NULL AND (st.status_type IS NULL OR st.status_type <> 'read')`,
    [userId, userId, conversationId, userId],
  );
  const row = conversationRows[0] ? { ...conversationRows[0], ...memberRows[0], ...messageRows[0], ...unreadRows[0] } : null;
  if (!row) return null;
  let displayName = row.name;
  if (['private', 'direct'].includes(row.conversation_type)) {
    const [otherRows] = await db.query(
      `SELECT u.full_name, u.username
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ? AND cm.user_id <> ? AND cm.left_at IS NULL LIMIT 1`,
      [conversationId, userId],
    );
    displayName = otherRows[0]?.full_name || otherRows[0]?.username || displayName;
  }
  return {
    id: Number(row.id),
    name: displayName || `Cuộc trò chuyện ${row.id}`,
    conversation_type: row.conversation_type,
    avatar_url: row.avatar_url,
    member_count: Number(row.member_count || 0),
    last_message_at: row.last_message_at,
    last_message_id: row.last_message_id,
    last_message_text: row.last_message_text,
    last_message_type: row.last_message_type,
    last_message_sender_id: row.last_message_sender_id,
    last_message_sender_username: row.last_message_sender_username,
    unread_count: Number(row.unread_count || 0),
    is_muted: Number(Boolean(settings.is_muted)),
    is_pinned: Number(Boolean(settings.is_pinned)),
    is_hidden: Number(Boolean(settings.is_hidden)),
  };
}

async function publish(event) {
  await redis.publish(CHAT_CHANNEL, JSON.stringify(event));
}

async function setMessageStatus(messageId, userId, statusType) {
  const [existing] = await db.query(
    'SELECT id, status_type FROM message_status WHERE message_id = ? AND user_id = ? LIMIT 1',
    [messageId, userId],
  );
  if (existing.length) {
    if (existing[0].status_type === statusType) return false;
    if (existing[0].status_type === 'read' && statusType !== 'read') return false;
    await db.query(
      'UPDATE message_status SET status_type = ?, status_at = NOW() WHERE id = ?',
      [statusType, existing[0].id],
    );
  } else {
    try {
      await db.query(
        'INSERT INTO message_status (message_id, user_id, status_type) VALUES (?, ?, ?)',
        [messageId, userId, statusType],
      );
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      const [raced] = await db.query(
        'SELECT status_type FROM message_status WHERE message_id = ? AND user_id = ? LIMIT 1',
        [messageId, userId],
      );
      if (!raced.length || raced[0].status_type === statusType || (raced[0].status_type === 'read' && statusType !== 'read')) return false;
      await db.query(
        'UPDATE message_status SET status_type = ?, status_at = NOW() WHERE message_id = ? AND user_id = ?',
        [statusType, messageId, userId],
      );
    }
  }
  return true;
}

async function markConversationDelivered(userId, conversationId) {
  const [rows] = await db.query(
    `SELECT m.id, m.sender_id FROM messages m
     LEFT JOIN message_status ms ON ms.message_id = m.id AND ms.user_id = ?
     WHERE m.conversation_id = ? AND m.sender_id <> ? AND m.is_deleted = 0
       AND (ms.status_type IS NULL OR ms.status_type = 'sent')`,
    [userId, conversationId, userId],
  );
  for (const row of rows) {
    if (await setMessageStatus(row.id, userId, 'delivered')) {
      await publish({ type: 'message:status', conversation_id: conversationId, message_id: row.id, user_id: userId, sender_id: row.sender_id, status: 'delivered' });
    }
  }
}

async function getMessageForAction(messageId) {
  const [rows] = await db.query(
    `SELECT m.*, u.username,
      rm.id AS reply_id, rm.text_content AS reply_text, ru.username AS reply_username
      , fm.id AS forwarded_source_id, fm.sender_id AS forwarded_source_sender_id
      , fu.username AS forwarded_source_username, fm.text_content AS forwarded_source_text
      , fm.message_type AS forwarded_source_type, fm.created_at AS forwarded_source_created_at
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     LEFT JOIN messages rm ON rm.id = m.reply_to_id
     LEFT JOIN users ru ON ru.id = rm.sender_id
      LEFT JOIN messages fm ON fm.id = m.forwarded_from_message_id
      LEFT JOIN users fu ON fu.id = fm.sender_id
     WHERE m.id = ? LIMIT 1`,
    [messageId],
  );
  return rows[0] || null;
}

async function getMessageReactions(messageId) {
  const [rows] = await db.query(
    `SELECT mr.*, u.username, u.full_name
     FROM message_reactions mr
     JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = ?
     ORDER BY mr.created_at`,
    [messageId],
  );
  return rows;
}

async function getMessagesReactions(messageIds) {
  if (!messageIds.length) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT mr.*, u.username, u.full_name
     FROM message_reactions mr
     JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id IN (${placeholders})
     ORDER BY mr.created_at`,
    messageIds,
  );
  const byMessage = new Map();
  for (const row of rows) {
    if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, []);
    byMessage.get(row.message_id).push({
      id: row.id,
      message_id: row.message_id,
      user_id: row.user_id,
      username: row.username,
      full_name: row.full_name,
      reaction_type: row.reaction_type,
      created_at: row.created_at,
    });
  }
  return byMessage;
}

function getMentionMatches(text) {
  const matches = [];
  const pattern = /(^|\s)@([a-zA-Z0-9_.-]{1,50})/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const username = match[2];
    const start = match.index + match[1].length;
    matches.push({
      username,
      start,
      end: start + username.length + 1,
    });
  }
  return matches;
}

async function resolveMentions(conversationId, text) {
  const matches = getMentionMatches(text);
  if (!matches.length) return [];

  const usernames = [...new Set(matches.map((match) => match.username.toLowerCase()))];
  const placeholders = usernames.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT u.id, u.username, u.full_name
     FROM users u
     JOIN conversation_members cm ON cm.user_id = u.id
     WHERE cm.conversation_id = ?
       AND cm.left_at IS NULL
       AND u.account_status = 'active'
       AND LOWER(u.username) IN (${placeholders})`,
    [conversationId, ...usernames],
  );

  const usersByUsername = new Map(rows.map((row) => [String(row.username).toLowerCase(), row]));
  const invalid = usernames.find((username) => !usersByUsername.has(username));
  if (invalid) {
    throw new Error(`Không thể mention @${invalid}: người dùng không thuộc cuộc trò chuyện`);
  }

  return matches.map((match) => {
    const user = usersByUsername.get(match.username.toLowerCase());
    return {
      mentioned_user_id: Number(user.id),
      username: user.username,
      full_name: user.full_name,
      start: match.start,
      end: match.end,
    };
  });
}

async function getMessagesMentions(messageIds) {
  if (!messageIds.length) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT mm.message_id, mm.mentioned_user_id, mm.username_snapshot,
            mm.mention_start, mm.mention_end, u.full_name
     FROM message_mentions mm
     JOIN users u ON u.id = mm.mentioned_user_id
     WHERE mm.message_id IN (${placeholders})
     ORDER BY mm.message_id, mm.mention_start`,
    messageIds,
  );
  const byMessage = new Map();
  for (const row of rows) {
    if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, []);
    byMessage.get(row.message_id).push({
      user_id: Number(row.mentioned_user_id),
      username: row.username_snapshot,
      full_name: row.full_name,
      start: row.mention_start,
      end: row.mention_end,
    });
  }
  return byMessage;
}

function normalizePin(row) {
  if (!row?.pinned_id) return null;
  return {
    id: row.pinned_id,
    message_id: row.id || row.message_id,
    conversation_id: row.conversation_id,
    pinned_by: Number(row.pinned_by),
    pinned_by_username: row.pinned_by_username,
    created_at: row.pin_created_at,
  };
}

async function insertMessageMentions(messageId, mentions) {
  if (!mentions.length) return;
  const values = mentions.map(() => '(?, ?, ?, ?, ?)').join(',');
  const params = mentions.flatMap((mention) => [
    messageId,
    mention.mentioned_user_id,
    mention.username,
    mention.start,
    mention.end,
  ]);
  await db.query(
    `INSERT INTO message_mentions
      (message_id, mentioned_user_id, username_snapshot, mention_start, mention_end)
     VALUES ${values}`,
    params,
  );
}

function normalizeMessage(row, attachment = null, status = null, reactions = [], mentions = [], pin = null) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    username: row.username,
    message: row.text_content,
    message_type: row.message_type,
    client_message_id: row.client_message_id,
    is_deleted: row.is_deleted,
    is_edited: row.is_edited,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    reply_to_id: row.reply_to_id,
    forwarded_from_message_id: row.forwarded_from_message_id ?? null,
    forwarded_by_user_id: row.forwarded_by_user_id ?? null,
    forwarded_at: row.forwarded_at ?? null,
    reply_to: row.reply_id ? {
      id: row.reply_id,
      username: row.reply_username,
      message: row.reply_text,
    } : null,
    status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    attachment,
    reactions,
    mentions,
    is_pinned: Boolean(pin),
    pin,
    forwarded_message: row.forwarded_source_id ? {
      id: row.forwarded_source_id,
      sender_id: row.forwarded_source_sender_id,
      username: row.forwarded_source_username,
      message: row.forwarded_source_text,
      message_type: row.forwarded_source_type,
      created_at: row.forwarded_source_created_at,
    } : null,
  };
}

app.get('/health', async (req,res) => {
  try { await db.query('SELECT 1'); res.json({ok:true, db:true, redis:redis.isReady}); }
  catch (e) { res.status(503).json({ok:false, error:e.message}); }
});

const frontendDist = path.resolve(__dirname, '../web/dist');
app.use(express.static(frontendDist));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path === '/health' || req.path === '/api' || req.path.startsWith('/api/') || req.path === '/socket.io' || req.path.startsWith('/socket.io/')) {
    return next();
  }
  return res.sendFile(path.join(frontendDist, 'index.html'), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const confirmation = String(req.body?.confirm_password || '');
    if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) return res.status(400).json({ error: 'Username không hợp lệ' });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Mật khẩu phải có 8-200 ký tự' });
    if (password !== confirmation) return res.status(400).json({ error: 'Mật khẩu xác nhận không khớp' });
    if (await getUserByUsername(username)) return res.status(409).json({ error: 'Username đã tồn tại' });
    const passwordHash = await hashPassword(password);
    const [result] = await db.query(
      'INSERT INTO users (username, password_hash, full_name, account_status) VALUES (?, ?, ?, ?)',
      [username, passwordHash, username, 'active'],
    );
    await db.query('INSERT INTO user_profiles (user_id) VALUES (?)', [result.insertId]);
    await db.query('INSERT INTO user_settings (user_id) VALUES (?)', [result.insertId]);
    await ensureFriendCode(result.insertId);
    const user = await getUserById(result.insertId);
    await createSession(user.id, req, res);
    return res.status(201).json({ success: true, user: publicUser(user) });
  } catch (error) {
    console.error('POST /api/auth/register', error);
    return res.status(500).json({ error: 'Không thể đăng ký tài khoản' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = await getUserByUsername(username);
    const valid = user && user.account_status === 'active' && await verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Username hoặc mật khẩu không đúng' });
    await createSession(user.id, req, res);
    return res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    console.error('POST /api/auth/login', error);
    return res.status(500).json({ error: 'Không thể đăng nhập' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ authenticated: true, user: publicUser(req.user) });
});

app.get('/api/auth/session-token', requireAuth, async (req, res) => {
  try {
    const cookieToken = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    if (!cookieToken) return res.status(401).json({ error: 'Chưa đăng nhập' });
    return res.json({ success: true, token: cookieToken });
  } catch (error) {
    console.error('GET /api/auth/session-token', error);
    return res.status(500).json({ error: 'Không thể cấp token xác thực media' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.query('UPDATE user_sessions SET is_active = 0 WHERE access_token = ?', [tokenHash]);
  clearSessionCookie(res);
  res.json({ ok: true, success: true });
});

app.get('/api/me/friend-code', requireAuth, async (req, res) => {
  try {
    const friendCode = await ensureFriendCode(req.user.id);
    return res.json({ success: true, friend_code: friendCode });
  } catch (error) {
    console.error('GET /api/me/friend-code', error);
    return res.status(500).json({ error: 'Không thể tải mã kết bạn' });
  }
});

app.get('/api/users/by-friend-code/:code', requireAuth, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return res.status(400).json({ error: 'Mã kết bạn không hợp lệ' });
    const [rows] = await db.query(
      'SELECT id, username, full_name, friend_code FROM users WHERE friend_code = ? AND account_status = \'active\' LIMIT 1',
      [code],
    );
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy mã kết bạn' });
    return res.json({ success: true, user: { id: rows[0].id, username: rows[0].username, full_name: rows[0].full_name, friend_code: rows[0].friend_code } });
  } catch (error) {
    console.error('GET /api/users/by-friend-code/:code', error);
    return res.status(500).json({ error: 'Không thể tra cứu mã kết bạn' });
  }
});

app.post('/api/bootstrap', requireAuth, async (req,res) => {
  try {
    await ensureAIConversationMembership(req.user.id);
    const conversationId = Number(req.body?.conversation_id);
    if (conversationId) {
      const member = await ensureMembership(req.user.id, conversationId);
      if (member) return res.json({ success: true, user: publicUser(req.user), conversation_id: conversationId });
    }
    return res.json({ success: true, user: publicUser(req.user), conversation_id: null });
  } catch(e) { return res.status(400).json({success:false,error:e.message}); }
});

app.get('/api/profile/me', requireAuth, async (req,res) => {
  try {
    const [profile] = await db.query('SELECT * FROM user_profiles WHERE user_id = ? LIMIT 1', [req.user.id]);
    const [settings] = await db.query('SELECT * FROM user_settings WHERE user_id = ? LIMIT 1', [req.user.id]);
    return res.json({
      success: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        full_name: req.user.full_name,
        avatar_url: profile[0]?.avatar_url || null,
        bio: profile[0]?.bio || '',
        display_name: profile[0]?.display_name || req.user.full_name,
        theme: profile[0]?.theme || 'system',
        show_online_status: settings[0]?.show_online_status ?? 1,
      },
    });
  } catch (error) {
    console.error('GET /api/profile/me', error);
    return res.status(500).json({ error: 'Không thể tải hồ sơ' });
  }
});

app.patch('/api/profile/me', requireAuth, async (req,res) => {
  try {
    const payload = req.body || {};
    const updates = {};
    if (payload.display_name !== undefined) updates.display_name = String(payload.display_name || '').trim().slice(0, 100) || req.user.full_name;
    if (payload.bio !== undefined) updates.bio = String(payload.bio || '').slice(0, 280);
    if (payload.avatar_url !== undefined) updates.avatar_url = String(payload.avatar_url || '').slice(0, 500);
    if (payload.theme !== undefined) updates.theme = ['light', 'dark', 'system'].includes(payload.theme) ? payload.theme : 'system';
    if (!Object.keys(updates).length) return res.json({ success: true, user: publicUser(req.user) });
    const fields = Object.keys(updates);
    const values = fields.map((field) => updates[field]);
    const setClause = fields.map((field) => `${field} = ?`).join(', ');
    await db.query(`UPDATE user_profiles SET ${setClause} WHERE user_id = ?`, [...values, req.user.id]);
    return res.json({ success: true, user: { ...publicUser(req.user), ...updates } });
  } catch (error) {
    console.error('PATCH /api/profile/me', error);
    return res.status(500).json({ error: 'Không thể cập nhật hồ sơ' });
  }
});

app.get('/api/settings/me', requireAuth, async (req,res) => {
  try {
    const [settings] = await db.query('SELECT * FROM user_settings WHERE user_id = ? LIMIT 1', [req.user.id]);
    const row = settings?.[0] || { show_online_status: 1, notification_preference: 'all', ai_can_friend: 1, ai_can_message: 1 };
    return res.json({
      success: true,
      settings: {
        show_online_status: Number(row.show_online_status ?? 1),
        notification_preference: row.notification_preference || 'all',
        ai_can_friend: Number(row.ai_can_friend ?? 1),
        ai_can_message: Number(row.ai_can_message ?? 1),
      },
    });
  } catch (error) {
    console.error('GET /api/settings/me', error);
    return res.status(500).json({ error: 'Không thể tải cài đặt' });
  }
});

app.patch('/api/settings/me', requireAuth, async (req,res) => {
  try {
    const payload = req.body || {};
    const allowed = ['show_online_status', 'notification_preference', 'ai_can_friend', 'ai_can_message'];
    const updatePairs = [];
    const params = [];
    for (const key of allowed) {
      if (payload[key] !== undefined) {
        updatePairs.push(`${key} = ?`);
        params.push(key === 'notification_preference' ? String(payload[key]).slice(0, 50) : Number(Boolean(payload[key])));
      }
    }
    if (!updatePairs.length) return res.json({ success: true, updated: false });
    await db.query(`UPDATE user_settings SET ${updatePairs.join(', ')} WHERE user_id = ?`, [...params, req.user.id]);
    return res.json({ success: true, updated: true });
  } catch (error) {
    console.error('PATCH /api/settings/me', error);
    return res.status(500).json({ error: 'Không thể cập nhật cài đặt' });
  }
});

app.get('/api/devices/sessions', requireAuth, async (req,res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, ip_address, last_active_at, expires_at, is_active, created_at
       FROM user_sessions WHERE user_id = ? ORDER BY last_active_at DESC, id DESC LIMIT 10`,
      [req.user.id],
    );
    return res.json({ success: true, sessions: rows.map((row) => ({ ...row, current: Number(row.is_active) === 1 })) });
  } catch (error) {
    console.error('GET /api/devices/sessions', error);
    return res.status(500).json({ error: 'Không thể tải thiết bị' });
  }
});

app.post('/api/devices/sessions/current/logout', requireAuth, async (req,res) => {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const tokenHash = token ? crypto.createHash('sha256').update(token).digest('hex') : null;
    if (tokenHash) await db.query('UPDATE user_sessions SET is_active = 0 WHERE user_id = ? AND access_token = ?', [req.user.id, tokenHash]);
    clearSessionCookie(res);
    return res.json({ success: true });
  } catch (error) {
    console.error('POST /api/devices/sessions/current/logout', error);
    return res.status(500).json({ error: 'Không thể đăng xuất thiết bị hiện tại' });
  }
});

app.get('/api/friendships', requireAuth, async (req,res) => {
  try {
    const [rows] = await db.query(
      `SELECT f.*, u.username, u.full_name
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE (f.requester_id = ? OR f.addressee_id = ?)
       ORDER BY f.updated_at DESC`,
      [req.user.id, req.user.id, req.user.id],
    );
    const normalized = await Promise.all(rows.map(async (row) => ({
      id: row.id,
      user_id: Number(row.requester_id),
      friend_id: Number(row.addressee_id),
      friend_username: row.username,
      friend_full_name: row.full_name,
      status: row.status,
      incoming: Number(row.addressee_id) === Number(req.user.id),
      outgoing: Number(row.requester_id) === Number(req.user.id),
      can_accept: row.status === 'pending' && Number(row.addressee_id) === Number(req.user.id),
      can_reject: row.status === 'pending' && Number(row.addressee_id) === Number(req.user.id),
      blocked_by_me: row.status === 'blocked' && Number(row.requester_id) === Number(req.user.id),
      conversation_id: row.status === 'accepted'
        ? await getOrCreatePrivateConversation(Number(row.requester_id), Number(row.addressee_id))
        : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })));
    return res.json({ success: true, friendships: normalized });
  } catch (error) {
    console.error('GET /api/friendships', error);
    return res.status(500).json({ error: 'Không thể tải danh sách bạn bè' });
  }
});

app.post('/api/friendships/:userId/request', requireAuth, async (req,res) => {
  try {
    const targetId = Number(req.params.userId);
    const currentUserId = Number(req.user.id);
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: 'User ID không hợp lệ' });
    if (targetId === currentUserId) return res.status(409).json({ error: 'Không thể kết bạn với chính mình' });
    const [target] = await db.query('SELECT id FROM users WHERE id = ? LIMIT 1', [targetId]);
    if (!target.length) return res.status(404).json({ error: 'Người dùng không tồn tại' });
    const [blocked] = await db.query(
      'SELECT id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
      [currentUserId, targetId, targetId, currentUserId],
    );
    if (blocked.length) return res.status(403).json({ error: 'Không thể gửi lời mời do trạng thái chặn' });
    const [existing] = await db.query(
      'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?) LIMIT 1',
      [currentUserId, targetId, targetId, currentUserId],
    );
    if (existing.length) {
      return res.status(409).json({ error: 'Mối quan hệ đã tồn tại', status: existing[0].status });
    }
    await db.query(
      'INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, ?)',
      [currentUserId, targetId, 'pending'],
    );
    await createNotification(targetId, 'friend_request', 'Lời mời kết bạn', `${req.user.full_name || req.user.username} muốn kết bạn với bạn.`, currentUserId, { user_id: currentUserId });
    return res.status(201).json({ success: true, status: 'pending' });
  } catch (error) {
    console.error('POST /api/friendships/:userId/request', error);
    return res.status(500).json({ error: 'Không thể gửi lời mời kết bạn' });
  }
});

app.post('/api/friendships/request-by-code', requireAuth, async (req, res) => {
  try {
    const code = String(req.body?.friend_code || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return res.status(400).json({ error: 'Mã kết bạn không hợp lệ' });
    const [rows] = await db.query('SELECT id FROM users WHERE friend_code = ? AND account_status = \'active\' LIMIT 1', [code]);
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy mã kết bạn' });
    const targetId = Number(rows[0].id);
    if (targetId === Number(req.user.id)) return res.status(409).json({ error: 'Không thể kết bạn với chính mình' });
    const [blocked] = await db.query('SELECT id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [req.user.id, targetId, targetId, req.user.id]);
    if (blocked.length) return res.status(403).json({ error: 'Không thể gửi lời mời do trạng thái chặn' });
    const [existing] = await db.query('SELECT status FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?) LIMIT 1', [req.user.id, targetId, targetId, req.user.id]);
    if (existing.length) return res.status(409).json({ error: 'Mối quan hệ đã tồn tại', status: existing[0].status });
    await db.query('INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, ?)', [req.user.id, targetId, 'pending']);
    await createNotification(targetId, 'friend_request', 'Lời mời kết bạn', `${req.user.full_name || req.user.username} muốn kết bạn với bạn.`, req.user.id, { user_id: req.user.id });
    return res.status(201).json({ success: true, status: 'pending', user_id: targetId });
  } catch (error) {
    console.error('POST /api/friendships/request-by-code', error);
    return res.status(500).json({ error: 'Không thể gửi lời mời kết bạn' });
  }
});

app.post('/api/friendships/:userId/accept', requireAuth, async (req,res) => {
  try {
    const targetId = Number(req.params.userId);
    const [row] = await db.query(
      'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?) LIMIT 1',
      [req.user.id, targetId, targetId, req.user.id],
    );
    if (!row.length || row[0].status !== 'pending' || Number(row[0].addressee_id) !== Number(req.user.id)) {
      return res.status(404).json({ error: 'Lời mời không tồn tại' });
    }
    const friendship = row[0];
    const [blocked] = await db.query('SELECT id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [friendship.requester_id, friendship.addressee_id, friendship.addressee_id, friendship.requester_id]);
    if (blocked.length) return res.status(403).json({ error: 'Không thể chấp nhận do trạng thái chặn' });
    await db.query('UPDATE friendships SET status = ?, updated_at = NOW() WHERE id = ?', ['accepted', friendship.id]);
    const conversationId = await getOrCreatePrivateConversation(friendship.requester_id, friendship.addressee_id);
    await createNotification(friendship.requester_id, 'friend_accepted', 'Kết bạn thành công', 'Một người bạn đã chấp nhận lời mời.', req.user.id);
    return res.json({ success: true, status: 'accepted', conversation_id: conversationId });
  } catch (error) {
    console.error('POST /api/friendships/:userId/accept', error);
    return res.status(500).json({ error: 'Không thể chấp nhận lời mời' });
  }
});

app.post('/api/friendships/:userId/reject', requireAuth, async (req,res) => {
  try {
    const targetId = Number(req.params.userId);
    const [row] = await db.query('SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?) LIMIT 1', [req.user.id, targetId, targetId, req.user.id]);
    if (!row.length || row[0].status !== 'pending' || Number(row[0].addressee_id) !== Number(req.user.id)) {
      return res.status(404).json({ error: 'Lời mời không tồn tại' });
    }
    await db.query('UPDATE friendships SET status = ?, updated_at = NOW() WHERE id = ?', ['rejected', row[0].id]);
    return res.json({ success: true, status: 'rejected' });
  } catch (error) {
    console.error('POST /api/friendships/:userId/reject', error);
    return res.status(500).json({ error: 'Không thể từ chối lời mời' });
  }
});

app.post('/api/friendships/:userId/block', requireAuth, async (req,res) => {
  try {
    const targetId = Number(req.params.userId);
    if (targetId === Number(req.user.id)) return res.status(409).json({ error: 'Không thể chặn chính mình' });
    const [target] = await db.query('SELECT id FROM users WHERE id = ? LIMIT 1', [targetId]);
    if (!target.length) return res.status(404).json({ error: 'Người dùng không tồn tại' });
    await db.query('INSERT IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [req.user.id, targetId]);
    const [existing] = await db.query(
      'SELECT id FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?) LIMIT 1',
      [req.user.id, targetId, targetId, req.user.id],
    );
    if (existing.length) {
      await db.query('UPDATE friendships SET status = ?, updated_at = NOW() WHERE id = ?', ['blocked', existing[0].id]);
    } else {
      await db.query(
        'INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, ?)',
        [req.user.id, targetId, 'blocked'],
      );
    }
    return res.json({ success: true, status: 'blocked' });
  } catch (error) {
    console.error('POST /api/friendships/:userId/block', error);
    return res.status(500).json({ error: 'Không thể chặn người dùng' });
  }
});

app.delete('/api/friendships/:userId', requireAuth, async (req,res) => {
  try {
    const targetId = Number(req.params.userId);
    await db.query('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)', [req.user.id, targetId, targetId, req.user.id]);
    await db.query('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [req.user.id, targetId]);
    return res.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/friendships/:userId', error);
    return res.status(500).json({ error: 'Không thể xóa mối quan hệ' });
  }
});

app.get('/api/notifications', requireAuth, async (req,res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30',
      [req.user.id],
    );
    return res.json({ success: true, notifications: rows.map((row) => ({
      ...row,
      type: row.notification_type,
      message: row.content,
      metadata: row.reference_id ? { user_id: Number(row.reference_id) } : null,
    })) });
  } catch (error) {
    console.error('GET /api/notifications', error);
    return res.status(500).json({ error: 'Không thể tải thông báo' });
  }
});

app.patch('/api/notifications/:id/read', requireAuth, async (req,res) => {
  try {
    const notificationId = Number(req.params.id);
    await db.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [notificationId, req.user.id]);
    return res.json({ success: true, notification_id: notificationId });
  } catch (error) {
    console.error('PATCH /api/notifications/:id/read', error);
    return res.status(500).json({ error: 'Không thể đánh dấu thông báo đã đọc' });
  }
});

app.post('/api/notifications/read-all', requireAuth, async (req,res) => {
  try {
    await db.query('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.user.id]);
    return res.json({ success: true });
  } catch (error) {
    console.error('POST /api/notifications/read-all', error);
    return res.status(500).json({ error: 'Không thể đánh dấu thông báo đã đọc' });
  }
});

app.get('/api/stories', requireAuth, async (req,res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, u.username, u.full_name,
              (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.id) AS view_count,
              (SELECT COUNT(*) FROM story_views sv2 WHERE sv2.story_id = s.id AND sv2.viewer_id = ?) AS viewed_by_me
       FROM stories s
       JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > NOW()
       ORDER BY s.created_at DESC
       LIMIT 30`,
      [req.user.id],
    );
    return res.json({ success: true, stories: rows.map((row) => ({
      ...row,
      media_type: row.story_type,
      caption: row.text_content || '',
      viewed: Number(row.viewed_by_me || 0) > 0,
    })) });
  } catch (error) {
    console.error('GET /api/stories', error);
    return res.status(500).json({ error: 'Không thể tải story' });
  }
});

app.post('/api/stories', requireAuth, async (req,res) => {
  try {
    const { media_url, media_type = 'image', caption = '' } = req.body || {};
    if (!media_url) return res.status(400).json({ error: 'Media story không được để trống' });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const [r] = await db.query(
      'INSERT INTO stories (user_id, story_type, media_url, text_content, expires_at) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, media_type, media_url, String(caption || '').slice(0, 500), expiresAt],
    );
    return res.status(201).json({ success: true, id: r.insertId });
  } catch (error) {
    console.error('POST /api/stories', error);
    return res.status(500).json({ error: 'Không thể đăng story' });
  }
});

app.post('/api/stories/:id/view', requireAuth, async (req,res) => {
  try {
    const storyId = Number(req.params.id);
    if (!Number.isInteger(storyId) || storyId <= 0) return res.status(400).json({ error: 'Story ID không hợp lệ' });
    const [story] = await db.query('SELECT id FROM stories WHERE id = ? AND expires_at > NOW() LIMIT 1', [storyId]);
    if (!story.length) return res.status(404).json({ error: 'Story không tồn tại hoặc đã hết hạn' });
    await db.query(
      'INSERT INTO story_views (story_id, viewer_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE viewed_at = NOW()',
      [storyId, req.user.id],
    );
    return res.json({ success: true, story_id: storyId });
  } catch (error) {
    console.error('POST /api/stories/:id/view', error);
    return res.status(500).json({ error: 'Không thể ghi nhận lượt xem story' });
  }
});

app.get('/api/search', requireAuth, async (req,res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ success: true, users: [], conversations: [], messages: [] });
    const search = `%${query}%`;
    const [userRows] = await db.query(
      `SELECT id, username, full_name FROM users WHERE account_status = 'active' AND (LOWER(username) LIKE LOWER(?) OR LOWER(full_name) LIKE LOWER(?)) ORDER BY username LIMIT 10`,
      [search, search],
    );
    const [conversationRows] = await db.query(
      `SELECT c.id, c.name, c.conversation_type, c.avatar_url
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
       WHERE LOWER(c.name) LIKE LOWER(?)
       ORDER BY c.updated_at DESC LIMIT 10`,
      [req.user.id, search],
    );
    const [messageRows] = await db.query(
      `SELECT m.id, m.conversation_id, m.text_content, SUBSTRING(m.text_content, 1, 180) AS snippet, m.created_at, u.username,
              c.name AS conversation_name
       FROM messages m JOIN users u ON u.id = m.sender_id
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN message_visibility mv ON mv.message_id = m.id AND mv.user_id = ?
       WHERE m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ? AND left_at IS NULL)
         AND mv.id IS NULL AND m.is_deleted = 0 AND m.text_content IS NOT NULL AND LOWER(m.text_content) LIKE LOWER(?)
       ORDER BY m.created_at DESC LIMIT 10`,
      [req.user.id, req.user.id, search],
    );
    return res.json({ success: true, users: userRows, conversations: conversationRows, messages: messageRows });
  } catch (error) {
    console.error('GET /api/search', error);
    return res.status(500).json({ error: 'Không thể tìm kiếm' });
  }
});

app.get('/api/conversations/:id/members', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    }
    if (!await ensureMembership(req.user.id, conversationId)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    const [rows] = await db.query(
      `SELECT u.id, u.username, u.full_name
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ?
         AND cm.left_at IS NULL
         AND u.account_status = 'active'
       ORDER BY LOWER(u.username), u.id`,
      [conversationId],
    );
    return res.json({
      success: true,
      members: rows.map((row) => ({
        id: Number(row.id),
        username: row.username,
        full_name: row.full_name,
      })),
    });
  } catch (error) {
    console.error('GET /api/conversations/:id/members', error);
    return res.status(500).json({ error: 'Không thể tải thành viên cuộc trò chuyện' });
  }
});

app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.name, c.conversation_type, c.avatar_url,
              COUNT(DISTINCT cm_all.user_id) AS member_count,
              MAX(m.created_at) AS last_message_at,
              MAX(CASE WHEN m.sender_id != ? THEN 1 ELSE 0 END) AS has_unread_inbox
       FROM conversations c
       JOIN conversation_members cm_self
         ON cm_self.conversation_id = c.id
        AND cm_self.user_id = ?
        AND cm_self.left_at IS NULL
       JOIN conversation_members cm_all
         ON cm_all.conversation_id = c.id
        AND cm_all.left_at IS NULL
       LEFT JOIN messages m ON m.conversation_id = c.id AND m.is_deleted = 0
      WHERE NOT (c.conversation_type = 'group' AND c.name = 'Chat Demo')
       GROUP BY c.id, c.name, c.conversation_type, c.avatar_url
       ORDER BY COALESCE(last_message_at, c.updated_at) DESC, c.id DESC`,
      [req.user.id, req.user.id],
    );
    const conversations = [];
    for (const row of rows) {
      const settings = await getConversationUserSettings(req.user.id, row.id);
      if (Number(settings.is_hidden) === 1) continue;
      const summary = await getConversationSummaryForUser(req.user.id, row.id);
      conversations.push({
        id: Number(row.id),
        name: row.name || `Cuộc trò chuyện ${row.id}`,
        conversation_type: row.conversation_type,
        avatar_url: row.avatar_url,
        member_count: Number(row.member_count),
        last_message_at: row.last_message_at,
        unread_count: summary?.unread_count ?? 0,
        is_muted: Number(Boolean(settings.is_muted)),
        is_pinned: Number(Boolean(settings.is_pinned)),
        is_hidden: Number(Boolean(settings.is_hidden)),
        last_message_text: summary?.last_message_text || '',
        last_message_type: summary?.last_message_type || 'text',
      });
    }
    conversations.sort((left, right) => {
      if (Number(left.is_pinned) !== Number(right.is_pinned)) return Number(right.is_pinned) - Number(left.is_pinned);
      return new Date(right.last_message_at || 0).getTime() - new Date(left.last_message_at || 0).getTime();
    });
    return res.json({ success: true, conversations });
  } catch (error) {
    console.error('GET /api/conversations', error);
    return res.status(500).json({ error: 'Không thể tải danh sách cuộc trò chuyện' });
  }
});

app.get('/api/conversations/:id/settings', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    if (!await ensureMembership(req.user.id, conversationId)) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    const settings = await getConversationUserSettings(req.user.id, conversationId);
    const conversationSetting = await getConversationSetting(conversationId);
    return res.json({ success: true, settings: {
      conversation_id: Number(conversationId),
      is_muted: Number(Boolean(settings.is_muted)),
      is_pinned: Number(Boolean(settings.is_pinned)),
      is_hidden: Number(Boolean(settings.is_hidden)),
      hide_chat_history: Number(Boolean(settings.hide_chat_history)),
      disappearing_enabled: Number(Boolean(conversationSetting.disappearing_enabled)),
      disappearing_seconds: Number(conversationSetting.disappearing_seconds || 0),
    }});
  } catch (error) {
    console.error('GET /api/conversations/:id/settings', error);
    return res.status(500).json({ error: 'Không thể tải cài đặt cuộc trò chuyện' });
  }
});

app.patch('/api/conversations/:id/settings', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    const { is_muted, is_pinned, is_hidden, hide_chat_history } = req.body || {};
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    if (!await ensureMembership(req.user.id, conversationId)) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    const next = await setConversationUserSettings(req.user.id, conversationId, { is_muted, is_pinned, is_hidden, hide_chat_history });
    await publish({ type: 'conversation:user_settings', conversation_id: conversationId, user_id: req.user.id, settings: {
      is_muted: Number(Boolean(next.is_muted)),
      is_pinned: Number(Boolean(next.is_pinned)),
      is_hidden: Number(Boolean(next.is_hidden)),
      hide_chat_history: Number(Boolean(next.hide_chat_history)),
    }});
    return res.json({ success: true, settings: {
      conversation_id: Number(conversationId),
      is_muted: Number(Boolean(next.is_muted)),
      is_pinned: Number(Boolean(next.is_pinned)),
      is_hidden: Number(Boolean(next.is_hidden)),
      hide_chat_history: Number(Boolean(next.hide_chat_history)),
    }});
  } catch (error) {
    console.error('PATCH /api/conversations/:id/settings', error);
    return res.status(500).json({ error: 'Không thể cập nhật cài đặt cuộc trò chuyện' });
  }
});

app.post('/api/conversations/:id/hide', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    if (!await ensureMembership(req.user.id, conversationId)) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    const settings = await setConversationUserSettings(req.user.id, conversationId, { is_hidden: true });
    return res.json({ success: true, settings: { conversation_id: conversationId, is_hidden: Number(Boolean(settings.is_hidden)) } });
  } catch (error) {
    console.error('POST /api/conversations/:id/hide', error);
    return res.status(500).json({ error: 'Không thể ẩn cuộc trò chuyện' });
  }
});

app.delete('/api/conversations/:id/hide', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    if (!await ensureMembership(req.user.id, conversationId)) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    const settings = await setConversationUserSettings(req.user.id, conversationId, { is_hidden: false });
    return res.json({ success: true, settings: { conversation_id: conversationId, is_hidden: Number(Boolean(settings.is_hidden)) } });
  } catch (error) {
    console.error('DELETE /api/conversations/:id/hide', error);
    return res.status(500).json({ error: 'Không thể khôi phục cuộc trò chuyện' });
  }
});

app.post('/api/conversations/:id/clear', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    if (!await ensureMembership(req.user.id, conversationId)) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    const settings = await setConversationUserSettings(req.user.id, conversationId, { hide_chat_history: true });
    await db.query(
      `INSERT INTO message_visibility (user_id, message_id)
       SELECT ?, m.id FROM messages m
       LEFT JOIN message_visibility mv ON mv.user_id = ? AND mv.message_id = m.id
       WHERE m.conversation_id = ? AND m.is_deleted = 0 AND mv.id IS NULL`,
      [req.user.id, req.user.id, conversationId],
    );
    return res.json({ success: true, settings: { conversation_id: conversationId, hide_chat_history: Number(Boolean(settings.hide_chat_history)) } });
  } catch (error) {
    console.error('POST /api/conversations/:id/clear', error);
    return res.status(500).json({ error: 'Không thể xóa lịch sử theo cá nhân' });
  }
});

app.post('/api/conversations/:id/leave', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    const member = await ensureMembership(req.user.id, conversationId);
    if (!member) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    if (member.role === 'admin' || member.role === 'owner') {
      const [others] = await db.query('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? AND left_at IS NULL LIMIT 1', [conversationId, req.user.id]);
      if (!others.length) {
        await db.query('DELETE FROM conversations WHERE id = ?', [conversationId]);
          await publish({ type: 'conversation:deleted', conversation_id: conversationId, user_id: req.user.id });
        return res.json({ success: true, left: true, deleted: true });
      }
    }
    await db.query('UPDATE conversation_members SET left_at = NOW() WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL', [conversationId, req.user.id]);
    await publish({ type: 'conversation:member_left', conversation_id: conversationId, user_id: req.user.id });
    return res.json({ success: true, left: true });
  } catch (error) {
    console.error('POST /api/conversations/:id/leave', error);
    return res.status(500).json({ error: 'Không thể rời cuộc trò chuyện' });
  }
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { name, member_ids = [], avatar_url = null } = req.body || {};
    const members = Array.isArray(member_ids) ? member_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0 && id !== Number(req.user.id)) : [];
    const groupName = String(name || '').trim() || 'Nhóm mới';
    const [row] = await db.query(
      'INSERT INTO conversations (conversation_type, name, avatar_url, created_by) VALUES (?, ?, ?, ?)',
      ['group', groupName, avatar_url || null, req.user.id],
    );
    const conversationId = row.insertId;
    await db.query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)', [conversationId, req.user.id, 'admin']);
    for (const memberId of members) {
      await db.query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE left_at = NULL', [conversationId, memberId, 'member']);
    }
    await db.query('INSERT INTO conversation_settings (conversation_id) VALUES (?) ON DUPLICATE KEY UPDATE conversation_id = conversation_id', [conversationId]);
    await db.query('INSERT INTO conversation_user_settings (user_id, conversation_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE updated_at = NOW()', [req.user.id, conversationId]);
    await publish({ type: 'conversation:created', conversation_id: conversationId, user_id: req.user.id, members, name: groupName });
    return res.status(201).json({ success: true, conversation: { id: Number(conversationId), name: groupName, conversation_type: 'group', avatar_url: avatar_url || null } });
  } catch (error) {
    console.error('POST /api/conversations', error);
    return res.status(500).json({ error: 'Không thể tạo nhóm trò chuyện' });
  }
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    const { name, avatar_url } = req.body || {};
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    const member = await ensureMembership(req.user.id, conversationId);
    if (!member) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    if (!['admin', 'owner'].includes(member.role)) return res.status(403).json({ error: 'Chỉ quản trị viên mới có thể sửa nhóm' });
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(String(name || '').trim() || 'Cuộc trò chuyện'); }
    if (avatar_url !== undefined) { updates.push('avatar_url = ?'); params.push(avatar_url || null); }
    if (!updates.length) return res.json({ success: true, conversation_id: conversationId });
    params.push(conversationId);
    await db.query(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`, params);
    await publish({ type: 'conversation:updated', conversation_id: conversationId, name, avatar_url });
    return res.json({ success: true, conversation_id: conversationId });
  } catch (error) {
    console.error('PATCH /api/conversations/:id', error);
    return res.status(500).json({ error: 'Không thể cập nhật cuộc trò chuyện' });
  }
});

app.post('/api/conversations/:id/members', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    const memberId = Number(req.body?.user_id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'User ID không hợp lệ' });
    const current = await ensureMembership(req.user.id, conversationId);
    if (!current) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    if (!['admin', 'owner'].includes(current.role)) return res.status(403).json({ error: 'Chỉ quản trị viên mới có thể thêm thành viên' });
    if (Number(memberId) === Number(req.user.id)) return res.status(409).json({ error: 'Không thể thêm chính mình' });
    await db.query(
      'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE left_at = NULL, role = VALUES(role)',
      [conversationId, memberId, 'member'],
    );
    await createNotification(memberId, 'group_event', 'Được thêm vào nhóm', 'Bạn đã được thêm vào nhóm chat.', conversationId, { conversation_id: conversationId });
    await publish({ type: 'conversation:member_added', conversation_id: conversationId, user_id: memberId, actor_id: req.user.id });
    return res.json({ success: true, user_id: memberId, conversation_id: conversationId });
  } catch (error) {
    console.error('POST /api/conversations/:id/members', error);
    return res.status(500).json({ error: 'Không thể thêm thành viên' });
  }
});

app.delete('/api/conversations/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    const userId = Number(req.params.userId);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'User ID không hợp lệ' });
    const current = await ensureMembership(req.user.id, conversationId);
    if (!current) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    if (!['admin', 'owner'].includes(current.role)) return res.status(403).json({ error: 'Chỉ quản trị viên mới có thể xóa thành viên' });
    if (userId === Number(req.user.id)) return res.status(400).json({ error: 'Dùng rời nhóm để xóa chính bạn' });
    await db.query('UPDATE conversation_members SET left_at = NOW() WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL', [conversationId, userId]);
    await publish({ type: 'conversation:member_removed', conversation_id: conversationId, user_id: userId, actor_id: req.user.id });
    return res.json({ success: true, removed_user_id: userId });
  } catch (error) {
    console.error('DELETE /api/conversations/:id/members/:userId', error);
    return res.status(500).json({ error: 'Không thể xóa thành viên' });
  }
});

async function getPinnedMessages(conversationId) {
  const [rows] = await db.query(
    `SELECT m.*, u.username,
            mp.id AS pinned_id, mp.pinned_by, pu.username AS pinned_by_username,
            mp.created_at AS pin_created_at
     FROM message_pins mp
     JOIN messages m ON m.id = mp.message_id
     JOIN users u ON u.id = m.sender_id
     JOIN users pu ON pu.id = mp.pinned_by
     WHERE mp.conversation_id = ?
     ORDER BY mp.created_at DESC`,
    [conversationId],
  );
  const ids = rows.map((row) => row.id);
  const attachments = ids.length
    ? (await db.query(
      `SELECT * FROM message_attachments WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ids,
    ))[0]
    : [];
  const attachmentsByMessage = new Map(attachments.map((attachment) => [attachment.message_id, attachment]));
  const reactionsByMessage = await getMessagesReactions(ids);
  const mentionsByMessage = await getMessagesMentions(ids);
  return rows.map((row) => normalizeMessage(
    row,
    attachmentsByMessage.get(row.id) || null,
    null,
    reactionsByMessage.get(row.id) || [],
    mentionsByMessage.get(row.id) || [],
    normalizePin(row),
  ));
}

app.get('/api/conversations/:id/pins', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: 'Conversation ID không hợp lệ' });
    }
    if (!await ensureMembership(req.user.id, conversationId)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    return res.json({ success: true, pins: await getPinnedMessages(conversationId) });
  } catch (error) {
    console.error('GET /api/conversations/:id/pins', error);
    return res.status(500).json({ error: 'Không thể tải tin nhắn đã ghim' });
  }
});

app.post('/api/messages/:id/pin', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Message ID không hợp lệ' });
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    if (Number(message.is_deleted) === 1) return res.status(409).json({ error: 'Không thể ghim tin nhắn đã xóa' });
    const [existing] = await db.query('SELECT id FROM message_pins WHERE message_id = ? LIMIT 1', [messageId]);
    if (existing.length) return res.status(409).json({ error: 'Tin nhắn đã được ghim' });
    await db.query(
      'INSERT INTO message_pins (message_id, conversation_id, pinned_by) VALUES (?, ?, ?)',
      [messageId, message.conversation_id, req.user.id],
    );
    const [pinRows] = await db.query(
      `SELECT mp.id AS pinned_id, mp.message_id, mp.conversation_id, mp.pinned_by,
              u.username AS pinned_by_username, mp.created_at AS pin_created_at
       FROM message_pins mp JOIN users u ON u.id = mp.pinned_by
       WHERE mp.message_id = ?`,
      [messageId],
    );
    const pin = normalizePin({ ...pinRows[0], id: messageId });
    await publish({
      type: 'message:pinned',
      conversation_id: message.conversation_id,
      message_id: messageId,
      pin,
      message: {
        id: message.id,
        username: message.username,
        message: message.text_content,
        created_at: message.created_at,
      },
    });
    return res.status(201).json({ success: true, pin });
  } catch (error) {
    console.error('POST /api/messages/:id/pin', error);
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Tin nhắn đã được ghim' });
    return res.status(500).json({ error: 'Không thể ghim tin nhắn' });
  }
});

app.delete('/api/messages/:id/pin', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Message ID không hợp lệ' });
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    const [result] = await db.query('DELETE FROM message_pins WHERE message_id = ?', [messageId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Tin nhắn chưa được ghim' });
    await publish({ type: 'message:unpinned', conversation_id: message.conversation_id, message_id: messageId });
    return res.json({ success: true, message_id: messageId });
  } catch (error) {
    console.error('DELETE /api/messages/:id/pin', error);
    return res.status(500).json({ error: 'Không thể bỏ ghim tin nhắn' });
  }
});

app.get('/api/messages', requireAuth, async (req,res) => {
  try {
    const conversationId = Number(req.query.conversation_id);
    if (!conversationId) return res.status(400).json({error:'Thiếu conversation_id'});
    if (!await ensureMembership(req.user.id, conversationId)) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    const limit = Math.min(Math.max(Number(req.query.limit)||50,1),200);
    const [rows] = await db.query(
      `SELECT m.*, u.username,
        rm.id AS reply_id, rm.text_content AS reply_text, ru.username AS reply_username,
        fm.id AS forwarded_source_id, fm.sender_id AS forwarded_source_sender_id,
        fu.username AS forwarded_source_username, fm.text_content AS forwarded_source_text,
        fm.message_type AS forwarded_source_type, fm.created_at AS forwarded_source_created_at,
        mp.id AS pinned_id, mp.pinned_by, pu.username AS pinned_by_username,
        mp.created_at AS pin_created_at,
        CASE WHEN m.sender_id = ? THEN (
          SELECT status_type FROM message_status recipient_ms
          WHERE recipient_ms.message_id = m.id AND recipient_ms.user_id <> m.sender_id
          ORDER BY FIELD(status_type, 'read', 'delivered', 'sent') LIMIT 1
        ) ELSE ms.status_type END AS viewer_status
       FROM messages m
       JOIN users u ON u.id=m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id
       LEFT JOIN users ru ON ru.id = rm.sender_id
      LEFT JOIN messages fm ON fm.id = m.forwarded_from_message_id
      LEFT JOIN users fu ON fu.id = fm.sender_id
      LEFT JOIN message_pins mp ON mp.message_id = m.id
      LEFT JOIN users pu ON pu.id = mp.pinned_by
        LEFT JOIN message_status ms ON ms.message_id = m.id AND ms.user_id = ?
        LEFT JOIN message_visibility mv ON mv.message_id = m.id AND mv.user_id = ?
             WHERE m.conversation_id=? AND mv.id IS NULL ORDER BY m.id DESC LIMIT ?`,
            [req.user.id, req.user.id, req.user.id, conversationId, limit],
    );
    rows.reverse();
    const ids = rows.map(r=>r.id);
    let attachments = [];
    if (ids.length) {
      const placeholders = ids.map(()=>'?').join(',');
      [attachments] = await db.query(`SELECT * FROM message_attachments WHERE message_id IN (${placeholders}) ORDER BY id`, ids);
    }
    const byMessage = new Map(attachments.map(a=>[a.message_id,a]));
    const reactionsByMessage = await getMessagesReactions(ids);
    const mentionsByMessage = await getMessagesMentions(ids);
    res.json(rows.map(r=>normalizeMessage(
      r,
      byMessage.get(r.id)||null,
      r.viewer_status || null,
      reactionsByMessage.get(r.id)||[],
      mentionsByMessage.get(r.id)||[],
      normalizePin(r),
    )));
  } catch(e) { console.error(e); res.status(500).json({error:'Không thể lấy tin nhắn'}); }
});

app.delete('/api/messages/:id/visibility', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Message ID không hợp lệ' });
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    await db.query('INSERT INTO message_visibility (user_id, message_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE hidden_at = NOW()', [req.user.id, messageId]);
    return res.json({ success: true, message_id: messageId });
  } catch (error) {
    console.error('DELETE /api/messages/:id/visibility', error);
    return res.status(500).json({ error: 'Không thể ẩn tin nhắn' });
  }
});

app.post('/api/dodo/quick', requireAuth, async (req,res) => {
  try {
    const serverReceivedAt = Date.now();
    const {
      message = '',
      request_id,
      action = 'ask',
      context = null,
      history = [],
    } = req.body || {};

    const user = req.user;
    const text = String(message || '').trim();
    const requestId = String(request_id || '').trim();

    if (!text) {
      return res.status(400).json({ error: 'Yêu cầu không được để trống' });
    }

    if (!requestId) {
      return res.status(400).json({ error: 'Thiếu request_id' });
    }

    const cleanHistory = Array.isArray(history)
      ? history
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
        .slice(-8)
        .map((item) => ({
          role: item.role,
          content: String(item.content || '').slice(0, 2000),
        }))
      : [];

    try {
      await enqueueAI({
        source: 'quick',
        action: String(action || 'ask'),
        user_id: user.id,
        username: user.username,
        message_id: requestId,
        request_id: requestId,
        message: text,
        server_received_at: serverReceivedAt,
        enqueued_at: Date.now(),
        context: context && typeof context === 'object'
          ? {
            type: String(context.type || '').slice(0, 40),
            content: String(context.content || '').slice(0, 4000),
            source: String(context.source || '').slice(0, 80),
          }
          : null,
        history: cleanHistory,
      });
    } catch (enqueueError) {
      console.error('[AI] Dodo quick enqueue failed:', enqueueError.message);
      return res.status(503).json({ error: 'Không thể kết nối AI, vui lòng thử lại.' });
    }

    res.json({
      success: true,
      request_id: requestId,
      server_received_at: serverReceivedAt,
      responded_at: Date.now(),
    });
  } catch (e) {
    console.error('POST /api/dodo/quick', e);
    res.status(500).json({ error: 'Dodo đang gặp trục trặc' });
  }
});

app.post('/api/messages', requireAuth, async (req,res) => {
  try {
    const {
      message = '',
      conversation_id,
      client_message_id,
      reply_to_id,
      attachment = null,
    } = req.body || {};

    const user = req.user;
    const conversationId = Number(conversation_id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: 'Cần chọn một cuộc trò chuyện trước khi gửi tin nhắn' });
    }

    const member = await ensureMembership(user.id, conversationId);

    if (!member) {
      return res.status(403).json({
        error: 'Bạn không thuộc cuộc trò chuyện này',
      });
    }

    const replyToId = Number(reply_to_id) || null;
    if (replyToId) {
      const replyTarget = await getMessageForAction(replyToId);
      if (!replyTarget || Number(replyTarget.conversation_id) !== conversationId) {
        return res.status(400).json({ error: 'Tin nhắn trả lời không hợp lệ' });
      }
    }

    const text = String(message || '').trim();

    // Tin nhắn phải có nội dung hoặc file đính kèm
    if (!text && !attachment) {
      return res.status(400).json({
        error: 'Tin nhắn không được để trống',
      });
    }

    let mentions;
    try {
      mentions = await resolveMentions(conversationId, text);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const setting = await getConversationSetting(conversationId);
    const temporary =
      Number(setting.disappearing_enabled) === 1 &&
      Number(setting.disappearing_seconds) > 0;

    // Tạm thời chưa cho file đi cùng tin nhắn tự xoá
    if (temporary && attachment) {
      return res.status(400).json({
        error: 'File đính kèm chưa hỗ trợ trong tin nhắn tự xoá',
      });
    }

    // =========================
    // TIN NHẮN TỰ XOÁ
    // =========================
    if (temporary) {
      const tempId =
        `temp-${user.id}-${Date.now()}-` +
        Math.random().toString(36).slice(2, 8);

      const ttl = Number(setting.disappearing_seconds);

      const payload = {
        id: tempId,
        conversation_id: conversationId,
        sender_id: user.id,
        username: user.username,
        message: text,
        message_type: 'text',
        client_message_id: client_message_id || null,
        temporary: true,
        mentions,
        expires_at: new Date(
          Date.now() + ttl * 1000
        ).toISOString(),
        created_at: nowIso(),
      };

      await redis.setEx(
        `tempmsg:${conversationId}:${tempId}`,
        ttl,
        JSON.stringify(payload)
      );

      await publish({
        type: 'message:new',
        conversation_id: conversationId,
        message: payload,
      });

      const aiConversation = await isAIConversation(conversationId);
      const shouldTriggerAI =
        aiConversation || /@ai\b/i.test(text);

      if (shouldTriggerAI) {
        await enqueueAI({
          source: 'temporary',
          conversation_id: conversationId,
          is_ai_conversation: aiConversation,
          user_id: user.id,
          username: user.username,
          message_id: tempId,
          message: text,
        });
      }

      return res.json({
        success: true,
        temporary: true,
        ...payload,
      });
    }

    // =========================
    // TIN NHẮN BÌNH THƯỜNG
    // =========================

    const messageType = attachment
      ? String(attachment.attachment_type || 'file')
      : 'text';

    const [r] = await db.query(
      `INSERT INTO messages
      (
        conversation_id,
        sender_id,
        message_type,
        text_content,
        client_message_id,
        reply_to_id
      )
      VALUES (?,?,?,?,?,?)`,
      [
        conversationId,
        user.id,
        messageType,
        text || null,
        client_message_id || null,
        replyToId,
      ]
    );

    await setMessageStatus(r.insertId, user.id, 'sent');
    await insertMessageMentions(r.insertId, mentions);

    // =========================
    // LƯU ATTACHMENT
    // =========================

    if (attachment) {
      await db.query(
        `INSERT INTO message_attachments
        (
          message_id,
          attachment_type,
          file_name,
          file_url,
          thumbnail_url,
          mime_type,
          file_size,
          width,
          height,
          duration_sec
        )
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          r.insertId,
          attachment.attachment_type || 'file',
          attachment.file_name || null,
          attachment.file_url,
          attachment.thumbnail_url || null,
          attachment.mime_type || null,
          attachment.file_size || null,
          attachment.width || null,
          attachment.height || null,
          attachment.duration_sec || null,
        ]
      );
    }

    // Lấy lại message
    const [rows] = await db.query(
      `SELECT m.*, u.username
       , rm.id AS reply_id, rm.text_content AS reply_text, ru.username AS reply_username
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id
       LEFT JOIN users ru ON ru.id = rm.sender_id
       WHERE m.id=?`,
      [r.insertId]
    );

    // Lấy attachment vừa lưu
    let savedAttachment = null;

    if (attachment) {
      const [attachmentRows] = await db.query(
        `SELECT *
         FROM message_attachments
         WHERE message_id=?
         ORDER BY id DESC
         LIMIT 1`,
        [r.insertId]
      );

      savedAttachment = attachmentRows[0] || null;
    }

    const payload = normalizeMessage(rows[0], savedAttachment, 'sent', [], mentions);

    // Realtime tới Web / Android
    await publish({
      type: 'message:new',
      conversation_id: conversationId,
      message: payload,
    });

    // AI vẫn hoạt động như trước
    const aiConversation = await isAIConversation(conversationId);
    const shouldTriggerAI =
      aiConversation || /@ai\b/i.test(text);

    if (shouldTriggerAI) {
      try {
        await enqueueAI({
          source: 'sql',
          conversation_id: conversationId,
          is_ai_conversation: aiConversation,
          user_id: user.id,
          username: user.username,
          message_id: r.insertId,
          message: text,
          client_message_id: client_message_id || null,
          request_id: String(client_message_id || `chat-${r.insertId}-${Date.now()}`),
        });
      } catch (enqueueError) {
        console.error('[AI] SQL-message enqueue failed:', enqueueError.message);
        return res.status(503).json({ error: 'Không thể kết nối AI, vui lòng thử lại.' });
      }
    }

    res.json({
      success: true,
      ...payload,
    });
  } catch(e) {
    console.error(
      'POST /api/messages',
      e
    );

    res.status(500).json({
      error:
        e.message ||
        'Không thể gửi tin nhắn',
    });
  }
});

app.post('/api/messages/:id/forward', requireAuth, async (req, res) => {
  const sourceMessageId = Number(req.params.id);
  const requestedConversationIds = Array.isArray(req.body?.conversation_ids)
    ? req.body.conversation_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const conversationIds = [...new Set(requestedConversationIds)].slice(0, 20);

  if (!Number.isInteger(sourceMessageId) || sourceMessageId <= 0) {
    return res.status(400).json({ error: 'Message ID không hợp lệ' });
  }
  if (!conversationIds.length) {
    return res.status(400).json({ error: 'Cần chọn ít nhất một cuộc trò chuyện' });
  }

  const source = await getMessageForAction(sourceMessageId);
  if (!source) return res.status(404).json({ error: 'Không tìm thấy tin nhắn gốc' });
  if (!await ensureMembership(req.user.id, source.conversation_id)) {
    return res.status(403).json({ error: 'Bạn không có quyền xem tin nhắn này' });
  }
  if (Number(source.is_deleted) === 1) {
    return res.status(409).json({ error: 'Không thể chuyển tiếp tin nhắn đã bị xóa' });
  }

  const [attachmentRows] = await db.query(
    'SELECT * FROM message_attachments WHERE message_id = ? ORDER BY id DESC LIMIT 1',
    [sourceMessageId],
  );
  const sourceAttachment = attachmentRows[0] || null;
  const sourceMentions = (await getMessagesMentions([sourceMessageId])).get(sourceMessageId) || [];
  const sourceReactions = await getMessageReactions(sourceMessageId);
  const connection = await db.getConnection();
  const inserted = [];

  try {
    await connection.beginTransaction();
    for (const conversationId of conversationIds) {
      const [membershipRows] = await connection.query(
        `SELECT id FROM conversation_members
         WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1`,
        [conversationId, req.user.id],
      );
      if (!membershipRows.length) {
        const error = new Error('Bạn không có quyền gửi vào một cuộc trò chuyện đã chọn');
        error.statusCode = 403;
        throw error;
      }

      const [targetMembers] = await connection.query(
        `SELECT user_id FROM conversation_members
         WHERE conversation_id = ? AND left_at IS NULL`,
        [conversationId],
      );
      const targetMemberIds = new Set(targetMembers.map((row) => Number(row.user_id)));
      const targetMentions = sourceMentions.filter((mention) => targetMemberIds.has(Number(mention.user_id)));
      const [messageResult] = await connection.query(
        `INSERT INTO messages
          (conversation_id, sender_id, message_type, text_content,
           forwarded_from_message_id, forwarded_by_user_id, forwarded_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          conversationId,
          req.user.id,
          source.message_type || 'text',
          source.text_content,
          sourceMessageId,
          req.user.id,
        ],
      );
      const newMessageId = messageResult.insertId;
      await connection.query(
        `INSERT INTO message_status (message_id, user_id, status_type)
         VALUES (?, ?, 'sent')`,
        [newMessageId, req.user.id],
      );
      if (sourceAttachment) {
        await connection.query(
          `INSERT INTO message_attachments
            (message_id, attachment_type, file_name, file_url, thumbnail_url,
             mime_type, file_size, width, height, duration_sec)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newMessageId,
            sourceAttachment.attachment_type,
            sourceAttachment.file_name,
            sourceAttachment.file_url,
            sourceAttachment.thumbnail_url,
            sourceAttachment.mime_type,
            sourceAttachment.file_size,
            sourceAttachment.width,
            sourceAttachment.height,
            sourceAttachment.duration_sec,
          ],
        );
      }
      if (targetMentions.length) {
        const values = targetMentions.map(() => '(?, ?, ?, ?, ?)').join(',');
        const params = targetMentions.flatMap((mention) => [
          newMessageId,
          mention.user_id,
          mention.username,
          mention.start,
          mention.end,
        ]);
        await connection.query(
          `INSERT INTO message_mentions
            (message_id, mentioned_user_id, username_snapshot, mention_start, mention_end)
           VALUES ${values}`,
          params,
        );
      }
      inserted.push({ messageId: newMessageId, conversationId });
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('POST /api/messages/:id/forward', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Không thể chuyển tiếp tin nhắn' });
  } finally {
    connection.release();
  }

  const forwarded = [];
  for (const item of inserted) {
    const forwardedRow = await getMessageForAction(item.messageId);
    const [forwardedAttachments] = await db.query(
      'SELECT * FROM message_attachments WHERE message_id = ? ORDER BY id DESC LIMIT 1',
      [item.messageId],
    );
    const forwardedMentions = (await getMessagesMentions([item.messageId])).get(item.messageId) || [];
    const payload = normalizeMessage(forwardedRow, forwardedAttachments[0] || null, 'sent', [], forwardedMentions);
    payload.forwarded_message = {
      id: source.id,
      sender_id: source.sender_id,
      username: source.username,
      message: source.text_content,
      message_type: source.message_type,
      attachment: sourceAttachment,
      mentions: sourceMentions,
      reactions: sourceReactions,
      created_at: source.created_at,
    };
    await publish({
      type: 'message:new',
      conversation_id: item.conversationId,
      message: payload,
    });
    forwarded.push(payload);
  }

  return res.json({ success: true, forwarded });
});

app.patch('/api/messages/:id', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    const text = String(req.body?.message || '').trim();
    if (!Number.isInteger(messageId) || messageId <= 0 || !text) {
      return res.status(400).json({ error: 'Tin nhắn chỉnh sửa không hợp lệ' });
    }
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    if (Number(message.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Bạn không có quyền chỉnh sửa tin nhắn này' });
    }
    if (Number(message.is_deleted) === 1) return res.status(409).json({ error: 'Tin nhắn đã bị xóa' });
    let mentions;
    try {
      mentions = await resolveMentions(message.conversation_id, text);
    } catch (mentionError) {
      return res.status(400).json({ error: mentionError.message });
    }
    await db.query(
      'UPDATE messages SET text_content = ?, is_edited = 1, edited_at = NOW() WHERE id = ?',
      [text, messageId],
    );
    await db.query('DELETE FROM message_mentions WHERE message_id = ?', [messageId]);
    await insertMessageMentions(messageId, mentions);
    const updated = await getMessageForAction(messageId);
    const [reactions] = await db.query(
      `SELECT mr.*, u.username, u.full_name
       FROM message_reactions mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.message_id = ? ORDER BY mr.created_at`,
      [messageId],
    );
    const payload = normalizeMessage(updated, null, message.status || 'sent', reactions, mentions);
    await publish({ type: 'message:edited', conversation_id: message.conversation_id, message: payload });
    return res.json({ success: true, ...payload });
  } catch (error) {
    console.error('PATCH /api/messages/:id', error);
    return res.status(500).json({ error: 'Không thể chỉnh sửa tin nhắn' });
  }
});

app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Message ID không hợp lệ' });
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    if (Number(message.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Bạn không có quyền xóa tin nhắn này' });
    }
    if (Number(message.is_deleted) === 1) return res.json({ success: true, already_deleted: true });
    await db.query(
      'UPDATE messages SET text_content = NULL, is_deleted = 1, deleted_at = NOW() WHERE id = ?',
      [messageId],
    );
    const updated = await getMessageForAction(messageId);
    const [reactions] = await db.query(
      `SELECT mr.*, u.username, u.full_name
       FROM message_reactions mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.message_id = ? ORDER BY mr.created_at`,
      [messageId],
    );
    const mentionsByMessage = await getMessagesMentions([messageId]);
    const payload = normalizeMessage(
      updated,
      null,
      message.status || 'sent',
      reactions,
      mentionsByMessage.get(messageId) || [],
    );
    await publish({ type: 'message:deleted', conversation_id: message.conversation_id, message: payload });
    return res.json({ success: true, ...payload });
  } catch (error) {
    console.error('DELETE /api/messages/:id', error);
    return res.status(500).json({ error: 'Không thể xóa tin nhắn' });
  }
});

app.post('/api/messages/:id/read', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Message ID không hợp lệ' });
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    if (Number(message.sender_id) === Number(req.user.id)) return res.json({ success: true, status: 'sent' });
    if (await setMessageStatus(messageId, req.user.id, 'read')) {
      await publish({
        type: 'message:status',
        conversation_id: message.conversation_id,
        message_id: messageId,
        user_id: req.user.id,
        sender_id: message.sender_id,
        status: 'read',
      });
    }
    return res.json({ success: true, message_id: messageId, status: 'read' });
  } catch (error) {
    console.error('POST /api/messages/:id/read', error);
    return res.status(500).json({ error: 'Không thể cập nhật trạng thái đọc' });
  }
});

app.post('/api/conversations/:id/disappearing', requireAuth, async (req,res) => {
  try {
    const conversationId=Number(req.params.id);
    const user=req.user; const member=await ensureMembership(user.id,conversationId);
    if(!member) return res.status(403).json({error:'Không phải thành viên'});
    const enabled=Boolean(req.body.enabled); const seconds=enabled ? Math.max(60, Number(req.body.seconds)||86400) : 0;
    await db.query(`INSERT INTO conversation_settings (conversation_id,disappearing_enabled,disappearing_seconds) VALUES (?,?,?) ON DUPLICATE KEY UPDATE disappearing_enabled=VALUES(disappearing_enabled), disappearing_seconds=VALUES(disappearing_seconds)`, [conversationId,enabled?1:0,seconds]);
    await publish({type:'conversation:settings',conversation_id:conversationId,settings:{disappearing_enabled:enabled?1:0,disappearing_seconds:seconds}});
    res.json({success:true,conversation_id:conversationId,disappearing_enabled:enabled?1:0,disappearing_seconds:seconds});
  } catch(e){res.status(500).json({error:e.message});}
});

// =========================
// MESSAGE REACTIONS
// =========================

app.get('/api/messages/:id/reactions', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Message ID không hợp lệ' });
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    const reactions = await getMessageReactions(messageId);
    res.json({ success: true, reactions });
  } catch (error) {
    console.error('GET /api/messages/:id/reactions', error);
    return res.status(500).json({ error: 'Không thể lấy reactions' });
  }
});

app.post('/api/messages/:id/reactions', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    const reactionType = String(req.body?.reaction_type || '').trim();
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Message ID không hợp lệ' });
    if (!ALLOWED_REACTIONS.has(reactionType)) return res.status(400).json({ error: 'Reaction type không được hỗ trợ' });
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    const [existing] = await db.query(
      'SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_type = ? LIMIT 1',
      [messageId, req.user.id, reactionType],
    );
    if (existing.length) {
      return res.json({ success: true, already_exists: true });
    }
    const [r] = await db.query(
      'INSERT INTO message_reactions (message_id, user_id, reaction_type) VALUES (?, ?, ?)',
      [messageId, req.user.id, reactionType],
    );
    const [rows] = await db.query(
      `SELECT mr.*, u.username, u.full_name
       FROM message_reactions mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.id = ?`,
      [r.insertId],
    );
    const reaction = rows[0];
    await publish({
      type: 'message:reaction_added',
      conversation_id: message.conversation_id,
      message_id: messageId,
      reaction: {
        id: reaction.id,
        message_id: reaction.message_id,
        user_id: reaction.user_id,
        username: reaction.username,
        full_name: reaction.full_name,
        reaction_type: reaction.reaction_type,
        created_at: reaction.created_at,
      },
    });
    res.json({ success: true, reaction });
  } catch (error) {
    console.error('POST /api/messages/:id/reactions', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.json({ success: true, already_exists: true });
    }
    return res.status(500).json({ error: 'Không thể thêm reaction' });
  }
});

app.delete('/api/messages/:id/reactions', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    const reactionType = String(req.body?.reaction_type || '').trim();
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Message ID không hợp lệ' });
    if (!ALLOWED_REACTIONS.has(reactionType)) return res.status(400).json({ error: 'Reaction type không được hỗ trợ' });
    const message = await getMessageForAction(messageId);
    if (!message) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
    if (!await ensureMembership(req.user.id, message.conversation_id)) {
      return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này' });
    }
    const [result] = await db.query(
      'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_type = ?',
      [messageId, req.user.id, reactionType],
    );
    if (result.affectedRows === 0) {
      return res.json({ success: true, not_found: true });
    }
    await publish({
      type: 'message:reaction_removed',
      conversation_id: message.conversation_id,
      message_id: messageId,
      reaction: { user_id: req.user.id, reaction_type: reactionType },
    });
    res.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/messages/:id/reactions', error);
    return res.status(500).json({ error: 'Không thể xóa reaction' });
  }
});

async function enqueueAI(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error('Invalid AI job payload');
  }

  const source = String(job.source || 'sql').trim();
  if (!['sql', 'temporary', 'quick'].includes(source)) {
    throw new Error('Invalid AI source');
  }

  const text = String(job.message || '').trim();
  if (!text) {
    throw new Error('AI job requires non-empty message');
  }

  if (!job.user_id) {
    throw new Error('AI job requires user_id');
  }

  if (source !== 'quick') {
    const conversationId = Number(job.conversation_id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new Error('AI job requires conversation_id');
    }
  }

  const requestId = String(
    job.request_id ||
    job.client_message_id ||
    job.message_id ||
    `${String(job.conversation_id || 'unknown')}:${String(job.user_id || 'unknown')}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  ).trim();

  if (!requestId) {
    throw new Error('AI job requires request_id');
  }

  job.request_id = requestId;
  if (job.client_message_id) {
    job.client_message_id = String(job.client_message_id);
  }

  const dedupeKey = String(
    job.request_id ||
    job.client_message_id ||
    job.message_id ||
    `${job.conversation_id || 'unknown'}:${job.user_id || 'unknown'}:${String(job.message || '').slice(0, 80)}`
  );

  const now = Date.now();
  const lastSeen = AI_ENQUEUE_DEDUPE.get(dedupeKey);
  if (lastSeen && now - lastSeen < 500) {
    console.log(`[AI] Suppressed duplicate enqueue key=${dedupeKey.slice(0,80)}`);
    return false;
  }
  AI_ENQUEUE_DEDUPE.set(dedupeKey, now);

  try {
    await redis.rPush(AI_QUEUE_KEY, JSON.stringify(job));
    console.log(`[AI] Enqueued job queue=${AI_QUEUE_KEY} request_id=${requestId} conversation=${job.conversation_id || 'unknown'} message=${job.message_id || requestId || job.client_message_id || 'unknown'} source=${source}`);
    return true;
  } catch (error) {
    const safeMsg = error && error.message ? error.message : String(error);
    console.error('[AI] Enqueue failed:', safeMsg);
    throw new Error('Không thể kết nối AI, vui lòng thử lại.');
  }
}

async function canExposePresence(userId) {
  const [rows] = await db.query(
    'SELECT COALESCE(show_online_status, 1) AS show_online_status FROM user_settings WHERE user_id = ? LIMIT 1',
    [userId],
  );
  return !rows.length || Number(rows[0].show_online_status) === 1;
}

async function emitGlobalOnlineUsers() {
  for (const targetSocketIds of socketsByUser.values()) {
    for (const socketId of targetSocketIds) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (!targetSocket) continue;
      const [rows] = await db.query(
        `SELECT DISTINCT other_cm.user_id
         FROM conversation_members own_cm
         JOIN conversation_members other_cm ON other_cm.conversation_id = own_cm.conversation_id
         LEFT JOIN user_settings us ON us.user_id = other_cm.user_id
         WHERE own_cm.user_id = ? AND own_cm.left_at IS NULL AND other_cm.left_at IS NULL
           AND other_cm.user_id <> own_cm.user_id AND COALESCE(us.show_online_status, 1) = 1`,
        [targetSocket.user.id],
      );
      const visibleIds = rows.map((row) => Number(row.user_id)).filter((id) => socketsByUser.has(id));
      targetSocket.emit('online_users', visibleIds);
    }
  }
}

async function emitConversationPresence(socket, conversationId) {
  const [members] = await db.query(
    `SELECT cm.user_id FROM conversation_members cm
     LEFT JOIN user_settings us ON us.user_id = cm.user_id
     WHERE cm.conversation_id = ? AND cm.left_at IS NULL AND us.show_online_status = 1`,
    [conversationId],
  );
  const onlineIds = new Set(socketsByUser.keys());
  socket.emit('conversation_presence', {
    conversation_id: conversationId,
    user_ids: members.map((member) => Number(member.user_id)).filter((id) => onlineIds.has(id)),
  });
}

io.on('connection', socket => {
  const wasOnline = socketsByUser.has(socket.user.id);
  if(!wasOnline) socketsByUser.set(socket.user.id,new Set());
  socketsByUser.get(socket.user.id).add(socket.id);
  socket.emit('session_ready',{user_id:socket.user.id,username:socket.user.username});
  emitGlobalOnlineUsers().catch((error) => console.error('Presence broadcast error:', error));
  socket.on('join_conversation', async conversationId => {
    if(!socket.user) return socket.emit('server_error',{error:'Chưa xác thực'});
    const cid=Number(conversationId); if(!cid) return;
    const member=await ensureMembership(socket.user.id,cid); if(!member) return socket.emit('server_error',{error:'Không có quyền vào cuộc trò chuyện'});
    socket.join(room(cid));
    await markConversationDelivered(socket.user.id, cid);
    await emitConversationPresence(socket, cid);
    if (!wasOnline && await canExposePresence(socket.user.id)) {
      socket.to(room(cid)).emit('presence:update', { conversation_id: cid, user_id: socket.user.id, online: true });
    }
    socket.emit('conversation_joined',{conversation_id:cid});
  });
  socket.on('mark_read', async data => {
    try {
      const cid = Number(data?.conversation_id);
      const messageIds = Array.isArray(data?.message_ids)
        ? data.message_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 100)
        : [];
      if (!cid || !messageIds.length || !await ensureMembership(socket.user.id, cid)) return;
      const placeholders = messageIds.map(() => '?').join(',');
      const [rows] = await db.query(
        `SELECT id, sender_id FROM messages WHERE conversation_id = ? AND id IN (${placeholders}) AND sender_id <> ?`,
        [cid, ...messageIds, socket.user.id],
      );
      for (const row of rows) {
        if (await setMessageStatus(row.id, socket.user.id, 'read')) {
          await publish({ type: 'message:status', conversation_id: cid, message_id: row.id, user_id: socket.user.id, sender_id: row.sender_id, status: 'read' });
        }
      }
    } catch (error) {
      console.error('Socket mark_read error:', error);
    }
  });
  socket.on('typing', async data => {
    const cid=Number(data?.conversation_id);
    if(!cid || !await ensureMembership(socket.user.id,cid)) return;
    socket.to(room(cid)).emit('typing',{conversation_id:cid,user_id:socket.user.id,username:socket.user.username,typing:Boolean(data.typing)});
  });
  socket.on('disconnecting',()=>{
    socket._presenceRooms = Array.from(socket.rooms);
  });
  socket.on('disconnect', async ()=>{
    if(!socket.user) return;
    const set=socketsByUser.get(socket.user.id);
    if(!set) return;
    set.delete(socket.id);
    const wentOffline = set.size === 0;
    if(wentOffline) socketsByUser.delete(socket.user.id);
    emitGlobalOnlineUsers().catch((error) => console.error('Presence broadcast error:', error));
    if(wentOffline && await canExposePresence(socket.user.id)) {
      for (const joinedRoom of socket._presenceRooms || []) {
        if (!joinedRoom.startsWith('conversation:')) continue;
        const cid = Number(joinedRoom.slice('conversation:'.length));
        socket.to(joinedRoom).emit('presence:update', { conversation_id: cid, user_id: socket.user.id, online: false });
      }
    }
  });
});

async function main() {
  if (!redis.isOpen) {
    await redis.connect();
  }

  if (!redisSub.isOpen) {
    await redisSub.connect();
  }

  await backfillFriendCodes();

  console.log('Redis connected');
  console.log('Redis subscriber connected');
  console.log('Listening Redis channel:', CHAT_CHANNEL);

  await redisSub.subscribe(CHAT_CHANNEL, raw => {
    try {
      console.log('\n========== REDIS EVENT ==========');
      console.log(raw);

      const e = JSON.parse(raw);

      console.log('Event type:', e.type);
      console.log('Conversation:', e.conversation_id);
      if (e.type === 'ai:done') {
        console.log('[AI TRACE] redis event:', e);
      }

      if (e.type === 'ai:quick:processing' || e.type === 'ai:quick:done') {
        console.log('[AI SPEED]', {
          event: e.type,
          request_id: e.request_id,
          timing: e.timing || null,
        });
        const socketIds = socketsByUser.get(Number(e.user_id)) || new Set();
        for (const socketId of socketIds) {
          io.to(socketId).emit(
            e.type === 'ai:quick:processing'
              ? 'dodo_quick_processing'
              : 'dodo_quick_done',
            e,
          );
        }
      } else if (e.type === 'message:new') {
        console.log('MESSAGE NEW:', e.message);

        io.to(room(e.conversation_id)).emit(
          'new_message',
          e.message
        );

        console.log(
          'Socket emitted: new_message ->',
          room(e.conversation_id)
        );

      } else if (e.type === 'message:edited' || e.type === 'message:deleted') {
        io.to(room(e.conversation_id)).emit(e.type, e);

      } else if (e.type === 'message:status') {
        io.to(room(e.conversation_id)).emit('message:status', e);

      } else if (e.type === 'ai:processing') {
        console.log('AI PROCESSING:', e);

        io.to(room(e.conversation_id)).emit(
          'ai_processing',
          e
        );

        console.log(
          'Socket emitted: ai_processing ->',
          room(e.conversation_id)
        );

      } else if (e.type === 'ai:done') {
        console.log('AI DONE:', e);

        io.to(room(e.conversation_id)).emit(
          'ai_processing_done',
          e
        );

        console.log(
          '[AI TRACE] socket emit:',
          'ai_processing_done',
          room(e.conversation_id),
          e
        );

      } else if (e.type === 'message:expired') {
        console.log('MESSAGE EXPIRED:', e);

        io.to(room(e.conversation_id)).emit(
          'message_expired',
          e
        );

      } else if (e.type === 'conversation:settings') {
        console.log('CONVERSATION SETTINGS:', e.settings);

        io.to(room(e.conversation_id)).emit(
          'conversation_settings',
          e.settings
        );

      } else if (e.type === 'message:reaction_added') {
        console.log('MESSAGE REACTION ADDED:', e);

        io.to(room(e.conversation_id)).emit('message:reaction_added', e);

      } else if (e.type === 'message:reaction_removed') {
        console.log('MESSAGE REACTION REMOVED:', e);

        io.to(room(e.conversation_id)).emit('message:reaction_removed', e);
      } else if (e.type === 'message:pinned' || e.type === 'message:unpinned') {
        io.to(room(e.conversation_id)).emit(e.type, e);
      } else if (e.type === 'conversation:user_settings') {
        const socketIds = socketsByUser.get(Number(e.user_id)) || new Set();
        for (const socketId of socketIds) io.to(socketId).emit('conversation:user_settings', e);
      } else if (e.type === 'conversation:created') {
        const memberIds = [...new Set([Number(e.user_id), ...(Array.isArray(e.members) ? e.members.map(Number) : [])].filter(Boolean))];
        for (const userId of memberIds) {
          const socketIds = socketsByUser.get(userId) || new Set();
          for (const socketId of socketIds) io.to(socketId).emit('conversation:created', e);
        }
      } else if (e.type.startsWith('conversation:')) {
        io.to(room(e.conversation_id)).emit(e.type, e);
      } else if (e.type === 'notification:new') {
        const socketIds = socketsByUser.get(Number(e.user_id)) || new Set();
        for (const socketId of socketIds) io.to(socketId).emit('notification:new', e.notification);
      }

      console.log('================================\n');

    } catch (e) {
      console.error('Redis event error:', e);
    }
  });

  server.listen(
    Number(process.env.PORT || 3000),
    '0.0.0.0',
    () => {
      console.log(
        `Chat server listening on ${process.env.PORT || 3000}`
      );
    }
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});