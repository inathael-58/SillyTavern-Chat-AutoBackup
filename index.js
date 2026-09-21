/*
 * Chat Auto Backup — SillyTavern UI extension
 *
 * Keeps rolling snapshots of every chat in the browser's IndexedDB, so a copy
 * survives even when the server fails to save, returns a truncated chat, or
 * loses the file. Snapshots are taken from the chat in memory (not from the
 * server), gzip-compressed, de-duplicated, and pruned per chat.
 */

const MODULE = 'chat_autobackup';
const DB_NAME = 'ST_ChatAutoBackup';
const DB_VERSION = 1;
const META = 'meta';
const PAYLOAD = 'payload';
const LOG = '[ChatAutoBackup]';

const DEFAULTS = Object.freeze({
    enabled: true,
    debounceSec: 4,          // wait this long after the last change before writing
    intervalMin: 5,          // periodic safety check (0 = off)
    maxPerChat: 15,          // rolling snapshots kept per chat
    keepPeak: true,          // never prune the snapshot with the most messages
    shrinkWarn: true,        // warn when a loaded chat is much shorter than its backup
    notifyOnSave: false,     // toast on every backup
    showIndicator: true,     // floating status button over the chat
    indicatorFontSize: 12,   // px
    // Where the floating button sits. x/y are fractions (0–1) of the space the
    // button can travel across the screen; `edge` is the screen edge it is
    // snapped to (null = free, e.g. after "reset to centre").
    indicatorPos: Object.freeze({ x: 1, y: 0.08, edge: 'right' }),
});

const INDICATOR_CENTER = Object.freeze({ x: 0.5, y: 0.5, edge: null });
const EDGE_MARGIN = 8; // px gap between the snapped button and the screen edge

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    // v1.1 stored a fixed corner; carry it over to the draggable position.
    if (s.indicatorPosition !== undefined && s.indicatorPos === undefined) {
        const [v, h] = String(s.indicatorPosition).split('-');
        s.indicatorPos = { x: h === 'left' ? 0 : 1, y: v === 'bottom' ? 0.85 : 0.08, edge: h === 'left' ? 'left' : 'right' };
    }
    delete s.indicatorPosition;
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = (v && typeof v === 'object') ? { ...v } : v;
    }
    return s;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

// cyrb53 — fast non-crypto 53-bit hash, good enough for change detection
function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fileStamp(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}@${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
}

function safeFileName(s) {
    return String(s).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'chat';
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const toast = {
    ok: (m, t) => globalThis.toastr?.success(m, t ?? 'Chat Backup'),
    info: (m, t) => globalThis.toastr?.info(m, t ?? 'Chat Backup'),
    warn: (m, t, o) => globalThis.toastr?.warning(m, t ?? 'Chat Backup', o),
    err: (m, t) => globalThis.toastr?.error(m, t ?? 'Chat Backup'),
};

// ---------------------------------------------------------------- compression

const canGzip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pack(text) {
    if (!canGzip) return { enc: 'raw', data: text };
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const data = await new Response(stream).blob();
    return { enc: 'gzip', data };
}

async function unpack(rec) {
    if (rec.enc === 'raw') return rec.data;
    const stream = rec.data.stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
}

// ---------------------------------------------------------------- IndexedDB

let dbPromise = null;

function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains(META)) {
                const s = d.createObjectStore(META, { keyPath: 'id', autoIncrement: true });
                s.createIndex('key', 'key', { unique: false });
                s.createIndex('ts', 'ts', { unique: false });
            }
            if (!d.objectStoreNames.contains(PAYLOAD)) {
                d.createObjectStore(PAYLOAD, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
}

function reqP(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

function txDone(tx) {
    return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

async function dbAdd(meta, payload) {
    const d = await db();
    const tx = d.transaction([META, PAYLOAD], 'readwrite');
    const id = await reqP(tx.objectStore(META).add(meta));
    tx.objectStore(PAYLOAD).put({ id, ...payload });
    await txDone(tx);
    return id;
}

async function dbMetaByKey(key) {
    const d = await db();
    const tx = d.transaction(META, 'readonly');
    const list = await reqP(tx.objectStore(META).index('key').getAll(key));
    return list.sort((a, b) => b.ts - a.ts);
}

async function dbAllMeta() {
    const d = await db();
    const tx = d.transaction(META, 'readonly');
    const list = await reqP(tx.objectStore(META).getAll());
    return list.sort((a, b) => b.ts - a.ts);
}

async function dbPayload(id) {
    const d = await db();
    const tx = d.transaction(PAYLOAD, 'readonly');
    return await reqP(tx.objectStore(PAYLOAD).get(id));
}

async function dbDelete(ids) {
    if (!ids.length) return;
    const d = await db();
    const tx = d.transaction([META, PAYLOAD], 'readwrite');
    for (const id of ids) {
        tx.objectStore(META).delete(id);
        tx.objectStore(PAYLOAD).delete(id);
    }
    await txDone(tx);
}

// ---------------------------------------------------------------- snapshot capture

/** Identify the chat currently open. Returns null when nothing is open. */
function currentChatInfo() {
    const c = ctx();
    const chatId = typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : c.chatId;
    if (!chatId) return null;

    if (c.groupId) {
        const group = (c.groups || []).find(g => String(g.id) === String(c.groupId));
        return {
            key: `g:${c.groupId}:${chatId}`,
            type: 'group',
            chatId: String(chatId),
            groupId: String(c.groupId),
            label: group?.name ?? `Group ${c.groupId}`,
            avatar: null,
        };
    }

    if (c.characterId === undefined || c.characterId === null) return null;
    const ch = c.characters?.[c.characterId];
    if (!ch) return null;
    return {
        key: `c:${ch.avatar}:${chatId}`,
        type: 'character',
        chatId: String(chatId),
        groupId: null,
        label: ch.name,
        avatar: ch.avatar,
    };
}

/**
 * Synchronously serialize the open chat into JSONL (same layout SillyTavern
 * writes to disk: header line for character chats, then one message per line).
 */
function captureNow() {
    const info = currentChatInfo();
    if (!info) return null;
    const c = ctx();
    const messages = Array.isArray(c.chat) ? c.chat : [];
    // Never capture an empty chat — that is the state we're protecting against.
    if (!messages.length) return null;

    const lines = [];
    if (info.type === 'character') {
        lines.push(JSON.stringify({
            user_name: c.name1,
            character_name: c.name2,
            create_date: messages[0]?.send_date ?? fileStamp(Date.now()),
            chat_metadata: c.chatMetadata ?? c.chat_metadata ?? {},
        }));
    }
    for (const m of messages) lines.push(JSON.stringify(m));
    const jsonl = lines.join('\n');

    const last = messages[messages.length - 1];
    return {
        info,
        jsonl,
        hash: hash(jsonl),
        count: messages.length,
        preview: String(last?.mes ?? '').replace(/\s+/g, ' ').slice(0, 140),
        previewName: last?.name ?? '',
        ts: Date.now(),
    };
}

// ---------------------------------------------------------------- core backup logic

let pending = null;       // captured-but-not-yet-written snapshot
let pendingTimer = null;
let writing = Promise.resolve();
const lastHashByKey = new Map();
const inflightByKey = new Map(); // key -> number of writes queued/running
let lastError = null;            // { key, message } of the most recent failed write

function schedule() {
    const s = settings();
    if (!s.enabled) return;
    const snap = captureNow();
    if (!snap) { updateIndicator(); return; }
    // If a snapshot for a different chat is still pending, write it now.
    if (pending && pending.info.key !== snap.info.key) flush();
    pending = snap;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flush, Math.max(0, Number(s.debounceSec) || 0) * 1000);
    updateIndicator();
}

function flush() {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    const snap = pending;
    pending = null;
    if (!snap) return writing;
    const key = snap.info.key;
    inflightByKey.set(key, (inflightByKey.get(key) || 0) + 1);
    writing = writing
        .then(() => store(snap))
        .then(() => { if (lastError?.key === key) lastError = null; })
        .catch(e => { console.error(LOG, e); lastError = { key, message: String(e?.message ?? e) }; })
        .finally(() => {
            const n = (inflightByKey.get(key) || 1) - 1;
            if (n > 0) inflightByKey.set(key, n); else inflightByKey.delete(key);
            updateIndicator();
        });
    return writing;
}

/** Write a snapshot unless identical to the newest one, then prune. */
async function store(snap, { force = false, reason = 'auto' } = {}) {
    const { info } = snap;
    const existing = await dbMetaByKey(info.key);
    const newest = existing[0];

    if (!force && (lastHashByKey.get(info.key) === snap.hash || newest?.hash === snap.hash)) {
        lastHashByKey.set(info.key, snap.hash);
        return { skipped: true };
    }

    const peak = existing.reduce((m, x) => Math.max(m, x.count), 0);
    const shrunk = peak >= 6 && snap.count < peak * 0.6;

    const packed = await pack(snap.jsonl);
    const size = packed.enc === 'gzip' ? packed.data.size : new Blob([packed.data]).size;
    const meta = {
        key: info.key,
        type: info.type,
        chatId: info.chatId,
        groupId: info.groupId,
        avatar: info.avatar,
        label: info.label,
        ts: snap.ts,
        hash: snap.hash,
        count: snap.count,
        preview: snap.preview,
        previewName: snap.previewName,
        rawSize: snap.jsonl.length,
        size,
        reason,
        shrunk,
    };
    const id = await dbAdd(meta, packed);
    lastHashByKey.set(info.key, snap.hash);

    await prune(info.key);

    if (settings().notifyOnSave) toast.info(`${info.label}: ${snap.count} ข้อความ`, 'Backup แล้ว');
    return { id, meta };
}

async function prune(key) {
    const s = settings();
    const list = await dbMetaByKey(key); // newest first
    const max = Math.max(1, Number(s.maxPerChat) || DEFAULTS.maxPerChat);
    if (list.length <= max) return;

    const keep = new Set(list.slice(0, max).map(x => x.id));
    if (s.keepPeak) {
        const peak = list.reduce((a, b) => (b.count > a.count || (b.count === a.count && b.ts > a.ts) ? b : a));
        keep.add(peak.id);
    }
    await dbDelete(list.filter(x => !keep.has(x.id)).map(x => x.id));
}

/** Called after a chat is opened: warn if it's much shorter than its backup. */
async function checkLoadedChat() {
    const s = settings();
    const info = currentChatInfo();
    if (!info) return;
    const c = ctx();
    const count = Array.isArray(c.chat) ? c.chat.length : 0;
    const list = await dbMetaByKey(info.key);
    if (!list.length) return;
    const peak = list.reduce((a, b) => (b.count > a.count ? b : a));

    if (s.shrinkWarn && peak.count >= 6 && count < peak.count * 0.6) {
        toast.warn(
            `แชทนี้โหลดมาได้ ${count} ข้อความ แต่ backup มี ${peak.count} ข้อความ (${fmtTime(peak.ts)})<br>คลิกเพื่อเปิดรายการ backup`,
            '⚠ แชทอาจหาย/ไม่ครบ',
            { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: () => openBrowser(info.key) },
        );
    }
}

// ---------------------------------------------------------------- restore

async function snapshotText(id) {
    const rec = await dbPayload(id);
    if (!rec) throw new Error('ไม่พบข้อมูล snapshot');
    return await unpack(rec);
}

async function downloadSnapshot(meta) {
    const text = await snapshotText(meta.id);
    const name = `${safeFileName(meta.label)} - ${safeFileName(meta.chatId)} - backup ${fileStamp(meta.ts)}.jsonl`;
    downloadBlob(new Blob([text], { type: 'application/jsonl' }), name);
}

/** Save the snapshot to the server as a NEW chat file (never overwrites). */
async function restoreAsNewChat(meta) {
    if (meta.type !== 'character') {
        toast.warn('แชทกลุ่มกู้คืนอัตโนมัติไม่ได้ — ใช้ปุ่มดาวน์โหลดแล้ววางไฟล์ในโฟลเดอร์ group chats เอง');
        return;
    }
    const c = ctx();
    const idx = (c.characters || []).findIndex(ch => ch.avatar === meta.avatar);
    if (idx < 0) {
        toast.err('ไม่พบตัวละครนี้แล้ว (อาจถูกลบหรือเปลี่ยนไฟล์ avatar) — ใช้ปุ่มดาวน์โหลดแทน');
        return;
    }
    const ch = c.characters[idx];
    const text = await snapshotText(meta.id);
    const chat = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const fileName = `${safeFileName(meta.chatId)} (restored ${fileStamp(meta.ts)})`;

    const res = await fetch('/api/chats/save', {
        method: 'POST',
        headers: c.getRequestHeaders(),
        body: JSON.stringify({ ch_name: ch.name, file_name: fileName, chat, avatar_url: ch.avatar, force: true }),
    });
    if (!res.ok) throw new Error(`Server ตอบกลับ ${res.status} ${res.statusText}`);

    toast.ok(`สร้างไฟล์แชทใหม่ "${fileName}" แล้ว`, 'กู้คืนสำเร็จ');

    // Open it if we're on that character already and the API is available.
    if (String(c.characterId) === String(idx) && typeof c.openCharacterChat === 'function') {
        try { await c.openCharacterChat(fileName); } catch (e) { console.warn(LOG, e); }
    }
}

// ---------------------------------------------------------------- export / import

async function exportAll() {
    await flush();
    const all = await dbAllMeta();
    if (!all.length) return toast.info('ยังไม่มี backup');
    const out = { format: 'st-chat-autobackup', version: 1, exported: Date.now(), snapshots: [] };
    for (const m of all) {
        out.snapshots.push({ meta: { ...m, id: undefined }, jsonl: await snapshotText(m.id) });
    }
    downloadBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), `ST-chat-backups ${fileStamp(Date.now())}.json`);
}

async function importFile(file) {
    const data = JSON.parse(await file.text());
    if (data?.format !== 'st-chat-autobackup' || !Array.isArray(data.snapshots)) throw new Error('ไฟล์ไม่ใช่ export ของ Chat Auto Backup');
    const all = await dbAllMeta();
    const seen = new Set(all.map(m => `${m.key}|${m.hash}`));
    let added = 0;
    for (const { meta, jsonl } of data.snapshots) {
        if (!meta?.key || typeof jsonl !== 'string') continue;
        const h = meta.hash ?? hash(jsonl);
        if (seen.has(`${meta.key}|${h}`)) continue;
        const { id: _drop, ...clean } = meta;
        const packed = await pack(jsonl);
        clean.hash = h;
        clean.size = packed.enc === 'gzip' ? packed.data.size : jsonl.length;
        clean.reason = 'import';
        await dbAdd(clean, packed);
        seen.add(`${meta.key}|${h}`);
        added++;
    }
    return added;
}

// ---------------------------------------------------------------- browser UI

let browserKey = null; // null = all chats

async function openBrowser(key) {
    await flush();
    browserKey = key === undefined ? (currentChatInfo()?.key ?? null) : key;
    const old = document.getElementById('cab_modal');
    if (old) (old._cabClose ?? (() => old.remove()))();

    const wrap = document.createElement('div');
    wrap.id = 'cab_modal';
    wrap.innerHTML = `
        <div class="cab_dialog">
            <div class="cab_head">
                <b>Chat Backups</b>
                <select id="cab_scope" class="text_pole"></select>
                <div class="cab_close menu_button fa-solid fa-xmark" title="ปิด"></div>
            </div>
            <div id="cab_list" class="cab_list"><i>กำลังโหลด…</i></div>
            <div class="cab_foot" id="cab_foot"></div>
        </div>`;
    document.body.appendChild(wrap);

    // Match the *visible* viewport (mobile address bar / keyboard shrink it),
    // so the dialog — and its close button — can never sit off-screen.
    const vv = window.visualViewport;
    const fit = () => {
        wrap.style.top = `${vv ? vv.offsetTop : 0}px`;
        wrap.style.left = `${vv ? vv.offsetLeft : 0}px`;
        wrap.style.width = `${vv ? vv.width : window.innerWidth}px`;
        wrap.style.height = `${vv ? vv.height : window.innerHeight}px`;
    };
    fit();
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    function close() {
        vv?.removeEventListener('resize', fit);
        vv?.removeEventListener('scroll', fit);
        window.removeEventListener('resize', fit);
        document.removeEventListener('keydown', onKey);
        wrap.remove();
    }

    wrap._cabClose = close;
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    wrap.querySelector('.cab_close').addEventListener('click', close);
    wrap.querySelector('#cab_scope').addEventListener('change', e => {
        browserKey = e.target.value || null;
        renderBrowser();
    });
    await renderBrowser();
}

async function renderBrowser() {
    const wrap = document.getElementById('cab_modal');
    if (!wrap) return;
    const all = await dbAllMeta();

    // scope selector: one entry per chat
    const chats = new Map();
    for (const m of all) {
        if (!chats.has(m.key)) chats.set(m.key, { label: m.label, chatId: m.chatId, n: 0, ts: m.ts });
        chats.get(m.key).n++;
    }
    const cur = currentChatInfo();
    const scope = wrap.querySelector('#cab_scope');
    scope.innerHTML = `<option value="">ทุกแชท (${all.length})</option>` +
        [...chats.entries()].map(([k, v]) =>
            `<option value="${escapeHtml(k)}">${k === cur?.key ? '● ' : ''}${escapeHtml(v.label)} — ${escapeHtml(v.chatId)} (${v.n})</option>`).join('');
    if (browserKey && !chats.has(browserKey)) browserKey = null;
    scope.value = browserKey ?? '';

    const rows = browserKey ? all.filter(m => m.key === browserKey) : all;
    const list = wrap.querySelector('#cab_list');
    if (!rows.length) {
        list.innerHTML = '<div class="cab_empty">ยังไม่มี backup สำหรับแชทนี้</div>';
    } else {
        const peakByKey = new Map();
        for (const m of all) if (!peakByKey.has(m.key) || m.count > peakByKey.get(m.key)) peakByKey.set(m.key, m.count);
        list.innerHTML = rows.map(m => `
            <div class="cab_row" data-id="${m.id}">
                <div class="cab_info">
                    <div class="cab_title">
                        <span>${fmtTime(m.ts)}</span>
                        <span class="cab_count">${m.count} ข้อความ</span>
                        ${m.count === peakByKey.get(m.key) ? '<span class="cab_tag cab_peak" title="snapshot ที่มีข้อความมากที่สุดของแชทนี้ — ไม่ถูกลบอัตโนมัติ">สูงสุด</span>' : ''}
                        ${m.shrunk ? '<span class="cab_tag cab_warn" title="แชทสั้นลงผิดปกติเมื่อเทียบกับ backup ก่อนหน้า">สั้นลง</span>' : ''}
                        ${m.reason === 'manual' ? '<span class="cab_tag">manual</span>' : ''}
                        ${m.reason === 'import' ? '<span class="cab_tag">import</span>' : ''}
                    </div>
                    ${browserKey ? '' : `<div class="cab_sub">${escapeHtml(m.label)} — ${escapeHtml(m.chatId)}</div>`}
                    <div class="cab_preview"><b>${escapeHtml(m.previewName)}:</b> ${escapeHtml(m.preview)}</div>
                    <div class="cab_sub">${fmtBytes(m.size)} (ไม่บีบอัด ${fmtBytes(m.rawSize)})</div>
                </div>
                <div class="cab_actions">
                    ${m.type === 'character' ? '<div class="menu_button cab_restore" title="บันทึกเป็นไฟล์แชทใหม่บนเซิร์ฟเวอร์ (ไม่ทับของเดิม)"><i class="fa-solid fa-rotate-left"></i> กู้คืน</div>' : ''}
                    <div class="menu_button cab_dl" title="ดาวน์โหลด .jsonl"><i class="fa-solid fa-download"></i></div>
                    <div class="menu_button cab_del" title="ลบ snapshot นี้"><i class="fa-solid fa-trash"></i></div>
                </div>
            </div>`).join('');
    }

    list.querySelectorAll('.cab_row').forEach(row => {
        const meta = rows.find(m => m.id === Number(row.dataset.id));
        const guard = fn => async () => {
            try { await fn(); } catch (e) { console.error(LOG, e); toast.err(String(e.message ?? e)); }
        };
        row.querySelector('.cab_restore')?.addEventListener('click', guard(async () => {
            if (!confirm(`กู้คืน snapshot ${fmtTime(meta.ts)} (${meta.count} ข้อความ) เป็นไฟล์แชทใหม่?\nไฟล์แชทเดิมจะไม่ถูกแก้ไข`)) return;
            await restoreAsNewChat(meta);
        }));
        row.querySelector('.cab_dl').addEventListener('click', guard(() => downloadSnapshot(meta)));
        row.querySelector('.cab_del').addEventListener('click', guard(async () => {
            if (!confirm('ลบ snapshot นี้?')) return;
            await dbDelete([meta.id]);
            await renderBrowser();
            updateIndicator();
        }));
    });

    const total = all.reduce((a, m) => a + (m.size || 0), 0);
    let quota = '';
    try {
        const est = await navigator.storage?.estimate?.();
        if (est?.quota) quota = ` · พื้นที่เบราว์เซอร์ใช้ ${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}`;
    } catch { /* ignore */ }
    wrap.querySelector('#cab_foot').textContent = `${all.length} snapshots · ${chats.size} แชท · ${fmtBytes(total)}${quota}`;
}

// ---------------------------------------------------------------- floating status indicator
//
//   OK! #123        newest backup matches the chat on screen (messages #0–#123)
//   Waiting... #120 changes not written yet — number is what IS backed up so far
//   Attention! #123 chat on screen is much shorter than its backup, or a write failed
//
// Numbers follow SillyTavern's message ids, which start at #0.

let indicatorSeq = 0;

function ensureIndicator() {
    let el = document.getElementById('cab_indicator');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'cab_indicator';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.hidden = true;
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBrowser(); } });
    makeDraggable(el);
    // Fixed to the screen (not the chat column) so it can be parked anywhere.
    document.body.appendChild(el);

    const reflow = () => placeIndicator();
    window.addEventListener('resize', reflow);
    window.visualViewport?.addEventListener('resize', reflow);
    return el;
}

function viewportSize() {
    const vv = window.visualViewport;
    return { vw: vv?.width ?? window.innerWidth, vh: vv?.height ?? window.innerHeight };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function normPos(p) {
    const x = clamp(Number(p?.x), 0, 1), y = clamp(Number(p?.y), 0, 1);
    const edge = ['left', 'right', 'top', 'bottom'].includes(p?.edge) ? p.edge : null;
    return { x: Number.isFinite(x) ? x : 1, y: Number.isFinite(y) ? y : 0.08, edge };
}

/** Put the button where settings say, always fully inside the visible screen. */
function placeIndicator(el = document.getElementById('cab_indicator')) {
    if (!el || el.hidden || el.classList.contains('cab_dragging')) return;
    const { vw, vh } = viewportSize();
    const w = el.offsetWidth, h = el.offsetHeight;
    const travelX = Math.max(0, vw - w - 2 * EDGE_MARGIN);
    const travelY = Math.max(0, vh - h - 2 * EDGE_MARGIN);
    const p = normPos(settings().indicatorPos);
    let left = EDGE_MARGIN + p.x * travelX;
    let top = EDGE_MARGIN + p.y * travelY;
    if (p.edge === 'left') left = EDGE_MARGIN;
    if (p.edge === 'right') left = EDGE_MARGIN + travelX;
    if (p.edge === 'top') top = EDGE_MARGIN;
    if (p.edge === 'bottom') top = EDGE_MARGIN + travelY;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.edge = p.edge ?? 'none';
}

/** Drag with mouse or finger; on release snap to the nearest screen edge. A tap still opens the list. */
function makeDraggable(el) {
    const THRESHOLD = 6; // px of movement before a press counts as a drag
    let start = null;
    let dragged = false;

    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, id: e.pointerId };
        dragged = false;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });

    el.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.id) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!dragged && Math.hypot(dx, dy) < THRESHOLD) return;
        dragged = true;
        el.classList.add('cab_dragging');
        const { vw, vh } = viewportSize();
        el.style.left = `${clamp(start.left + dx, 0, Math.max(0, vw - el.offsetWidth))}px`;
        el.style.top = `${clamp(start.top + dy, 0, Math.max(0, vh - el.offsetHeight))}px`;
    });

    const end = e => {
        if (!start || e.pointerId !== start.id) return;
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        start = null;
        if (!dragged) {
            if (e.type === 'pointerup') openBrowser();
            return;
        }
        el.classList.remove('cab_dragging');
        if (e.type === 'pointerup') snapIndicator(el);
        placeIndicator(el);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
}

function snapIndicator(el) {
    const { vw, vh } = viewportSize();
    const r = el.getBoundingClientRect();
    const dist = { left: r.left, right: vw - r.right, top: r.top, bottom: vh - r.bottom };
    const edge = Object.keys(dist).reduce((a, b) => (dist[b] < dist[a] ? b : a));
    const travelX = Math.max(1, vw - r.width - 2 * EDGE_MARGIN);
    const travelY = Math.max(1, vh - r.height - 2 * EDGE_MARGIN);
    const pos = {
        x: clamp((r.left - EDGE_MARGIN) / travelX, 0, 1),
        y: clamp((r.top - EDGE_MARGIN) / travelY, 0, 1),
        edge,
    };
    if (edge === 'left') pos.x = 0;
    if (edge === 'right') pos.x = 1;
    if (edge === 'top') pos.y = 0;
    if (edge === 'bottom') pos.y = 1;
    settings().indicatorPos = pos;
    saveSettings();
}

function resetIndicatorPosition() {
    settings().indicatorPos = { ...INDICATOR_CENTER };
    saveSettings();
    placeIndicator();
}

function applyIndicatorStyle(el = document.getElementById('cab_indicator')) {
    if (!el) return;
    const s = settings();
    const size = clamp(Number(s.indicatorFontSize) || DEFAULTS.indicatorFontSize, 8, 40);
    el.style.setProperty('--cab-font-size', `${size}px`);
    placeIndicator(el); // size change moves the edges
}

async function updateIndicator() {
    const seq = ++indicatorSeq;
    const el = ensureIndicator();
    const s = settings();
    applyIndicatorStyle(el);

    const info = s.enabled && s.showIndicator ? currentChatInfo() : null;
    const c = ctx();
    const count = Array.isArray(c.chat) ? c.chat.length : 0;
    if (!info || !count) { el.hidden = true; return; }

    let list = [];
    try { list = await dbMetaByKey(info.key); } catch (e) { console.error(LOG, e); }
    if (seq !== indicatorSeq) return; // a newer update already ran

    const newest = list[0];
    const peak = list.reduce((a, b) => (!a || b.count > a.count ? b : a), null);
    const busy = (pending && pending.info.key === info.key) || inflightByKey.has(info.key);
    const lastId = m => (m ? `#${m.count - 1}` : '#–');

    let state, label, num, tip;
    if (lastError && lastError.key === info.key) {
        state = 'attention'; label = 'Attention!'; num = lastId(newest);
        tip = `บันทึก backup ไม่สำเร็จ: ${lastError.message}`;
    } else if (peak && peak.count >= 6 && count < peak.count * 0.6) {
        state = 'attention'; label = 'Attention!'; num = lastId(peak);
        tip = `แชทบนจอมี ${count} ข้อความ แต่ backup มีถึง ${peak.count} ข้อความ (${fmtTime(peak.ts)}) — แชทอาจหาย/ไม่ครบ`;
    } else if (busy || !newest || lastHashByKey.get(info.key) !== newest.hash) {
        state = 'waiting'; label = 'Waiting...'; num = lastId(newest);
        tip = newest
            ? `กำลังรอบันทึก — backup ล่าสุดถึงข้อความ ${lastId(newest)} (${fmtTime(newest.ts)})`
            : 'กำลังรอบันทึก — แชทนี้ยังไม่มี backup';
    } else {
        state = 'ok'; label = 'OK!'; num = lastId(newest);
        tip = `backup ครบถึงข้อความ ${lastId(newest)} (${fmtTime(newest.ts)})`;
    }

    el.dataset.state = state;
    el.textContent = `${label} ${num}`;
    el.title = `${tip}\nคลิกเพื่อดู/กู้คืน · ลากเพื่อย้ายตำแหน่ง`;
    el.hidden = false;
    placeIndicator(el); // text width may have changed
}

// ---------------------------------------------------------------- settings panel

function renderSettings() {
    const s = settings();
    const html = `
    <div id="cab_settings" class="cab_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Auto Backup</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="cab_enabled"> เปิด backup อัตโนมัติ</label>
                <div class="cab_grid">
                    <label for="cab_debounce">รอหลังแชทเปลี่ยน (วินาที)</label>
                    <input type="number" id="cab_debounce" class="text_pole" min="0" max="120" step="1">
                    <label for="cab_interval">ตรวจซ้ำทุก (นาที, 0 = ปิด)</label>
                    <input type="number" id="cab_interval" class="text_pole" min="0" max="120" step="1">
                    <label for="cab_max">เก็บต่อแชท (snapshots)</label>
                    <input type="number" id="cab_max" class="text_pole" min="1" max="200" step="1">
                </div>
                <label class="checkbox_label" title="snapshot ที่มีข้อความมากที่สุดจะไม่ถูกลบ แม้จะเก่ากว่าจำนวนที่ตั้งไว้"><input type="checkbox" id="cab_keeppeak"> เก็บ snapshot ที่ยาวที่สุดไว้เสมอ</label>
                <label class="checkbox_label"><input type="checkbox" id="cab_shrinkwarn"> เตือนเมื่อแชทที่โหลดมาสั้นกว่า backup</label>
                <label class="checkbox_label"><input type="checkbox" id="cab_notify"> แจ้งเตือนทุกครั้งที่ backup</label>
                <hr class="sysHR">
                <label class="checkbox_label" title="OK! / Waiting... / Attention! ตามด้วยเลขข้อความสุดท้ายที่ backup แล้ว — คลิกปุ่มเพื่อเปิดรายการ backup"><input type="checkbox" id="cab_indicator_on"> แสดงปุ่มสถานะบนหน้าแชท</label>
                <div class="cab_grid">
                    <label for="cab_indicator_size">ขนาดตัวอักษรปุ่ม (px)</label>
                    <input type="number" id="cab_indicator_size" class="text_pole" min="8" max="40" step="1">
                </div>
                <div class="cab_buttons">
                    <div id="cab_indicator_reset" class="menu_button" title="ย้ายปุ่มสถานะกลับมากลางจอ (ใช้เมื่อปุ่มหลุดไปอยู่ที่หาไม่เจอ)"><i class="fa-solid fa-crosshairs"></i> รีเซ็ตตำแหน่งปุ่ม</div>
                </div>
                <small class="cab_note">ลากปุ่มสถานะไปวางตรงไหนก็ได้ ปล่อยแล้วจะดูดติดขอบจอที่ใกล้ที่สุด</small>
                <div class="cab_buttons">
                    <div id="cab_now" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> Backup ตอนนี้</div>
                    <div id="cab_open" class="menu_button"><i class="fa-solid fa-clock-rotate-left"></i> ดู/กู้คืน</div>
                    <div id="cab_export" class="menu_button" title="ส่งออก backup ทั้งหมดเป็นไฟล์เดียว"><i class="fa-solid fa-file-export"></i> Export</div>
                    <div id="cab_import" class="menu_button"><i class="fa-solid fa-file-import"></i> Import</div>
                    <input type="file" id="cab_import_file" accept=".json,application/json" hidden>
                </div>
                <small class="cab_note">เก็บในเบราว์เซอร์นี้เท่านั้น (IndexedDB) — เครื่อง/เบราว์เซอร์อื่นมี backup แยกกัน ควรกด Export เก็บไว้เป็นระยะ</small>
            </div>
        </div>
    </div>`;

    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', html);

    const $ = id => document.getElementById(id);
    const bindCheck = (id, key, after) => {
        $(id).checked = !!s[key];
        $(id).addEventListener('change', e => { s[key] = e.target.checked; saveSettings(); after?.(); });
    };
    const bindNum = (id, key, after) => {
        $(id).value = s[key];
        $(id).addEventListener('change', e => {
            const v = Number(e.target.value);
            s[key] = Number.isFinite(v) && v >= 0 ? v : DEFAULTS[key];
            e.target.value = s[key];
            saveSettings();
            after?.();
        });
    };
    bindCheck('cab_enabled', 'enabled', () => { startTimer(); updateIndicator(); });
    bindCheck('cab_keeppeak', 'keepPeak');
    bindCheck('cab_shrinkwarn', 'shrinkWarn');
    bindCheck('cab_notify', 'notifyOnSave');
    bindCheck('cab_indicator_on', 'showIndicator', updateIndicator);
    bindNum('cab_debounce', 'debounceSec');
    bindNum('cab_interval', 'intervalMin', startTimer);
    bindNum('cab_max', 'maxPerChat');

    const sizeInput = $('cab_indicator_size');
    sizeInput.value = s.indicatorFontSize;
    sizeInput.addEventListener('input', e => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v) || v < 8 || v > 40) return; // wait until the value is sensible
        s.indicatorFontSize = v;
        saveSettings();
        applyIndicatorStyle();
    });
    sizeInput.addEventListener('change', e => {
        const v = Math.min(40, Math.max(8, Math.round(Number(e.target.value)) || DEFAULTS.indicatorFontSize));
        s.indicatorFontSize = v;
        e.target.value = v;
        saveSettings();
        applyIndicatorStyle();
    });

    $('cab_indicator_reset').addEventListener('click', () => {
        resetIndicatorPosition();
        const el = document.getElementById('cab_indicator');
        if (!el || el.hidden) toast.info('ตั้งตำแหน่งไว้กลางจอแล้ว ปุ่มจะขึ้นเมื่อเปิดแชทที่มีข้อความ');
    });

    $('cab_now').addEventListener('click', backupNow);
    $('cab_open').addEventListener('click', () => openBrowser());
    $('cab_export').addEventListener('click', () => exportAll().catch(e => toast.err(String(e.message ?? e))));
    $('cab_import').addEventListener('click', () => $('cab_import_file').click());
    $('cab_import_file').addEventListener('change', async e => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try { toast.ok(`นำเข้า ${await importFile(f)} snapshots`); } catch (err) { toast.err(String(err.message ?? err)); }
        updateIndicator();
    });
}

async function backupNow() {
    const snap = captureNow();
    if (!snap) return toast.warn('ไม่มีแชทที่เปิดอยู่ หรือแชทว่าง');
    pending = null;
    clearTimeout(pendingTimer);
    try {
        await writing;
        const r = await store(snap, { force: true, reason: 'manual' });
        if (lastError?.key === snap.info.key) lastError = null;
        toast.ok(`${snap.info.label}: ${snap.count} ข้อความ`, r.skipped ? 'ไม่มีอะไรเปลี่ยน' : 'Backup แล้ว');
    } catch (e) {
        console.error(LOG, e);
        lastError = { key: snap.info.key, message: String(e.message ?? e) };
        toast.err(String(e.message ?? e));
    }
    updateIndicator();
}

// ---------------------------------------------------------------- wiring

let intervalId = null;

function startTimer() {
    clearInterval(intervalId);
    intervalId = null;
    const s = settings();
    const min = Number(s.intervalMin) || 0;
    if (!s.enabled || min <= 0) return;
    intervalId = setInterval(() => {
        const snap = captureNow();
        if (!snap || lastHashByKey.get(snap.info.key) === snap.hash) return;
        if (pending && pending.info.key !== snap.info.key) flush();
        pending = snap;
        flush();
    }, min * 60_000);
}

function wireEvents() {
    const { eventSource, event_types: E } = ctx();
    const changeEvents = [
        E.MESSAGE_SENT, E.MESSAGE_RECEIVED, E.MESSAGE_EDITED, E.MESSAGE_DELETED,
        E.MESSAGE_SWIPED, E.MESSAGE_UPDATED, E.GENERATION_ENDED,
    ].filter(Boolean);
    for (const ev of [...new Set(changeEvents)]) eventSource.on(ev, () => schedule());

    if (E.CHAT_CHANGED) {
        eventSource.on(E.CHAT_CHANGED, async () => {
            flush(); // pending snapshot of the previous chat was captured already
            try { await checkLoadedChat(); } catch (e) { console.error(LOG, e); }
            // Baseline snapshot of the chat as loaded (skipped if unchanged).
            if (settings().enabled) {
                const snap = captureNow();
                if (snap) { pending = snap; flush(); }
            }
            updateIndicator();
        });
    }

    // Best effort on tab close: nothing async is guaranteed here, but a pending
    // write that's already in-flight usually completes.
    window.addEventListener('pagehide', () => flush());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

async function init() {
    settings();
    renderSettings();
    wireEvents();
    startTimer();
    // Ask the browser not to evict our data under storage pressure.
    try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
    try { await db(); } catch (e) { toast.err('เปิด IndexedDB ไม่ได้: ' + (e?.message ?? e)); }
    updateIndicator();
    console.log(LOG, 'loaded');
}

// expose for debugging / tests
globalThis.ChatAutoBackup = { captureNow, store, flush, schedule, dbAllMeta, dbMetaByKey, snapshotText, exportAll, importFile, restoreAsNewChat, openBrowser, checkLoadedChat, backupNow, settings, updateIndicator };

if (typeof jQuery === 'function') jQuery(init); else init();
