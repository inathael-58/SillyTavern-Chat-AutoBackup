// theme-palette.js — แม่แบบสีที่อ่านออกเสมอ สำหรับ extension ของ SillyTavern
// ใช้ร่วมกันในทุก extension ของ inathael-58 · คัดลอกไฟล์นี้ทั้งไฟล์ อย่าแก้แยกที่ใดที่หนึ่ง
// PALETTE_VERSION 4
//
// ปัญหาที่แก้:
//  1. ช่องสีของธีม (Quote/Italics/Underline) ถูกตั้งให้ตัดกับ "พื้นแชท" แต่แผงของ extension วางบน "พื้น UI"
//     ธีมจำนวนมากจึงได้สีเน้นกลืนกับพื้น (ครีมบนเบจ น้ำตาลเข้มบนเขียวเข้ม)
//  2. พื้น UI ของธีม (--SmartThemeBlurTintColor) มักโปร่งใส และ CSS `rgb(from …)` ที่ใช้ทำให้ทึบ
//     คำนวณไม่ได้บน Safari บางรุ่น แผงข้อมูลจึงเห็นแชทด้านหลังทะลุขึ้นมา
//
// วิธี: อ่านสีธีมจริงด้วย JS → ทำพื้นให้ทึบ → เลื่อนความสว่างของแต่ละสี (คงโทนเดิม) จนตัดกับพื้นถึงเกณฑ์
//   ตัวอักษร ≥ 4.5:1 · สีเน้น/สถานะ/ไอคอน ≥ 3:1 · สีกลุ่มในกราฟ ≥ 2.6:1
// แล้วเขียนเป็นตัวแปร CSS บน <html>:  --{prefix}-p-*  (ทุกค่าเป็นสีทึบ ไม่ต้องพึ่ง color-mix)
//
//   surface      พื้นแผงข้อมูล (ทึบ 97%)          surface2   พื้นการ์ด/ช่องกรอกในแผง (ทึบ)
//   fg           ตัวอักษรหลัก                      muted      ตัวอักษรรอง
//   line         เส้นขอบ                           accent     สีเน้นจากช่องที่เลือก (≥3:1 ขอบ/ไอคอน/กราฟ)
//   accent-text  สีเน้นสำหรับตัวอักษร (≥4.5:1)       accent-soft  พื้นอ่อนของสีเน้น (ทึบ)
//   on-accent    ตัวอักษรบนพื้นสีเน้น (ขาว ≥4.5:1 หรือเข้ม ≥7:1 — accent ถูกเลื่อนให้ได้ตามนี้)              em · underline  สีตัวเอียง/ขีดเส้นใต้ของธีม ปรับให้อ่านได้ (≥4.5:1)
//   ok · warn · danger   สีสถานะ                   c1 … c6    สีกลุ่มสำหรับกราฟ/แท็ก
//
// กติกา: แผงที่แสดงข้อมูลใช้ surface (ทึบ) · ปุ่ม/ไอคอนลอยโปร่งได้ตามดีไซน์ ไม่ต้องใช้ตัวแปรนี้
//
// ทางลัดสำหรับ extension ที่ใช้ --SmartTheme* ตรง ๆ ทั่วไฟล์: เขียนทับตัวแปรธีมเฉพาะในแผงของเรา
// (ทำงานเมื่อคำนวณสำเร็จแล้วเท่านั้น — <html> จะมี class "{prefix}-pal")
//   html.pw-pal :is(#pw_overlay, .pw-settings) {
//       --SmartThemeBlurTintColor: var(--pw-p-surface);   --SmartThemeBodyColor: var(--pw-p-fg);
//       --SmartThemeQuoteColor: var(--pw-p-accent-text);  --SmartThemeBorderColor: var(--pw-p-line);
//       --SmartThemeEmColor: var(--pw-p-em);              --SmartThemeUnderlineColor: var(--pw-p-underline);
//   }
//
// พื้นตายตัวของ extension เอง (เช่น โหมดสว่าง/มืดที่ผู้ใช้เลือก): ส่ง surfaces แล้วได้สีเน้นที่ตัดกับพื้นนั้น
//   installThemePalette({ prefix: 'cbp', surfaces: { light: '#fbfaf7', dark: '#1b1a21' } })
//   → --cbp-p-accent-light, --cbp-p-accent-dark  (≥4.5:1 กับพื้นนั้น คงโทนสีเน้นของธีม)
//
// สีประจำตัวของ extension ที่ใช้เป็นตัวอักษรบนแผง: ส่ง colors แล้วได้เวอร์ชันที่อ่านออกบนพื้นแผง (คงโทนเดิม)
//   installThemePalette({ prefix: 'ec', colors: { sun: '#f2a03d' } })  →  --ec-p-sun  (≥4.5:1)
//
// ใช้:
//   import { installThemePalette } from './theme-palette.js';
//   const palette = installThemePalette({ prefix: 'pw' });          // สีเน้นจาก Quote
//   palette.setAccent('em');                                          // เปลี่ยนช่องสีเน้น
//   ใน CSS:  --pw-accent: var(--pw-p-accent, var(--SmartThemeQuoteColor));   (ค่าเดิมเป็นสำรอง)

export const PALETTE_VERSION = 4;

export const ACCENT_SOURCES = Object.freeze({
    quote: '--SmartThemeQuoteColor',
    em: '--SmartThemeEmColor',
    underline: '--SmartThemeUnderlineColor',
    body: '--SmartThemeBodyColor',
});

// ── สี ──

export function parseColor(str) {
    const t = String(str || '');
    let m = t.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+)(%?))?/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : (m[5] ? +m[4] / 100 : +m[4])];
    m = t.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    return null;
}
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
}
export function hslToRgb([h, s, l]) {
    h = ((h % 360) + 360) % 360 / 360;
    if (!s) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const t = x => { x = (x + 1) % 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
    return [t(h + 1 / 3) * 255, t(h) * 255, t(h - 1 / 3) * 255];
}
/** เลื่อนความสว่าง (คงโทนสี) จนตัดกับพื้นอย่างน้อย min */
export function ensureContrast(rgb, bg, min) {
    if (contrast(rgb, bg) >= min) return rgb;
    const [h, s, l0] = rgbToHsl(rgb);
    const goDark = luminance(bg) > 0.18;
    for (let i = 1; i <= 40; i++) {
        const l = goDark ? l0 - i * 0.025 : l0 + i * 0.025;
        if (l < 0 || l > 1) break;
        const c = hslToRgb([h, s, l]);
        if (contrast(c, bg) >= min) return c;
    }
    return goDark ? [20, 20, 24] : [240, 240, 236];
}
const WHITE = [255, 255, 255];
const INK = [20, 20, 24];
/**
 * พื้นสีที่มีตัวอักษรวางทับ (ปุ่มหลัก ป้ายตัวเลข แท็บที่เลือก): คงโทนสี เลื่อนแค่ความสว่าง จน
 * ตัวอักษรขาวได้ ≥ 4.5:1 หรือตัวอักษรเข้มได้ ≥ 7:1 และพื้นยังตัดกับ bg ≥ minBg
 * ทำไมเข้มต้อง 7: ตัวอักษรดำบนสีกลาง ๆ (ชมพู ม่วง ฟ้า) อ่านยากกว่าที่ค่า contrast บอกมาก
 * เช่น ดำบนชมพูอมม่วงได้ 4.9:1 แต่ผู้ใช้อ่านไม่ออกบนมือถือ — สีกลางจึงถูกทำให้เข้มลงแล้วใช้ตัวขาว
 * @returns {{ fill: number[], on: number[] }}
 */
export function fillFor(rgb, bg, minBg = 3) {
    if (contrast(WHITE, rgb) >= 4.5) return { fill: rgb, on: WHITE };
    if (contrast(INK, rgb) >= 7) return { fill: rgb, on: INK };
    const L = luminance(rgb);
    const options = [
        { fill: ensureContrast(rgb, WHITE, 4.5), on: WHITE },
        { fill: ensureContrast(rgb, INK, 7), on: INK },
    ].filter(o => !bg || contrast(o.fill, bg) >= minBg)
        .sort((a, b) => Math.abs(luminance(a.fill) - L) - Math.abs(luminance(b.fill) - L));
    return options[0] ?? { fill: rgb, on: contrast(WHITE, rgb) >= contrast(INK, rgb) ? WHITE : INK };
}
const flatten = (c, bg) => (c[3] === undefined || c[3] >= 1 ? c.slice(0, 3) : c.slice(0, 3).map((v, i) => v * c[3] + bg[i] * (1 - c[3])));
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const css = c => `rgb(${c.map(v => Math.round(Math.max(0, Math.min(255, v)))).join(', ')})`;

/** คำนวณชุดสีจากสีธีมที่อ่านมา (ฟังก์ชันล้วน ใช้ทดสอบได้) */
export function computePalette(theme, accentName = 'quote', surfaces = {}, colors = {}) {
    const tint = theme['--SmartThemeBlurTintColor'], chat = theme['--SmartThemeChatTintColor'];
    // พื้น UI ที่โปร่งเกือบหมด มักไม่มีความหมายของสีจริง — ใช้พื้นแชทแทน
    const pick = tint && tint[3] >= 0.08 ? tint : chat && chat[3] >= 0.08 ? chat : tint;
    if (!pick) return null;
    const bg = pick.slice(0, 3);
    const light = luminance(bg) > 0.18;
    const body = theme['--SmartThemeBodyColor'];
    const fg = ensureContrast(body ? flatten(body, bg) : (light ? [30, 30, 34] : [230, 230, 222]), bg, 4.5);
    const src = ACCENT_SOURCES[accentName] ?? ACCENT_SOURCES.quote;
    const raw = theme[src] ? flatten(theme[src], bg) : fg;
    let [ah, as] = rgbToHsl(raw);
    if (as < 0.12) as = 0;
    // accent ใช้เป็นทั้งเส้นขอบ (≥3:1 กับพื้น) และพื้นปุ่ม/ป้ายที่มีตัวอักษร on-accent ทับ
    const { fill: accent, on: onAccent } = fillFor(ensureContrast(raw, bg, 3), bg, 3);
    const accentText = ensureContrast(raw, bg, 4.5);
    const textOf = v => css(ensureContrast(theme[v] ? flatten(theme[v], bg) : fg, bg, 4.5));
    const sat = as ? Math.min(0.75, Math.max(0.42, as)) : 0.45;
    const hue = (dh, sMul = 1) => ensureContrast(hslToRgb([ah + dh, sat * sMul, light ? 0.42 : 0.66]), bg, 2.6);
    const status = (h, s) => ensureContrast(hslToRgb([h, s, light ? 0.4 : 0.62]), bg, 3);
    const surface2 = mix(bg, fg, 0.06);
    return {
        surface: `rgba(${bg.map(v => Math.round(v)).join(', ')}, 0.97)`,
        surface2: css(surface2),
        fg: css(fg),
        muted: css(ensureContrast(mix(bg, fg, 0.65), bg, 3)),
        line: css(mix(bg, fg, 0.22)),
        accent: css(accent),
        'accent-text': css(accentText),
        em: textOf('--SmartThemeEmColor'),
        underline: textOf('--SmartThemeUnderlineColor'),
        'accent-soft': css(mix(bg, accent, 0.16)),
        'on-accent': css(onAccent),
        ok: css(status(140, 0.5)),
        warn: css(status(38, 0.9)),
        danger: css(status(356, 0.78)),
        c1: css(hue(60)), c2: css(hue(140)), c3: css(hue(200)), c4: css(hue(260)), c5: css(hue(320, 0.8)), c6: css(hue(30, 0.3)),
        ...Object.fromEntries(Object.entries(surfaces).map(([name, value]) => {
            const s = parseColor(value) ?? hexToRgb(value);
            return s ? [`accent-${name}`, css(ensureContrast(raw, s.slice(0, 3), 4.5))] : null;
        }).filter(Boolean)),
        ...Object.fromEntries(Object.entries(colors).map(([name, value]) => {
            const c = parseColor(value) ?? hexToRgb(value);
            return c ? [name, css(ensureContrast(c.slice(0, 3), bg, 4.5))] : null;
        }).filter(Boolean)),
        light,
    };
}
function hexToRgb(hex) {
    const m = String(hex || '').trim().match(/^#?([\da-f]{3}|[\da-f]{6})$/i);
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

// ── ติดตั้ง ──

const THEME_VARS = ['--SmartThemeBlurTintColor', '--SmartThemeChatTintColor', '--SmartThemeBodyColor', ...Object.values(ACCENT_SOURCES)];

function readTheme() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none';
    document.body.append(probe);
    const out = {};
    for (const v of THEME_VARS) {
        probe.style.color = `var(${v})`;
        out[v] = parseColor(getComputedStyle(probe).color);
    }
    probe.remove();
    return out;
}

/**
 * @param {{ prefix: string, accent?: string|(() => string), surfaces?: Record<string, string>, colors?: Record<string, string> }} opts
 * prefix  ชื่อนำหน้าตัวแปร เช่น 'pw' → --pw-p-accent
 * accent  ชื่อช่องสีเน้น ('quote' | 'em' | 'underline' | 'body') หรือฟังก์ชันที่คืนชื่อนั้น
 * surfaces  พื้นตายตัวของ extension { ชื่อ: สี } → ได้ --{prefix}-p-accent-{ชื่อ}
 * colors    สีประจำตัวของ extension { ชื่อ: สี } → ได้ --{prefix}-p-{ชื่อ} ที่อ่านออกบนพื้นแผง
 */
export function installThemePalette({ prefix, accent = 'quote', surfaces = {}, colors = {} } = {}) {
    if (!prefix) throw new Error('theme-palette: prefix required');
    let accentOf = typeof accent === 'function' ? accent : () => accent;
    let last = '';
    let timer = null;
    const listeners = new Set();
    const root = document.documentElement;

    function refresh() {
        try {
            const p = computePalette(readTheme(), accentOf(), surfaces, colors);
            if (!p) return null;
            const key = JSON.stringify(p);
            if (key !== last) {
                last = key;
                for (const [k, v] of Object.entries(p)) if (k !== 'light') root.style.setProperty(`--${prefix}-p-${k}`, v);
                root.style.setProperty(`--${prefix}-p-scheme`, p.light ? 'light' : 'dark');
                root.classList.add(`${prefix}-pal`);
                for (const fn of listeners) { try { fn(p); } catch { /* ignore */ } }
            }
            return p;
        } catch (err) {
            console.warn(`[theme-palette:${prefix}]`, err);
            return null;
        }
    }
    const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, 250); };

    // ST เปลี่ยนธีมด้วยการตั้งตัวแปรสีบน <html>/<body> และ class ของ <body>
    // การเขียนตัวแปรของเราเองก็ทำให้ observer ทำงาน แต่ค่าที่คำนวณได้จะเท่าเดิม (key ไม่เปลี่ยน) จึงไม่วนซ้ำ
    const obs = new MutationObserver(soon);
    obs.observe(root, { attributes: true, attributeFilter: ['style', 'class'] });
    if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
    try {
        const c = globalThis.SillyTavern?.getContext?.();
        const ev = c?.eventTypes ?? c?.event_types;
        if (c?.eventSource && ev?.SETTINGS_UPDATED) c.eventSource.on(ev.SETTINGS_UPDATED, soon);
    } catch { /* ignore */ }

    refresh();
    return {
        refresh,
        setAccent(name) { accentOf = typeof name === 'function' ? name : () => name; return refresh(); },
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        get current() { return last ? JSON.parse(last) : null; },
    };
}
