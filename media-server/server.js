const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { execFile } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
require('dotenv').config();

const app = express();
const configuredOrigins = String(process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);
const allowAllOrigins = configuredOrigins.includes('*');
const allowedOrigins = allowAllOrigins ? [] : configuredOrigins;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowAllOrigins || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }
    return callback(new Error('Origin không được phép'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

async function requireAuth(req, res, next) {
  try {
    const headers = {
      cookie: req.headers.cookie || '',
      authorization: req.headers.authorization || '',
    };
    const response = await fetch(`${process.env.CHAT_SERVER_URL || 'http://localhost:3000'}/api/auth/me`, {
      headers,
    });
    if (!response.ok) return res.status(401).json({ error: 'Chưa đăng nhập' });
    req.user = await response.json();
    return next();
  } catch (error) {
    console.error('Media auth error:', error.message);
    return res.status(503).json({ error: 'Không thể xác thực phiên' });
  }
}

const dir = path.resolve(process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(dir, { recursive: true });
app.use('/media', express.static(dir));

const max = Number(process.env.MAX_FILE_MB || 200) * 1024 * 1024;
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const allowedImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const allowedVideoTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const allowedVideoExtensions = new Set(['.mp4', '.webm', '.mov']);
const blockedExtensions = new Set([
  '.bat', '.cmd', '.com', '.dll', '.exe', '.hta', '.js', '.mjs', '.ps1', '.sh', '.so',
  '.vbs', '.wsf',
]);

function isAllowedFile(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (blockedExtensions.has(extension)) return false;
  if (file.mimetype.startsWith('image/')) {
    return allowedImageTypes.has(file.mimetype) && allowedImageExtensions.has(extension);
  }
  if (file.mimetype.startsWith('video/')) {
    return allowedVideoTypes.has(file.mimetype) && allowedVideoExtensions.has(extension);
  }
  return true;
}

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, dir),
  filename: (req, file, callback) => callback(
    null,
    `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${path.extname(file.originalname).toLowerCase()}`,
  ),
});
const upload = multer({
  storage,
  limits: { fileSize: max },
  fileFilter: (req, file, callback) => {
    if (!isAllowedFile(file)) return callback(new Error('Định dạng này chưa được hỗ trợ.'));
    return callback(null, true);
  },
});

function probe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', filePath],
      (error, output) => error ? reject(error) : resolve(JSON.parse(output)),
    );
  });
}

app.get('/', (req, res) => res.json({ service: 'media-server', status: 'ok' }));
app.get('/health', (req, res) => res.json({ ok: true, storage: process.env.STORAGE_MODE || 'local' }));

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file' });
    const isVideo = req.file.mimetype.startsWith('video/');
    const isImage = req.file.mimetype.startsWith('image/');
    let thumbnailUrl = null;
    let width = null;
    let height = null;
    let duration = null;
    const safeOriginalName = path.basename(req.file.originalname || req.file.filename);

    if (isImage) {
      const thumbnailName = `thumb_${path.parse(req.file.filename).name}.jpg`;
      await sharp(req.file.path)
        .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toFile(path.join(dir, thumbnailName));
      thumbnailUrl = `${process.env.MEDIA_BASE_URL || ''}/media/${thumbnailName}`;
      const metadata = await sharp(req.file.path).metadata();
      width = metadata.width || null;
      height = metadata.height || null;
    }

    if (isVideo) {
      const metadata = await probe(req.file.path);
      duration = Math.round(Number(metadata.format?.duration) || 0);
      const stream = (metadata.streams || []).find((item) => item.width && item.height);
      width = stream?.width || null;
      height = stream?.height || null;
      const thumbnailName = `thumb_${path.parse(req.file.filename).name}.jpg`;
      await new Promise((resolve, reject) => execFile(
        ffmpeg,
        ['-y', '-ss', '0', '-i', req.file.path, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '5', path.join(dir, thumbnailName)],
        (error) => error ? reject(error) : resolve(),
      ));
      thumbnailUrl = `${process.env.MEDIA_BASE_URL || ''}/media/${thumbnailName}`;
    }

    return res.json({
      success: true,
      attachment: {
        attachment_type: isVideo ? 'video' : isImage ? 'image' : 'file',
        file_name: safeOriginalName,
        file_url: `${process.env.MEDIA_BASE_URL || ''}/media/${req.file.filename}`,
        thumbnail_url: thumbnailUrl,
        mime_type: req.file.mimetype,
        file_size: req.file.size,
        width,
        height,
        duration_sec: duration,
      },
    });
  } catch (error) {
    console.error('Media upload error:', error.message);
    return res.status(500).json({ error: 'Không thể xử lý file tải lên.' });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File quá lớn.' });
  }
  return res.status(400).json({ error: error.message || 'Không thể tải file lên.' });
});

app.listen(
  Number(process.env.PORT || 3002),
  '0.0.0.0',
  () => console.log(`Media server listening on ${process.env.PORT || 3002}`),
);
