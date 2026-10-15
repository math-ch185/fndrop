'use strict';
/*
 * 飞牛快传 FnDrop —— 局域网文件 / 文字互传服务
 * 零第三方依赖，Node.js 18+ 直接运行
 *
 * 配置方式（两种，环境变量优先级更高）：
 *   1) 同目录下的 config.json   ← Windows 用户推荐，改这个文件就行
 *   2) 环境变量                 ← Docker / 命令行用
 *
 * config.json 支持的键（键名任选一种写法，见 config.json 示例）：
 *   port / host / password / dataDir / publicUrl
 *   httpsCert / httpsKey / trustProxy / sessionDays
 *   loginMaxFail / loginLockMin / fileTtlHours / maxFileGb
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/* ------------------------- 配置加载 ------------------------- */
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfigFile() {
  const file = CONFIG_PATH;
  try {
    let raw = fs.readFileSync(file, 'utf8');
    // 去掉整行注释（以 // 开头的行），不影响引号内的 https://
    raw = raw.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    raw = raw.replace(/^\uFEFF/, '');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[警告] config.json 解析失败，已忽略：' + e.message);
    return {};
  }
}
const CFG = loadConfigFile();

let cfgMtime = 0;
try { cfgMtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch { /* 没有配置文件 */ }

function pick(cfgKey, envKey, def) {
  const e = process.env[envKey];
  if (e !== undefined && e !== '') return e;
  const c = CFG[cfgKey];
  if (c !== undefined && c !== null && c !== '') return String(c);
  return def;
}

const PORT = parseInt(pick('port', 'PORT', '8080'), 10);
const HOST = pick('host', 'HOST', '0.0.0.0');
const APP_PASSWORD = pick('password', 'APP_PASSWORD', '123456');
// 账号（用户名）。单用户服务，默认 admin。留空字符串 '' 表示不校验账号。
const APP_USERNAME = String(pick('username', 'APP_USERNAME', 'admin')).trim();
const DATA_DIR = path.resolve(pick('dataDir', 'DATA_DIR', path.join(__dirname, 'data')));
const PUBLIC_DIR = path.resolve(pick('publicDir', 'PUBLIC_DIR', path.join(__dirname, 'public')));
const FILE_TTL_HOURS = parseFloat(pick('fileTtlHours', 'FILE_TTL_HOURS', '0'));
const MAX_FILE_BYTES = parseFloat(pick('maxFileGb', 'MAX_FILE_GB', '20')) * 1024 * 1024 * 1024;
let PUBLIC_URL = pick('publicUrl', 'PUBLIC_URL', '').trim();

/**
 * 热更新外网地址：穿透工具每次启动拿到的免费域名都不同，
 * 它会把新地址写回 config.json，这里检测到文件变化就自动生效，无需重启服务。
 */
function refreshPublicUrl() {
  if (process.env.PUBLIC_URL) return; // 环境变量优先级最高，不覆盖
  try {
    const m = fs.statSync(CONFIG_PATH).mtimeMs;
    if (m === cfgMtime) return;
    cfgMtime = m;
    const c = loadConfigFile();
    const next = (c && typeof c.publicUrl === 'string') ? c.publicUrl.trim() : '';
    if (next !== PUBLIC_URL) {
      PUBLIC_URL = next;
      log(next ? '外网地址已更新: ' + next : '外网地址已清空');
    }
  } catch { /* 忽略 */ }
}

const HTTPS_CERT = pick('httpsCert', 'HTTPS_CERT', '').trim();
const HTTPS_KEY = pick('httpsKey', 'HTTPS_KEY', '').trim();
const TRUST_PROXY = pick('trustProxy', 'TRUST_PROXY', '1') !== '0';
const SESSION_DAYS = parseFloat(pick('sessionDays', 'SESSION_DAYS', '30'));
const LOGIN_MAX_FAIL = parseInt(pick('loginMaxFail', 'LOGIN_MAX_FAIL', '8'), 10);
const LOGIN_LOCK_MIN = parseFloat(pick('loginLockMin', 'LOGIN_LOCK_MIN', '10'));
const CHUNK_LIMIT = 64 * 1024 * 1024; // 单个分片请求体上限

// 供 Windows 脚本读取当前配置的端口，然后退出
if (process.argv.includes('--print-port')) {
  process.stdout.write(String(PORT));
  process.exit(0);
}

const FILES_DIR = path.join(DATA_DIR, 'files');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const FILES_INDEX = path.join(DATA_DIR, 'files.json');
const CLIP_INDEX = path.join(DATA_DIR, 'clip.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');

let SECRET = '';
let files = [];   // [{id,name,size,createdAt,from,mime}]
let clips = [];   // [{id,text,from,createdAt}]
const sseClients = new Set();
const loginFails = new Map(); // ip -> { count, lockedUntil }

/* ------------------------------ 工具函数 ------------------------------ */

function log(...a) { console.log('[' + new Date().toISOString() + ']', ...a); }

/* 真实客户端 IP（外网经反向代理时取 X-Forwarded-For） */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    const xr = req.headers['x-real-ip'];
    if (xr) return String(xr).trim();
  }
  return (req.socket && (req.socket.remoteAddress || '')) || 'unknown';
}

/* 是否处于 HTTPS 环境（直连 TLS 或反向代理转发） */
function isSecureReq(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return false;
}

/* 登录限流 */
function checkLoginAllowed(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return { ok: true };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { ok: false, wait: Math.ceil((rec.lockedUntil - Date.now()) / 60000) };
  }
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) loginFails.delete(ip);
  return { ok: true };
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_FAIL) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MIN * 60000;
    rec.count = 0;
    log('登录失败次数过多，已锁定 IP', ip, LOGIN_LOCK_MIN, '分钟');
  }
  loginFails.set(ip, rec);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return fallback; }
}

let tmpSeq = 0;
async function writeJsonAtomic(file, data) {
  // 每个写操作一个唯一临时文件名，避免并发写互相把对方的 .tmp 改名走 -> ENOENT 500
  const tmp = file + '.' + process.pid + '.' + (++tmpSeq) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data));
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      // 仅「临时文件被别的写进程抢先 / 目标被占用」类错误才重试
      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(e.code)) break;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
  try { await fsp.unlink(tmp); } catch (e) { /* 尽力而为 */ }
  if (lastErr) throw lastErr;
}

function sanitizeName(name) {
  let n = String(name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').trim();
  if (!n || n === '.' || n === '..') n = 'file';
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180) + ext;
  }
  return n;
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

/* ------------------------------ 会话认证 ------------------------------ */

function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const good = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getCookie(req, key) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === key) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function isAuthed(req) {
  return verifyToken(getCookie(req, 'fd_sid'));
}

/* ------------------------------ HTTP 辅助 ------------------------------ */

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('BAD_JSON'); }
}

function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

/* 虚拟网卡不算「局域网地址」：Docker 网桥、虚拟机网卡、隧道等 */
const VIRTUAL_IFACE = /^(docker|veth|vEthernet|br-|virbr|vmnet|vmware|vnet|tun|tap|dummy|zt|wg|tailscale|lo)/i;

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;          // 名字像虚拟网卡的直接跳过
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (/^169\.254\./.test(info.address)) continue;  // 链路本地
      if (/^172\.(1[7-9]|2\d|3[01])\./.test(info.address)) continue; // Docker 网段
      out.push({ iface: name, ip: info.address });
    }
  }
  // 家庭/办公局域网通常在这两段，排前面
  const rank = (x) => (/^192\.168\./.test(x.ip) ? 0 : /^10\./.test(x.ip) ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** 把「用户当前正在用的那个地址」顶到第一位，界面里就是带（当前）的那条 */
function preferCurrentHost(list, req) {
  const host = String(req.headers.host || '').split(':')[0];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return list;
  const i = list.findIndex((a) => a.ip === host);
  if (i > 0) list.unshift(list.splice(i, 1)[0]);
  return list;
}

function deviceOf(req, body) {
  const h = req.headers['x-device-name'];
  if (h) return decodeURIComponent(String(h)).slice(0, 40) || '未知设备';
  if (body && body.from) return String(body.from).slice(0, 40);
  return '未知设备';
}

/* ------------------------------ 业务逻辑 ------------------------------ */

async function loadState() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });

  // 清理历史遗留的原子写临时文件（*.tmp），避免越积越多
  try {
    for (const f of await fsp.readdir(DATA_DIR)) {
      if (f.endsWith('.tmp')) await fsp.unlink(path.join(DATA_DIR, f)).catch(() => {});
    }
  } catch { /* ignore */ }

  try { SECRET = (await fsp.readFile(SECRET_FILE, 'utf8')).trim(); } catch { /* not exists */ }
  if (!SECRET || SECRET.length < 32) {
    SECRET = crypto.randomBytes(32).toString('hex');
    await fsp.writeFile(SECRET_FILE, SECRET, { mode: 0o600 });
  }

  files = await readJson(FILES_INDEX, []);
  clips = await readJson(CLIP_INDEX, []);
  if (!Array.isArray(files)) files = [];
  if (!Array.isArray(clips)) clips = [];

  // 清理索引中已不存在的文件
  const existed = [];
  for (const f of files) {
    try { await fsp.access(path.join(FILES_DIR, f.id)); existed.push(f); } catch { /* drop */ }
  }
  files = existed;
}

function publicFile(f) {
  return { id: f.id, name: f.name, size: f.size, createdAt: f.createdAt, from: f.from, mime: f.mime };
}

async function addFileRecord(filePath, name, size, from) {
  const id = crypto.randomBytes(10).toString('hex');
  const finalPath = path.join(FILES_DIR, id);
  await fsp.rename(filePath, finalPath);
  const rec = {
    id, name: sanitizeName(name), size, from: from || '未知设备',
    createdAt: Date.now(), mime: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream'
  };
  files.unshift(rec);
  await writeJsonAtomic(FILES_INDEX, files);
  broadcast('files', { action: 'add', file: publicFile(rec) });
  return rec;
}

async function deleteFile(id) {
  const i = files.findIndex((f) => f.id === id);
  if (i < 0) return false;
  files.splice(i, 1);
  await writeJsonAtomic(FILES_INDEX, files);
  try { await fsp.unlink(path.join(FILES_DIR, id)); } catch { /* ignore */ }
  return true;
}

async function doCleanup() {
  if (!(FILE_TTL_HOURS > 0)) return;
  const deadline = Date.now() - FILE_TTL_HOURS * 3600000;
  const dead = files.filter((f) => f.createdAt < deadline);
  for (const f of dead) await deleteFile(f.id);
  if (dead.length) log('自动清理过期文件', dead.length, '个');
}

/* ------------------------------ 静态文件 ------------------------------ */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const st = await fsp.stat(filePath);
    if (st.isDirectory()) throw new Error('dir');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ------------------------------ 路由 ------------------------------ */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  /* --- 公开接口 --- */
  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const gate = checkLoginAllowed(ip);
    if (!gate.ok) {
      return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 ' + gate.wait + ' 分钟后再试' });
    }
    const body = await readJsonBody(req);
    const given = Buffer.from(String(body.password || ''));
    const want = Buffer.from(APP_PASSWORD);
    const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      noteLoginFail(ip);
      log('登录失败', ip);
      return sendJson(res, 401, { ok: false, error: '账号或密码错误' });
    }
    // 账号校验（可选）：配了用户名且前端传了非空账号，就必须对上
    const u = String(body.username || '').trim();
    if (u && u !== APP_USERNAME) {
      noteLoginFail(ip);
      log('登录账号不符', ip, u);
      return sendJson(res, 401, { ok: false, error: '账号或密码错误' });
    }
    loginFails.delete(ip);
    const secure = isSecureReq(req) ? '; Secure' : '';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'fd_sid=' + makeToken() + '; Path=/; HttpOnly; SameSite=Lax' + secure +
                    '; Max-Age=' + Math.round(SESSION_DAYS * 86400)
    });
    res.end(JSON.stringify({ ok: true }));
    log('登录成功', ip, '设备:', deviceOf(req, body));
    return;
  }

  if (p === '/api/status') {
    refreshPublicUrl();
    return sendJson(res, 200, {
      authed: isAuthed(req), name: '飞牛快传',
      port: PORT, addresses: preferCurrentHost(lanAddresses(), req), publicUrl: PUBLIC_URL,
      secure: isSecureReq(req),
      maxFileBytes: MAX_FILE_BYTES, chunkLimit: CHUNK_LIMIT
    });
  }

  /* --- 以下均需登录 --- */
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });

  if (p === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'fd_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  /* --- 文件列表 --- */
  if (p === '/api/files' && req.method === 'GET') {
    const total = files.reduce((s, f) => s + f.size, 0);
    return sendJson(res, 200, { ok: true, files: files.map(publicFile), totalSize: total });
  }

  if (p === '/api/files/delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    let n = 0;
    for (const id of ids) if (await deleteFile(String(id))) n++;
    broadcast('files', { action: 'delete', ids });
    return sendJson(res, 200, { ok: true, deleted: n });
  }

  if (p === '/api/files/clear' && req.method === 'POST') {
    const ids = files.map((f) => f.id);
    for (const id of ids) await deleteFile(id);
    broadcast('files', { action: 'clear' });
    return sendJson(res, 200, { ok: true, deleted: ids.length });
  }

  /* --- 下载 --- */
  if (p === '/api/download' && req.method === 'GET') {
    const id = q.get('id') || '';
    const rec = files.find((f) => f.id === id);
    if (!rec) return sendJson(res, 404, { ok: false, error: '文件不存在' });
    const fp = path.join(FILES_DIR, rec.id);
    let st;
    try { st = await fsp.stat(fp); } catch { return sendJson(res, 404, { ok: false, error: '文件已被删除' }); }
    const headers = {
      'Content-Type': rec.mime || 'application/octet-stream',
      'Content-Disposition': contentDisposition(rec.name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? Math.max(0, st.size - parseInt(m[2] || '0', 10)) : parseInt(m[1], 10);
      let end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
      if (!Number.isFinite(start) || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      return fs.createReadStream(fp, { start, end }).pipe(res);
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(fp).pipe(res);
    return;
  }

  /* --- 分片上传 --- */
  if (p === '/api/upload/init' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const name = sanitizeName(body.name);
    const size = Number(body.size) || 0;
    const chunks = Math.max(1, Number(body.chunks) || 1);
    const lastModified = Number(body.lastModified) || 0;
    if (size <= 0) return sendJson(res, 400, { ok: false, error: '文件为空' });
    if (size > MAX_FILE_BYTES) return sendJson(res, 413, { ok: false, error: '文件超过大小上限' });

    const uploadId = crypto.createHash('sha1')
      .update(name + '|' + size + '|' + lastModified).digest('hex').slice(0, 20);
    const dir = path.join(TMP_DIR, uploadId);
    await fsp.mkdir(dir, { recursive: true });

    const metaPath = path.join(dir, 'meta.json');
    let meta = await readJson(metaPath, null);
    if (!meta || meta.size !== size || meta.chunks !== chunks || meta.name !== name) {
      meta = { uploadId, name, size, chunks, createdAt: Date.now() };
      await writeJsonAtomic(metaPath, meta);
      // meta 变了说明是另一个文件，清掉旧分片
      for (const f of await fsp.readdir(dir)) {
        if (f !== 'meta.json') await fsp.unlink(path.join(dir, f)).catch(() => {});
      }
    }
    const received = [];
    for (const f of await fsp.readdir(dir)) {
      if (/^\d+\.part$/.test(f)) received.push(parseInt(f, 10));
    }
    return sendJson(res, 200, { ok: true, uploadId, received, chunks });
  }

  if (p === '/api/upload/chunk' && req.method === 'PUT') {
    const uploadId = (q.get('uploadId') || '').replace(/[^a-f0-9]/g, '');
    const index = parseInt(q.get('index') || '-1', 10);
    if (!uploadId || index < 0) return sendJson(res, 400, { ok: false, error: '参数错误' });
    const dir = path.join(TMP_DIR, uploadId);
    try { await fsp.access(dir); } catch { return sendJson(res, 404, { ok: false, error: '上传会话不存在' }); }

    const target = path.join(dir, index + '.part');
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(target);
      let bytes = 0;
      req.on('data', (c) => { bytes += c.length; if (bytes > CHUNK_LIMIT) { req.destroy(); ws.destroy(); } });
      req.on('error', reject);
      ws.on('error', reject);
      ws.on('close', resolve);
      req.pipe(ws);
    });
    return sendJson(res, 200, { ok: true, index });
  }

  if (p === '/api/upload/complete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const uploadId = String(body.uploadId || '').replace(/[^a-f0-9]/g, '');
    const dir = path.join(TMP_DIR, uploadId);
    const meta = await readJson(path.join(dir, 'meta.json'), null);
    if (!meta) return sendJson(res, 404, { ok: false, error: '上传会话不存在或已过期' });

    const missing = [];
    for (let i = 0; i < meta.chunks; i++) {
      try { await fsp.access(path.join(dir, i + '.part')); } catch { missing.push(i); }
    }
    if (missing.length) return sendJson(res, 400, { ok: false, error: '分片缺失', missing });

    const merged = path.join(TMP_DIR, uploadId + '.merged');
    const out = fs.createWriteStream(merged);
    for (let i = 0; i < meta.chunks; i++) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(path.join(dir, i + '.part'));
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(out, { end: false });
      });
    }
    await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });

    const from = deviceOf(req, body);
    const rec = await addFileRecord(merged, meta.name, meta.size, from);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    log('接收文件', rec.name, rec.size, '来自', from);
    return sendJson(res, 200, { ok: true, file: publicFile(rec) });
  }

  /* --- 小文件一次性上传（粘贴图片等） --- */
  if (p === '/api/upload/raw' && req.method === 'POST') {
    const name = sanitizeName(decodeURIComponent(q.get('name') || 'file'));
    const tmp = path.join(TMP_DIR, crypto.randomBytes(8).toString('hex') + '.raw');
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      let bytes = 0;
      req.on('data', (c) => { bytes += c.length; if (bytes > MAX_FILE_BYTES) { req.destroy(); ws.destroy(); } });
      req.on('error', reject);
      ws.on('error', reject);
      ws.on('close', resolve);
      req.pipe(ws);
    });
    const st = await fsp.stat(tmp);
    if (!st.size) { await fsp.unlink(tmp).catch(() => {}); return sendJson(res, 400, { ok: false, error: '空文件' }); }
    const rec = await addFileRecord(tmp, name, st.size, deviceOf(req, null));
    log('接收文件', rec.name, rec.size, '来自', rec.from);
    return sendJson(res, 200, { ok: true, file: publicFile(rec) });
  }

  /* --- 剪贴板 --- */
  if (p === '/api/clip' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, items: clips.slice(0, 60) });
  }

  if (p === '/api/clip' && req.method === 'POST') {
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const text = String(body.text || '');
    if (!text.trim()) return sendJson(res, 400, { ok: false, error: '内容为空' });
    if (text.length > 500000) return sendJson(res, 413, { ok: false, error: '文字过长' });
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      text, from: deviceOf(req, body), createdAt: Date.now()
    };
    clips.unshift(item);
    if (clips.length > 60) clips.length = 60;
    await writeJsonAtomic(CLIP_INDEX, clips);
    broadcast('clip', { action: 'add', item });
    return sendJson(res, 200, { ok: true, item });
  }

  if (p === '/api/clip/delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const before = clips.length;
    if (body.all) clips = [];
    else clips = clips.filter((c) => c.id !== String(body.id || ''));
    await writeJsonAtomic(CLIP_INDEX, clips);
    broadcast('clip', { action: 'refresh' });
    return sendJson(res, 200, { ok: true, deleted: before - clips.length });
  }

  return sendJson(res, 404, { ok: false, error: 'Not Found' });
}

/* ------------------------------ 启动 ------------------------------ */

const requestHandler = async (req, res) => {
  const proto = isSecureReq(req) ? 'https' : 'http';
  const url = new URL(req.url, proto + '://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
    const code = err.message === 'BODY_TOO_LARGE' ? 413 : (err.message === 'BAD_JSON' ? 400 : 500);
    if (code === 500) log('请求处理失败', url.pathname, err);
    sendJson(res, code, { ok: false, error: err.message });
  }
};

let server;
let usingTls = false;
try {
  if (HTTPS_CERT && HTTPS_KEY) {
    server = https.createServer({
      cert: fs.readFileSync(HTTPS_CERT),
      key: fs.readFileSync(HTTPS_KEY)
    }, requestHandler);
    usingTls = true;
  }
} catch (e) {
  log('HTTPS 证书读取失败，回退到 HTTP：' + e.message);
  server = null;
}
if (!server) server = http.createServer(requestHandler);

server.headersTimeout = 0;
server.requestTimeout = 0;

(async () => {
  await loadState();
  await doCleanup();
  setInterval(doCleanup, 3600000);

  server.listen(PORT, HOST, () => {
    log('飞牛快传 FnDrop 已启动');
    if (Object.keys(CFG).length) log('已读取 config.json');
    log('数据目录:', DATA_DIR);
    log('本机访问: ' + (usingTls ? 'https' : 'http') + '://127.0.0.1:' + PORT);
    for (const a of lanAddresses()) log('局域网访问: ' + (usingTls ? 'https' : 'http') + '://' + a.ip + ':' + PORT + '  (' + a.iface + ')');
    if (PUBLIC_URL) log('外网访问: ' + PUBLIC_URL);
    if (!usingTls && !PUBLIC_URL) log('提示: 外网访问请配上 DDNS/内网穿透，并建议启用 HTTPS（HTTPS_CERT/HTTPS_KEY）');
    if (APP_PASSWORD === '123456') log('⚠ 当前用的是默认密码 123456，请打开 config.json 修改 password');
  });
})();

process.on('SIGTERM', () => { log('收到 SIGTERM，正在退出'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
