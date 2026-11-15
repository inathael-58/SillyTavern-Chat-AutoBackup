// float-colors.js — สีปุ่มลอยแบบ "ปรับตามธีม" (adaptive) สำหรับ extension ของ SillyTavern
// ใช้ร่วมกันใน Chat Auto Backup · Lore Lens · Chat Browser · As you command · Quick Dock
// คัดลอกไฟล์นี้ทั้งไฟล์ อย่าแก้แยกที่ใดที่หนึ่ง (ต้องมี theme-palette.js อยู่ข้าง ๆ)
// FLOAT_COLORS_VERSION 1
//
// ปุ่มลอยมีสีได้สองแบบต่อช่อง:
//   ปรับตามธีม  ดึงสีจากแม่แบบสี (theme-palette.js) แล้วปรับความสว่างให้ตัดกับพื้นปุ่มเสมอ
//              คงโทนสีของธีม จึงกลมกลืน และคำนวณใหม่ทุกครั้งที่เปลี่ยนธีม
//   เลือกเอง    ใช้สีที่ผู้ใช้เลือกตรง ๆ ทุกธีม ไม่เปลี่ยนตามธีม
// ช่องที่ "ปรับตามธีม" จะปรับให้อ่านออกบนพื้นจริงของปุ่ม แม้พื้นนั้นจะเป็นสีที่เลือกเอง
//
// ป้ายตัวเลขบนปุ่มลอย (ทุก extension ใช้แบบเดียวกัน กันป้ายอยู่คนละมุมหรือทับกันใน Quick Dock):
//   มุมขวาบน · top:-4px right:-4px · สูง 18px · กว้างอย่างน้อย 18px · padding 0 5px
//   ตัวหนา 10.5px · พื้น accent · ตัวอักษร onAccent · วงรอบ 2px สีพื้นปุ่ม (ring)
//
// ใช้:
//   import { floatColors } from './float-colors.js';
//   const c = floatColors(palette?.current, { bg: s.bg === 'custom' ? s.bgColor : null });
//   if (c) el.style.setProperty('--xx-fg', c.fg);
//   palette.onChange(() => applyLook());   // คำนวณใหม่เมื่อเปลี่ยนธีม

import { parseColor, contrast, ensureContrast, luminance } from './theme-palette.js';

export const FLOAT_COLORS_VERSION = 1;

/** ชื่อโหมดสีสำหรับเมนูในหน้าตั้งค่า */
export const COLOR_MODE_LABELS = Object.freeze({
    auto: 'ปรับตามธีม (อ่านง่ายเสมอ)',
    custom: 'เลือกสีเอง (ใช้ทุกธีม)',
});

let probe = null;

/** สี CSS ใด ๆ (#hex, rgb(), var(--…)) → [r, g, b] (ตัดความโปร่งทิ้ง) หรือ null */
export function resolveRgb(color) {
    if (!color || typeof document === 'undefined') return null;
    if (!probe?.isConnected) {
        probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none';
        (document.body ?? document.documentElement).append(probe);
    }
    probe.style.color = '';
    probe.style.color = String(color);
    if (!probe.style.color) return null;
    const c = parseColor(getComputedStyle(probe).color);
    return c ? c.slice(0, 3) : null;
}

const css = c => `rgb(${c.map(v => Math.round(Math.max(0, Math.min(255, v)))).join(', ')})`;
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const WHITE = [255, 255, 255];
const INK = [20, 20, 24];
const bestOn = c => (contrast(WHITE, c) >= contrast(INK, c) ? WHITE : INK);

/**
 * สีของปุ่มลอย
 * @param {object|null} p  ชุดสีจาก theme-palette (palette.current) — null ได้ จะอ่านสีธีมตรง ๆ แทน
 * @param {{ bg?: string|null, fg?: string|null, border?: string|null, accent?: string|null }} pick
 *        สีที่ผู้ใช้เลือกเอง (สี CSS) — ช่องที่เป็น null/ว่าง = ปรับตามธีม
 * @returns {null | { bg, fg, muted, border, accent, accentText, onAccent, danger, ring, light }}
 *   bg          พื้นปุ่ม: พื้น UI ของธีมแบบทึบ หรือสีที่เลือก
 *   fg          ไอคอน/ตัวอักษร ≥ 4.5:1 กับพื้นปุ่ม (คงโทนตัวอักษรของธีม)
 *   muted       ตัวอักษรรอง ≥ 3:1
 *   border      เส้นขอบ
 *   accent      สีเน้น/วงแหวน/ป้ายตัวเลข ≥ 3:1 กับพื้นปุ่ม (คงโทนสีเน้นของธีม)
 *   accentText  สีเน้นที่ใช้เป็นตัวอักษร ≥ 4.5:1
 *   onAccent    ตัวอักษรบนพื้นสีเน้น (ขาวหรือเข้ม แล้วแต่อันไหนตัดกว่า)
 *   danger      สีเตือน ≥ 4.5:1
 *   ring        วงรอบป้ายตัวเลข (= พื้นปุ่ม)
 */
export function floatColors(p, pick = {}) {
    const bg = resolveRgb(pick.bg) ?? (p && resolveRgb(p.surface)) ?? resolveRgb('var(--SmartThemeBlurTintColor)');
    if (!bg) return null;
    const themeFg = (p && resolveRgb(p.fg)) ?? resolveRgb('var(--SmartThemeBodyColor)') ?? (luminance(bg) > 0.18 ? INK : WHITE);
    const themeAccent = (p && resolveRgb(p.accent)) ?? resolveRgb('var(--SmartThemeQuoteColor)') ?? themeFg;
    const fg = resolveRgb(pick.fg) ?? ensureContrast(themeFg, bg, 4.5);
    const accentPicked = resolveRgb(pick.accent);
    const accent = accentPicked ?? ensureContrast(themeAccent, bg, 3);
    return {
        bg: css(bg),
        fg: css(fg),
        muted: css(ensureContrast(mix(bg, fg, 0.7), bg, 3)),
        border: css(resolveRgb(pick.border) ?? mix(bg, fg, 0.3)),
        accent: css(accent),
        accentText: css(accentPicked ?? ensureContrast(themeAccent, bg, 4.5)),
        onAccent: css(bestOn(accent)),
        danger: css(ensureContrast([229, 72, 77], bg, 4.5)),
        ring: css(bg),
        light: luminance(bg) > 0.18,
    };
}
