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
const VERSION = '2.3.0'; // keep in sync with manifest.json
const BASE_URL = new URL('.', import.meta.url);

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
    // syncAuto: write chats that are newer in Dropbox (from another device or ST server) back into this server.
    // syncSince: when sync was first used on this server — older Dropbox-only chats are offered, not created.
    // syncDeletes: once sync is in use, deleting a chat here also removes it from Dropbox and the other devices.
    dropbox: Object.freeze({ appKey: '', refreshToken: '', pendingVerifier: '', auto: true, intervalMin: 2, indicatorStyle: 'full', syncAuto: false, syncSince: 0, syncDeletes: true, syncPresets: true, syncCards: true, syncLorebooks: true, syncPersonas: true, syncQuickReplies: true, syncRegex: true }), // indicatorStyle: 'full' | 'short' | 'off'
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
    info: (m, t, o) => globalThis.toastr?.info(m, t ?? 'Chat Backup', o),
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
    // Same header SillyTavern writes, so chat metadata (extension state, variables,
    // author's note…) is backed up and synced along with the messages.
    const h = info.type === 'character'
        ? JSON.stringify({
            user_name: c.name1,
            character_name: c.name2,
            create_date: messages[0]?.send_date ?? stableCreateDate(info.key),
            chat_metadata: c.chatMetadata ?? c.chat_metadata ?? {},
        })
        : JSON.stringify({ chat_metadata: c.chatMetadata ?? c.chat_metadata ?? {}, user_name: 'unused', character_name: 'unused' });
    lines.push(h);
    head = hash(h);
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

    const peak = existing.filter(x => !x.acked).reduce((m, x) => Math.max(m, x.count), 0);
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
    const list = (await dbMetaByKey(info.key)).filter(m => !m.acked);
    if (!list.length) return;
    const peak = list.reduce((a, b) => (b.count > a.count ? b : a));

    if (s.shrinkWarn && peak.count >= 6 && count < peak.count * 0.6) {
        toast.warn(
            `แชทนี้โหลดมาได้ ${count} ข้อความ แต่ backup มี ${peak.count} ข้อความ (${fmtTime(peak.ts)})<br>แตะเพื่อดูว่าควรทำอะไรต่อ`,
            '⚠ แชทอาจหาย/ไม่ครบ',
            { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: () => showAttention() },
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

/** Open the one modal (replacing any other) sized to the visible viewport. Returns { wrap, close }. */
function openModal(innerHtml) {
    const old = document.getElementById('cab_modal');
    if (old) (old._cabClose ?? (() => old.remove()))();

    const wrap = document.createElement('div');
    wrap.id = 'cab_modal';
    wrap.innerHTML = innerHtml;
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
    wrap.querySelector('.cab_close')?.addEventListener('click', close);
    return { wrap, close };
}

async function openBrowser(key) {
    await flush();
    browserKey = key === undefined ? (currentChatInfo()?.key ?? null) : key;
    const { wrap } = openModal(`
        <div class="cab_dialog">
            <div class="cab_head">
                <b>Chat Backups</b>
                <select id="cab_scope" class="text_pole"></select>
                <div class="cab_close menu_button fa-solid fa-xmark" title="ปิด"></div>
            </div>
            <div id="cab_list" class="cab_list"><i>กำลังโหลด…</i></div>
            <div class="cab_foot" id="cab_foot"></div>
        </div>`);
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
                        ${m.cloud && m.source !== 'dropbox' ? `<span class="cab_tag cab_db_tag" title="ส่งขึ้น Dropbox แล้วเมื่อ ${fmtTime(m.cloud)}">Dropbox</span>` : ''}
                        ${m.reason === 'manual' ? '<span class="cab_tag">manual</span>' : ''}
                        ${m.reason === 'sync' ? (m.source === 'before-delete'
                            ? '<span class="cab_tag" title="ฉบับในเครื่องก่อนถูกลบตามอีกเครื่อง">ก่อนลบ</span>'
                            : m.source === 'before-sync'
                            ? '<span class="cab_tag" title="ฉบับในเครื่องก่อนถูกเขียนทับด้วยฉบับจาก Dropbox ตอนซิงค์">ก่อนซิงค์</span>'
                            : '<span class="cab_tag" title="ฉบับที่ซิงค์มาจาก Dropbox แล้วเขียนลงเซิร์ฟเวอร์นี้">ซิงค์จาก Dropbox</span>') : ''}
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
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onIndicatorTap(el); } });
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
            if (e.type === 'pointerup') onIndicatorTap(el);
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
    const peak = list.filter(m => !m.acked).reduce((a, b) => (!a || b.count > a.count ? b : a), null);
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
    const parts = [document.createTextNode(`${label} ${num}`)];
    const db = dropboxStateFor(info.key, list);
    const dbStyle = dbxSettings().indicatorStyle;
    if (db && dbStyle !== 'off') {
        const span = document.createElement('span');
        span.className = 'cab_db';
        span.dataset.db = db.state;
        span.textContent = dbStyle === 'short' ? ` ${db.short}` : ` · ${db.text}`;
        parts.push(span);
        tip += `\n${db.tip}`;
    }
    const needsHelp = state === 'attention' || db?.state === 'held';
    el.dataset.help = needsHelp ? '1' : '';
    if (needsHelp) tip += '\nแตะเพื่อดูว่าเกิดอะไรขึ้น และทำอะไรต่อได้บ้าง';
    el.replaceChildren(...parts);
    el.title = `${tip}\n${needsHelp ? '' : 'คลิกเพื่อดู/กู้คืน · '}ลากเพื่อย้ายตำแหน่ง`;
    el.hidden = false;
    placeIndicator(el); // text width may have changed
}

/**
 * What Dropbox holds for this chat, for the status button.
 *   DB #20      Dropbox has the newest backup (messages #0–#20)
 *   DB #18...   a newer backup is waiting to be sent; Dropbox has up to #18
 *   DB! #18     not sent: looked truncated, or the last attempt failed
 * Short style shows only ✓ / … / ✗.
 */
function dropboxStateFor(key, list) {
    if (!dbxConnected()) return null;
    const newest = list[0];
    const fromMeta = list.find(m => m.cloud);
    const stored = cloudRecord(key);
    const up = [fromMeta && { ts: fromMeta.cloud, count: fromMeta.count }, stored]
        .filter(Boolean).sort((a, b) => b.ts - a.ts)[0];
    const num = up ? `#${up.count - 1}` : '#–';
    const when = up ? `ส่งถึงข้อความ ${num} เมื่อ ${fmtTime(up.ts)}` : 'ยังไม่เคยส่งแชทนี้';
    const held = cloud.withheld.find(w => w.key === key);
    if (held) return { state: 'held', short: '✗', text: `DB! ${num}`, tip: `Dropbox: ไม่ได้ส่งเวอร์ชันล่าสุด — ${held.why} (กด "ส่งตอนนี้" ในแผงตั้งค่าถ้าตั้งใจ) · ${when}` };
    if (cloud.error && newest && !newest.cloud) return { state: 'held', short: '✗', text: `DB! ${num}`, tip: `Dropbox: ส่งไม่สำเร็จ — ${cloud.error} (จะลองใหม่เอง) · ${when}` };
    if (newest && !newest.cloud) {
        const why = dbxSettings().auto === false ? 'ปิดการส่งอัตโนมัติอยู่' : 'รอส่ง';
        return { state: 'behind', short: '…', text: `DB ${num}...`, tip: `Dropbox: ${why} — ${when}` };
    }
    return { state: 'ok', short: '✓', text: `DB ${num}`, tip: `Dropbox: ${when}` };
}

// Last known Dropbox copy per chat. Kept outside the snapshot list because the
// uploaded snapshot itself may later be merged or pruned away.
function cloudRecords() {
    try { return JSON.parse(localStorage.getItem('cab_cloud_state') || '{}') || {}; } catch { return {}; }
}
function cloudRecord(key) { return cloudRecords()[key] || null; }
function setCloudRecord(key, rec) {
    try {
        const all = cloudRecords();
        if (all[key] && all[key].ts > rec.ts) return;
        all[key] = rec;
        localStorage.setItem('cab_cloud_state', JSON.stringify(all));
    } catch { /* storage unavailable: meta.cloud still covers the common case */ }
}

// ---------------------------------------------------------------- "what happened?" dialog

function onIndicatorTap(el) {
    if (el.dataset.help) showAttention(); else openBrowser();
}

/** Mark every snapshot of this chat as "not the reference any more" (user trimmed the chat on purpose). */
async function ackShrink(key) {
    const list = await dbMetaByKey(key);
    const d = await db();
    const tx = d.transaction(META, 'readwrite');
    for (const m of list) if (!m.acked) tx.objectStore(META).put({ ...m, acked: true });
    await txDone(tx);
    lastError = lastError?.key === key ? null : lastError;
}

/**
 * Explain what is wrong with the open chat's backup, and offer the ways forward.
 * Problems are listed most urgent first; each carries its own buttons.
 */
async function showAttention() {
    await flush();
    const info = currentChatInfo();
    if (!info) return openBrowser();
    const c = ctx();
    const count = Array.isArray(c.chat) ? c.chat.length : 0;
    const list = await dbMetaByKey(info.key);
    const newest = list[0];
    const peak = list.filter(m => !m.acked).reduce((a, b) => (!a || b.count > a.count ? b : a), null);
    const held = cloud.withheld.find(w => w.key === info.key);
    const cloudErr = dbxConnected() && cloud.error && newest && !newest.cloud ? cloud.error : '';

    const problems = [];
    if (lastError && lastError.key === info.key) {
        problems.push({
            title: 'บันทึก backup ลงเครื่องไม่สำเร็จ',
            body: `<p>ข้อความจาก browser: <code>${escapeHtml(lastError.message)}</code></p>
                <p>มักเกิดจากพื้นที่ในเครื่องเต็ม หรือ browser ไม่อนุญาตให้เก็บข้อมูล (เช่น โหมดส่วนตัว) แชทบนเซิร์ฟเวอร์ไม่ได้รับผลกระทบ แต่ช่วงนี้ไม่มีสำเนาใหม่ในเครื่อง</p>`,
            actions: [
                { label: 'ลองบันทึกอีกครั้ง', primary: true, run: async () => { await backupNow(); } },
                { label: 'Export backup ทั้งหมดเก็บไว้', run: () => exportAll() },
            ],
        });
    }
    if (peak && peak.count >= 6 && count < peak.count * 0.6) {
        const canRestore = peak.type === 'character';
        problems.push({
            title: `แชทบนจอสั้นกว่า backup (${count} จาก ${peak.count} ข้อความ)`,
            body: `<p>แชทนี้เคยมีถึงข้อความ #${peak.count - 1} (backup เมื่อ ${fmtTime(peak.ts)}) แต่ตอนนี้โหลดมาได้แค่ ${count} ข้อความ</p>
                <p><b>ถ้าไม่ได้ลบเอง</b> — เซิร์ฟเวอร์น่าจะส่งแชทมาไม่ครบ หรือไฟล์แชทเสีย ลองโหลดใหม่ก่อน ถ้ายังสั้นอยู่ให้กู้คืนจาก backup (จะได้เป็นไฟล์แชทใหม่ ไฟล์เดิมไม่ถูกแตะ)</p>
                <p><b>ถ้าลบข้อความเองโดยตั้งใจ</b> — กด "ตั้งใจลบเอง" แล้วแชทนี้จะเป็นฉบับหลักต่อจากนี้ backup เดิมยังอยู่ในรายการเผื่อเปลี่ยนใจ</p>`,
            actions: [
                { label: 'โหลดแชทใหม่จากเซิร์ฟเวอร์', run: async () => {
                    if (typeof c.reloadCurrentChat !== 'function') throw new Error('ST รุ่นนี้ไม่มีคำสั่งโหลดแชทใหม่ — ลองเปิดแชทอื่นแล้วกลับมา');
                    await c.reloadCurrentChat();
                    await new Promise(r => setTimeout(r, 500));
                    const now = Array.isArray(ctx().chat) ? ctx().chat.length : 0;
                    (now >= peak.count * 0.6 ? toast.ok : toast.warn)(`โหลดใหม่แล้ว ได้ ${now} ข้อความ`, 'Chat Backup');
                } },
                canRestore && { label: `กู้คืนฉบับ ${peak.count} ข้อความ`, primary: true, run: async () => {
                    if (!confirm(`กู้คืน backup ${fmtTime(peak.ts)} (${peak.count} ข้อความ) เป็นไฟล์แชทใหม่?\nไฟล์แชทปัจจุบันจะไม่ถูกแก้ไข`)) return false;
                    await restoreAsNewChat(peak);
                } },
                { label: 'เลือก backup เอง', run: () => { openBrowser(info.key); return 'keep'; } },
                { label: 'ตั้งใจลบเอง', run: async () => {
                    if (!confirm(`ยืนยันว่าลบข้อความเองโดยตั้งใจ?\nแชท ${count} ข้อความนี้จะเป็นฉบับหลัก${dbxConnected() ? ' และจะส่งทับไฟล์บน Dropbox' : ''} — backup เดิมยังอยู่ในรายการ`)) return false;
                    await ackShrink(info.key);
                    if (dbxConnected()) await cloudTick({ ignoreGap: true, force: true, forceKeys: [info.key] });
                    toast.ok('ตั้งแชทนี้เป็นฉบับหลักแล้ว', 'Chat Backup');
                } },
            ],
        });
    } else if (held?.kind === 'diverged') {
        problems.push({
            title: 'แชทนี้ถูกแก้จากอีกเครื่อง',
            body: `<p>ไฟล์บน Dropbox เปลี่ยนไปหลังจากที่เครื่องนี้ซิงค์ครั้งล่าสุด (เช่น เล่นต่อใน ST อีกที่หรือ TauriTavern) ระบบจึงยังไม่ส่งแชทในเครื่องทับ</p>
                <p><b>ซิงค์แชทนี้</b> — ถ้าอีกเครื่องแค่คุยต่อ จะดึงข้อความใหม่มาใส่แชทนี้ให้เลย ถ้าแก้ทั้งสองฝั่ง จะให้เลือกว่าใช้ฉบับไหน</p>`,
            actions: [
                { label: 'ซิงค์แชทนี้', primary: true, run: async () => { await syncNow({ only: info }); } },
            ],
        });
    } else if (held) {
        problems.push({
            title: 'ยังไม่ได้ส่งแชทนี้ขึ้น Dropbox',
            body: `<p>เหตุผล: ${escapeHtml(held.why)}</p>
                <p>ไฟล์บน Dropbox มีข้อความมากกว่าที่อยู่ในเครื่อง ระบบจึงไม่ส่งทับ กันแชทที่โหลดมาไม่ครบไปลบของดี</p>
                <p><b>ถ้าแชทในเครื่องหายไปบางส่วน</b> — ดึงฉบับจาก Dropbox มาแล้วกู้คืน<br><b>ถ้าลบข้อความเองโดยตั้งใจ</b> — ส่งทับได้เลย (Dropbox เก็บเวอร์ชันเก่าไว้ให้อีกประมาณ 30 วัน)</p>`,
            actions: [
                { label: 'ดึงฉบับจาก Dropbox', primary: true, run: async () => {
                    const r = await cloudPull(null, { onlyKey: info.key });
                    toast.ok(r.added ? 'ได้ฉบับจาก Dropbox แล้ว — เลือกกู้คืนจากรายการ' : 'ฉบับบน Dropbox มีอยู่ในรายการแล้ว', 'Dropbox');
                    openBrowser(info.key);
                    return 'keep';
                } },
                { label: 'ส่งทับ Dropbox', run: async () => {
                    if (!confirm('ส่งแชทในเครื่องทับไฟล์บน Dropbox?')) return false;
                    await ackShrink(info.key);
                    await cloudTick({ ignoreGap: true, force: true, forceKeys: [info.key] });
                    if (cloud.error) throw new Error(cloud.error);
                    toast.ok('ส่งทับแล้ว', 'Dropbox');
                } },
            ],
        });
    }
    if (cloudErr) {
        const needsReconnect = !dbxConnected() || /เชื่อมต่อใหม่/.test(cloudErr);
        problems.push({
            title: 'ส่งขึ้น Dropbox ไม่สำเร็จ',
            body: `<p>ข้อความจาก Dropbox: <code>${escapeHtml(cloudErr)}</code></p>
                <p>${needsReconnect ? 'สิทธิ์ที่ให้ไว้ใช้ไม่ได้แล้ว ต้องเชื่อมต่อใหม่ในแผงตั้งค่า Extensions → Chat Auto Backup' : 'ส่วนใหญ่เป็นเพราะเน็ตหลุดชั่วคราว ระบบจะลองใหม่เองทุกครึ่งนาที backup ในเครื่องยังปกติ'}</p>`,
            actions: needsReconnect ? [] : [
                { label: 'ลองส่งอีกครั้ง', primary: true, run: async () => {
                    cloud.backoffUntil = 0;
                    await cloudTick({ ignoreGap: true });
                    if (cloud.error) throw new Error(cloud.error);
                    toast.ok('ส่งแล้ว', 'Dropbox');
                } },
            ],
        });
    }
    if (!problems.length) return openBrowser(info.key);

    const { wrap, close } = openModal(`
        <div class="cab_dialog cab_explain">
            <div class="cab_head">
                <b>${escapeHtml(info.label)} — เกิดอะไรขึ้น</b>
                <div class="cab_close menu_button fa-solid fa-xmark" title="ปิด"></div>
            </div>
            <div class="cab_list">${problems.map((p, i) => `
                <section class="cab_problem">
                    <h4>${escapeHtml(p.title)}</h4>
                    ${p.body}
                    <div class="cab_buttons">${p.actions.filter(Boolean).map((a, j) =>
                        `<div class="menu_button${a.primary ? ' cab_primary' : ''}" data-p="${i}" data-a="${j}">${escapeHtml(a.label)}</div>`).join('')}</div>
                </section>`).join('')}
            </div>
            <div class="cab_foot"><span class="cab_linkish" data-browse>ดูรายการ backup ทั้งหมดของแชทนี้</span></div>
        </div>`);
    wrap.querySelector('[data-browse]').addEventListener('click', () => openBrowser(info.key));
    let busy = false;
    wrap.querySelectorAll('.cab_problem .menu_button').forEach(btn => {
        const action = problems[btn.dataset.p].actions.filter(Boolean)[btn.dataset.a];
        btn.addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            btn.classList.add('disabled');
            let result;
            try { result = await action.run(); } catch (e) { console.error(LOG, e); toast.err(String(e?.message ?? e)); result = false; }
            busy = false;
            btn.classList.remove('disabled');
            if (result === false || result === 'keep') return;
            if (document.getElementById('cab_modal') === wrap) close();
            updateIndicator();
        });
    });
}

// ---------------------------------------------------------------- settings panel

function renderSettings() {
    const s = settings();
    const html = `
    <div id="cab_settings" class="cab_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Auto Backup <small class="cab_version">v${VERSION}</small></b>
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
                        <label for="cab_dbx_style">สถานะ Dropbox บนปุ่ม</label>
                        <select id="cab_dbx_style" class="text_pole">
                            <option value="full">แบบเต็ม · DB #20</option>
                            <option value="short">แบบย่อ ✓ … ✗</option>
                            <option value="off">ไม่แสดง</option>
                        </select>
                    </div>
                    <div class="cab_grid">
                        <label for="cab_dbx_interval" title="ถ้าเปิดซิงค์ระหว่างเครื่องไว้ จะส่งทันทีหลังแชทเปลี่ยนเสมอ ไม่ใช้ค่านี้">ส่งแต่ละแชทไม่ถี่กว่าทุก (นาที)</label>
                        <input type="number" id="cab_dbx_interval" class="text_pole" min="1" max="120" step="1">
                    </div>
                    <div class="cab_buttons">
                        <div id="cab_dbx_now" class="menu_button" title="ส่งทุกแชทที่ยังไม่ได้ส่ง ตอนนี้เลย">ส่งตอนนี้</div>
                        <div id="cab_dbx_pull" class="menu_button" title="ดาวน์โหลดไฟล์แชทจาก Dropbox กลับมาเป็น snapshot (ไม่เขียนทับแชทบนเซิร์ฟเวอร์)">ดึง backup จาก Dropbox</div>
                        <div id="cab_dbx_disconnect" class="menu_button">ยกเลิกการเชื่อมต่อ</div>
                    </div>
                    <hr class="sysHR">
                    <b>ซิงค์แชทระหว่างเครื่อง</b>
                    <small class="cab_note">ใช้เมื่อเล่นสลับหลายที่ เช่น ST บนโฮสกับ TauriTavern: เชื่อมต่อ Dropbox app เดียวกันทุกที่ แล้วแชทที่คุยต่อจากอีกที่จะถูกเขียนลงแชทในเครื่องนี้ ถ้าแก้ทั้งสองฝั่งจะให้เลือกเอง ตัวละครและกลุ่มต้องมีอยู่แล้วทั้งสองที่ (ชื่อไฟล์ avatar ตรงกัน)</small>
                    <label class="checkbox_label" title="ตรวจทุก 3 นาที และทุกครั้งที่กลับเข้าแอป — เขียนลงเครื่องเฉพาะกรณีที่ปลอดภัย (อีกเครื่องคุยต่อ หรือในเครื่องนี้ไม่ได้แก้) · แชทที่เปลี่ยนในเครื่องนี้จะส่งขึ้นทันทีภายในไม่กี่วินาที"><input type="checkbox" id="cab_sync_auto"> ดึงแชทที่ใหม่กว่าจาก Dropbox อัตโนมัติ</label>
                    <label class="checkbox_label" title="ลบแชทใน ST เครื่องนี้แล้ว ไฟล์ใน Dropbox จะถูกลบด้วย และเครื่องอื่นจะลบตามตอนซิงค์ (ถ้าเครื่องนั้นไม่ได้แก้แชทนั้นหลังซิงค์ ถ้าแก้จะถามก่อน) — ใช้เมื่อเคยซิงค์ที่นี่แล้วเท่านั้น"><input type="checkbox" id="cab_sync_deletes"> ลบแล้วลบใน Dropbox และเครื่องอื่นด้วย (แชท, Quick Reply, regex)</label>
                    <label class="checkbox_label" title="preset ทุกประเภทที่ ST จัดการ (Chat/Text Completion, Instruct, Context, System Prompt, Reasoning…) ถ้า preset ที่เลือกใช้อยู่ถูกอัปเดตจากอีกเครื่อง จะโหลดค่าใหม่ให้"><input type="checkbox" id="cab_sync_presets"> ซิงค์ preset ด้วย</label>
                    <label class="checkbox_label" title="lorebook (World Info) ที่เป็นไฟล์แยก ถ้าเปิด lorebook นั้นค้างไว้ในหน้าแก้ จะโหลดฉบับใหม่ให้"><input type="checkbox" id="cab_sync_worlds"> ซิงค์ lorebook ด้วย</label>
                    <label class="checkbox_label" title="ชื่อ คำอธิบาย ตำแหน่ง/ความลึก lorebook ที่ผูกไว้ การผูกกับตัวละคร และรูป persona (การเปลี่ยนแค่รูปจะไปพร้อมการแก้ครั้งถัดไป)"><input type="checkbox" id="cab_sync_personas"> ซิงค์ persona ด้วย</label>
                    <label class="checkbox_label" title="ชุด Quick Reply ทั้งหมด ชุดที่อัปเดตจากอีกเครื่องจะใช้ได้หลังโหลดหน้าใหม่ (จะขึ้นแจ้งเตือนให้แตะ)"><input type="checkbox" id="cab_sync_qr"> ซิงค์ Quick Reply ด้วย</label>
                    <label class="checkbox_label" title="regex แบบ global (regex ที่ผูกกับการ์ดหรือ preset ไปพร้อมการ์ด/preset อยู่แล้ว) ใช้ได้ทันที"><input type="checkbox" id="cab_sync_regex"> ซิงค์ regex ด้วย</label>
                    <label class="checkbox_label" title="การ์ดตัวละคร (ข้อมูลการ์ด รูป lorebook ที่ฝังในการ์ด) ชื่อไฟล์ avatar เหมือนกันทุกเครื่อง แชทจึงจับคู่กันได้ — ครั้งแรกต้องส่งการ์ดทุกใบขึ้น Dropbox อาจใช้เวลาและเน็ต"><input type="checkbox" id="cab_sync_cards"> ซิงค์การ์ดตัวละครด้วย</label>
                    <small id="cab_sync_status" class="cab_note"></small>
                    <div class="cab_buttons">
                        <div id="cab_sync_now" class="menu_button" title="เทียบทุกแชทบน Dropbox กับเซิร์ฟเวอร์นี้ แล้วอัปเดตแชทที่อีกเครื่องคุยต่อ">ซิงค์ตอนนี้</div>
                        <div id="cab_sync_decide" class="menu_button" hidden>เลือกฉบับ</div>
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
    if (E.CHAT_DELETED) eventSource.on(E.CHAT_DELETED, name => { onChatDeleted('character', name); });
    if (E.GROUP_CHAT_DELETED) eventSource.on(E.GROUP_CHAT_DELETED, name => { onChatDeleted('group', name); });

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
    // Syncing between devices: closing the tab before the latest change reached Dropbox
    // would leave the other device behind, so let the browser ask first (desktop only —
    // mobile browsers never show this prompt, but still get the upload started here).
    window.addEventListener('beforeunload', e => {
        if (!dbxConnected() || !dbxSettings().syncAuto || !cloudUnsent()) return;
        flush().then(() => cloudTick({ fast: true })).catch(() => { /* next tick */ });
        e.preventDefault();
        e.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { checkForNewVersion(); syncSoon(); }
        if (document.visibilityState !== 'hidden') return;
        // Leaving the app: write what's pending (including a change with no message event,
        // e.g. an extension updating chat metadata), then push it off the device if we can.
        if (settings().enabled) {
            const snap = captureNow();
            if (snap && lastHashByKey.get(snap.info.key) !== snap.hash) {
                if (pending && pending.info.key !== snap.info.key) flush();
                pending = snap;
            }
        }
        flush().then(() => cloudTick({ ignoreGap: true })).catch(() => { /* next tick */ });
    });
}

// ---------------------------------------------------------------- stale-code check
//
// SillyTavern loads extension files by a fixed URL, and a home-screen web app
// on iOS rarely does a real reload, so after "Update" the old code can keep
// running for a long time. Compare with the manifest on the server; if it is
// newer, refresh the cached files explicitly and reload.

let versionCheckedAt = 0;
let versionToastShown = false;

async function checkForNewVersion() {
    if (versionToastShown || Date.now() - versionCheckedAt < 10 * 60_000) return;
    versionCheckedAt = Date.now();
    let remote;
    try {
        const res = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        if (!res.ok) return;
        remote = String((await res.json())?.version ?? '');
    } catch { return; }
    if (!remote || remote === VERSION) return;
    versionToastShown = true;
    toast.info(`ติดตั้ง v${remote} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION} อยู่<br>แตะที่นี่เพื่อโหลดเวอร์ชันใหม่`, 'Chat Auto Backup', {
        timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false,
        onclick: () => reloadWithFreshFiles(),
    });
}

async function reloadWithFreshFiles() {
    try {
        await flush();
        // cache: 'reload' fetches from the server and overwrites the browser's cached copy,
        // so the page reload below picks up the new files.
        await Promise.all(['index.js', 'style.css', 'manifest.json'].map(f =>
            fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
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
/** Marker left when a chat is deleted, so the other devices delete it too: /deleted/<type>/<entity>/<chat>.json */
function dbxTombPathOf(m) {
    return `/deleted${dbxPathOf(m).replace(/\.jsonl$/, '.json')}`;
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

/**
 * mode: 'overwrite' (default) · 'add' (fail if the file exists) · { update: rev } (fail if the
 * file is no longer at that revision — someone else uploaded meanwhile). Failures read "…conflict…".
 */
async function dbxUpload(path, blob, ts, mode = 'overwrite') {
    const m = mode && typeof mode === 'object' ? { '.tag': 'update', update: mode.update } : mode;
    const arg = { path, mode: m, mute: true, autorename: false, client_modified: new Date(ts).toISOString().replace(/\.\d+Z$/, 'Z') };
    const res = await dbxFetch(`${DBX_CONTENT}/2/files/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': dbxArg(arg) },
        body: blob,
    });
    if (!res.ok) throw new Error(await dbxError(res));
    return await res.json();
}

async function dbxDownloadBlob(path) {
    const res = await dbxFetch(`${DBX_CONTENT}/2/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': dbxArg({ path }) } });
    if (!res.ok) throw new Error(await dbxError(res));
    return await res.blob();
}

async function dbxDownloadText(path) {
    const res = await dbxFetch(`${DBX_CONTENT}/2/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': dbxArg({ path }) } });
    if (!res.ok) throw new Error(await dbxError(res));
    return await res.text();
}

/** Upload chats whose newest snapshot isn't in Dropbox yet. */
/**
 * ignoreGap: send now, even with automatic upload off (a manual "send").
 * fast: skip only the per-chat pacing — used while syncing between devices, so the
 * other side never waits on a chat this one already has.
 */
async function cloudTick({ ignoreGap = false, force = false, forceKeys = null, fast = false } = {}) {
    const d = dbxSettings();
    if (!dbxConnected()) return;
    if (!force && !ignoreGap && d.auto === false) return;
    if (cloud.running) { cloud.again = { ignoreGap: ignoreGap || cloud.again?.ignoreGap, fast: fast || cloud.again?.fast }; return; }
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
            if (!ignoreGap && !fast && Date.now() - (cloud.lastAt.get(key) || 0) < gap) continue;
            due.push({ m, forced });
        }
        cloud.pending = due.length;
        renderDbxStatus();
        for (const { m, forced } of due) {
            const hold = (why, kind = 'bigger') => { withheld.push({ key: m.key, label: m.label, why, kind }); cloud.pending--; };
            let text = await snapshotText(m.id);
            if (text.includes('"tt_swipe_cold"')) {
                // TauriTavern "load historical swipes on demand": the chat in memory lacks older
                // swipes, so send the server's full file instead of the snapshot.
                const t = syncTargetOf(m.type, m.type === 'group' ? m.groupId : m.avatar, m.chatId);
                const arr = t.missing ? [] : await serverChat(t);
                if (chatState(arr).count < m.count) { hold('อ่านแชทฉบับเต็มจากเซิร์ฟเวอร์ไม่ได้'); continue; }
                text = toJsonl(arr);
            }
            const blob = new Blob([text], { type: 'application/octet-stream' });
            const path = dbxPathOf(m);
            const mine = chatState(parseJsonl(text));
            let mode = 'overwrite';
            if (!forced) {
                const remote = await dbxMetadata(path);
                const markSent = async () => {
                    m.cloud = Date.now();
                    await dbMarkCloud(m.id, m.cloud);
                    setCloudRecord(m.key, { ts: m.cloud, count: m.count });
                    cloud.pending--;
                };
                if (remote) {
                    const known = syncBase(m.key);
                    const base = known?.skipped || known?.deleted ? null : known; // "skip" in the sync dialog is no agreement
                    // Same messages as Dropbox already has (only the chat header differs, e.g.
                    // right after a sync rewrote this chat): nothing worth sending.
                    if (base && base.rev === remote.rev && base.sig === mine.sig && base.meta !== undefined && metaEq(base.meta, mine.meta)) { await markSent(); continue; }
                    if (!base || base.rev !== remote.rev) {
                        // Dropbox changed since this browser last matched it (another device or ST
                        // server uploaded). Only send ours if it grew out of what is there.
                        const rText = await dbxDownloadText(`rev:${remote.rev}`);
                        const r = chatState(parseJsonl(rText));
                        if (r.sig === mine.sig && metaEq(r.meta, mine.meta)) {
                            setSyncBase(m.key, { rev: remote.rev, sig: mine.sig, meta: mine.meta ?? r.meta });
                            await markSent();
                            continue;
                        }
                        const rHash = jsonlHash(rText);
                        const ownOldCopy = !!rHash && all.some(x => x.key === m.key && x.hash === rHash);
                        if (r.sig === mine.sig) {
                            // Same messages, different chat metadata: send ours only if Dropbox's
                            // metadata hasn't changed since we last matched; otherwise the sync merges.
                            if (!ownOldCopy && !(base && base.meta === r.meta)) {
                                hold('Dropbox มีฉบับที่แก้จากเครื่องอื่น — ต้องซิงค์ก่อน', 'diverged');
                                continue;
                            }
                        } else {
                            // Ours is still what we last matched, so Dropbox holds a newer change
                            // (maybe deleted messages): sending ours would undo it.
                            if (base && base.sig === mine.sig) {
                                hold('Dropbox มีฉบับที่แก้จากเครื่องอื่น — ต้องซิงค์ก่อน', 'diverged');
                                continue;
                            }
                            // Messages there unchanged since we last matched (only its header moved on)?
                            const unchanged = base && base.sig === r.sig;
                            if (!unchanged && !ownOldCopy && !isAncestor(r, mine)) {
                                hold('Dropbox มีฉบับที่แก้จากเครื่องอื่น — ต้องซิงค์ก่อน', 'diverged');
                                continue;
                            }
                        }
                    }
                    // Never let a chat that came back truncated overwrite a fuller copy in Dropbox.
                    if (remote.size > 20_000 && blob.size < remote.size * 0.6) {
                        hold(`ไฟล์บน Dropbox ใหญ่กว่ามาก (${fmtBytes(remote.size)} → ${fmtBytes(blob.size)})`);
                        continue;
                    }
                    mode = { update: remote.rev };
                } else {
                    // Not in Dropbox: deleted on another device? Then don't bring it back.
                    if (await dbxMetadata(dbxTombPathOf(m))) {
                        if (syncBase(m.key)?.deleted) { await markSent(); continue; }
                        hold('แชทนี้ถูกลบที่อีกเครื่องแล้ว — กดซิงค์เพื่อเลือกว่าจะลบหรือเก็บไว้', 'diverged');
                        continue;
                    }
                    mode = 'add';
                }
            }
            let up;
            try {
                up = await dbxUpload(path, blob, m.ts, mode);
            } catch (e) {
                if (!/conflict/.test(String(e?.message))) throw e;
                hold('Dropbox มีฉบับที่แก้จากเครื่องอื่น — ต้องซิงค์ก่อน', 'diverged');
                continue;
            }
            setSyncBase(m.key, { rev: up.rev, sig: mine.sig, meta: mine.meta });
            m.cloud = Date.now();
            await dbMarkCloud(m.id, m.cloud);
            setCloudRecord(m.key, { ts: m.cloud, count: m.count });
            cloud.lastAt.set(m.key, m.cloud);
            updateIndicator();
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
        updateIndicator();
        if (cloud.again) { const a = cloud.again; cloud.again = null; setTimeout(() => cloudTick(a), 1000); }
    }
}

/** After a snapshot is written: sync shortly (pacing still applies). */
function cloudSoon() {
    if (!dbxConnected()) return;
    const fast = !!dbxSettings().syncAuto;
    clearTimeout(cloud.soonTimer);
    cloud.soonTimer = setTimeout(() => { cloud.soonTimer = null; cloudTick({ fast }); }, fast ? 1500 : 3000);
}

/** A change on this device that hasn't reached Dropbox yet (and isn't held back on purpose). */
function cloudUnsent() {
    return !!(pending || inflightByKey.size || cloud.soonTimer || (cloud.pending > 0 && (cloud.running || cloud.error)));
}

/** Download every chat file from Dropbox into local snapshots. */
async function cloudPull(progress, { onlyKey = null } = {}) {
    const files = [];
    if (onlyKey) {
        const m = (await dbMetaByKey(onlyKey))[0];
        const path = m && dbxPathOf(m);
        const meta = path && await dbxMetadata(path);
        if (!meta) throw new Error('ไม่พบไฟล์ของแชทนี้บน Dropbox');
        files.push({ ...meta, path_display: meta.path_display || path, path_lower: meta.path_lower || path });
    } else {
        let page = await dbxRpc('files/list_folder', { path: '', recursive: true, limit: 2000 });
        for (;;) {
            for (const e of page.entries) if (e['.tag'] === 'file' && /\.jsonl$/i.test(e.name)) files.push(e);
            if (!page.has_more) break;
            page = await dbxRpc('files/list_folder/continue', { cursor: page.cursor });
        }
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
        if (d.count) setCloudRecord(key, { ts: Date.parse(f.server_modified) || Date.now(), count: d.count });
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
    updateIndicator();
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
    if (d.onIndicator === false && d.indicatorStyle === 'full') d.indicatorStyle = 'off'; // from v1.6
    delete d.onIndicator;
    if (!['full', 'short', 'off'].includes(d.indicatorStyle)) d.indicatorStyle = 'full';
    $('cab_dbx_style').value = d.indicatorStyle;
    $('cab_dbx_style').addEventListener('change', e => { d.indicatorStyle = e.target.value; saveSettings(); updateIndicator(); });
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
        updateIndicator();
        renderDbxPanel();
        cloudTick({ ignoreGap: true });
    }));

    $('cab_dbx_auto').addEventListener('change', e => { d.auto = e.target.checked; saveSettings(); renderDbxStatus(); updateIndicator(); if (d.auto) cloudTick(); });
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
        updateIndicator();
    }));

    $('cab_sync_auto').checked = !!d.syncAuto;
    $('cab_sync_auto').addEventListener('change', e => {
        d.syncAuto = e.target.checked;
        saveSettings();
        if (d.syncAuto) { sync.lastAt = 0; syncSoon(500); }
    });
    $('cab_sync_now').addEventListener('click', run($('cab_sync_now'), async () => {
        const r = await syncNow();
        if (r?.busy) toast.info('กำลังส่งขึ้น Dropbox อยู่ ลองอีกครั้งในอีกสักครู่', 'ซิงค์');
    }));
    $('cab_sync_decide').addEventListener('click', () => showSyncDecisions());
    $('cab_sync_presets').checked = d.syncPresets !== false;
    $('cab_sync_presets').addEventListener('change', e => { d.syncPresets = e.target.checked; saveSettings(); });
    $('cab_sync_worlds').checked = d.syncLorebooks !== false;
    $('cab_sync_worlds').addEventListener('change', e => { d.syncLorebooks = e.target.checked; saveSettings(); });
    $('cab_sync_personas').checked = d.syncPersonas !== false;
    $('cab_sync_personas').addEventListener('change', e => { d.syncPersonas = e.target.checked; saveSettings(); });
    $('cab_sync_qr').checked = d.syncQuickReplies !== false;
    $('cab_sync_qr').addEventListener('change', e => { d.syncQuickReplies = e.target.checked; saveSettings(); });
    $('cab_sync_regex').checked = d.syncRegex !== false;
    $('cab_sync_regex').addEventListener('change', e => { d.syncRegex = e.target.checked; saveSettings(); });
    $('cab_sync_cards').checked = d.syncCards !== false;
    $('cab_sync_cards').addEventListener('change', e => { d.syncCards = e.target.checked; saveSettings(); });
    $('cab_sync_deletes').checked = d.syncDeletes !== false;
    $('cab_sync_deletes').addEventListener('change', e => { d.syncDeletes = e.target.checked; saveSettings(); });

    renderDbxPanel();
    renderSyncStatus();
    setInterval(() => cloudTick(), 30_000);
    setInterval(() => syncSoon(0), 3 * 60_000);
    if (dbxConnected()) {
        setTimeout(() => cloudTick(), 5000);
        syncSoon(6000);
    }
}

// ---------------------------------------------------------------- two-way sync between ST servers
//
// Several SillyTavern servers (e.g. a hosted ST and TauriTavern) connected to the
// same Dropbox app meet in the per-chat files above. For each chat this browser
// remembers the Dropbox revision it last matched ("base": rev + message signature):
//
//   Dropbox rev == base rev            unchanged since; nothing to pull
//   server == Dropbox                  in sync
//   Dropbox only grew the server copy  the other side added messages/swipes → write it here
//   server == base, Dropbox differs    only the other side changed it      → write it here
//   server only grew the Dropbox copy  only this side changed it           → the upload sends it
//   anything else                      changed on both sides               → the user picks
//
// Before a chat on the server is overwritten its current content is kept as a snapshot.
// Comparisons use message content only (name, text, swipes, hidden flag), never the
// chat header, so the same chat on two servers compares equal.

const sync = { decisions: [], missing: [], notified: new Set(), lastAt: 0, applied: 0, error: '', progress: '', timer: null };
const AUTO_KINDS = ['forward', 'changed', 'create', 'meta', 'remove'];

function syncStoreKey() { return `cab_sync_base:${dbxSettings().appKey || ''}`; }
function syncBases() {
    try { return JSON.parse(localStorage.getItem(syncStoreKey()) || '{}') || {}; } catch { return {}; }
}
function syncBase(key) { return syncBases()[key] || null; }
function setSyncBase(key, rec) {
    try {
        const all = syncBases();
        if (rec) all[key] = rec; else delete all[key];
        localStorage.setItem(syncStoreKey(), JSON.stringify(all));
    } catch { /* storage unavailable: every sync just compares contents again */ }
}

/** Same layout as msgSig (so describeChanges can read it), but from content only. */
function syncMsgKey(m) {
    const sw = Array.isArray(m?.swipes) ? m.swipes.map(x => String(x ?? '')) : null;
    const sid = sw ? Number(m?.swipe_id) || 0 : 0;
    const body = JSON.stringify([String(m?.name ?? ''), !!m?.is_user, !!m?.is_system, String(m?.mes ?? ''), sw, sid]);
    return `${hash(String(m?.mes ?? ''))}|${sw ? sw.length : 0}|${sid}|${hash(body)}`;
}

function parseJsonl(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip a broken line, as ST does */ }
    }
    return out;
}

const toJsonl = arr => arr.map(x => JSON.stringify(x)).join('\n');

/** Snapshot hash of a JSONL text ('' when it can't be read), to recognise this browser's own uploads. */
function jsonlHash(text) {
    try { return deriveFromJsonl(text).hash; } catch { return ''; }
}

/** Header + messages of a chat, with content signatures. */
function chatState(arr) {
    const list = Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object') : [];
    const head = list.length && !('mes' in list[0]) ? list[0] : null;
    const msgs = head ? list.slice(1) : list;
    const keys = msgs.map(syncMsgKey);
    return { head, msgs, keys, sig: hash(keys.join('\n')), meta: metaSig(head), count: msgs.length };
}

// Chat metadata keys that differ per server or per load and say nothing about the chat.
const META_VOLATILE = ['integrity', 'tainted', 'lastInContextMessageId'];

function stableJson(v) {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
    return JSON.stringify(v) ?? 'null';
}

/** Signature of a chat's metadata; null when the file has no header (unknown, never a difference). */
function metaSig(head) {
    if (!head) return null;
    const m = { ...(head.chat_metadata ?? {}) };
    for (const k of META_VOLATILE) delete m[k];
    return hash(stableJson(m));
}

const metaEq = (a, b) => a == null || b == null || a === b;

/** True when b is a continued from a: same messages, then more (b may also have more swipes on a's last). */
function isAncestor(a, b) {
    const n = a.count;
    if (n > b.count) return false;
    if (n === 0) return true;
    for (let i = 0; i < n - 1; i++) if (a.keys[i] !== b.keys[i]) return false;
    if (a.keys[n - 1] === b.keys[n - 1]) return true;
    const x = a.msgs[n - 1], y = b.msgs[n - 1];
    if (String(x?.name ?? '') !== String(y?.name ?? '') || !!x?.is_user !== !!y?.is_user) return false;
    const swipesOf = m => (Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.mes ?? '']).map(t => String(t ?? ''));
    const xs = swipesOf(x), ys = swipesOf(y);
    return xs.length <= ys.length && xs.every((t, i) => ys[i].startsWith(t));
}

/** The chat on this server that a Dropbox file belongs to. */
function syncTargetOf(type, entity, chatId) {
    const c = ctx();
    entity = String(entity ?? '');
    chatId = String(chatId ?? '');
    // Dropbox may report a folder's name in different letter case (it ignores case).
    const pick = (list, idOf) => {
        const exact = list.find(x => idOf(x) === entity);
        if (exact) return exact;
        const loose = list.filter(x => idOf(x).toLowerCase() === entity.toLowerCase());
        return loose.length === 1 ? loose[0] : undefined;
    };
    if (type === 'group') {
        const group = pick(c.groups || [], g => String(g.id));
        if (group) entity = String(group.id);
        return { key: `g:${entity}:${chatId}`, type: 'group', chatId, groupId: entity, avatar: null, group, label: group?.name ?? `Group ${entity}`, missing: !group };
    }
    const ch = pick(c.characters || [], x => String(x.avatar));
    if (ch) entity = ch.avatar;
    return { key: `c:${entity}:${chatId}`, type: 'character', chatId, groupId: null, avatar: entity, ch, label: ch?.name ?? entity.replace(/\.png$/i, ''), missing: !ch };
}

/** The chat file as stored on this server ([] when it doesn't exist). */
async function serverChat(t) {
    const c = ctx();
    const [url, body] = t.type === 'group'
        ? ['/api/chats/group/get', { id: t.chatId, allow_not_found: true }]
        : ['/api/chats/get', { ch_name: t.ch.name, file_name: t.chatId, avatar_url: t.avatar, allow_not_found: true }];
    const res = await fetch(url, { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`อ่านแชท "${t.label}" จากเซิร์ฟเวอร์ไม่สำเร็จ (${res.status})`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

function uuid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
        const r = Math.random() * 16 | 0;
        return (ch === 'x' ? r : (r & 3) | 8).toString(16);
    });
}

/** Write `remote`'s messages into the server's chat file, keeping the server's own header details. */
async function writeServerChat(t, remote, local, chatMeta = remote.head?.chat_metadata ?? local.head?.chat_metadata ?? {}) {
    const c = ctx();
    const old = local.head || {};
    const src = remote.head || {};
    // A fresh integrity slug makes any other tab still holding the old copy refuse to save over it.
    const meta = { ...chatMeta, integrity: uuid() };
    const head = t.type === 'group'
        ? { ...old, ...src, user_name: 'unused', character_name: 'unused', chat_metadata: meta }
        : {
            user_name: c.name1, character_name: t.ch.name, create_date: fileStamp(Date.now()),
            ...src, ...(old.create_date ? { create_date: old.create_date } : {}), chat_metadata: meta,
        };
    const chat = [head, ...remote.msgs];
    const [url, body] = t.type === 'group'
        ? ['/api/chats/group/save', { id: t.chatId, chat, force: true }]
        : ['/api/chats/save', { ch_name: t.ch.name, file_name: t.chatId, chat, avatar_url: t.avatar, force: true }];
    const res = await fetch(url, { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`บันทึกแชท "${t.label}" ลงเซิร์ฟเวอร์ไม่สำเร็จ (${res.status})`);

    // A group only lists the chats named in its own file.
    if (t.type === 'group' && Array.isArray(t.group.chats) && !t.group.chats.includes(t.chatId)) {
        t.group.chats.push(t.chatId);
        const r = await fetch('/api/groups/edit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(t.group) });
        if (!r.ok) throw new Error(`เพิ่มแชทเข้ากลุ่ม "${t.label}" ไม่สำเร็จ (${r.status})`);
    }
}

/** Keep `text` as a snapshot of the chat (skipped when identical to one already kept). */
async function addSnapshotText(t, text, { source, cloud: cloudTs = 0, ts = Date.now() } = {}) {
    const d = deriveFromJsonl(text);
    if (!d.count) return null;
    const same = (await dbMetaByKey(t.key)).find(m => m.hash === d.hash);
    if (same) {
        if (cloudTs && !same.cloud) await dbMarkCloud(same.id, cloudTs);
        return same.id;
    }
    const packed = await pack(text);
    const meta = {
        key: t.key, type: t.type, chatId: t.chatId, groupId: t.groupId, avatar: t.avatar, label: t.label,
        ts, hash: d.hash, count: d.count, preview: d.preview, previewName: d.previewName, swipe: d.swipe,
        rawSize: text.length, size: packed.enc === 'gzip' ? packed.data.size : text.length,
        reason: 'sync', source, shrunk: false, mergedSwipes: 0, sv: SNAP_VERSION,
    };
    if (cloudTs) meta.cloud = cloudTs;
    const id = await dbAdd(meta, packed, d.sigs);
    await prune(t.key);
    return id;
}

function isGenerating() {
    const el = document.getElementById('mes_stop');
    return !!el && getComputedStyle(el).display !== 'none';
}

/** Get the open chat's latest state onto the server before comparing it. */
async function settleOpenChat(t) {
    if (currentChatInfo()?.key !== t.key) return false;
    if (isGenerating()) throw Object.assign(new Error('กำลังสร้างข้อความในแชทนี้อยู่ — รอให้เสร็จก่อน'), { busy: true });
    await flush();
    try { await ctx().saveChat?.(); } catch (e) { console.warn(LOG, e); }
    return true;
}

/**
 * Compare one Dropbox file with the server. Returns null when nothing needs doing,
 * otherwise an item whose `kind` is one of
 *   forward · changed · create   — safe to write here
 *   conflict · shorter · gone · new — the user decides
 */
async function syncClassify(f, t) {
    const known = syncBase(t.key);
    const base = known?.deleted ? null : known; // deleted here before, now back in Dropbox: a new chat
    if (base && base.rev === f.rev) return null;
    await settleOpenChat(t);
    const remoteText = await dbxDownloadText(`rev:${f.rev}`);
    const remote = chatState(parseJsonl(remoteText));
    if (!remote.count) return null;
    // Same messages as when we last matched; only the header changed (e.g. the other side
    // re-saved it after a sync). Anything new here is for the upload to send.
    if (base && !base.skipped && base.sig === remote.sig && base.meta !== undefined && metaEq(base.meta, remote.meta)) {
        setSyncBase(t.key, { rev: f.rev, sig: remote.sig, meta: base.meta });
        return null;
    }
    const local = chatState(await serverChat(t));
    const item = {
        t, rev: f.rev, path: f.path_lower, when: Date.parse(f.client_modified) || Date.parse(f.server_modified) || 0,
        remote: { count: remote.count, sig: remote.sig, keys: remote.keys, meta: remote.meta },
        local: { count: local.count, sig: local.sig, keys: local.keys, meta: local.meta },
    };
    const agree = () => { setSyncBase(t.key, { rev: f.rev, sig: remote.sig, meta: remote.meta ?? local.meta }); return null; };

    if (!local.count) {
        if (base && !base.skipped) return { ...item, kind: 'gone' };
        const since = Number(dbxSettings().syncSince) || 0;
        return { ...item, kind: !base && since && (Date.parse(f.server_modified) || 0) >= since ? 'create' : 'new' };
    }
    if (local.sig === remote.sig) {
        if (metaEq(local.meta, remote.meta)) return agree();
        // Same messages, different chat metadata (memory, variables… kept by extensions).
        if (base && !base.skipped && base.meta === remote.meta) return agree(); // only this side changed it: the upload sends it
        return { ...item, kind: 'meta' };
    }
    // Unchanged here since we last matched: whatever Dropbox has now is the other side's
    // doing — including deleted messages, which the prefix tests below can't tell apart.
    if (base && !base.skipped && base.sig === local.sig) {
        if (isAncestor(local, remote)) return { ...item, kind: 'forward' };
        return { ...item, kind: local.count >= 6 && remote.count < local.count * 0.6 ? 'shorter' : 'changed' };
    }
    if (isAncestor(remote, local)) return agree(); // only this side moved on; the upload sends it
    if (isAncestor(local, remote)) return { ...item, kind: 'forward' };
    // Exactly what this browser once uploaded? Then the server copy grew out of it.
    const rHash = jsonlHash(remoteText);
    if (rHash && (await dbMetaByKey(t.key)).some(m => m.hash === rHash)) return agree();
    return { ...item, kind: 'conflict' };
}

/** A deletion marker from another device: delete here if untouched since the last sync, otherwise ask. */
async function syncClassifyDeleted(f, t) {
    const base = syncBase(t.key);
    if (base?.deleted && base.rev === f.rev) return null;
    const done = () => { setSyncBase(t.key, { deleted: true, rev: f.rev }); return null; };
    if (t.missing) return done();
    const local = chatState(await serverChat(t));
    if (!local.count) return done();
    const untouched = base && !base.deleted && !base.skipped && base.sig === local.sig && metaEq(base.meta, local.meta);
    const isOpen = currentChatInfo()?.key === t.key;
    return {
        t, rev: f.rev, path: f.path_lower, when: Date.parse(f.server_modified) || 0,
        remote: { count: 0, sig: '', keys: [], meta: null },
        local: { count: local.count, sig: local.sig, keys: local.keys, meta: local.meta },
        kind: untouched && !isOpen ? 'remove' : 'deleted',
    };
}

/** Write the Dropbox version into the server (the server's copy is kept as a snapshot first). */
async function syncUseRemote(item, { asNewChat = false } = {}) {
    const t = asNewChat ? { ...item.t, chatId: `${item.t.chatId} (Dropbox ${fileStamp(Date.now())})` } : item.t;
    if (asNewChat) t.key = `${t.type === 'group' ? 'g' : 'c'}:${t.type === 'group' ? t.groupId : t.avatar}:${t.chatId}`;
    const isOpen = asNewChat ? false : await settleOpenChat(t);
    const remoteText = await dbxDownloadText(`rev:${item.rev}`);
    const remote = chatState(parseJsonl(remoteText));
    if (!remote.count) throw new Error('ไฟล์บน Dropbox ว่างเปล่า');
    const localArr = asNewChat ? [] : await serverChat(t);
    const local = chatState(localArr);
    // Chat metadata: Dropbox's, unless this side changed it too since the last match — then
    // keep this side's keys that Dropbox lacks (Dropbox wins on keys both have).
    const base = asNewChat ? null : syncBase(t.key);
    const remoteMeta = remote.head?.chat_metadata, localMeta = local.head?.chat_metadata;
    const localMetaKept = base && !base.skipped && base.meta === local.meta;
    const chatMeta = !remoteMeta ? (localMeta ?? {})
        : (!local.count || localMetaKept || metaEq(local.meta, remote.meta)) ? remoteMeta
        : { ...(localMeta ?? {}), ...remoteMeta };
    const now = Date.now();
    const nothingToWrite = local.count && local.sig === remote.sig && metaSig({ chat_metadata: chatMeta }) === local.meta;
    if (!nothingToWrite) {
        if (local.count) await addSnapshotText(t, toJsonl(localArr), { source: 'before-sync', ts: now - 1 });
        await writeServerChat(t, remote, local, chatMeta);
    }
    if (!asNewChat) {
        if (remote.count < local.count) await ackShrink(t.key); // fewer messages on purpose, not a broken load
        await addSnapshotText(t, remoteText, { source: 'dropbox', cloud: now, ts: now });
        // Base = what Dropbox holds; if merged metadata differs from it, the upload sends ours.
        setSyncBase(t.key, { rev: item.rev, sig: remote.sig, meta: remote.meta ?? local.meta });
        setCloudRecord(t.key, { ts: now, count: remote.count });
        cloud.withheld = cloud.withheld.filter(w => w.key !== t.key);
    }
    if (isOpen && !nothingToWrite && typeof ctx().reloadCurrentChat === 'function') await ctx().reloadCurrentChat();
    return t;
}

/** Send the server's version to Dropbox (only if Dropbox is still at the revision the user looked at). */
async function syncUseLocal(item) {
    const t = item.t;
    await settleOpenChat(t);
    const arr = await serverChat(t);
    const st = chatState(arr);
    if (!st.count) throw new Error('แชทนี้ไม่มีในเซิร์ฟเวอร์แล้ว');
    const text = toJsonl(arr);
    let up;
    try {
        up = await dbxUpload(dbxPathOf(t), new Blob([text], { type: 'application/octet-stream' }), Date.now(), { update: item.rev });
    } catch (e) {
        if (/conflict/.test(String(e?.message))) throw new Error('ไฟล์บน Dropbox เพิ่งเปลี่ยนอีก — กดซิงค์อีกครั้งแล้วเลือกใหม่');
        throw e;
    }
    const now = Date.now();
    await addSnapshotText(t, text, { source: 'before-sync', cloud: now, ts: now });
    setSyncBase(t.key, { rev: up.rev, sig: st.sig, meta: st.meta });
    setCloudRecord(t.key, { ts: now, count: st.count });
    cloud.withheld = cloud.withheld.filter(w => w.key !== t.key);
}

async function syncKeepBoth(item) {
    const copy = await syncUseRemote(item, { asNewChat: true });
    await syncUseLocal(item);
    return copy;
}

/** Every snapshot of this chat counts as sent, so nothing tries to upload it again. */
async function markKeySent(key) {
    const now = Date.now();
    for (const m of await dbMetaByKey(key)) if (!m.cloud) await dbMarkCloud(m.id, now);
}

/**
 * Delete a chat from Dropbox and leave a marker so the other devices delete it too
 * (Dropbox keeps deleted files ~30 days; this device keeps its snapshots).
 */
async function syncDeleteEverywhere(t) {
    const marker = new Blob([JSON.stringify({ deleted: new Date().toISOString(), chat: t.chatId })], { type: 'application/octet-stream' });
    const up = await dbxUpload(dbxTombPathOf(t), marker, Date.now(), 'overwrite');
    try { await dbxRpc('files/delete_v2', { path: dbxPathOf(t) }); } catch (e) {
        if (!/not_found/.test(String(e?.message))) throw e;
    }
    setSyncBase(t.key, { deleted: true, rev: up.rev });
    await markKeySent(t.key);
    cloud.withheld = cloud.withheld.filter(w => w.key !== t.key);
}

/** Delete the chat on this server because another device deleted it (its content is kept as a snapshot). */
async function syncDeleteLocal(item) {
    const t = item.t;
    if (currentChatInfo()?.key === t.key) throw new Error(`แชท "${t.chatId}" เปิดอยู่ — เปิดแชทอื่นก่อนแล้วค่อยลบ`);
    const c = ctx();
    const arr = await serverChat(t);
    if (arr.length) await addSnapshotText(t, toJsonl(arr), { source: 'before-delete', cloud: Date.now() });
    const [url, body] = t.type === 'group'
        ? ['/api/chats/group/delete', { id: t.chatId }]
        : ['/api/chats/delete', { chatfile: `${t.chatId}.jsonl`, avatar_url: t.avatar }];
    const res = await fetch(url, { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(body) });
    if (!res.ok && chatState(await serverChat(t)).count) throw new Error(`ลบแชท "${t.chatId}" ไม่สำเร็จ (${res.status})`);
    if (t.type === 'group' && Array.isArray(t.group.chats) && t.group.chats.includes(t.chatId)) {
        t.group.chats = t.group.chats.filter(x => x !== t.chatId);
        if (t.group.chat_id === t.chatId && t.group.chats.length) t.group.chat_id = t.group.chats[t.group.chats.length - 1];
        await fetch('/api/groups/edit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(t.group) });
    }
    setSyncBase(t.key, { deleted: true, rev: item.rev });
    await markKeySent(t.key);
}

/** Deleted elsewhere, but keep it: put it back in Dropbox and drop the marker. */
async function syncKeepDeleted(item) {
    const t = item.t;
    await settleOpenChat(t);
    const arr = await serverChat(t);
    const st = chatState(arr);
    if (!st.count) throw new Error('แชทนี้ไม่มีในเซิร์ฟเวอร์แล้ว');
    let up;
    try {
        up = await dbxUpload(dbxPathOf(t), new Blob([toJsonl(arr)], { type: 'application/octet-stream' }), Date.now(), 'add');
    } catch (e) {
        if (/conflict/.test(String(e?.message))) throw new Error('มีแชทนี้กลับมาใน Dropbox แล้ว — กดซิงค์อีกครั้ง');
        throw e;
    }
    try { await dbxRpc('files/delete_v2', { path: dbxTombPathOf(t) }); } catch { /* already gone */ }
    setSyncBase(t.key, { rev: up.rev, sig: st.sig, meta: st.meta });
    await markKeySent(t.key);
    cloud.withheld = cloud.withheld.filter(w => w.key !== t.key);
}

/** A chat was deleted in ST here: remove it from Dropbox and the other devices too (once sync is in use). */
async function onChatDeleted(type, name) {
    const d = dbxSettings();
    if (!dbxConnected() || !d.syncSince || d.syncDeletes === false) return;
    const chatId = String(name ?? '').replace(/\.jsonl$/i, '');
    if (!chatId) return;
    // The event names only the file; find which character's or group's chat it was.
    const prefix = type === 'group' ? 'g:' : 'c:';
    const keys = new Set(Object.keys(syncBases()).filter(k => k.startsWith(prefix) && k.endsWith(`:${chatId}`)));
    try { for (const m of await dbAllMeta()) if (m.type === type && m.chatId === chatId) keys.add(m.key); } catch { /* ignore */ }
    for (const key of keys) {
        if (syncBase(key)?.deleted) continue;
        const entity = key.slice(2, key.length - chatId.length - 1);
        const t = syncTargetOf(type, entity, chatId);
        try {
            if (!t.missing && chatState(await serverChat(t)).count) continue; // still here: not this one
            const r = await withCloudLock(() => syncDeleteEverywhere(t));
            if (r?.busy) throw new Error('Dropbox ไม่ว่าง');
            toast.info(`ลบ "${chatId}" ออกจาก Dropbox แล้ว — เครื่องอื่นจะลบตามตอนซิงค์`, 'ซิงค์');
        } catch (e) {
            console.warn(LOG, 'delete sync', key, e);
            toast.warn(`ลบ "${chatId}" ออกจาก Dropbox ไม่สำเร็จ: ${e?.message ?? e}`, 'ซิงค์');
        }
    }
}

/** Leave this one alone until the Dropbox file changes again. */
function syncSkip(item) {
    setSyncBase(item.t.key, { rev: item.rev, sig: syncBase(item.t.key)?.sig ?? item.local.sig, skipped: true });
}

/** Run fn while no upload or other sync touches Dropbox. */
async function withCloudLock(fn, { wait = true } = {}) {
    for (let i = 0; cloud.running && wait && i < 240; i++) await new Promise(r => setTimeout(r, 250));
    if (cloud.running) return { busy: true };
    cloud.running = true;
    try { return await fn(); } finally {
        cloud.running = false;
        renderDbxStatus();
        updateIndicator();
        if (cloud.again) { const a = cloud.again; cloud.again = null; setTimeout(() => cloudTick(a), 1000); }
    }
}

/** Every chat file in Dropbox (or just the one for `only` = { type, avatar, groupId, chatId }). */
async function listChatFiles(only) {
    if (only) {
        for (const path of [dbxPathOf(only), dbxTombPathOf(only)]) {
            const meta = await dbxMetadata(path);
            if (meta) return [{ ...meta, path_display: meta.path_display || path, path_lower: meta.path_lower || path }];
        }
        return [];
    }
    const files = [];
    let page = await dbxRpc('files/list_folder', { path: '', recursive: true, limit: 2000 });
    for (;;) {
        for (const e of page.entries) if (e['.tag'] === 'file' && /\.(jsonl?|png)$/i.test(e.name)) files.push(e);
        if (!page.has_more) break;
        page = await dbxRpc('files/list_folder/continue', { cursor: page.cursor });
    }
    return files;
}

/**
 * Bring this server up to date with Dropbox: write what is safe, collect what needs a choice.
 * auto: skip (don't wait) if Dropbox is busy.
 */
async function syncPull({ auto = false, only = null } = {}) {
    if (!dbxConnected()) throw new Error('ยังไม่ได้เชื่อมต่อ Dropbox');
    const d = dbxSettings();
    if (!d.syncSince) { d.syncSince = Date.now(); saveSettings(); }
    return await withCloudLock(async () => {
        const out = { applied: [], decisions: [], missing: new Map(), errors: [], itemsApplied: [], itemsSent: 0 };
        sync.error = '';
        try {
            const files = await listChatFiles(only);
            if (!only) await syncItems(files, out, { auto });
            // /character|group/<entity>/<chat>.jsonl, or a deletion marker /deleted/…/<chat>.json
            const parse = f => {
                const parts = String(f.path_display || '').split('/').filter(Boolean);
                const tomb = parts[0] === 'deleted';
                if (tomb) parts.shift();
                if (parts.length !== 3 || !['character', 'group'].includes(parts[0])) return null;
                if (!(tomb ? /\.json$/i : /\.jsonl$/i).test(parts[2])) return null;
                return { tomb, t: syncTargetOf(parts[0], dbxUnseg(parts[1]), dbxUnseg(parts[2].replace(/\.jsonl?$/i, ''))) };
            };
            const parsed = files.map(parse);
            const inDropbox = new Set(parsed.filter(p => p && !p.tomb).map(p => p.t.key));
            for (let i = 0; i < files.length; i++) {
                sync.progress = `กำลังตรวจ ${i + 1}/${files.length}…`;
                renderSyncStatus();
                if (!parsed[i]) continue;
                const { tomb, t } = parsed[i];
                if (tomb && inDropbox.has(t.key)) continue; // the chat came back since: it wins
                if (!tomb && t.missing) { out.missing.set(t.label, (out.missing.get(t.label) || 0) + 1); continue; }
                // Background runs don't download again what already waits for the user's choice.
                const waiting = auto && sync.decisions.find(x => x.t.key === t.key && x.rev === files[i].rev);
                if (waiting) { out.decisions.push({ ...waiting, t }); continue; }
                try {
                    const item = tomb ? await syncClassifyDeleted(files[i], t) : await syncClassify(files[i], t);
                    if (!item) continue;
                    if (AUTO_KINDS.includes(item.kind)) {
                        await (item.kind === 'remove' ? syncDeleteLocal(item) : syncUseRemote(item));
                        out.applied.push(item);
                    } else {
                        out.decisions.push(item);
                    }
                } catch (e) {
                    if (e?.busy) continue; // the open chat is generating; next round
                    console.warn(LOG, 'sync', t.key, e);
                    out.errors.push(`${t.label}: ${e?.message ?? e}`);
                    if (/Dropbox (ขอให้รอ|ยกเลิกสิทธิ์)/.test(String(e?.message))) break;
                }
            }
        } catch (e) {
            out.errors.push(String(e?.message ?? e));
        } finally {
            sync.progress = '';
        }
        // Replace earlier decisions for the chats looked at; keep the rest.
        const looked = only ? new Set([`${only.type === 'group' ? 'g' : 'c'}:${only.type === 'group' ? only.groupId : only.avatar}:${only.chatId}`]) : null;
        sync.decisions = [
            ...sync.decisions.filter(x => looked ? !looked.has(x.t.key) : false),
            ...out.decisions,
        ];
        if (!only) sync.missing = [...out.missing.entries()];
        sync.applied += out.applied.length;
        if (out.itemsApplied.length || out.itemsSent) {
            sync.items = { got: (sync.items?.got || 0) + out.itemsApplied.length, sent: (sync.items?.sent || 0) + out.itemsSent };
        }
        sync.lastAt = Date.now();
        sync.error = out.errors.join(' · ');
        renderSyncStatus();
        return out;
    }, { wait: !auto });
}

function syncReport(r, { quiet = false } = {}) {
    if (!r || r.busy) return;
    const names = list => { const n = [...new Set(list.map(x => x.t.label))]; return `${n.slice(0, 4).join(', ')}${n.length > 4 ? ' …' : ''}`; };
    const updated = r.applied.filter(x => x.kind !== 'remove'), removed = r.applied.filter(x => x.kind === 'remove');
    if (updated.length) toast.ok(`อัปเดต ${updated.length} แชทจาก Dropbox: ${names(updated)}`, 'ซิงค์');
    if (removed.length) toast.info(`ลบ ${removed.length} แชทที่ถูกลบจากอีกเครื่อง: ${names(removed)} (ยังกู้ได้จากรายการ backup)`, 'ซิงค์');
    if (r.itemsApplied?.length) {
        const n = r.itemsApplied;
        toast.ok(`อัปเดตจาก Dropbox ${n.length} รายการ: ${n.slice(0, 4).join(', ')}${n.length > 4 ? ' …' : ''}`, 'ซิงค์');
    }
    const fresh = sync.decisions.filter(x => !sync.notified.has(`${x.t.key}|${x.rev}`));
    for (const x of sync.decisions) sync.notified.add(`${x.t.key}|${x.rev}`);
    if (sync.decisions.length && (fresh.length || !quiet)) {
        toast.warn(`มี ${sync.decisions.length} รายการที่ต้องเลือกว่าจะใช้ฉบับไหน — แตะที่นี่`, 'ซิงค์', {
            timeOut: quiet ? 15_000 : 0, extendedTimeOut: 0, closeButton: true, onclick: () => showSyncDecisions(),
        });
    }
    if (!quiet && !r.applied.length && !r.itemsApplied?.length && !sync.decisions.length && !r.errors.length) toast.ok('ตรงกับ Dropbox แล้ว', 'ซิงค์');
    if (r.errors.length && !quiet) toast.err(r.errors.slice(0, 3).join('<br>'), 'ซิงค์');
}

/** Manual sync from the panel or a dialog. */
async function syncNow(opts = {}) {
    await flush();
    const r = await syncPull(opts);
    syncReport(r);
    if (sync.decisions.length && opts.only) showSyncDecisions();
    return r;
}

function syncSoon(delay = 2000) {
    if (!dbxConnected() || !dbxSettings().syncAuto) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(async () => {
        if (document.visibilityState === 'hidden' || Date.now() - sync.lastAt < 20_000) return;
        try { syncReport(await syncPull({ auto: true }), { quiet: true }); } catch (e) { sync.error = String(e?.message ?? e); renderSyncStatus(); }
    }, delay);
}

function renderSyncStatus() {
    const el = document.getElementById('cab_sync_status');
    const btn = document.getElementById('cab_sync_decide');
    if (btn) {
        btn.hidden = !sync.decisions.length;
        btn.textContent = `เลือกฉบับ (${sync.decisions.length} รายการ)`;
    }
    if (!el) return;
    const parts = [];
    if (sync.progress) parts.push(sync.progress);
    else if (sync.lastAt) parts.push(`ซิงค์ล่าสุด ${fmtTime(sync.lastAt).slice(11, 16)}`);
    else parts.push('ยังไม่ได้ซิงค์ในรอบนี้');
    if (sync.applied) parts.push(`อัปเดตจาก Dropbox แล้ว ${sync.applied} ครั้ง`);
    if (sync.items) parts.push(`preset/การ์ด/lorebook/persona/QR/regex: รับ ${sync.items.got} ส่ง ${sync.items.sent}`);
    if (sync.decisions.length) parts.push(`รอเลือก ${sync.decisions.length} รายการ`);
    if (sync.missing.length) {
        const n = sync.missing.reduce((a, [, k]) => a + k, 0);
        parts.push(`ข้าม ${n} แชทเพราะไม่มีตัวละคร/กลุ่มนี้ในเครื่องนี้ (${sync.missing.slice(0, 5).map(([l]) => l).join(', ')}${sync.missing.length > 5 ? ' …' : ''})`);
    }
    if (sync.error) parts.push(`⚠ ${sync.error}`);
    el.textContent = parts.join(' · ');
}

const SYNC_KIND = {
    conflict: { title: 'แก้ทั้งสองฝั่ง', why: 'แชทนี้มีการเปลี่ยนทั้งในเครื่องนี้และจากอีกเครื่อง หลังจากซิงค์กันครั้งล่าสุด' },
    shorter: { title: 'ฉบับ Dropbox สั้นกว่ามาก', why: 'อีกเครื่องลบข้อความออกไปเยอะ — ถ้าไม่ได้ตั้งใจลบ ให้ใช้ฉบับในเครื่อง' },
    gone: { title: 'แชทนี้ถูกลบในเครื่องนี้', why: 'เคยซิงค์แชทนี้แล้ว แต่ตอนนี้ไม่มีในเซิร์ฟเวอร์นี้ (ลบหรือเปลี่ยนชื่อ)' },
    new: { title: 'มีบน Dropbox แต่ไม่มีในเครื่องนี้', why: 'แชทที่สร้างจากเครื่องอื่นก่อนเริ่มใช้การซิงค์ที่นี่ หรือเคยลบไปแล้ว' },
    deleted: { title: 'ถูกลบที่อีกเครื่อง', why: 'อีกเครื่องลบแชทนี้แล้ว แต่ที่นี่มีการแก้หลังซิงค์ครั้งล่าสุด หรือเปิดแชทนี้อยู่' },
    itemdel: { title: 'ถูกลบที่อีกเครื่อง', why: 'อีกเครื่องลบไปแล้ว แต่ที่นี่มีการแก้หลังซิงค์ครั้งล่าสุด (หรือยังไม่เคยซิงค์)' },
    item: { title: 'แก้ทั้งสองฝั่ง', why: 'แก้ทั้งในเครื่องนี้และจากอีกเครื่อง หลังจากซิงค์กันครั้งล่าสุด (หรือเพิ่งเริ่มซิงค์และสองฝั่งไม่ตรงกัน)' },
};

function showSyncDecisions() {
    if (!sync.decisions.length) { toast.info('ไม่มีแชทที่ต้องเลือก', 'ซิงค์'); return; }
    const { wrap } = openModal(`
        <div class="cab_dialog cab_explain">
            <div class="cab_head">
                <b>ซิงค์ — เลือกฉบับที่จะใช้</b>
                <div class="cab_close menu_button fa-solid fa-xmark" title="ปิด"></div>
            </div>
            <div class="cab_list" id="cab_sync_list"></div>
            <div class="cab_foot" id="cab_sync_foot"></div>
        </div>`);
    let busy = false;
    const act = (btn, fn) => async () => {
        if (busy) return;
        busy = true;
        wrap.querySelectorAll('.menu_button').forEach(b => b.classList.add('disabled'));
        try { await withCloudLock(fn); } catch (e) { console.error(LOG, e); toast.err(String(e?.message ?? e), 'ซิงค์'); }
        busy = false;
        renderSyncStatus();
        if (document.getElementById('cab_modal') !== wrap) return;
        if (!sync.decisions.length) { wrap._cabClose(); toast.ok('เรียบร้อย', 'ซิงค์'); return; }
        render();
    };
    const done = item => { sync.decisions = sync.decisions.filter(x => x !== item); };

    function render() {
        const items = sync.decisions;
        wrap.querySelector('#cab_sync_list').innerHTML = items.map((x, i) => {
            const k = SYNC_KIND[x.kind] ?? SYNC_KIND.conflict;
            if (x.kind === 'itemdel') {
                return `
            <section class="cab_problem">
                <h4>${escapeHtml(x.t.label)}</h4>
                <p><b>${escapeHtml(k.title)}</b> · ${escapeHtml(k.why)}</p>
                <div class="cab_buttons">
                    <div class="menu_button cab_primary" data-i="${i}" data-a="idellocal">ลบในเครื่องนี้ด้วย</div>
                    <div class="menu_button" data-i="${i}" data-a="ikeep">เก็บไว้ (ส่งกลับขึ้น Dropbox)</div>
                </div>
            </section>`;
            }
            if (x.kind === 'item') {
                const btnsI = [['iremote', 'ใช้ฉบับ Dropbox', true], ['ilocal', 'ใช้ฉบับในเครื่อง'], ...(x.entry.type === 'preset' ? [['iboth', 'เก็บทั้งคู่']] : [])];
                return `
            <section class="cab_problem">
                <h4>${escapeHtml(x.t.label)}</h4>
                <p><b>${escapeHtml(k.title)}</b> · ${escapeHtml(k.why)}</p>
                ${x.when ? `<p>ฉบับ Dropbox ส่งขึ้นเมื่อ ${fmtTime(x.when)}</p>` : ''}
                <div class="cab_buttons">${btnsI.map(([a, label, primary]) =>
                    `<div class="menu_button${primary ? ' cab_primary' : ''}" data-i="${i}" data-a="${a}">${escapeHtml(label)}</div>`).join('')}</div>
            </section>`;
            }
            const diff = x.local.count && !['gone', 'deleted'].includes(x.kind)
                ? describeChanges({ head: '', msgs: x.local.keys }, { head: '', msgs: x.remote.keys }).join(' · ') : '';
            const btns = x.kind === 'new' ? [['remote', 'สร้างแชทนี้', true], ['purge', 'ลบทุกเครื่อง'], ['skip', 'ข้าม']]
                : x.kind === 'gone' ? [['purge', 'ลบทุกเครื่อง', true], ['remote', 'สร้างกลับมา'], ['skip', 'ข้าม']]
                : x.kind === 'deleted' ? [['dellocal', 'ลบในเครื่องนี้ด้วย', true], ['keep', 'เก็บไว้ (ส่งกลับขึ้น Dropbox)']]
                : [['remote', 'ใช้ฉบับ Dropbox', x.kind === 'conflict'], ['local', 'ใช้ฉบับในเครื่อง', x.kind === 'shorter'], ['both', 'เก็บทั้งคู่']];
            return `
            <section class="cab_problem">
                <h4>${escapeHtml(x.t.label)} — ${escapeHtml(x.t.chatId)}</h4>
                <p><b>${escapeHtml(k.title)}</b> · ${escapeHtml(k.why)}</p>
                <p>ในเครื่อง ${x.local.count ? `${x.local.count} ข้อความ` : 'ไม่มี'} · ${x.kind === 'deleted' ? `ลบที่อีกเครื่องเมื่อ ${x.when ? fmtTime(x.when) : '?'}` : `Dropbox ${x.remote.count} ข้อความ${x.when ? ` (ส่งขึ้นเมื่อ ${fmtTime(x.when)})` : ''}`}</p>
                ${diff ? `<p class="cab_changes" title="ฉบับ Dropbox เทียบกับฉบับในเครื่อง">ฉบับ Dropbox: ${escapeHtml(diff)}</p>` : ''}
                <div class="cab_buttons">${btns.map(([a, label, primary]) =>
                    `<div class="menu_button${primary ? ' cab_primary' : ''}" data-i="${i}" data-a="${a}">${escapeHtml(label)}</div>`).join('')}</div>
            </section>`;
        }).join('');
        const nNew = items.filter(x => x.kind === 'new').length;
        const nGone = items.filter(x => x.kind === 'gone').length;
        const bulk = [
            nNew > 1 && `<div class="menu_button" data-bulk="create">สร้างที่มีบน Dropbox ทั้งหมด (${nNew})</div>`,
            nNew + nGone > 1 && `<div class="menu_button" data-bulk="purge">ลบทุกเครื่อง: แชทที่ไม่มีในเครื่องนี้ทั้งหมด (${nNew + nGone})</div>`,
            nNew > 1 && `<div class="menu_button" data-bulk="skip">ข้ามทั้งหมด (${nNew})</div>`,
        ].filter(Boolean);
        wrap.querySelector('#cab_sync_foot').innerHTML = `<small>ก่อนเขียนทับหรือลบแชทในเครื่อง ระบบเก็บฉบับเดิมไว้ในรายการ backup · "เก็บทั้งคู่" สร้างฉบับ Dropbox เป็นไฟล์แชทใหม่ · "ลบทุกเครื่อง" ลบไฟล์ออกจาก Dropbox และเครื่องอื่นจะลบตาม (Dropbox เก็บไฟล์ที่ลบไว้ให้กู้ได้ประมาณ 30 วัน)</small>`
            + (bulk.length ? `<div class="cab_buttons">${bulk.join('')}</div>` : '');

        wrap.querySelectorAll('[data-a]').forEach(btn => {
            const item = items[Number(btn.dataset.i)];
            btn.addEventListener('click', act(btn, async () => {
                const a = btn.dataset.a;
                if (a === 'idellocal' || a === 'ikeep') {
                    const fresh = (await localItemsOf(item.item.type)).get(item.t.key);
                    if (!fresh) throw new Error('ไม่มีในเครื่องนี้แล้ว');
                    if (a === 'idellocal') {
                        if (!confirm(`ลบ "${item.t.label}" ในเครื่องนี้ด้วย?`)) return;
                        await deleteItemLocally(fresh);
                        setItemBase(item.t.key, { deleted: true, rev: item.rev });
                    } else {
                        await keepDeletedItem(fresh);
                    }
                } else if (a === 'iremote') {
                    if (!confirm(`ใช้ฉบับ Dropbox แทน "${item.t.label}" ในเครื่องนี้?`)) return;
                    await resolveItem(item, 'remote');
                } else if (a === 'ilocal') {
                    if (!confirm(`ส่งฉบับในเครื่องของ "${item.t.label}" ทับใน Dropbox?\nเครื่องอื่นจะได้ฉบับนี้ตอนซิงค์ครั้งถัดไป`)) return;
                    await resolveItem(item, 'local');
                } else if (a === 'iboth') {
                    const copy = await resolveItem(item, 'both');
                    toast.ok(`บันทึกฉบับ Dropbox เป็น preset "${copy}" แล้ว`, 'ซิงค์');
                } else if (a === 'remote') {
                    if (item.local.count && !confirm(`เขียนฉบับ Dropbox (${item.remote.count} ข้อความ) ทับแชท "${item.t.chatId}" ในเครื่องนี้ (${item.local.count} ข้อความ)?\nฉบับในเครื่องจะเก็บไว้ในรายการ backup`)) return;
                    await syncUseRemote(item);
                } else if (a === 'local') {
                    if (!confirm(`ส่งฉบับในเครื่อง (${item.local.count} ข้อความ) ทับไฟล์บน Dropbox?\nเครื่องอื่นจะได้ฉบับนี้ตอนซิงค์ครั้งถัดไป (Dropbox เก็บเวอร์ชันเดิมไว้ประมาณ 30 วัน)`)) return;
                    await syncUseLocal(item);
                } else if (a === 'both') {
                    const copy = await syncKeepBoth(item);
                    toast.ok(`บันทึกฉบับ Dropbox เป็นแชท "${copy.chatId}"`, 'ซิงค์');
                } else if (a === 'purge') {
                    if (!confirm(`ลบแชท "${item.t.chatId}" ออกจาก Dropbox?\nเครื่องอื่นจะลบตามตอนซิงค์ (ถ้าที่นั่นไม่ได้แก้แชทนี้ ถ้าแก้จะถามก่อน)`)) return;
                    await syncDeleteEverywhere(item.t);
                } else if (a === 'dellocal') {
                    if (!confirm(`ลบแชท "${item.t.chatId}" (${item.local.count} ข้อความ) ในเครื่องนี้ด้วย?\nฉบับนี้จะเก็บไว้ในรายการ backup`)) return;
                    await syncDeleteLocal(item);
                } else if (a === 'keep') {
                    await syncKeepDeleted(item);
                } else {
                    syncSkip(item);
                }
                done(item);
            }));
        });
        wrap.querySelectorAll('[data-bulk]').forEach(btn => {
            btn.addEventListener('click', act(btn, async () => {
                if (btn.dataset.bulk === 'purge') {
                    const gone = sync.decisions.filter(x => x.kind === 'new' || x.kind === 'gone');
                    if (!confirm(`ลบ ${gone.length} แชทที่ไม่มีในเครื่องนี้ ออกจาก Dropbox?\nเครื่องอื่นจะลบตามตอนซิงค์ (ถ้าที่นั่นไม่ได้แก้แชทนั้น ถ้าแก้จะถามก่อน)`)) return;
                    for (let i = 0; i < gone.length; i++) {
                        btn.textContent = `กำลังลบ ${i + 1}/${gone.length}…`;
                        await syncDeleteEverywhere(gone[i].t);
                        done(gone[i]);
                    }
                    return;
                }
                const list = sync.decisions.filter(x => x.kind === 'new');
                if (btn.dataset.bulk === 'skip') { list.forEach(x => { syncSkip(x); done(x); }); return; }
                if (!confirm(`สร้าง ${list.length} แชทจาก Dropbox ในเครื่องนี้?`)) return;
                for (let i = 0; i < list.length; i++) {
                    btn.textContent = `กำลังสร้าง ${i + 1}/${list.length}…`;
                    await syncUseRemote(list[i]);
                    done(list[i]);
                }
            }));
        });
    }
    render();
}

// ---------------------------------------------------------------- presets & character cards
//
// Synced the same way as chats, one file per item:
//   /presets/<api>/<name>.json   a preset file, as SillyTavern stores it
//   /cards/<avatar>.png          the character card as "Export PNG" makes it
// Each browser remembers, per item, the Dropbox revision and content hash it last
// matched. A side that changed alone wins; changes on both sides are the user's call.
// Cards keep the same avatar file name everywhere, so their chats still match up.

const PRESET_APIS = ['openai', 'textgenerationwebui', 'kobold', 'novel', 'instruct', 'context', 'sysprompt', 'reasoning'];
const PRESET_LABEL = {
    openai: 'Chat Completion', textgenerationwebui: 'Text Completion', kobold: 'KoboldAI', novel: 'NovelAI',
    instruct: 'Instruct', context: 'Context', sysprompt: 'System Prompt', reasoning: 'Reasoning',
};
const presetHashCache = new WeakMap(); // preset object -> hash
const cardHashCache = new Map();       // avatar -> { fp, hash }

function itemStoreKey() { return `cab_item_base:${dbxSettings().appKey || ''}`; }
function itemBases() {
    try { return JSON.parse(localStorage.getItem(itemStoreKey()) || '{}') || {}; } catch { return {}; }
}
function itemBase(key) { return itemBases()[key] || null; }
function setItemBase(key, rec) {
    try {
        const all = itemBases();
        if (rec) all[key] = rec; else delete all[key];
        localStorage.setItem(itemStoreKey(), JSON.stringify(all));
    } catch { /* storage unavailable: items just get compared again */ }
}

const presetPath = (apiId, name) => `/presets/${apiId}/${dbxSeg(name)}.json`;
const cardPath = avatar => `/cards/${dbxSeg(avatar)}`;

function presetManager(apiId) {
    try { return ctx().getPresetManager?.(apiId) || null; } catch { return null; }
}

/** Every preset ST has in memory, keyed `p:<api>:<name>`. */
function localPresets() {
    const out = new Map();
    for (const apiId of PRESET_APIS) {
        const pm = presetManager(apiId);
        if (!pm?.getPresetList) continue;
        let list;
        try { list = pm.getPresetList(apiId); } catch { continue; }
        const { presets, preset_names } = list || {};
        if (!Array.isArray(presets) || !preset_names) continue;
        const pairs = Array.isArray(preset_names) ? preset_names.map((n, i) => [n, i]) : Object.entries(preset_names);
        for (const [name, idx] of pairs) {
            let obj = presets[idx];
            if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { continue; } }
            if (!name || !obj || typeof obj !== 'object') continue;
            out.set(`p:${apiId}:${name}`, { key: `p:${apiId}:${name}`, type: 'preset', apiId, name, obj, label: `${PRESET_LABEL[apiId]}: ${name}` });
        }
    }
    return out;
}

/**
 * Drop empty values (undefined, null, "", false, [], {}) so that SillyTavern filling in
 * defaults when it re-saves a card or preset doesn't count as a change.
 */
function lean(v) {
    if (Array.isArray(v)) return v.map(lean);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            const y = lean(x);
            if (y === undefined || y === null || y === '' || y === false) continue;
            if (Array.isArray(y) && !y.length) continue;
            if (y && typeof y === 'object' && !Array.isArray(y) && !Object.keys(y).length) continue;
            out[k] = y;
        }
        return out;
    }
    return v;
}

function presetHash(obj) {
    let h = presetHashCache.get(obj);
    if (!h) { h = hash(stableJson(lean(obj))); presetHashCache.set(obj, h); }
    return h;
}

/** Every character card, keyed `card:<avatar>`. */
function localCards() {
    const out = new Map();
    for (const ch of ctx().characters || []) {
        if (!ch?.avatar || !/\.png$/i.test(ch.avatar)) continue;
        out.set(`card:${ch.avatar}`, { key: `card:${ch.avatar}`, type: 'card', avatar: ch.avatar, ch, label: `การ์ด: ${ch.name ?? ch.avatar}` });
    }
    return out;
}

/** Hash of a card's content (its "data"), the same whether read from ST or from an exported PNG. */
function cardDataHash(card) {
    const data = structuredClone(card?.data ?? card ?? {});
    if (data.extensions) delete data.extensions.fav; // per-user, cleared on export
    return hash(stableJson(lean(data)));
}

async function localCardHash(item) {
    const ch = item.ch;
    const fp = `${ch.date_added}|${ch.data_size}|${ch.json_data?.length ?? ''}`;
    const known = cardHashCache.get(item.avatar);
    if (known && known.fp === fp && ch.date_added !== undefined) return known.hash;
    let json = ch.json_data;
    if (!json) {
        const res = await fetch('/api/characters/get', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ avatar_url: item.avatar }) });
        if (!res.ok) throw new Error(`อ่านการ์ด ${item.avatar} ไม่สำเร็จ (${res.status})`);
        const full = await res.json();
        json = full?.json_data ?? JSON.stringify({ data: full?.data ?? {} });
    }
    const h = cardDataHash(JSON.parse(json));
    cardHashCache.set(item.avatar, { fp, hash: h });
    return h;
}

const lorebookPath = name => `/worlds/${dbxSeg(name)}.json`;
const personaPath = id => `/personas/${dbxSeg(id)}.json`;

/** Every lorebook (World Info file), keyed `wi:<name>`. Read through ST's cache, so ST's own edits are seen. */
async function localLorebooks() {
    const out = new Map();
    const c = ctx();
    const names = typeof c.getWorldInfoNames === 'function' ? c.getWorldInfoNames() : [];
    for (const name of names) {
        let obj;
        try { obj = await c.loadWorldInfo?.(name); } catch { obj = null; }
        if (!obj || typeof obj !== 'object') continue;
        out.set(`wi:${name}`, { key: `wi:${name}`, type: 'wi', name, obj, label: `Lorebook: ${name}` });
    }
    return out;
}

/** Every persona, keyed `persona:<avatar file>`: its name and description settings. */
function localPersonas() {
    const out = new Map();
    const pu = ctx().powerUserSettings;
    for (const [id, name] of Object.entries(pu?.personas || {})) {
        if (!id) continue;
        const obj = { name: String(name ?? ''), descriptor: pu.persona_descriptions?.[id] ?? {} };
        out.set(`persona:${id}`, { key: `persona:${id}`, type: 'persona', id, obj, label: `Persona: ${name || id}` });
    }
    return out;
}

// Lorebooks are edited in place by ST's editor, so their hash is never cached by object.
const personaHash = obj => hash(stableJson(lean({ name: obj?.name, descriptor: obj?.descriptor })));
const itemHash = item => (item.type === 'preset' ? presetHash(item.obj)
    : item.type === 'card' ? localCardHash(item)
    : item.type === 'persona' ? personaHash(item.obj)
    : hash(stableJson(lean(item.obj))));

const blobToDataUrl = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

/** The persona's picture as a data URL (null when it can't be read or is very large). */
async function personaImage(id) {
    try {
        const res = await fetch(`User Avatars/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const blob = await res.blob();
        return blob.size && blob.size < 8_000_000 ? await blobToDataUrl(blob) : null;
    } catch { return null; }
}

/** Save a lorebook through ST, keeping its cache, list and open editor up to date. */
async function applyLorebook(name, obj) {
    const c = ctx();
    const isNew = !(c.getWorldInfoNames?.() || []).includes(name);
    await c.saveWorldInfo(name, obj, true);
    if (isNew) { try { await c.updateWorldInfoList?.(); } catch (e) { console.warn(LOG, e); } }
    try { await c.reloadWorldInfoEditor?.(name); } catch { /* editor not open */ }
}

/** Write a persona's name, description settings and picture; refresh the active persona's copy. */
async function applyPersona(id, obj, local) {
    const c = ctx();
    const pu = c.powerUserSettings;
    if (!pu) throw new Error('ST รุ่นนี้ไม่เปิดให้แก้ persona จาก extension');
    if (obj.image) {
        const blob = await (await fetch(obj.image)).blob();
        const form = new FormData();
        form.append('avatar', new File([blob], id, { type: blob.type || 'image/png' }));
        form.append('overwrite_name', id);
        const headers = { ...c.getRequestHeaders() };
        delete headers['Content-Type'];
        const res = await fetch('/api/avatars/upload', { method: 'POST', headers, body: form });
        if (!res.ok) console.warn(LOG, 'persona picture upload failed', res.status);
    }
    // The active persona's description is copied into power_user; keep that copy in step.
    const old = local?.obj?.descriptor;
    const active = old && pu.personas?.[id] === c.name1 && pu.persona_description === (old.description ?? '');
    pu.personas ??= {};
    pu.persona_descriptions ??= {};
    pu.personas[id] = obj.name;
    pu.persona_descriptions[id] = structuredClone(obj.descriptor ?? {});
    if (active) {
        const dsc = pu.persona_descriptions[id];
        pu.persona_description = dsc.description ?? '';
        if (dsc.position !== undefined) pu.persona_description_position = dsc.position;
        if (dsc.depth !== undefined) pu.persona_description_depth = dsc.depth;
        if (dsc.role !== undefined) pu.persona_description_role = dsc.role;
        pu.persona_description_lorebook = dsc.lorebook ?? '';
        try { jQuery('#persona_description').val(pu.persona_description); } catch { /* no UI */ }
    }
    c.saveSettingsDebounced();
}

const quickReplyPath = name => `/quickreplies/${dbxSeg(name)}.json`;
const regexPath = id => `/regex/${dbxSeg(id)}.json`;

// Quick Reply sets live in the Quick Reply extension's own module; ST's buttons hold
// references to those objects, so a set written from Dropbox only takes effect after a
// reload. Until then QR sync pauses, so the stale copy in memory is never sent back.
let qrModule;
let qrReloadNeeded = false;
async function quickReplySets() {
    if (qrModule === undefined) {
        try { qrModule = await import(new URL('../../quick-reply/src/QuickReplySet.js', import.meta.url).href); } catch (e) {
            console.warn(LOG, 'Quick Reply module not reachable; Quick Reply sync is off', e);
            qrModule = null;
        }
    }
    return qrModule?.QuickReplySet?.list ?? null;
}

/** Every Quick Reply set, keyed `qr:<name>`, in the form ST saves it. */
async function localQuickReplies() {
    const out = new Map();
    const list = await quickReplySets();
    if (!list || qrReloadNeeded) return out;
    for (const set of list) {
        if (!set?.name || set.isDeleted) continue;
        const obj = JSON.parse(JSON.stringify(set));
        out.set(`qr:${set.name}`, { key: `qr:${set.name}`, type: 'qr', name: set.name, obj, label: `Quick Reply: ${set.name}` });
    }
    return out;
}

/** Every global regex script, keyed `rx:<id>` (scoped scripts travel inside their card or preset). */
function localRegex() {
    const out = new Map();
    for (const script of ctx().extensionSettings?.regex || []) {
        if (!script?.id) continue;
        out.set(`rx:${script.id}`, { key: `rx:${script.id}`, type: 'rx', id: script.id, obj: script, label: `Regex: ${script.scriptName || script.id}` });
    }
    return out;
}

async function applyQuickReply(name, obj) {
    const res = await fetch('/api/quick-replies/save', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ ...obj, name }) });
    if (!res.ok) throw new Error(`บันทึก Quick Reply "${name}" ไม่สำเร็จ (${res.status})`);
    if (!qrReloadNeeded) {
        qrReloadNeeded = true;
        toast.info('Quick Reply อัปเดตจากอีกเครื่องแล้ว — แตะที่นี่เพื่อโหลดหน้าใหม่ให้ใช้ได้', 'ซิงค์', {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, onclick: () => location.reload(),
        });
    }
}

function applyRegex(id, obj) {
    const ext = ctx().extensionSettings;
    ext.regex ??= [];
    const i = ext.regex.findIndex(x => x?.id === id);
    const script = { ...structuredClone(obj), id };
    if (i >= 0) ext.regex[i] = script; else ext.regex.push(script);
    ctx().saveSettingsDebounced();
}

// Items whose deletion is synced (a marker under /deleted/, like chats).
const DELETABLE = { qr: 'quickreplies', rx: 'regex' };
const itemTombPath = item => `/deleted/${DELETABLE[item.type]}/${dbxSeg(item.type === 'qr' ? item.name : item.id)}.json`;
const itemPathOf = item => (item.type === 'qr' ? quickReplyPath(item.name) : regexPath(item.id));

/** Delete a Quick Reply set or regex script here because another device deleted it. */
async function deleteItemLocally(item) {
    if (item.type === 'qr') {
        const res = await fetch('/api/quick-replies/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name: item.name }) });
        if (!res.ok) throw new Error(`ลบ Quick Reply "${item.name}" ไม่สำเร็จ (${res.status})`);
        if (!qrReloadNeeded) {
            qrReloadNeeded = true;
            toast.info('Quick Reply เปลี่ยนจากอีกเครื่อง — แตะที่นี่เพื่อโหลดหน้าใหม่ให้ใช้ได้', 'ซิงค์', {
                timeOut: 0, extendedTimeOut: 0, closeButton: true, onclick: () => location.reload(),
            });
        }
    } else {
        const ext = ctx().extensionSettings;
        ext.regex = (ext.regex || []).filter(x => x?.id !== item.id);
        ctx().saveSettingsDebounced();
    }
}

/** Deleted here: take it out of Dropbox and leave a marker for the other devices. */
async function deleteItemEverywhere(item) {
    const marker = new Blob([JSON.stringify({ deleted: new Date().toISOString() })], { type: 'application/octet-stream' });
    const up = await dbxUpload(itemTombPath(item), marker, Date.now(), 'overwrite');
    try { await dbxRpc('files/delete_v2', { path: itemPathOf(item) }); } catch (e) {
        if (!/not_found/.test(String(e?.message))) throw e;
    }
    setItemBase(item.key, { deleted: true, rev: up.rev });
}

/** Deleted elsewhere, but keep it: put it back and drop the marker. */
async function keepDeletedItem(item) {
    await uploadItem(item, await itemHash(item), null);
    try { await dbxRpc('files/delete_v2', { path: itemTombPath(item) }); } catch { /* already gone */ }
}

// Regex scripts run in list order; the order travels as a list of ids in /regexorder.json.
const REGEX_ORDER_PATH = '/regexorder.json';
const regexIds = () => (ctx().extensionSettings?.regex || []).map(x => x?.id).filter(Boolean);

/** Put the local scripts in Dropbox's order; scripts Dropbox doesn't list keep their place at the end. */
function applyRegexOrder(ids) {
    const ext = ctx().extensionSettings;
    if (!Array.isArray(ext.regex)) return;
    const pos = new Map(ids.map((id, i) => [id, i]));
    const before = regexIds().join('\n');
    ext.regex = ext.regex.map((x, i) => [x, i])
        .sort((a, b) => (pos.get(a[0]?.id) ?? Infinity) - (pos.get(b[0]?.id) ?? Infinity) || a[1] - b[1])
        .map(([x]) => x);
    if (regexIds().join('\n') !== before) ctx().saveSettingsDebounced();
}

async function syncRegexOrder(entry, out) {
    if (!Array.isArray(ctx().extensionSettings?.regex)) return;
    const key = 'rxorder';
    const B = itemBase(key);
    const send = async rev => {
        const ids = regexIds();
        const up = await dbxUpload(REGEX_ORDER_PATH, new Blob([JSON.stringify(ids)], { type: 'application/octet-stream' }), Date.now(), rev ? { update: rev } : 'add');
        setItemBase(key, { rev: up.rev, hash: hash(ids.join('\n')) });
    };
    const lh = hash(regexIds().join('\n'));
    if (!entry) { if (regexIds().length) await send(null); return; }
    if (B && B.rev === entry.rev) { if (lh !== B.hash) await send(entry.rev); return; }
    const ids = JSON.parse(await dbxDownloadText(`rev:${entry.rev}`));
    const rh = hash((Array.isArray(ids) ? ids : []).join('\n'));
    if (lh !== rh) {
        // Dropbox's order wins unless only this side reordered since the last match.
        applyRegexOrder(Array.isArray(ids) ? ids : []);
        if (hash(regexIds().join('\n')) !== lh) out.itemsApplied.push('ลำดับ regex');
    }
    const now = hash(regexIds().join('\n'));
    if (now === rh) setItemBase(key, { rev: entry.rev, hash: rh });
    else { setItemBase(key, { rev: entry.rev, hash: rh }); await send(entry.rev); } // this side has scripts Dropbox's list lacks
}

async function localItemsOf(type) {
    return type === 'preset' ? localPresets() : type === 'card' ? localCards()
        : type === 'persona' ? localPersonas() : type === 'qr' ? await localQuickReplies()
        : type === 'rx' ? localRegex() : await localLorebooks();
}

/** The text of a PNG tEXt chunk (SillyTavern keeps the card JSON, base64, under "chara"). */
async function pngText(blob, keyword) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(buf.buffer);
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const len = view.getUint32(pos);
        const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
        if (type === 'tEXt') {
            const chunk = buf.subarray(pos + 8, pos + 8 + len);
            const zero = chunk.indexOf(0);
            if (zero > 0 && String.fromCharCode(...chunk.subarray(0, zero)) === keyword) {
                let out = '';
                for (const b of chunk.subarray(zero + 1)) out += String.fromCharCode(b);
                return out;
            }
        }
        if (type === 'IEND') break;
        pos += 12 + len;
    }
    return null;
}

async function cardFromPng(blob) {
    const b64 = await pngText(blob, 'chara');
    if (!b64) throw new Error('ไฟล์การ์ดไม่มีข้อมูลตัวละคร');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function downloadItem(entry) {
    if (entry.type === 'preset') {
        const obj = JSON.parse(await dbxDownloadText(`rev:${entry.rev}`));
        return { obj, hash: presetHash(obj) };
    }
    if (['wi', 'qr', 'rx'].includes(entry.type)) {
        const obj = JSON.parse(await dbxDownloadText(`rev:${entry.rev}`));
        return { obj, hash: hash(stableJson(lean(obj))) };
    }
    if (entry.type === 'persona') {
        const obj = JSON.parse(await dbxDownloadText(`rev:${entry.rev}`));
        return { obj, hash: personaHash(obj) };
    }
    const blob = await dbxDownloadBlob(`rev:${entry.rev}`);
    return { blob, hash: cardDataHash(await cardFromPng(blob)) };
}

async function uploadItem(item, h, rev) {
    let path, blob;
    if (item.type === 'preset') {
        path = presetPath(item.apiId, item.name);
        blob = new Blob([JSON.stringify(item.obj, null, 4)], { type: 'application/octet-stream' });
    } else if (item.type === 'wi' || item.type === 'qr' || item.type === 'rx') {
        path = item.type === 'wi' ? lorebookPath(item.name) : item.type === 'qr' ? quickReplyPath(item.name) : regexPath(item.id);
        blob = new Blob([JSON.stringify(item.obj, null, 4)], { type: 'application/octet-stream' });
    } else if (item.type === 'persona') {
        path = personaPath(item.id);
        // The picture travels along, but only name and description count as a change.
        blob = new Blob([JSON.stringify({ ...item.obj, image: await personaImage(item.id) })], { type: 'application/octet-stream' });
    } else {
        path = cardPath(item.avatar);
        const res = await fetch('/api/characters/export', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ format: 'png', avatar_url: item.avatar }) });
        if (!res.ok) throw new Error(`export การ์ดไม่สำเร็จ (${res.status})`);
        blob = await res.blob();
    }
    let up;
    try {
        up = await dbxUpload(path, blob, Date.now(), rev ? { update: rev } : 'add');
    } catch (e) {
        if (/conflict/.test(String(e?.message))) throw new Error('ใน Dropbox เพิ่งเปลี่ยน — จะเทียบใหม่รอบหน้า');
        throw e;
    }
    setItemBase(item.key, { rev: up.rev, hash: h });
}

/** Save a preset file and update ST's in-memory list; re-apply it when it is the one selected. */
async function applyPreset(apiId, name, obj) {
    const res = await fetch('/api/presets/save', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ preset: obj, name, apiId }) });
    if (!res.ok) throw new Error(`บันทึก preset "${name}" ไม่สำเร็จ (${res.status})`);
    name = (await res.json().catch(() => null))?.name ?? name;
    const pm = presetManager(apiId);
    if (!pm?.getPresetList) return;
    const { presets, preset_names } = pm.getPresetList(apiId);
    const keyed = Array.isArray(preset_names);
    let idx = keyed ? preset_names.indexOf(name) : preset_names[name];
    const asString = typeof presets[idx ?? 0] === 'string';
    const value = asString ? JSON.stringify(obj) : obj;
    if (pm.isAdvancedFormatting?.() && obj && typeof obj === 'object') obj.name = name;
    if (idx !== undefined && idx >= 0) {
        presets[idx] = value;
    } else {
        presets.push(value);
        idx = presets.length - 1;
        if (keyed && !pm.isAdvancedFormatting?.()) preset_names[idx] = name;
        if (!keyed) preset_names[name] = idx;
        if (pm.select) jQuery(pm.select).append(jQuery('<option></option>', { value: keyed ? name : idx, text: name }));
    }
    if (pm.getSelectedPresetName?.() === name) await pm.selectPreset(keyed ? name : String(idx));
}

/** Import a card PNG over the one with the same file name, keeping this side's last chat and favourite. */
async function applyCard(avatar, blob, localCh) {
    const c = ctx();
    const form = new FormData();
    form.append('avatar', new File([blob], avatar, { type: 'image/png' }));
    form.append('file_type', 'png');
    form.append('preserved_name', avatar);
    const headers = { ...c.getRequestHeaders() };
    delete headers['Content-Type'];
    const res = await fetch('/api/characters/import', { method: 'POST', headers, body: form });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.error) throw new Error(`นำเข้าการ์ด ${avatar} ไม่สำเร็จ (${res.status})`);
    if (localCh && (localCh.chat || localCh.fav)) {
        const fav = !!(localCh.fav || localCh.data?.extensions?.fav);
        await fetch('/api/characters/merge-attributes', {
            method: 'POST', headers: c.getRequestHeaders(),
            body: JSON.stringify({ avatar, ...(localCh.chat ? { chat: localCh.chat } : {}), fav, data: { extensions: { fav } } }),
        }).catch(() => null);
    }
    cardHashCache.delete(avatar);
}

async function applyItem(entry, content, local) {
    if (entry.type === 'preset') await applyPreset(entry.apiId, entry.name, content.obj);
    else if (entry.type === 'wi') await applyLorebook(entry.name, content.obj);
    else if (entry.type === 'persona') await applyPersona(entry.id, content.obj, local);
    else if (entry.type === 'qr') await applyQuickReply(entry.name, content.obj);
    else if (entry.type === 'rx') applyRegex(entry.id, content.obj);
    else await applyCard(entry.avatar, content.blob, local?.ch);
}

/** After cards changed: reload ST's character list and remember what this side now has. */
async function refreshCardsAfter(applied) {
    if (!applied.length) return;
    try { await ctx().getCharacters?.(); } catch (e) { console.warn(LOG, e); }
    const now = localCards();
    for (const { key, rev } of applied) {
        const item = now.get(key);
        // ST may tidy a card on import; take its own reading as the matched state.
        if (item) { try { setItemBase(key, { rev, hash: await localCardHash(item) }); } catch { /* next round */ } }
    }
}

/**
 * Sync presets and cards with Dropbox (run inside the Dropbox lock, before chats so that
 * new characters exist when their chats arrive). auto: stop after ~15 s, continue next round.
 */
async function syncItems(entries, out, { auto = false } = {}) {
    const d = dbxSettings();
    const doPresets = d.syncPresets !== false, doCards = d.syncCards !== false;
    const doWorlds = d.syncLorebooks !== false, doPersonas = d.syncPersonas !== false;
    const doQr = d.syncQuickReplies !== false && !qrReloadNeeded, doRegex = d.syncRegex !== false;
    if (!doPresets && !doCards && !doWorlds && !doPersonas && !doQr && !doRegex) return;
    const remote = new Map();
    const tombs = new Map(); // deletion markers (Quick Reply, regex)
    let regexOrder = null;
    for (const e of entries) {
        const parts = String(e.path_display || '').split('/').filter(Boolean);
        if (doPresets && parts[0] === 'presets' && parts.length === 3 && PRESET_APIS.includes(parts[1]) && /\.json$/i.test(parts[2])) {
            const name = dbxUnseg(parts[2].replace(/\.json$/i, ''));
            remote.set(`p:${parts[1]}:${name}`, { ...e, type: 'preset', apiId: parts[1], name, label: `${PRESET_LABEL[parts[1]]}: ${name}` });
        } else if (doCards && parts[0] === 'cards' && parts.length === 2 && /\.png$/i.test(parts[1])) {
            const avatar = dbxUnseg(parts[1]);
            remote.set(`card:${avatar}`, { ...e, type: 'card', avatar, label: `การ์ด: ${avatar.replace(/\.png$/i, '')}` });
        } else if (doWorlds && parts[0] === 'worlds' && parts.length === 2 && /\.json$/i.test(parts[1])) {
            const name = dbxUnseg(parts[1].replace(/\.json$/i, ''));
            remote.set(`wi:${name}`, { ...e, type: 'wi', name, label: `Lorebook: ${name}` });
        } else if (doPersonas && parts[0] === 'personas' && parts.length === 2 && /\.json$/i.test(parts[1])) {
            const id = dbxUnseg(parts[1].replace(/\.json$/i, ''));
            remote.set(`persona:${id}`, { ...e, type: 'persona', id, label: `Persona: ${id}` });
        } else if (doQr && parts[0] === 'quickreplies' && parts.length === 2 && /\.json$/i.test(parts[1])) {
            const name = dbxUnseg(parts[1].replace(/\.json$/i, ''));
            remote.set(`qr:${name}`, { ...e, type: 'qr', name, label: `Quick Reply: ${name}` });
        } else if (doRegex && parts[0] === 'regex' && parts.length === 2 && /\.json$/i.test(parts[1])) {
            const id = dbxUnseg(parts[1].replace(/\.json$/i, ''));
            remote.set(`rx:${id}`, { ...e, type: 'rx', id, label: `Regex: ${id}` });
        } else if (parts[0] === 'deleted' && parts.length === 3 && /\.json$/i.test(parts[2])) {
            const v = dbxUnseg(parts[2].replace(/\.json$/i, ''));
            if (doQr && parts[1] === 'quickreplies') tombs.set(`qr:${v}`, { ...e, type: 'qr', name: v, label: `Quick Reply: ${v}` });
            if (doRegex && parts[1] === 'regex') tombs.set(`rx:${v}`, { ...e, type: 'rx', id: v, label: `Regex: ${v}` });
        } else if (doRegex && parts.length === 1 && parts[0] === 'regexorder.json') {
            regexOrder = e;
        }
    }
    const local = new Map([
        ...(doPresets ? localPresets() : []), ...(doCards ? localCards() : []),
        ...(doWorlds ? await localLorebooks() : []), ...(doPersonas ? localPersonas() : []),
        ...(doQr ? await localQuickReplies() : []), ...(doRegex ? localRegex() : []),
    ]);
    // Quick Reply module unreachable (or waiting for a reload): leave Dropbox's sets alone.
    const qrReachable = doQr && !!(await quickReplySets());
    if (doQr && !qrReachable) for (const map of [remote, tombs]) for (const k of [...map.keys()]) if (k.startsWith('qr:')) map.delete(k);
    // Only trust "missing here" as a deletion when the local list could really be read.
    const deletesOn = d.syncDeletes !== false;
    const listedHere = type => (type === 'qr' ? qrReachable : type === 'rx' ? Array.isArray(ctx().extensionSettings?.regex) : false);
    const keys = [...new Set([...remote.keys(), ...local.keys(), ...tombs.keys()])];
    const deadline = auto ? Date.now() + 15_000 : Infinity;
    const cardsApplied = [];
    for (let i = 0; i < keys.length && Date.now() < deadline; i++) {
        const key = keys[i];
        const L = local.get(key), R = remote.get(key), B = itemBase(key), T = tombs.get(key);
        const label = (L || R || T).label;
        sync.progress = `กำลังตรวจ preset/การ์ด/lorebook/persona/QR/regex ${i + 1}/${keys.length}…`;
        renderSyncStatus();
        try {
            if (!R && T) {
                // Deleted on another device.
                if (!L) { setItemBase(key, { deleted: true, rev: T.rev }); continue; }
                if (B?.deleted && B.rev === T.rev) { await keepDeletedItem(L); out.itemsSent++; continue; } // made again here since
                if (B && !B.deleted && (await itemHash(L)) === B.hash) {
                    await deleteItemLocally(L);
                    setItemBase(key, { deleted: true, rev: T.rev });
                    out.itemsApplied.push(`ลบ ${label}`);
                    continue;
                }
                const waitingDel = sync.decisions.find(x => x.kind === 'itemdel' && x.t.key === key && x.rev === T.rev);
                if (!waitingDel || !auto) {
                    out.decisions.push({ kind: 'itemdel', t: { key, label, chatId: '' }, rev: T.rev, item: L, when: Date.parse(T.server_modified) || 0, local: { count: 0 }, remote: { count: 0 } });
                } else out.decisions.push(waitingDel);
                continue;
            }
            if (!R) {
                if (!L) continue;
                // Not in Dropbox yet (or deleted there): send it.
                await uploadItem(L, await itemHash(L), null);
                out.itemsSent++;
                continue;
            }
            if (B && B.rev === R.rev) {
                if (!L) {
                    // Deleted here since the last match.
                    if (DELETABLE[R.type] && deletesOn && listedHere(R.type)) { await deleteItemEverywhere({ ...R, key }); out.itemsSent++; }
                    continue;
                }
                const lh = await itemHash(L);
                if (lh !== B.hash) { await uploadItem(L, lh, R.rev); out.itemsSent++; }
                continue;
            }
            const waiting = sync.decisions.find(x => x.kind === 'item' && x.t.key === key && x.rev === R.rev);
            if (waiting && auto) { out.decisions.push(waiting); continue; }
            const content = await downloadItem(R);
            if (R.type === 'persona' && content.obj?.name) R.label = `Persona: ${content.obj.name}`;
            if (R.type === 'rx' && content.obj?.scriptName) R.label = `Regex: ${content.obj.scriptName}`;
            const lh = L ? await itemHash(L) : null;
            if (lh === content.hash) { setItemBase(key, { rev: R.rev, hash: lh }); continue; }
            if (!L || (B && lh === B.hash)) {
                await applyItem(R, content, L);
                setItemBase(key, { rev: R.rev, hash: content.hash });
                if (R.type === 'card') cardsApplied.push({ key, rev: R.rev });
                out.itemsApplied.push(L?.label ?? R.label);
                continue;
            }
            if (B && content.hash === B.hash) { await uploadItem(L, lh, R.rev); out.itemsSent++; continue; }
            out.decisions.push({
                kind: 'item', t: { key, label, chatId: '' }, rev: R.rev, entry: R, item: L,
                when: Date.parse(R.client_modified) || Date.parse(R.server_modified) || 0,
                local: { count: 0 }, remote: { count: 0 },
            });
        } catch (e) {
            console.warn(LOG, 'item sync', key, e);
            out.errors.push(`${label}: ${e?.message ?? e}`);
            if (/Dropbox (ขอให้รอ|ยกเลิกสิทธิ์)/.test(String(e?.message))) break;
        }
    }
    await refreshCardsAfter(cardsApplied);
    if (doRegex && Date.now() < deadline) {
        try { await syncRegexOrder(regexOrder, out); } catch (e) { out.errors.push(`ลำดับ regex: ${e?.message ?? e}`); }
    }
}

/** "Use Dropbox's" / "use this side's" / (presets) "keep both" for an item changed on both sides. */
async function resolveItem(x, how) {
    const key = x.t.key;
    if (how === 'local') {
        const item = (await localItemsOf(x.item.type)).get(key);
        if (!item) throw new Error('ไม่มีในเครื่องนี้แล้ว');
        await uploadItem(item, await itemHash(item), x.rev);
        return;
    }
    const content = await downloadItem(x.entry);
    if (how === 'both') {
        const copy = `${x.entry.name} (Dropbox)`;
        await applyPreset(x.entry.apiId, copy, structuredClone(content.obj));
        const presets = localPresets();
        const copied = presets.get(`p:${x.entry.apiId}:${copy}`);
        if (copied) await uploadItem(copied, presetHash(copied.obj), itemBase(copied.key)?.rev ?? null);
        const item = presets.get(key);
        if (item) await uploadItem(item, presetHash(item.obj), x.rev);
        return copy;
    }
    await applyItem(x.entry, content, x.item);
    setItemBase(key, { rev: x.rev, hash: content.hash });
    if (x.entry.type === 'card') await refreshCardsAfter([{ key, rev: x.rev }]);
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
    setTimeout(checkForNewVersion, 3000);
    wirePockyPanel();
    refreshPockyPanel().catch(e => console.warn(LOG, e));
    console.log(LOG, 'loaded');
}

// expose for debugging / tests
globalThis.ChatAutoBackup = { captureNow, store, flush, schedule, dbAllMeta, dbMetaByKey, snapshotText, exportAll, importFile, restoreAsNewChat, openBrowser, checkLoadedChat, backupNow, settings, updateIndicator, cleanText, describeChanges, deriveFromJsonl, cloudTick, cloudPull, syncPull, syncNow, showSyncDecisions, showAttention, checkForNewVersion, reloadWithFreshFiles, VERSION };

if (typeof jQuery === 'function') jQuery(init); else init();
