/* 飞牛快传 FnDrop — 前端逻辑 */
(function () {
  'use strict';

  const CHUNK_SIZE = 4 * 1024 * 1024;   // 每个分片 4MB
  const CONCURRENCY = 3;                // 同时上传的分片数
  const $ = (id) => document.getElementById(id);

  const state = { files: [], clips: [], addresses: [], publicUrl: '', port: 8080, selected: new Set() };

  /* ================= 设备名 ================= */
  function defaultDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return '安卓手机';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows电脑';
    if (/Linux/.test(ua)) return 'Linux';
    return '我的设备';
  }
  let deviceName = localStorage.getItem('fndrop_device') || defaultDeviceName();

  /* ================= 工具 ================= */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtSize(n) {
    if (n === null || n === undefined) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
  }
  function fmtTime(ts) {
    const d = new Date(ts), now = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2400);
  }

  /* 局域网 http 下 clipboard API 不可用，需降级 */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 继续降级 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
      } catch (e) { return false; }
  }

  /* 文件内容复制到剪贴板：文本类直接复制内容；图片类尝试复制图片；其余提示下载 */
  const TEXT_EXT = ['txt','md','markdown','log','csv','tsv','json','jsonl','ndjson','xml','yml','yaml','ini','conf','config','toml','env','properties','gitignore','editorconfig','js','mjs','cjs','ts','tsx','jsx','py','java','kt','swift','c','h','cpp','cc','hpp','cs','go','rs','php','rb','pl','lua','sh','bash','zsh','bat','ps1','sql','html','htm','css','scss','less','vue','r','groovy','dockerfile'];

  async function copyFile(f) {
    const mime = f.mime || '';
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const isImg = mime.startsWith('image/');
    const isText = mime.startsWith('text/') || TEXT_EXT.includes(ext);
    try {
      if (isImg) {
        const res = await fetch('/api/download?id=' + f.id, { credentials: 'same-origin' });
        const blob = await res.blob();
        if (navigator.clipboard && window.isSecureContext && typeof ClipboardItem !== 'undefined') {
          try {
            await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
            toast('已复制图片，可直接粘贴');
            return;
          } catch (e) { /* 降级到提示 */ }
        }
        toast('当前为 HTTP 环境，浏览器禁止直接复制图片，请点 ⬇ 下载');
        return;
      }
      if (!isText) {
        toast('该文件类型无法直接复制，请点 ⬇ 下载');
        return;
      }
      if (f.size > 10 * 1024 * 1024) {
        toast('文件超过 10MB，请点 ⬇ 下载后复制');
        return;
      }
      const res = await fetch('/api/download?id=' + f.id, { credentials: 'same-origin' });
      const text = await res.text();
      const ok = await copyText(text);
      toast(ok ? '已复制内容到剪贴板' : '复制失败，请下载后手动复制');
    } catch (e) {
      toast('复制失败：' + e.message);
    }
  }

  function iconFor(name, mime) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if ((mime || '').startsWith('image/')) return '🖼️';
    if ((mime || '').startsWith('video/')) return '🎬';
    if ((mime || '').startsWith('audio/')) return '🎵';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'apk'].includes(ext)) return '🗜️';
    if (['pdf'].includes(ext)) return '📕';
    if (['doc', 'docx', 'wps'].includes(ext)) return '📘';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
    if (['ppt', 'pptx'].includes(ext)) return '📙';
    if (['exe', 'msi', 'dmg'].includes(ext)) return '⚙️';
    if (['txt', 'md', 'log', 'json'].includes(ext)) return '📄';
    return '📎';
  }

  async function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Device-Name': encodeURIComponent(deviceName) }, opts.headers || {});
    if (opts.json !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
      opts.method = opts.method || 'POST';
      delete opts.json;
    }
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts));
    if (res.status === 401) { showLogin(); throw new Error('UNAUTHORIZED'); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  /* ================= 登录 ================= */
  function showLogin() {
    $('login').classList.remove('hidden');
    $('app').classList.add('hidden');
    if (window.__es) { try { window.__es.close(); } catch (e) {} window.__es = null; }
    setTimeout(() => $('loginPwd').focus(), 80);
  }
  function showApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('devText').textContent = deviceName;
    startStream();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: $('loginUser').value.trim(), password: $('loginPwd').value })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { $('loginErr').textContent = d.error || '账号或密码错误，请重试'; return; }
      $('loginPwd').value = '';
      await boot();
    } catch (err) {
      $('loginErr').textContent = '连接失败：' + err.message;
    } finally { btn.disabled = false; }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
    showLogin();
  });

  $('devChip').addEventListener('click', () => {
    const n = prompt('给这台设备起个名字（其他设备会看到它）：', deviceName);
    if (n && n.trim()) {
      deviceName = n.trim().slice(0, 20);
      localStorage.setItem('fndrop_device', deviceName);
      $('devText').textContent = deviceName;
      toast('已改名为「' + deviceName + '」');
    }
  });

  /* ================= 地址弹窗 ================= */
  const addrPop = $('addrPop');
  $('addrChip').addEventListener('click', (e) => {
    e.stopPropagation();
    renderAddrList();
    addrPop.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!addrPop.classList.contains('hidden') && !addrPop.contains(e.target)) addrPop.classList.add('hidden');
  });

  function accessUrls() {
    const out = [];
    if (state.publicUrl) out.push({ tag: '外网', cls: 'wan', url: state.publicUrl.replace(/\/+$/, '') });
    const cur = location.hostname;
    for (const a of state.addresses || []) {
      out.push({ tag: '局域网', cls: '', url: 'http://' + a.ip + ':' + state.port + (a.ip === cur ? '（当前）' : '') });
    }
    if (!out.length) out.push({ tag: '当前', cls: '', url: location.origin });
    return out;
  }

  function renderAddrList() {
    const list = accessUrls();
    $('addrList').innerHTML = list.map((u) =>
      '<div class="addr-row" data-url="' + esc(u.url.replace(/（当前）/, '')) + '">' +
      '<span class="addr-tag ' + u.cls + '">' + u.tag + '</span>' +
      '<span class="addr-url">' + esc(u.url) + '</span></div>'
    ).join('');
    $('addrList').querySelectorAll('.addr-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const ok = await copyText(row.dataset.url);
        toast(ok ? '已复制：' + row.dataset.url : '复制失败，请手动输入：' + row.dataset.url, 3000);
      });
    });
  }

  function renderAddrChip() {
    const cur = location.hostname;
    if (state.publicUrl) {
      try { $('addrText').textContent = new URL(state.publicUrl).host; return; } catch (e) {}
    }
    if (cur && cur !== 'localhost' && cur !== '127.0.0.1') { $('addrText').textContent = cur; return; }
    const a = (state.addresses || [])[0];
    $('addrText').textContent = a ? a.ip : cur;
  }

  /* ================= Tab ================= */
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'clip') {
        $('clipDot').classList.add('hidden');
        localStorage.setItem('fndrop_clipseen', state.clips[0] ? state.clips[0].id : '');
      }
    });
  });

  /* ================= 上传 ================= */
  const queueEl = $('queue');
  const activeUploads = new Map();

  function queueKey(f) { return f.name + '|' + f.size + '|' + f.lastModified; }

  function createQueueItem(file) {
    const el = document.createElement('div');
    el.className = 'up-item';
    el.innerHTML =
      '<div class="up-head"><span class="up-name">' + esc(file.name) + '</span>' +
      '<span class="up-meta">准备中…</span></div>' +
      '<div class="bar"><i></i></div>' +
      '<div class="up-err"></div>';
    queueEl.prepend(el);
    return el;
  }
  function setQueue(el, pct, text, cls) {
    el.querySelector('.bar > i').style.width = pct + '%';
    el.querySelector('.up-meta').textContent = text;
    if (cls) el.classList.add(cls);
  }

  async function uploadFile(file) {
    const key = queueKey(file);
    if (activeUploads.has(key)) return;
    const el = createQueueItem(file);
    activeUploads.set(key, el);

    try {
      const chunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
      const init = await api('/api/upload/init', {
        json: { name: file.name, size: file.size, chunks, lastModified: file.lastModified }
      });
      const uploadId = init.uploadId;
      const received = new Set(init.received || []);

      let doneBytes = 0;
      for (const i of received) doneBytes += Math.min(CHUNK_SIZE, file.size - i * CHUNK_SIZE);

      const pending = [];
      for (let i = 0; i < chunks; i++) if (!received.has(i)) pending.push(i);

      const paint = (label) => {
        const pct = Math.min(100, Math.round((doneBytes / file.size) * 100));
        setQueue(el, pct, label || (pct + '% · ' + fmtSize(doneBytes) + ' / ' + fmtSize(file.size)));
      };
      paint(received.size ? ('断点续传 ' + received.size + '/' + chunks) : '上传中…');

      let cursor = 0;
      async function worker() {
        while (cursor < pending.length) {
          const idx = pending[cursor++];
          const start = idx * CHUNK_SIZE;
          const blob = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
          let lastErr = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const res = await fetch('/api/upload/chunk?uploadId=' + uploadId + '&index=' + idx, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'X-Device-Name': encodeURIComponent(deviceName) },
                body: blob
              });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e;
              if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
            }
          }
          if (lastErr) throw lastErr;
          doneBytes += blob.size;
          paint();
        }
      }
      const workers = [];
      for (let i = 0; i < Math.max(1, Math.min(CONCURRENCY, pending.length)); i++) workers.push(worker());
      await Promise.all(workers);

      setQueue(el, 100, '合并中…');
      await api('/api/upload/complete', { json: { uploadId, from: deviceName } });
      setQueue(el, 100, '完成 · ' + fmtSize(file.size), 'done');
      setTimeout(() => el.remove(), 2600);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') return;
      el.classList.add('err');
      setQueue(el, 100, '失败');
      el.querySelector('.up-err').textContent = '上传失败：' + err.message + '（重新选择同一文件可断点续传）';
    } finally {
      activeUploads.delete(key);
    }
  }

  function handleFiles(list) {
    const arr = Array.from(list || []);
    if (!arr.length) return;
    toast('开始上传 ' + arr.length + ' 个文件');
    arr.forEach((f) => uploadFile(f));
  }

  const dz = $('dropzone');
  dz.addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dz.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return;
    dz.classList.remove('over');
  }));
  dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /* 默认停在「文字剪贴板」页，拖拽区是隐藏的。
     所以拖到页面任意位置都算数：自动切到「文件传输」页再上传，免得拖了没反应。 */
  window.addEventListener('drop', (e) => {
    const fl = e.dataTransfer && e.dataTransfer.files;
    if (!fl || !fl.length || dz.contains(e.target)) return;
    const btn = document.querySelector('.tab[data-tab="files"]');
    if (btn && !btn.classList.contains('active')) btn.click();
    handleFiles(fl);
  });

  /* 粘贴：图片/文件 -> 上传；纯文字 -> 同步到剪贴板 */
  window.addEventListener('paste', (e) => {
    const inBox = e.target && e.target.id === 'clipInput';
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    let text = '';
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) {
          const isImg = (it.type || '').startsWith('image/');
          const ext = (it.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          const name = f.name && f.name !== 'image.png'
            ? f.name
            : ('粘贴图片_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.' + ext);
          files.push(isImg && !f.name ? new File([f], name, { type: f.type }) : f);
        }
      } else if (it.kind === 'string' && it.type === 'text/plain') {
        it.getAsString((s) => { text += s; });
      }
    }
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
      return;
    }
    if (inBox) return; // 在输入框里粘贴走默认行为
    if (text.trim()) {
      e.preventDefault();
      sendClip(text, true);
    }
  });

  /* ================= 文件列表 ================= */
  function updateSelUI() {
    const n = state.selected.size;
    const c = $('selCount'); if (c) c.textContent = n;
    const btn = $('delSelected'); if (btn) btn.disabled = n === 0;
    const all = $('selAll');
    if (all) {
      const total = (state.files || []).length;
      all.checked = total > 0 && n === total;
      all.indeterminate = n > 0 && n < total;
    }
  }

  function renderFiles() {
    const list = state.files || [];
    $('fileCount').textContent = list.length;
    const total = list.reduce((s, f) => s + (f.size || 0), 0);
    $('totalSize').textContent = total ? fmtSize(total) : '';
    const box = $('fileList');
    // 清掉已不存在（被删/被别的设备删）的勾选
    const alive = new Set(list.map((f) => f.id));
    for (const id of [...state.selected]) if (!alive.has(id)) state.selected.delete(id);
    if (!list.length) {
      box.innerHTML = '<div class="empty">还没有文件，上传一个试试 👆</div>';
      updateSelUI();
      return;
    }
    box.innerHTML = list.map((f) => {
      const isImg = (f.mime || '').startsWith('image/');
      const thumb = isImg
        ? '<img src="/api/download?id=' + f.id + '" alt="" loading="lazy">'
        : esc(iconFor(f.name, f.mime));
      const checked = state.selected.has(f.id) ? ' checked' : '';
      return '<div class="file-item' + (checked ? ' selected' : '') + '">' +
        '<label class="fi-check" title="勾选以便批量删除"><input type="checkbox" data-fsel="' + f.id + '"' + checked + '></label>' +
        '<div class="fi-icon">' + thumb + '</div>' +
        '<div class="fi-body">' +
          '<div class="fi-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
          '<div class="fi-meta">' + fmtSize(f.size) + ' · ' + fmtTime(f.createdAt) + ' · 来自 ' + esc(f.from || '未知') + '</div>' +
        '</div>' +
        '<div class="fi-acts">' +
          '<button class="mini" data-fcopy="' + f.id + '" title="复制内容（文本/代码直接复制，图片需 HTTPS）">复制</button>' +
          '<a class="icon-btn" href="/api/download?id=' + f.id + '" download="' + esc(f.name) + '" title="下载">⬇</a>' +
          '<button class="icon-btn del" data-del="' + f.id + '" title="删除">✕</button>' +
        '</div></div>';
    }).join('');

    box.querySelectorAll('[data-fsel]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.fsel;
        if (cb.checked) state.selected.add(id); else state.selected.delete(id);
        const item = cb.closest('.file-item');
        if (item) item.classList.toggle('selected', cb.checked);
        updateSelUI();
      });
    });
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.del;
        if (!confirm('确定删除这个文件？')) return;
        try { await api('/api/files/delete', { json: { id } }); } catch (e) { toast('删除失败：' + e.message); }
      });
    });
    box.querySelectorAll('[data-fcopy]').forEach((b) => {
      b.addEventListener('click', async () => {
        const f = (state.files || []).find((x) => x.id === b.dataset.fcopy);
        if (f) await copyFile(f);
      });
    });
    updateSelUI();
  }

  $('selAll').addEventListener('change', (e) => {
    const list = state.files || [];
    if (e.target.checked) list.forEach((f) => state.selected.add(f.id));
    else state.selected.clear();
    renderFiles();
  });
  $('delSelected').addEventListener('click', async () => {
    const ids = [...state.selected];
    if (!ids.length) return;
    if (!confirm('确定删除所选 ' + ids.length + ' 个文件？不可恢复。')) return;
    try {
      const r = await api('/api/files/delete', { json: { ids } });
      state.selected.clear();
      toast('已删除 ' + (r && r.deleted != null ? r.deleted : ids.length) + ' 个文件');
      refreshFiles();
    } catch (e) { toast('删除失败：' + e.message); }
  });

  $('clearAll').addEventListener('click', async () => {
    if (!state.files.length) return;
    if (!confirm('确定清空全部 ' + state.files.length + ' 个文件？不可恢复。')) return;
    try { await api('/api/files/clear', { json: {} }); toast('已清空'); } catch (e) { toast('失败：' + e.message); }
  });

  /* ================= 剪贴板 ================= */
  function renderClips() {
    const list = state.clips || [];
    $('clipCount').textContent = list.length;
    const box = $('clipList');
    if (!list.length) {
      box.innerHTML = '<div class="empty">暂无内容</div>';
      return;
    }
    box.innerHTML = list.map((c) =>
      '<div class="clip-item">' +
        '<div class="clip-text">' + esc(c.text) + '</div>' +
        '<div class="clip-foot">' +
          '<span class="clip-meta">' + esc(c.from || '未知') + ' · ' + fmtTime(c.createdAt) + '</span>' +
          '<span class="clip-btns">' +
            '<button class="mini" data-copy="' + c.id + '">复制</button>' +
            '<button class="mini danger" data-cdel="' + c.id + '">删除</button>' +
          '</span>' +
        '</div>' +
      '</div>'
    ).join('');

    box.querySelectorAll('[data-copy]').forEach((b) => {
      b.addEventListener('click', async () => {
        const item = state.clips.find((x) => x.id === b.dataset.copy);
        if (!item) return;
        const ok = await copyText(item.text);
        toast(ok ? '已复制到剪贴板' : '复制失败，请长按文字手动复制');
      });
    });
    box.querySelectorAll('[data-cdel]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await api('/api/clip/delete', { json: { id: b.dataset.cdel } }); } catch (e) { toast('失败：' + e.message); }
      });
    });
  }

  let sending = false;
  async function sendClip(text, silent) {
    const t = String(text || '').trim();
    if (!t) { if (!silent) toast('内容为空'); return false; }
    if (sending) return false;
    sending = true;
    try {
      await api('/api/clip', { json: { text: t, from: deviceName } });
      if (!silent) { $('clipInput').value = ''; updateLen(); toast('已同步到所有设备'); }
      else toast('已同步文字到剪贴板');
      return true;
    } catch (e) {
      if (e.message !== 'UNAUTHORIZED') toast('发送失败：' + e.message);
      return false;
    } finally { sending = false; }
  }

  function updateLen() { $('clipLen').textContent = $('clipInput').value.length + ' 字'; }
  $('clipInput').addEventListener('input', updateLen);
  $('clipInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendClip($('clipInput').value); }
  });
  $('clipSend').addEventListener('click', () => sendClip($('clipInput').value));
  $('clipClear').addEventListener('click', async () => {
    if (!state.clips.length) return;
    if (!confirm('确定清空全部剪贴板记录？')) return;
    try { await api('/api/clip/delete', { json: { all: true } }); } catch (e) { toast('失败：' + e.message); }
  });

  /* ================= 实时事件 ================= */
  let retry = 0;
  function startStream() {
    if (window.__es) { try { window.__es.close(); } catch (e) {} }
    const es = new EventSource('/api/events');
    window.__es = es;

    es.addEventListener('open', () => { retry = 0; });
    es.addEventListener('files', (ev) => {
      let d = {}; try { d = JSON.parse(ev.data); } catch (e) {}
      if (d.action === 'add' && d.file) {
        if (!state.files.some((f) => f.id === d.file.id)) {
          state.files.unshift(d.file);
          renderFiles();
          if (d.file.from !== deviceName) toast('收到新文件：' + d.file.name, 3000);
        }
      } else { refreshFiles(); }
    });
    es.addEventListener('clip', (ev) => {
      let d = {}; try { d = JSON.parse(ev.data); } catch (e) {}
      if (d.action === 'add' && d.item) {
        state.clips.unshift(d.item);
        if (state.clips.length > 60) state.clips.length = 60;
        renderClips();
        if (d.item.from !== deviceName) {
          toast('新文字：' + d.item.text.slice(0, 30) + (d.item.text.length > 30 ? '…' : ''), 3000);
          const activeTab = document.querySelector('.tab.active');
          if (!activeTab || activeTab.dataset.tab !== 'clip') $('clipDot').classList.remove('hidden');
        }
      } else { refreshClips(); }
    });
    es.addEventListener('error', () => {
      try { es.close(); } catch (e) {}
      const wait = Math.min(15000, 1500 * Math.pow(2, retry++));
      setTimeout(() => { if (!$('app').classList.contains('hidden')) startStream(); }, wait);
    });
  }

  async function refreshFiles() {
    try {
      const d = await api('/api/files');
      state.files = d.files || [];
      renderFiles();
    } catch (e) { /* ignore */ }
  }
  async function refreshClips() {
    try {
      const d = await api('/api/clip');
      state.clips = d.items || [];
      renderClips();
    } catch (e) { /* ignore */ }
  }

  /* ================= 启动 ================= */
  async function boot() {
    try {
      const st = await fetch('/api/status', { credentials: 'same-origin' }).then((r) => r.json());
      state.addresses = st.addresses || [];
      state.publicUrl = st.publicUrl || '';
      state.port = st.port || 8080;
      if (!st.authed) { showLogin(); return; }
      showApp();
      renderAddrChip();
      await Promise.all([refreshFiles(), refreshClips()]);
    } catch (e) {
      showLogin();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('app').classList.contains('hidden')) {
      if (!window.__es) startStream();
    }
  });

  boot();
})();
