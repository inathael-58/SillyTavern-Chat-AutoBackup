// On-screen diagnostics for a SillyTavern extension panel.
// Phones have no console, so "it doesn't open" carries no information. The Diagnose button
// opens the panel, measures what is really on screen, closes it again and shows a report
// the user can copy. The report lives in the Extensions drawer, which ST itself keeps visible
// even when our panel is not.
//
// Same file in every extension; configure it with createDiagnostics({...}).

/**
 * @param {object} o
 * @param {string} o.name            shown in toasts and the report
 * @param {string} o.version         the running version
 * @param {URL}    o.baseUrl         the extension folder (new URL('.', import.meta.url))
 * @param {() => any} o.open         opens the panel (may return a promise)
 * @param {() => any} o.close        closes it again
 * @param {() => boolean} o.isOpen
 * @param {() => Element|null} o.overlay  the full-screen layer (or the panel itself)
 * @param {() => Element|null} [o.frame]  the visible card/sheet inside it
 * @param {() => string} [o.state]   one line of settings worth reporting
 */
export function createDiagnostics(o) {
    const log = [];
    const LOG = `[${o.name}]`;
    let openedAt = 0;

    function diag(msg) {
        log.push(`${new Date().toISOString().slice(11, 23)} ${msg}`);
        if (log.length > 30) log.shift();
    }
    const caller = () => (new Error().stack || '').split('\n').slice(2, 5).map(x => x.trim()).join(' < ');

    /** Call when the panel opens / closes, so the log shows a close that follows an open too soon. */
    function noteOpen(what = '') { openedAt = Date.now(); diag(`open ${what}`.trim()); }
    function noteClose() { diag(`close ${openedAt ? `${Date.now() - openedAt}ms หลังเปิด` : ''} · ${caller()}`); }

    /** Show an error on screen as well as in the console. */
    function reportError(where, err) {
        console.error(LOG, where, err);
        diag(`ERROR ${where}: ${err?.stack || err}`);
        try { globalThis.toastr?.error(`${where}: ${err?.message ?? err}`, o.name, { timeOut: 15000, extendedTimeOut: 15000 }); } catch { /* ignore */ }
    }

    const base = o.baseUrl.href;
    window.addEventListener('error', e => {
        if (String(e.filename || '').startsWith(base)) diag(`window error ${e.message} @${String(e.filename).slice(base.length)}:${e.lineno}`);
    });
    window.addEventListener('unhandledrejection', e => {
        if (String(e.reason?.stack || '').includes(base)) diag(`unhandled ${e.reason?.message ?? e.reason}`);
    });

    const elName = el => {
        if (!el) return 'null';
        const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
        return `${el.tagName?.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}`;
    };
    const rect = el => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };

    /** Ancestors whose style makes position:fixed follow them instead of the screen, or that hide everything. */
    function fixedBreakers(el) {
        const out = [];
        for (let n = el?.parentElement; n; n = n.parentElement) {
            const cs = getComputedStyle(n);
            const bad = ['transform', 'perspective', 'filter', 'backdropFilter', 'contain', 'willChange']
                .filter(k => cs[k] && !['none', 'normal', 'auto', ''].includes(cs[k]))
                .map(k => `${k}:${cs[k]}`);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') bad.push(`display:${cs.display} visibility:${cs.visibility} opacity:${cs.opacity}`);
            if (bad.length) out.push(`${elName(n)} {${bad.join('; ')}}`);
        }
        return out;
    }

    /** Open the panel, measure it, close it again, and return the report as text. */
    async function run() {
        const lines = [];
        const add = (k, v) => lines.push(`${k}: ${v}`);
        let remote = '?';
        try { remote = String((await (await fetch(new URL('manifest.json', o.baseUrl), { cache: 'no-store' })).json())?.version ?? '?'); } catch { /* offline */ }
        add('version', `v${o.version} (server ${remote})`);
        add('ua', navigator.userAgent);
        const vv = window.visualViewport;
        add('viewport', `${innerWidth}x${innerHeight} · vv ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} @${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)} scale ${vv.scale}` : '-'} · dpr ${devicePixelRatio}`);
        add('scroll', `window ${scrollX},${scrollY} · html ${document.documentElement.scrollTop} · body ${document.body.scrollTop}`);
        add('html class', document.documentElement.className || '-');
        if (o.state) { try { add('settings', o.state()); } catch (err) { add('settings', `อ่านไม่ได้: ${err?.message ?? err}`); } }

        const before = log.length;
        const wasOpen = !!o.isOpen();
        if (!wasOpen) {
            try { await o.open(); } catch (err) { reportError('เปิดแผงไม่ได้', err); }
        }
        await new Promise(r => setTimeout(r, 700));
        const ov = o.overlay();
        add('overlay', ov ? `inDOM=${document.body.contains(ov)} parent=${elName(ov.parentElement)} ${elName(ov)}` : 'ไม่มี');
        if (ov) {
            const cs = getComputedStyle(ov);
            add('overlay style', `display:${cs.display} visibility:${cs.visibility} opacity:${cs.opacity} position:${cs.position} z:${cs.zIndex} transform:${cs.transform}`);
            add('overlay rect', rect(ov)); // a height of 0 means position:fixed is sized against something other than the screen
            const fr = o.frame?.();
            if (fr) { const cf = getComputedStyle(fr); add('frame', `${rect(fr)} opacity:${cf.opacity} transform:${cf.transform}`); }
            const target = fr || ov;
            const r = target.getBoundingClientRect();
            const pts = r.width && r.height
                ? [[0.5, 0.15], [0.5, 0.5], [0.5, 0.85]].map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy])
                : [[innerWidth / 2, innerHeight / 2]];
            add('ที่จุดบนจอ', pts.map(([x, y]) => {
                const el = document.elementFromPoint(x, y);
                return `${Math.round(x)},${Math.round(y)}=${ov.contains(el) ? 'แผง' : elName(el)}`;
            }).join(' · '));
            const br = fixedBreakers(ov);
            add('ตัวบัง fixed', br.length ? br.join(' | ') : 'ไม่มี');
        }
        add('log', '');
        lines.push(...log.slice(Math.max(0, before - 8)).map(x => '  ' + x));
        if (!wasOpen && o.isOpen()) { try { await o.close(); } catch { /* ignore */ } }
        return lines.join('\n');
    }

    /** Put the Diagnose button into `btnHost` and its report box after `boxAfter` (default: after btnHost). */
    function mount(btnHost, boxAfter = btnHost) {
        if (!btnHost || btnHost.querySelector('[data-diag-run]')) return;
        const btn = document.createElement('div');
        btn.className = 'menu_button';
        btn.dataset.diagRun = '';
        btn.title = `ทดลองเปิด ${o.name} แล้ววัดว่าเกิดอะไรขึ้น ได้รายงานไว้คัดลอกส่งให้คนแก้`;
        btn.innerHTML = '<i class="fa-solid fa-stethoscope"></i> ตรวจปัญหา';
        btnHost.appendChild(btn);
        const box = document.createElement('div');
        box.hidden = true;
        box.style.margin = '6px 0';
        box.innerHTML = `<textarea class="text_pole" readonly rows="10" style="width:100%;font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre"></textarea>
            <div class="menu_button" data-diag-copy style="width:fit-content;display:inline-flex;gap:6px;align-items:center"><i class="fa-solid fa-copy"></i> คัดลอกรายงาน</div>`;
        boxAfter.insertAdjacentElement('afterend', box);
        const ta = box.querySelector('textarea');
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            let text;
            try { text = await run(); } catch (err) { text = `ตรวจไม่สำเร็จ: ${err?.stack || err}\n${log.join('\n')}`; }
            box.hidden = false;
            ta.value = text;
        });
        box.querySelector('[data-diag-copy]').addEventListener('click', async e => {
            e.stopPropagation();
            try { await navigator.clipboard.writeText(ta.value); globalThis.toastr?.success('คัดลอกรายงานแล้ว', '', { timeOut: 1500 }); }
            catch { ta.focus(); ta.select(); globalThis.toastr?.info('เลือกข้อความไว้แล้ว กดคัดลอกเองได้เลย'); }
        });
    }

    /** Register /<command> returning the report (no-op on SillyTavern builds without the parser). */
    function registerCommand(c, command) {
        try {
            if (!c?.SlashCommandParser?.addCommandObject || !c?.SlashCommand?.fromProps) return;
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: command,
                callback: async () => run(),
                helpString: `ตรวจปัญหา ${o.name} แล้วคืนรายงาน (ดูหรือคัดลอกได้จาก Extensions → ${o.name} → ตรวจปัญหา)`,
            }));
        } catch (err) { console.warn(LOG, 'slash command', err); }
    }

    return { diag, noteOpen, noteClose, reportError, run, mount, registerCommand };
}
