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
const DB_VERSION = 2;
const META = 'meta';
const PAYLOAD = 'payload';
const SIGS = 'sigs';        // per-snapshot message signatures, used to describe what changed
const SNAP_VERSION = 2;     // meta.sv — snapshots below this get their preview/signatures rebuilt
const PREVIEW_LEN = 200;
const LOG = '[ChatAutoBackup]';

const DEFAULTS = Object.freeze({
    enabled: true,
    debounceSec: 4,          // wait this long after the last change before writing
    intervalMin: 5,          // periodic safety check (0 = off)
    maxPerChat: 15,          // rolling snapshots kept per chat
    keepPeak: true,          // never prune the snapshot with the most messages
    shrinkWarn: true,        // warn when a loaded chat is much shorter than its backup
    notifyOnSave: false,     // toast on every backup
    mergeSwipes: true,       // replace the newest snapshot when only the last message's swipes changed
    showIndicator: true,     // floating status button over the chat
    indicatorFontSize: 12,   // px
    // Where the floating button sits. x/y are fractions (0–1) of the space the
    // button can travel across the screen; `edge` is the screen edge it is
    // snapped to (null = free, e.g. after "reset to centre").
    indicatorPos: Object.freeze({ x: 1, y: 0.08, edge: 'right' }),
    // Off-device copy of each chat's newest snapshot in the user's own Dropbox (App folder).
    dropbox: Object.freeze({ appKey: '', refreshToken: '', pendingVerifier: '', auto: true, intervalMin: 2 }),
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
            if (!d.objectStoreNames.contains(SIGS)) {
                d.createObjectStore(SIGS, { keyPath: 'id' });
            }
        };
        req.onblocked = () => toast.warn('มีแท็บ SillyTavern อื่นที่ยังใช้ extension เวอร์ชันเก่าอยู่ — ปิดหรือรีเฟรชแท็บนั้นก่อน');
        req.onsuccess = () => {
            const d = req.result;
            // Let a newer version in another tab upgrade the database.
            d.onversionchange = () => { d.close(); dbPromise = null; };
            resolve(d);
        };
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

async function dbAdd(meta, payload, sigs) {
    const d = await db();
    const tx = d.transaction([META, PAYLOAD, SIGS], 'readwrite');
    const id = await reqP(tx.objectStore(META).add(meta));
    tx.objectStore(PAYLOAD).put({ id, ...payload });
    if (sigs) tx.objectStore(SIGS).put({ id, head: sigs.head, msgs: sigs.msgs });
    await txDone(tx);
    return id;
}

async function dbPutMeta(meta, sigs) {
    const d = await db();
    const tx = d.transaction([META, SIGS], 'readwrite');
    tx.objectStore(META).put(meta);
    if (sigs) tx.objectStore(SIGS).put({ id: meta.id, head: sigs.head, msgs: sigs.msgs });
    await txDone(tx);
}

/** Mark a snapshot as uploaded — only if it still exists (it may have been merged or pruned meanwhile). */
async function dbMarkCloud(id, ts) {
    const d = await db();
    const tx = d.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    const req = store.get(id);
    req.onsuccess = () => { if (req.result) store.put({ ...req.result, cloud: ts }); };
    await txDone(tx);
}

async function dbGetSigs(id) {
    const d = await db();
    const tx = d.transaction(SIGS, 'readonly');
    return await reqP(tx.objectStore(SIGS).get(id));
}

async function dbAllSigs() {
    const d = await db();
    const tx = d.transaction(SIGS, 'readonly');
    return await reqP(tx.objectStore(SIGS).getAll());
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
    const tx = d.transaction([META, PAYLOAD, SIGS], 'readwrite');
    for (const id of ids) {
        tx.objectStore(META).delete(id);
        tx.objectStore(PAYLOAD).delete(id);
        tx.objectStore(SIGS).delete(id);
    }
    await txDone(tx);
}

// ---------------------------------------------------------------- message text & signatures

// HTML formatting tags: drop the tag, keep the words inside. Every other tag —
// <scene>, <status>, <thinking>, <details>, <div>… (usually regex-rendered
// blocks) — is dropped together with its content.
const INLINE_TAGS = ['a', 'abbr', 'b', 'big', 'blockquote', 'br', 'center', 'cite', 'code', 'del', 'em', 'font',
    'hr', 'i', 'ins', 'kbd', 'mark', 'p', 'q', 'rp', 'rt', 'ruby', 's', 'small', 'span', 'strike', 'strong',
    'sub', 'sup', 'tt', 'u', 'wbr'];
const BLOCK_RE = new RegExp(`<(?!(?:${INLINE_TAGS.join('|')})(?=[\\s/>]))([a-zA-Z][\\w:-]*)(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const ANY_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

function decodeEntities(t) {
    return t.replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (_, e) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }[e]));
}

/** Readable text of a message for previews: tag blocks removed, formatting tags unwrapped. */
function cleanText(text, { keepLines = false } = {}) {
    const src = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
    const finish = t => {
        t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n').replace(ANY_TAG_RE, '');
        t = decodeEntities(t);
        return keepLines
            ? t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
            : t.replace(/\s+/g, ' ').trim();
    };
    let out = src;
    for (let i = 0; i < 25; i++) { // repeat for nested blocks
        const next = out.replace(BLOCK_RE, ' ');
        if (next === out) break;
        out = next;
    }
    // Whole message wrapped in one custom tag? Then keep the words instead of nothing.
    return finish(out) || finish(src);
}

/** mes-hash | swipe count | selected swipe | whole-message hash */
function msgSig(m, json) {
    const sw = Array.isArray(m?.swipes) ? m.swipes.length : 0;
    return `${hash(String(m?.mes ?? ''))}|${sw}|${Number(m?.swipe_id) || 0}|${hash(json)}`;
}

function sigHash(sigs) {
    return hash(`${sigs.head}\n${sigs.msgs.join('\n')}`);
}

function lastMsgInfo(m) {
    const sw = Array.isArray(m?.swipes) ? m.swipes.length : 0;
    return {
        preview: cleanText(m?.mes).slice(0, PREVIEW_LEN),
        previewName: m?.name ?? '',
        swipe: sw > 1 ? [(Number(m.swipe_id) || 0) + 1, sw] : null,
    };
}

/** Rebuild signatures + preview from a stored JSONL snapshot. */
function deriveFromJsonl(text) {
    const lines = String(text).split('\n').filter(l => l.trim());
    let head = '';
    let start = 0;
    if (lines.length) {
        const first = JSON.parse(lines[0]);
        if (first && typeof first === 'object' && !('mes' in first)) { head = hash(lines[0]); start = 1; }
    }
    const msgs = [];
    let last = null;
    for (let i = start; i < lines.length; i++) {
        last = JSON.parse(lines[i]);
        msgs.push(msgSig(last, lines[i]));
    }
    const sigs = { head, msgs };
    return { sigs, hash: sigHash(sigs), count: msgs.length, ...lastMsgInfo(last) };
}

function fmtIds(ids) {
    const parts = [];
    for (let i = 0; i < ids.length; i++) {
        let j = i;
        while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
        parts.push(j > i ? `#${ids[i]}–#${ids[j]}` : `#${ids[i]}`);
        i = j;
    }
    return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} …` : parts.join(', ');
}

/** Human summary of what changed between two snapshots of the same chat. */
function describeChanges(prev, cur) {
    const A = prev.msgs, B = cur.msgs;
    let p = 0;
    while (p < A.length && p < B.length && A[p] === B[p]) p++;
    let q = 0;
    while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
    const aEnd = A.length - q, bEnd = B.length - q;
    const pairs = Math.min(aEnd, bEnd) - p;

    const out = [];
    const edits = [];
    const swipes = [];
    for (let k = 0; k < pairs; k++) {
        const i = p + k;
        const [, aSw, aSid] = A[i].split('|').map(Number);
        const [, bSw, bSid] = B[i].split('|').map(Number);
        if (bSw > aSw && bSw > 1) swipes.push(`+${bSw - aSw} swipe ที่ #${i} (เลือก ${bSid + 1}/${bSw})`);
        else if (bSw < aSw && aSw > 1) swipes.push(`ลบ swipe ที่ #${i} (เหลือ ${bSw})`);
        else if (bSid !== aSid && bSw > 1) swipes.push(`เปลี่ยนไปใช้ swipe ${bSid + 1}/${bSw} ที่ #${i}`);
        else edits.push(i);
    }
    if (bEnd - p > pairs) {
        const from = p + pairs, to = bEnd - 1;
        out.push(`+${to - from + 1} ข้อความ (${fmtIds(from === to ? [from] : [from, to]).replace(', ', '–')})`);
    }
    if (aEnd - p > pairs) {
        const from = p + pairs, to = aEnd - 1;
        out.push(`ลบ ${to - from + 1} ข้อความ (${fmtIds(from === to ? [from] : [from, to]).replace(', ', '–')})`);
    }
    out.push(...swipes);
    if (edits.length) out.push(`แก้ ${fmtIds(edits)}`);
    if (!out.length) out.push(prev.head !== cur.head ? 'ข้อมูลแชทเปลี่ยน (ไม่มีข้อความเปลี่ยน)' : 'ไม่มีอะไรเปลี่ยน');
    return out;
}

/** Signatures for a snapshot, rebuilding them (and its preview) for snapshots made before v1.3. */
async function getSigs(meta) {
    if ((meta.sv || 0) >= SNAP_VERSION) {
        const rec = await dbGetSigs(meta.id);
        if (rec) return rec;
    }
    return await upgradeSnapshot(meta);
}

async function upgradeSnapshot(meta) {
    const d = deriveFromJsonl(await snapshotText(meta.id));
    Object.assign(meta, {
        hash: d.hash,
        preview: d.preview,
        previewName: d.previewName,
        swipe: d.swipe,
        sv: SNAP_VERSION,
    });
    await dbPutMeta(meta, d.sigs);
    return { id: meta.id, ...d.sigs };
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

// A chat whose first message has no send_date still needs a fixed header date,
// otherwise every capture would look like a change.
const createDateByKey = new Map();
function stableCreateDate(key) {
    if (!createDateByKey.has(key)) createDateByKey.set(key, fileStamp(Date.now()));
    return createDateByKey.get(key);
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
    let head = '';
    if (info.type === 'character') {
        const h = JSON.stringify({
            user_name: c.name1,
            character_name: c.name2,
            create_date: messages[0]?.send_date ?? stableCreateDate(info.key),
            chat_metadata: c.chatMetadata ?? c.chat_metadata ?? {},
        });
        lines.push(h);
        head = hash(h);
    }
    const msgs = [];
    for (const m of messages) {
        const j = JSON.stringify(m);
        lines.push(j);
        msgs.push(msgSig(m, j));
    }
    const jsonl = lines.join('\n');
    const sigs = { head, msgs };

    return {
        info,
        jsonl,
        sigs,
        hash: sigHash(sigs),
        count: messages.length,
        ...lastMsgInfo(messages[messages.length - 1]),
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

    // Snapshots from before v1.3 used a different hash; bring the newest one up to date first.
    if (newest && (newest.sv || 0) < SNAP_VERSION) {
        try { await upgradeSnapshot(newest); } catch (e) { console.warn(LOG, e); }
    }

    if (!force && (lastHashByKey.get(info.key) === snap.hash || newest?.hash === snap.hash)) {
        lastHashByKey.set(info.key, snap.hash);
        return { skipped: true };
    }

    const s = settings();
    let mergeInto = null;
    if (!force && reason === 'auto' && s.mergeSwipes && newest && newest.reason === 'auto' && newest.count === snap.count) {
        try { if (await onlyLastSwipesGrew(newest, snap)) mergeInto = newest; } catch (e) { console.warn(LOG, e); }
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
        swipe: snap.swipe,
        rawSize: snap.jsonl.length,
        size,
        reason,
        shrunk,
        mergedSwipes: mergeInto ? (mergeInto.mergedSwipes || 0) + 1 : 0,
        sv: SNAP_VERSION,
    };
    const id = await dbAdd(meta, packed, snap.sigs);
    if (mergeInto) await dbDelete([mergeInto.id]);
    lastHashByKey.set(info.key, snap.hash);

    await prune(info.key);

    if (settings().notifyOnSave) toast.info(`${info.label}: ${snap.count} ข้อความ`, 'Backup แล้ว');
    cloudSoon();
    return { id, meta };
}

/**
 * True when the new snapshot differs from `prevMeta` only in the last message's
 * swipes, and every swipe text of the old one is still there (or only grew, as
 * while a swipe is streaming) — so the old snapshot holds nothing the new one lacks.
 */
async function onlyLastSwipesGrew(prevMeta, snap) {
    const prev = await getSigs(prevMeta);
    const A = prev.msgs, B = snap.sigs.msgs, n = B.length;
    if (prev.head !== snap.sigs.head || A.length !== n || n === 0) return false;
    for (let i = 0; i < n - 1; i++) if (A[i] !== B[i]) return false;

    const lastOf = t => { const s = String(t).trimEnd(); return JSON.parse(s.slice(s.lastIndexOf('\n') + 1)); };
    const oldLast = lastOf(await snapshotText(prevMeta.id));
    const newLast = lastOf(snap.jsonl);
    const swipesOf = m => (Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.mes ?? '']).map(x => String(x ?? ''));
    const oldSw = swipesOf(oldLast), newSw = swipesOf(newLast);
    if (newSw.length < 2 || newSw.length < oldSw.length) return false;
    return oldSw.every((t, i) => newSw[i].startsWith(t));
}

async function prune(key) {
    const s = settings();
    // Named checkpoints imported from Pocky are kept until deleted by hand.
    const list = (await dbMetaByKey(key)).filter(x => !x.note); // newest first
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
    for (const m of all) if ((m.sv || 0) < SNAP_VERSION) { try { await upgradeSnapshot(m); } catch (e) { console.warn(LOG, e); } }
    const seen = new Set(all.map(m => `${m.key}|${m.hash}`));
    let added = 0;
    for (const { meta, jsonl } of data.snapshots) {
        if (!meta?.key || typeof jsonl !== 'string') continue;
        let d;
        try { d = deriveFromJsonl(jsonl); } catch { continue; }
        const h = d.hash;
        if (seen.has(`${meta.key}|${h}`)) continue;
        const { id: _drop, ...clean } = meta;
        const packed = await pack(jsonl);
        Object.assign(clean, { hash: h, count: d.count, preview: d.preview, previewName: d.previewName, swipe: d.swipe, sv: SNAP_VERSION });
        clean.size = packed.enc === 'gzip' ? packed.data.size : jsonl.length;
        clean.rawSize = jsonl.length;
        clean.reason = 'import';
        await dbAdd(clean, packed, d.sigs);
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
        // One-time rebuild of previews/signatures for snapshots made before v1.3.
        const old = rows.filter(m => (m.sv || 0) < SNAP_VERSION);
        for (let i = 0; i < old.length; i++) {
            list.innerHTML = `<div class="cab_empty">กำลังเตรียมข้อมูล snapshot เก่า… ${i + 1}/${old.length}</div>`;
            try { await upgradeSnapshot(old[i]); } catch (e) { console.warn(LOG, 'upgrade failed', old[i].id, e); }
        }
        if (document.getElementById('cab_modal') !== wrap) return;

        const sigsById = new Map();
        try { for (const r of await dbAllSigs()) sigsById.set(r.id, r); } catch (e) { console.warn(LOG, e); }

        // previous (older) snapshot of the same chat, and the one snapshot the pruner always keeps
        const prevById = new Map();
        const peakIdByKey = new Map();
        const byKey = new Map();
        for (const m of all) (byKey.get(m.key) ?? byKey.set(m.key, []).get(m.key)).push(m);
        for (const [k, list2] of byKey) {
            const asc = [...list2].sort((a, b) => a.ts - b.ts);
            asc.forEach((m, i) => prevById.set(m.id, asc[i - 1] ?? null));
            const peak = list2.reduce((a, b) => (b.count > a.count || (b.count === a.count && b.ts > a.ts) ? b : a));
            peakIdByKey.set(k, peak.id);
        }
        const changesOf = m => {
            const prev = prevById.get(m.id);
            if (!prev) return 'snapshot เก่าสุดที่เก็บไว้';
            const a = sigsById.get(prev.id), b = sigsById.get(m.id);
            return a && b ? describeChanges(a, b).join(' · ') : '';
        };

        list.innerHTML = rows.map(m => {
            const changes = changesOf(m);
            return `
            <div class="cab_row" data-id="${m.id}">
                <div class="cab_info">
                    <div class="cab_title">
                        <span>${fmtTime(m.ts)}</span>
                        <span class="cab_count">${m.count} ข้อความ</span>
                        ${m.swipe ? `<span class="cab_tag" title="ข้อความล่าสุดมี ${m.swipe[1]} swipe ขณะนั้นเลือกอันที่ ${m.swipe[0]} — กู้คืนแล้วได้ครบทุก swipe">swipe ${m.swipe[0]}/${m.swipe[1]}</span>` : ''}
                        ${peakIdByKey.get(m.key) === m.id ? '<span class="cab_tag cab_peak" title="snapshot ที่มีข้อความมากที่สุดของแชทนี้ — ไม่ถูกลบอัตโนมัติ">สูงสุด</span>' : ''}
                        ${m.shrunk ? '<span class="cab_tag cab_warn" title="แชทสั้นลงผิดปกติเมื่อเทียบกับ backup ก่อนหน้า">สั้นลง</span>' : ''}
                        ${m.reason === 'manual' ? '<span class="cab_tag">manual</span>' : ''}
                        ${m.reason === 'import' ? `<span class="cab_tag">${m.source === 'pocky' ? 'จาก Pocky' : m.source === 'dropbox' ? 'จาก Dropbox' : 'import'}</span>` : ''}
                        ${m.note ? `<span class="cab_tag cab_note_tag" title="จุดคืนค่าที่ตั้งชื่อไว้ใน Pocky — ไม่ถูกลบอัตโนมัติ">${escapeHtml(m.note)}</span>` : ''}
                    </div>
                    ${browserKey ? '' : `<div class="cab_sub">${escapeHtml(m.label)} — ${escapeHtml(m.chatId)}</div>`}
                    ${changes ? `<div class="cab_changes" title="เทียบกับ snapshot ก่อนหน้าของแชทนี้">${escapeHtml(changes)}${m.mergedSwipes ? ` <span class="cab_merged">(รวม swipe ไว้ ${m.mergedSwipes} ครั้ง)</span>` : ''}</div>` : ''}
                    <div class="cab_preview" title="แตะเพื่ออ่านข้อความล่าสุดทั้งข้อความ"><b>${escapeHtml(m.previewName)}:</b> ${escapeHtml(m.preview || '(ไม่มีข้อความ)')}</div>
                    <div class="cab_full" hidden title="แตะเพื่อย่อ"></div>
                    <div class="cab_sub">${fmtBytes(m.size)} (ไม่บีบอัด ${fmtBytes(m.rawSize)})</div>
                </div>
                <div class="cab_actions">
                    ${m.type === 'character' ? '<div class="menu_button cab_restore" title="บันทึกเป็นไฟล์แชทใหม่บนเซิร์ฟเวอร์ (ไม่ทับของเดิม)"><i class="fa-solid fa-rotate-left"></i> กู้คืน</div>' : ''}
                    <div class="menu_button cab_dl" title="ดาวน์โหลด .jsonl"><i class="fa-solid fa-download"></i></div>
                    <div class="menu_button cab_del" title="ลบ snapshot นี้"><i class="fa-solid fa-trash"></i></div>
                </div>
            </div>`;
        }).join('');
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
        const pv = row.querySelector('.cab_preview');
        const full = row.querySelector('.cab_full');
        pv.addEventListener('click', guard(async () => {
            if (!full.dataset.loaded) {
                const t = String(await snapshotText(meta.id)).trimEnd();
                const last = JSON.parse(t.slice(t.lastIndexOf('\n') + 1));
                const name = document.createElement('b');
                name.textContent = `${last?.name ?? ''}:`;
                full.replaceChildren(name, document.createTextNode(' ' + (cleanText(last?.mes, { keepLines: true }) || '(ไม่มีข้อความ)')));
                full.dataset.loaded = '1';
            }
            pv.hidden = true;
            full.hidden = false;
        }));
        full.addEventListener('click', () => { full.hidden = true; pv.hidden = false; });
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
                <label class="checkbox_label" title="ถ้าเปลี่ยนแค่ swipe ของข้อความสุดท้าย (ปัด/สร้าง swipe ใหม่) จะแทนที่ snapshot ล่าสุดแทนการเพิ่มใหม่ — ไม่เสียข้อมูล เพราะ snapshot ใหม่มีทุก swipe อยู่แล้ว"><input type="checkbox" id="cab_mergeswipes"> รวม snapshot ที่ต่างกันแค่ swipe ของข้อความสุดท้าย</label>
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
                <hr class="sysHR">
                <b>สำรองขึ้น Dropbox</b>
                <small id="cab_dbx_status" class="cab_note"></small>
                <div id="cab_dbx_setup">
                    <small class="cab_note">ตั้งค่าครั้งเดียว: สร้าง app ที่ <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener">dropbox.com/developers/apps</a> (เลือก Scoped access · App folder) → แท็บ Permissions ติ๊ก <code>files.content.write</code> และ <code>files.content.read</code> แล้วกด Submit → คัดลอก App key จากแท็บ Settings มาวางด้านล่าง</small>
                    <input id="cab_dbx_key" class="text_pole" placeholder="App key" autocomplete="off" autocapitalize="off" spellcheck="false">
                    <div class="cab_buttons"><div id="cab_dbx_connect" class="menu_button">เชื่อมต่อ</div></div>
                    <div id="cab_dbx_step2" hidden>
                        <small class="cab_note">1. <a id="cab_dbx_link" target="_blank" rel="noopener">เปิดหน้าอนุญาตของ Dropbox</a> แล้วกด Allow<br>2. คัดลอกรหัสที่ Dropbox แสดง กลับมาวางตรงนี้</small>
                        <input id="cab_dbx_code" class="text_pole" placeholder="รหัสจาก Dropbox" autocomplete="off" autocapitalize="off" spellcheck="false">
                        <div class="cab_buttons"><div id="cab_dbx_confirm" class="menu_button">ยืนยันรหัส</div></div>
                    </div>
                </div>
                <div id="cab_dbx_on" hidden>
                    <label class="checkbox_label" title="ส่ง snapshot ล่าสุดของแชทที่เปลี่ยน ขึ้น Dropbox ทีละแชท ทับไฟล์เดิมของแชทนั้น"><input type="checkbox" id="cab_dbx_auto"> ส่งขึ้น Dropbox อัตโนมัติ</label>
                    <div class="cab_grid">
                        <label for="cab_dbx_interval">ส่งแต่ละแชทไม่ถี่กว่าทุก (นาที)</label>
                        <input type="number" id="cab_dbx_interval" class="text_pole" min="1" max="120" step="1">
                    </div>
                    <div class="cab_buttons">
                        <div id="cab_dbx_now" class="menu_button" title="ส่งทุกแชทที่ยังไม่ได้ส่ง ตอนนี้เลย">ส่งตอนนี้</div>
                        <div id="cab_dbx_pull" class="menu_button" title="ดาวน์โหลดไฟล์แชทจาก Dropbox กลับมาเป็น snapshot (ไม่เขียนทับแชทบนเซิร์ฟเวอร์)">ดึง backup จาก Dropbox</div>
                        <div id="cab_dbx_disconnect" class="menu_button">ยกเลิกการเชื่อมต่อ</div>
                    </div>
                </div>
                <div id="cab_pocky" hidden>
                    <hr class="sysHR">
                    <b>ข้อมูลที่ Pocky chat vault ทิ้งไว้</b>
                    <small id="cab_pocky_info" class="cab_note"></small>
                    <div class="cab_buttons">
                        <div id="cab_pocky_import" class="menu_button" title="นำ backup ล่าสุดของแต่ละแชท และจุดคืนค่าที่ตั้งชื่อไว้ เข้ามาเป็น snapshot ของ Chat Auto Backup">นำเข้าอันที่สำคัญ</div>
                        <div id="cab_pocky_delete" class="menu_button" title="ลบฐานข้อมูลของ Pocky ออกจากเบราว์เซอร์นี้ เพื่อคืนพื้นที่">ลบฐานข้อมูล Pocky</div>
                    </div>
                </div>
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
    bindCheck('cab_mergeswipes', 'mergeSwipes');
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
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') return;
        // Leaving the app: write what's pending, then push it off the device if we can.
        flush().then(() => cloudTick({ ignoreGap: true })).catch(() => { /* next tick */ });
    });
}

// ---------------------------------------------------------------- Dropbox sync
//
// One file per chat in the app's own Dropbox folder, always the newest snapshot:
//   /character/<avatar>/<chat id>.jsonl      /group/<group id>/<chat id>.jsonl
// Plain SillyTavern JSONL, so a file can also be imported into ST by hand.
// Only one chat is ever in memory at a time; nothing reads the whole database.

const DBX_API = 'https://api.dropboxapi.com';
const DBX_CONTENT = 'https://content.dropboxapi.com';
const cloud = {
    token: '', tokenExp: 0,
    running: false, again: null,
    lastAt: new Map(),       // key -> ms of this session's last upload (per-chat pacing)
    backoffUntil: 0,
    lastOk: 0, pending: 0, withheld: [], error: '', progress: '',
    soonTimer: null,
};

function dbxSettings() {
    const s = settings();
    if (!s.dropbox || typeof s.dropbox !== 'object') s.dropbox = { ...DEFAULTS.dropbox };
    for (const [k, v] of Object.entries(DEFAULTS.dropbox)) if (s.dropbox[k] === undefined) s.dropbox[k] = v;
    return s.dropbox;
}

function pendingVerifier() {
    let v = dbxSettings().pendingVerifier;
    if (!v) { try { v = localStorage.getItem('cab_dbx_verifier') || ''; } catch { /* ignore */ } }
    return v;
}

const dbxConnected = () => !!(dbxSettings().refreshToken && dbxSettings().appKey);

/** Dropbox-API-Arg is an HTTP header: JSON with every non-ASCII char as \uXXXX. */
function dbxArg(obj) {
    return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Path segments: percent-encode only what Dropbox or file systems dislike, so names stay readable.
function dbxSeg(t) {
    return String(t).replace(/[%\/\\<>:"|?*\u0000-\u001f]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
        .replace(/[. ]$/, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function dbxUnseg(t) {
    return String(t).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function dbxPathOf(m) {
    const entity = m.type === 'group' ? m.groupId : m.avatar;
    return `/${m.type === 'group' ? 'group' : 'character'}/${dbxSeg(entity)}/${dbxSeg(m.chatId)}.jsonl`;
}

function b64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function dbxError(res) {
    const t = await res.text().catch(() => '');
    try { const j = JSON.parse(t); return j.error_summary || j.error_description || j.error || t; } catch { return t || `${res.status} ${res.statusText}`; }
}

async function dbxToken() {
    if (cloud.token && Date.now() < cloud.tokenExp - 60_000) return cloud.token;
    const d = dbxSettings();
    if (!d.refreshToken) throw new Error('ยังไม่ได้เชื่อมต่อ Dropbox');
    const res = await fetch(`${DBX_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: d.refreshToken, client_id: d.appKey }),
    });
    if (!res.ok) {
        const msg = await dbxError(res);
        if (/invalid_grant|invalid_client/.test(msg)) {
            d.refreshToken = '';
            saveSettings();
            renderDbxPanel();
            throw new Error('Dropbox ยกเลิกสิทธิ์แล้ว — ต้องเชื่อมต่อใหม่');
        }
        throw new Error(`ขอสิทธิ์ Dropbox ไม่สำเร็จ: ${msg}`);
    }
    const j = await res.json();
    cloud.token = j.access_token;
    cloud.tokenExp = Date.now() + (Number(j.expires_in) || 14_400) * 1000;
    return cloud.token;
}

async function dbxFetch(url, init = {}, retry = true) {
    const token = await dbxToken();
    const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401 && retry) { cloud.token = ''; return dbxFetch(url, init, false); }
    if (res.status === 429) {
        cloud.backoffUntil = Date.now() + (Number(res.headers.get('Retry-After')) || 60) * 1000;
        throw new Error('Dropbox ขอให้รอสักครู่');
    }
    return res;
}

async function dbxRpc(endpoint, body) {
    const res = await dbxFetch(`${DBX_API}/2/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { const e = new Error(await dbxError(res)); e.status = res.status; throw e; }
    return await res.json();
}

async function dbxMetadata(path) {
    try { return await dbxRpc('files/get_metadata', { path }); } catch (e) {
        if (e.status === 409 && /not_found/.test(e.message)) return null;
        throw e;
    }
}

async function dbxUpload(path, blob, ts) {
    const arg = { path, mode: 'overwrite', mute: true, autorename: false, client_modified: new Date(ts).toISOString().replace(/\.\d+Z$/, 'Z') };
    const res = await dbxFetch(`${DBX_CONTENT}/2/files/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': dbxArg(arg) },
        body: blob,
    });
    if (!res.ok) throw new Error(await dbxError(res));
    return await res.json();
}

async function dbxDownloadText(path) {
    const res = await dbxFetch(`${DBX_CONTENT}/2/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': dbxArg({ path }) } });
    if (!res.ok) throw new Error(await dbxError(res));
    return await res.text();
}

/** Upload chats whose newest snapshot isn't in Dropbox yet. */
async function cloudTick({ ignoreGap = false, force = false, forceKeys = null } = {}) {
    const d = dbxSettings();
    if (!dbxConnected()) return;
    if (!force && !ignoreGap && d.auto === false) return;
    if (cloud.running) { cloud.again = { ignoreGap: ignoreGap || cloud.again?.ignoreGap }; return; }
    if (!force && Date.now() < cloud.backoffUntil) return;
    cloud.running = true;
    cloud.error = '';
    try {
        const all = await dbAllMeta(); // metadata only, newest first
        const newest = new Map();
        for (const m of all) if (!newest.has(m.key)) newest.set(m.key, m);
        const gap = Math.max(1, Number(d.intervalMin) || DEFAULTS.dropbox.intervalMin) * 60_000;
        const due = [];
        const withheld = [];
        for (const [key, m] of newest) {
            if (m.cloud) continue;
            const forced = force && (!forceKeys || forceKeys.includes(key));
            if (m.shrunk && !forced) { withheld.push({ key, label: m.label, why: 'แชทสั้นลงผิดปกติ' }); continue; }
            if (!ignoreGap && Date.now() - (cloud.lastAt.get(key) || 0) < gap) continue;
            due.push({ m, forced });
        }
        cloud.pending = due.length;
        renderDbxStatus();
        for (const { m, forced } of due) {
            const text = await snapshotText(m.id);
            const blob = new Blob([text], { type: 'application/octet-stream' });
            const path = dbxPathOf(m);
            if (!forced) {
                // Never let a chat that came back truncated overwrite a fuller copy in Dropbox.
                const remote = await dbxMetadata(path);
                if (remote?.size > 20_000 && blob.size < remote.size * 0.6) {
                    withheld.push({ key: m.key, label: m.label, why: `ไฟล์บน Dropbox ใหญ่กว่ามาก (${fmtBytes(remote.size)} → ${fmtBytes(blob.size)})` });
                    cloud.pending--;
                    continue;
                }
            }
            await dbxUpload(path, blob, m.ts);
            m.cloud = Date.now();
            await dbMarkCloud(m.id, m.cloud);
            cloud.lastAt.set(m.key, m.cloud);
            cloud.lastOk = m.cloud;
            cloud.pending--;
            renderDbxStatus();
        }
        cloud.withheld = withheld;
    } catch (e) {
        console.warn(LOG, 'Dropbox sync', e);
        cloud.error = String(e?.message ?? e);
        cloud.backoffUntil = Math.max(cloud.backoffUntil, Date.now() + 60_000);
    } finally {
        cloud.running = false;
        renderDbxStatus();
        if (cloud.again) { const a = cloud.again; cloud.again = null; setTimeout(() => cloudTick(a), 1000); }
    }
}

/** After a snapshot is written: sync shortly (pacing still applies). */
function cloudSoon() {
    if (!dbxConnected()) return;
    clearTimeout(cloud.soonTimer);
    cloud.soonTimer = setTimeout(() => cloudTick(), 3000);
}

/** Download every chat file from Dropbox into local snapshots. */
async function cloudPull(progress) {
    const files = [];
    let page = await dbxRpc('files/list_folder', { path: '', recursive: true, limit: 2000 });
    for (;;) {
        for (const e of page.entries) if (e['.tag'] === 'file' && /\.jsonl$/i.test(e.name)) files.push(e);
        if (!page.has_more) break;
        page = await dbxRpc('files/list_folder/continue', { cursor: page.cursor });
    }
    const all = await dbAllMeta();
    for (const m of all) if ((m.sv || 0) < SNAP_VERSION) { try { await upgradeSnapshot(m); } catch { /* ignore */ } }
    const seen = new Set(all.map(m => `${m.key}|${m.hash}`));
    const c = ctx();
    let added = 0, skipped = 0;
    for (let i = 0; i < files.length; i++) {
        progress?.(`กำลังดึง ${i + 1}/${files.length}…`);
        const f = files[i];
        const parts = String(f.path_display || '').split('/').filter(Boolean);
        if (parts.length !== 3 || !['character', 'group'].includes(parts[0])) { skipped++; continue; }
        const isGroup = parts[0] === 'group';
        const entity = dbxUnseg(parts[1]);
        const chatId = dbxUnseg(parts[2].replace(/\.jsonl$/i, ''));
        const key = `${isGroup ? 'g' : 'c'}:${entity}:${chatId}`;
        let text, d;
        try { text = await dbxDownloadText(f.path_lower); d = deriveFromJsonl(text); } catch (e) { console.warn(LOG, e); skipped++; continue; }
        if (!d.count || seen.has(`${key}|${d.hash}`)) { skipped++; continue; }
        let label = entity;
        if (isGroup) label = (c.groups || []).find(g => String(g.id) === entity)?.name ?? `Group ${entity}`;
        else {
            label = (c.characters || []).find(ch => ch.avatar === entity)?.name ?? label;
            try { const h = JSON.parse(text.slice(0, text.indexOf('\n'))); if (label === entity && h?.character_name) label = h.character_name; } catch { /* ignore */ }
        }
        const packed = await pack(text);
        const meta = {
            key, type: isGroup ? 'group' : 'character', chatId,
            groupId: isGroup ? entity : null, avatar: isGroup ? null : entity, label,
            ts: Date.parse(f.client_modified) || Date.parse(f.server_modified) || Date.now(),
            hash: d.hash, count: d.count, preview: d.preview, previewName: d.previewName, swipe: d.swipe,
            rawSize: text.length, size: packed.enc === 'gzip' ? packed.data.size : text.length,
            reason: 'import', source: 'dropbox', shrunk: false, mergedSwipes: 0, sv: SNAP_VERSION,
            cloud: Date.now(),
        };
        await dbAdd(meta, packed, d.sigs);
        seen.add(`${key}|${d.hash}`);
        added++;
        text = null;
    }
    return { added, skipped, total: files.length };
}

function renderDbxStatus() {
    const el = document.getElementById('cab_dbx_status');
    if (!el) return;
    if (!dbxConnected()) {
        el.textContent = pendingVerifier() ? 'รอรหัสจาก Dropbox…' : 'ยังไม่ได้เชื่อมต่อ';
        return;
    }
    const parts = ['เชื่อมต่อแล้ว'];
    if (dbxSettings().auto === false) parts.push('ปิดการส่งอัตโนมัติ');
    if (cloud.progress) parts.push(cloud.progress);
    else if (cloud.running) parts.push(cloud.pending ? `กำลังส่ง… (เหลือ ${cloud.pending} แชท)` : 'กำลังตรวจ…');
    if (cloud.lastOk) parts.push(`ส่งล่าสุด ${fmtTime(cloud.lastOk).slice(11, 16)}`);
    if (cloud.withheld.length) parts.push(`ไม่ส่ง ${cloud.withheld.length} แชท (${cloud.withheld.map(w => `${w.label}: ${w.why}`).join('; ')}) — กด "ส่งตอนนี้" ถ้าตั้งใจ`);
    if (cloud.error) parts.push(`⚠ ${cloud.error} (จะลองใหม่เอง)`);
    el.textContent = parts.join(' · ');
}

function renderDbxPanel() {
    const on = dbxConnected();
    const setup = document.getElementById('cab_dbx_setup');
    const onBox = document.getElementById('cab_dbx_on');
    if (!setup || !onBox) return;
    setup.hidden = on;
    onBox.hidden = !on;
    // Keep the code box visible after a reload, so a code copied from Dropbox can still be pasted.
    document.getElementById('cab_dbx_step2').hidden = on || !pendingVerifier();
    const link = document.getElementById('cab_dbx_link');
    link.hidden = !link.getAttribute('href');
    renderDbxStatus();
}

function wireDbxPanel() {
    const $ = id => document.getElementById(id);
    if (!$('cab_dbx_setup')) return;
    const d = dbxSettings();
    $('cab_dbx_key').value = d.appKey;
    $('cab_dbx_auto').checked = d.auto !== false;
    $('cab_dbx_interval').value = d.intervalMin;

    let busy = false;
    const run = (btn, fn) => async () => {
        if (busy) return;
        busy = true;
        btn.classList.add('disabled');
        try { await fn(); } catch (e) { console.error(LOG, e); toast.err(String(e?.message ?? e), 'Dropbox'); }
        busy = false;
        btn.classList.remove('disabled');
        renderDbxPanel();
    };

    $('cab_dbx_connect').addEventListener('click', run($('cab_dbx_connect'), async () => {
        const key = $('cab_dbx_key').value.trim();
        if (!/^[a-z0-9]{8,32}$/i.test(key)) { toast.warn('วาง App key จากแท็บ Settings ของ app ใน Dropbox', 'Dropbox'); return; }
        const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
        let challenge = verifier, method = 'plain';
        if (crypto.subtle) {
            challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
            method = 'S256';
        }
        d.appKey = key;
        d.pendingVerifier = verifier;
        saveSettings();
        try { localStorage.setItem('cab_dbx_verifier', verifier); } catch { /* ignore */ }
        // A real link (not window.open after an await) so iOS never blocks it as a pop-up.
        $('cab_dbx_link').href = `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({
            client_id: key, response_type: 'code', token_access_type: 'offline', code_challenge: challenge, code_challenge_method: method,
        })}`;
        $('cab_dbx_code').value = '';
    }));

    $('cab_dbx_confirm').addEventListener('click', run($('cab_dbx_confirm'), async () => {
        const code = $('cab_dbx_code').value.trim();
        if (!code) { toast.warn('วางรหัสที่ Dropbox แสดงหลังกด Allow', 'Dropbox'); return; }
        const res = await fetch(`${DBX_API}/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: d.appKey, code_verifier: pendingVerifier() }),
        });
        if (!res.ok) throw new Error(`ยืนยันรหัสไม่สำเร็จ: ${await dbxError(res)} — กด "เชื่อมต่อ" แล้วขอรหัสใหม่`);
        const j = await res.json();
        if (!j.refresh_token) throw new Error('Dropbox ไม่ได้ให้สิทธิ์แบบค้างไว้ (ไม่มี refresh token)');
        d.refreshToken = j.refresh_token;
        d.pendingVerifier = '';
        try { localStorage.removeItem('cab_dbx_verifier'); } catch { /* ignore */ }
        cloud.token = j.access_token;
        cloud.tokenExp = Date.now() + (Number(j.expires_in) || 14_400) * 1000;
        saveSettings();
        toast.ok('เชื่อมต่อแล้ว กำลังส่ง backup ขึ้นไป', 'Dropbox');
        renderDbxPanel();
        cloudTick({ ignoreGap: true });
    }));

    $('cab_dbx_auto').addEventListener('change', e => { d.auto = e.target.checked; saveSettings(); renderDbxStatus(); if (d.auto) cloudTick(); });
    $('cab_dbx_interval').addEventListener('change', e => {
        const v = Math.round(Number(e.target.value));
        d.intervalMin = Number.isFinite(v) && v >= 1 && v <= 120 ? v : DEFAULTS.dropbox.intervalMin;
        e.target.value = d.intervalMin;
        saveSettings();
    });

    $('cab_dbx_now').addEventListener('click', run($('cab_dbx_now'), async () => {
        await flush();
        await cloudTick({ ignoreGap: true });
        if (cloud.withheld.length) {
            const list = cloud.withheld.map(w => `• ${w.label}: ${w.why}`).join('\n');
            if (confirm(`แชทเหล่านี้ไม่ได้ส่ง เพราะดูเหมือนข้อความหายไป:\n${list}\n\nส่งทับไฟล์บน Dropbox เลยไหม? (Dropbox เก็บประวัติเวอร์ชันเดิมไว้ให้กู้ได้ประมาณ 30 วัน)`)) {
                await cloudTick({ ignoreGap: true, force: true, forceKeys: cloud.withheld.map(w => w.key) });
            }
        }
        if (cloud.error) throw new Error(cloud.error);
        toast.ok('ส่งขึ้น Dropbox แล้ว', 'Dropbox');
    }));

    $('cab_dbx_pull').addEventListener('click', run($('cab_dbx_pull'), async () => {
        if (!confirm('ดึงไฟล์แชททั้งหมดจาก Dropbox กลับมาเป็น snapshot ในเครื่องนี้?\n(แชทบนเซิร์ฟเวอร์ไม่ถูกแก้ — กู้คืนเองได้จากรายการ backup)')) return;
        try {
            const r = await cloudPull(t => { cloud.progress = t; renderDbxStatus(); });
            toast.ok(`ได้ ${r.added} snapshot จาก ${r.total} ไฟล์${r.skipped ? ` · ข้าม ${r.skipped} (มีอยู่แล้วหรืออ่านไม่ได้)` : ''}`, 'ดึงจาก Dropbox');
        } finally {
            cloud.progress = '';
            updateIndicator();
        }
    }));

    $('cab_dbx_disconnect').addEventListener('click', run($('cab_dbx_disconnect'), async () => {
        if (!confirm('ยกเลิกการเชื่อมต่อ Dropbox?\n(ไฟล์ที่ส่งไปแล้วยังอยู่ใน Dropbox)')) return;
        try { await dbxFetch(`${DBX_API}/2/auth/token/revoke`, { method: 'POST' }, false); } catch { /* token may already be dead */ }
        d.refreshToken = '';
        d.pendingVerifier = '';
        cloud.token = '';
        saveSettings();
    }));

    renderDbxPanel();
    setInterval(() => cloudTick(), 30_000);
    if (dbxConnected()) setTimeout(() => cloudTick(), 5000);
}

// ---------------------------------------------------------------- leftovers from Pocky chat vault
//
// Pocky keeps every snapshot uncompressed in its own IndexedDB database, and
// uninstalling the extension does not remove it. These helpers read it one
// record at a time (never getAll — that is what made Safari run out of memory),
// import what matters, and delete it.

const POCKY_DB = 'sillytavern-chat-vault';
const POCKY_LATEST = 'latest-backups';
const POCKY_HISTORY = 'backup-history';

/** true / false, or null when the browser can't list databases. */
async function pockyDbExists() {
    if (typeof indexedDB?.databases !== 'function') return null;
    try { return (await indexedDB.databases()).some(d => d.name === POCKY_DB); } catch { return null; }
}

/** Open Pocky's database without creating it; resolves null when it doesn't exist. */
function openPockyDb() {
    return new Promise((resolve, reject) => {
        let created = false;
        const req = indexedDB.open(POCKY_DB);
        req.onupgradeneeded = () => { created = true; };
        req.onsuccess = () => {
            const d = req.result;
            d.onversionchange = () => d.close();
            if (created) { d.close(); indexedDB.deleteDatabase(POCKY_DB); resolve(null); return; }
            resolve(d);
        };
        req.onerror = () => reject(req.error);
    });
}

function pockyStillInstalled() {
    return !!document.querySelector('[id^="chat_vault_"], [class*="chat-vault-cat"]');
}

async function pockyStats(d) {
    const names = [...d.objectStoreNames];
    const count = async store => (names.includes(store) ? await reqP(d.transaction(store, 'readonly').objectStore(store).count()) : 0);
    return { chats: await count(POCKY_LATEST), history: await count(POCKY_HISTORY) };
}

function pockyToSnapshot(r) {
    const content = String(r?.content ?? '');
    if (!content.trim() || !r?.chatId) return null;
    const d = deriveFromJsonl(content);
    if (!d.count) return null;
    const isGroup = r.entityType === 'group';
    const entity = String(r.entityId ?? '');
    const chatId = String(r.chatId);
    return {
        d,
        jsonl: content,
        meta: {
            key: `${isGroup ? 'g' : 'c'}:${entity}:${chatId}`,
            type: isGroup ? 'group' : 'character',
            chatId,
            groupId: isGroup ? entity : null,
            avatar: isGroup ? null : entity,
            label: String(r.characterName || entity || chatId),
            ts: Date.parse(r.savedAt) || Date.now(),
            hash: d.hash,
            count: d.count,
            preview: d.preview,
            previewName: d.previewName,
            swipe: d.swipe,
            rawSize: content.length,
            reason: 'import',
            source: 'pocky',
            note: r.isCheckpoint && r.checkpointName ? String(r.checkpointName).slice(0, 80) : '',
            shrunk: false,
            mergedSwipes: 0,
            sv: SNAP_VERSION,
        },
    };
}

/** Import each chat's newest Pocky backup plus its named checkpoints. */
async function importFromPocky(progress) {
    const pd = await openPockyDb();
    if (!pd) return { added: 0, skipped: 0 };
    try {
        const names = [...pd.objectStoreNames];
        const keys = [];
        if (names.includes(POCKY_LATEST)) {
            for (const k of await reqP(pd.transaction(POCKY_LATEST, 'readonly').objectStore(POCKY_LATEST).getAllKeys())) keys.push([POCKY_LATEST, k]);
        }
        if (names.includes(POCKY_HISTORY)) {
            // Walk the history one record at a time and remember only the checkpoints' keys.
            const store = pd.transaction(POCKY_HISTORY, 'readonly').objectStore(POCKY_HISTORY);
            await new Promise((res, rej) => {
                let n = 0;
                const cur = store.openCursor();
                cur.onsuccess = () => {
                    const c = cur.result;
                    if (!c) return res();
                    if (c.value?.isCheckpoint) keys.push([POCKY_HISTORY, c.primaryKey]);
                    if (++n % 50 === 0) progress?.(`กำลังค้นหาจุดคืนค่าที่ตั้งชื่อไว้… (${n})`);
                    c.continue();
                };
                cur.onerror = () => rej(cur.error);
            });
        }

        const all = await dbAllMeta();
        for (const m of all) if ((m.sv || 0) < SNAP_VERSION) { try { await upgradeSnapshot(m); } catch { /* ignore */ } }
        const seen = new Set(all.map(m => `${m.key}|${m.hash}`));
        let added = 0, skipped = 0;
        for (let i = 0; i < keys.length; i++) {
            progress?.(`กำลังนำเข้า ${i + 1}/${keys.length}…`);
            const [storeName, k] = keys[i];
            let rec;
            try { rec = await reqP(pd.transaction(storeName, 'readonly').objectStore(storeName).get(k)); } catch { skipped++; continue; }
            let snap;
            try { snap = pockyToSnapshot(rec); } catch { snap = null; }
            rec = null;
            if (!snap) { skipped++; continue; }
            const id = `${snap.meta.key}|${snap.meta.hash}`;
            if (seen.has(id)) {
                // Same content already here; still keep a checkpoint's name.
                if (snap.meta.note) {
                    const same = all.find(m => `${m.key}|${m.hash}` === id);
                    if (same && !same.note) { same.note = snap.meta.note; await dbPutMeta(same); }
                }
                skipped++;
                continue;
            }
            const packed = await pack(snap.jsonl);
            snap.meta.size = packed.enc === 'gzip' ? packed.data.size : snap.jsonl.length;
            const newId = await dbAdd(snap.meta, packed, snap.d.sigs);
            all.push({ ...snap.meta, id: newId });
            seen.add(id);
            added++;
        }
        return { added, skipped };
    } finally {
        pd.close();
    }
}

function deletePockyDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(POCKY_DB);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => toast.warn('Pocky ยังเปิดฐานข้อมูลอยู่ในแท็บอื่น — ปิดหรือรีเฟรชแท็บนั้นแล้วการลบจะทำต่อเอง');
    });
}

async function storageUsed() {
    try { return (await navigator.storage?.estimate?.())?.usage ?? null; } catch { return null; }
}

async function refreshPockyPanel() {
    const box = document.getElementById('cab_pocky');
    const info = document.getElementById('cab_pocky_info');
    if (!box || !info) return;
    let exists = await pockyDbExists();
    let stats = null;
    if (exists !== false) {
        try {
            const pd = await openPockyDb();
            if (pd) { stats = await pockyStats(pd); pd.close(); exists = true; } else exists = false;
        } catch (e) { console.warn(LOG, e); }
    }
    box.hidden = !exists;
    if (!exists) return;
    const used = await storageUsed();
    info.textContent = `พบฐานข้อมูลของ Pocky: ${stats?.chats ?? '?'} แชท, ประวัติ ${stats?.history ?? '?'} snapshot (ไม่บีบอัด)`
        + (used != null ? ` · เว็บไซต์นี้ใช้พื้นที่เบราว์เซอร์รวม ${fmtBytes(used)}` : '')
        + (pockyStillInstalled() ? ' · ⚠ Pocky ยังติดตั้งอยู่ ถอนการติดตั้งก่อน ไม่อย่างนั้นมันจะสร้างข้อมูลใหม่ขึ้นมาอีก' : '');
}

function wirePockyPanel() {
    const imp = document.getElementById('cab_pocky_import');
    const del = document.getElementById('cab_pocky_delete');
    const info = document.getElementById('cab_pocky_info');
    if (!imp || !del) return;
    let busy = false;
    const run = fn => async () => {
        if (busy) return;
        busy = true;
        imp.classList.add('disabled'); del.classList.add('disabled');
        try { await fn(); } catch (e) { console.error(LOG, e); toast.err(String(e?.message ?? e)); }
        busy = false;
        imp.classList.remove('disabled'); del.classList.remove('disabled');
    };
    imp.addEventListener('click', run(async () => {
        if (!confirm('นำเข้า backup ล่าสุดของแต่ละแชท และจุดคืนค่าที่ตั้งชื่อไว้ จาก Pocky?\n(ประวัติอัตโนมัติอื่น ๆ จะไม่นำเข้า)')) return;
        await flush();
        const { added, skipped } = await importFromPocky(t => { info.textContent = t; });
        toast.ok(`นำเข้า ${added} snapshot${skipped ? ` · ข้าม ${skipped} (ซ้ำหรือว่าง)` : ''}`, 'นำเข้าจาก Pocky');
        await refreshPockyPanel();
        updateIndicator();
    }));
    del.addEventListener('click', run(async () => {
        if (pockyStillInstalled() && !confirm('Pocky ยังติดตั้งอยู่ ถ้าลบตอนนี้ มันจะเริ่มเก็บข้อมูลใหม่อีก ควรถอนการติดตั้ง Pocky ก่อน\n\nลบต่อเลยไหม?')) return;
        if (!confirm('ลบฐานข้อมูลของ Pocky ทั้งหมดในเบราว์เซอร์นี้?\n\nสิ่งที่ยังไม่ได้นำเข้าจะหายถาวร — backup ของ Chat Auto Backup ไม่ได้รับผลกระทบ')) return;
        const before = await storageUsed();
        info.textContent = 'กำลังลบ…';
        await deletePockyDb();
        const after = await storageUsed();
        toast.ok(before != null && after != null
            ? `พื้นที่เบราว์เซอร์ ${fmtBytes(before)} → ${fmtBytes(after)} (Safari อาจอัปเดตตัวเลขช้า)`
            : 'ลบแล้ว', 'ลบฐานข้อมูล Pocky แล้ว');
        await refreshPockyPanel();
    }));
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
    wireDbxPanel();
    wirePockyPanel();
    refreshPockyPanel().catch(e => console.warn(LOG, e));
    console.log(LOG, 'loaded');
}

// expose for debugging / tests
globalThis.ChatAutoBackup = { captureNow, store, flush, schedule, dbAllMeta, dbMetaByKey, snapshotText, exportAll, importFile, restoreAsNewChat, openBrowser, checkLoadedChat, backupNow, settings, updateIndicator, cleanText, describeChanges, deriveFromJsonl, cloudTick, cloudPull };

if (typeof jQuery === 'function') jQuery(init); else init();
