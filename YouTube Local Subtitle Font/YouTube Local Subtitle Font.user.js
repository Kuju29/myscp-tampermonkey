// ==UserScript==
// @name         YouTube Local Subtitle Font
// @namespace    https://github.com/Kuju29/myscp-tampermonkey
// @version      2026.10.7.3
// @description  ฟอนต์ในเครื่อง สี และเงาคำบรรยาย ปรับทิศทาง/ขนาดเงาโดยไม่หมุนข้อความ พร้อม log
// @match        *://www.youtube.com/*
// @icon         https://www.youtube.com/favicon.ico
// @updateURL    https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Local%20Subtitle%20Font/YouTube%20Local%20Subtitle%20Font.user.js
// @downloadURL  https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Local%20Subtitle%20Font/YouTube%20Local%20Subtitle%20Font.user.js
// @run-at       document-idle
// @sandbox      JavaScript
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

/*
 * v2026.10.7.3 — SHADOW direction, not text rotation.
 * Angle 0=right, 90=down, 180=left, 270=up; distance 0=center.
 * Shadow size uses a bounded set of text-shadow samples (approximate spread).
 * No transform, display, font-size, line-height, or background override.
 * Keeps the existing font key. Migrates v7.2 shadow X/Y; discards text rotation.
 * Fix: bind queryLocalFonts to the real Window, not Tampermonkey's window proxy.
 * Fix: mirror native menu cell order (including the empty icon column).
 * Diagnostics include API receiver/context and native-vs-added row geometry.
 * Replace the old script in Tampermonkey; do not enable both versions.
 *
 * desktop YouTube / Tampermonkey, one self-contained file.
 * No remote libraries, font downloads, FontData.blob(), transcript requests,
 * cookies, filesystem scanning, clipboard permission, or YouTube internal API.
 * Only chosen family/faces and style settings are saved; full font list stays in memory.
 * Local Font Access is requested only from a user-initiated menu action.
 * Documentation: https://developer.chrome.com/docs/capabilities/web-apis/local-fonts
 *                https://www.tampermonkey.net/documentation.php
 */
(() => {
    'use strict';

    const VERSION = '2026.10.7.3';
    const PREFIX = '[YTLocalFont]';
    // DOM-only mode supplies a userscript window/proxy. Some newer Web APIs
    // reject that proxy as `this` (Illegal invocation), even on a normal click.
    // unsafeWindow is the actual page Window; this grant is NOT filesystem access.
    // No injected script strings, CSP bypass, page bridge, or extra permission prompts.
    const fontWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : document.defaultView;
    const apiReceiver = typeof unsafeWindow !== 'undefined' ? 'unsafeWindow' : 'document.defaultView';
    let lastEnumerationStage = 'idle';
    let enumerationAttempts = 0;
    const KEY = 'yt-local-subtitle-font-v1';
    const STYLE_KEY = 'yt-local-subtitle-style-v1';
    const CAPTION = '.html5-video-player .ytp-caption-window-container .ytp-caption-segment';
    const OWN = '[data-ytlf-ui]';
    const LIMIT = 600;
    const started = performance.now();
    const logs = [];
    const players = new Map();
    const popups = new Map();
    const optionMenus = new WeakMap();
    const optionTitles = new Set(['ตัวเลือก', 'options']);
    const familyLabels = new Set(['ชุดแบบอักษร', 'font family']);
    const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });
    let droppedLogs = 0;
    let permission = 'unknown';
    let permissionObject = null;
    let families = [];
    let enumerating = false;
    let enumerationError = '';
    let enumerationCount = 0;
    let selected = null;
    let loadedFaces = [];
    let alias = '';
    let applySerial = 0;
    let applying = false;
    let applyError = '';
    let picker = null;
    let discoveryQueued = false;
    let pendingCaptionAudit = false;
    let captionUpdates = 0;
    let styleElement = null;
    let stylePrefs = null;
    let styleDirty = false;
    let styleError = '';

    stylePrefs = defaultStylePrefs();

    if (document.getElementById('ytlf-ui-style')) {
        console.warn(PREFIX, 'already_running — ปิดสคริปต์รุ่นซ้ำ แล้วโหลดหน้าใหม่');
        return;
    }

    function log(event, details = {}, level = 'info') {
        const entry = { time: new Date().toISOString(), ms: Math.round(performance.now() - started), level, event, details };
        logs.push(entry);
        if (logs.length > LIMIT) { logs.shift(); droppedLogs++; }
        // Serialize now: DevTools must not show a later, mutated object instead.
        console[level](`${PREFIX} ${event}`, JSON.stringify(details));
    }
    function errorData(error) {
        return { name: String(error?.name || 'Error'), message: String(error?.message || error).slice(0, 600) };
    }
    function norm(text) { return String(text || '').normalize('NFKC').toLocaleLowerCase().trim(); }
    function short(text, size = 160) { return String(text || '').trim().slice(0, size); }
    function node(tag, cls = '', text = '') {
        const element = document.createElement(tag);
        if (cls) element.className = cls;
        if (text) element.textContent = text;
        return element;
    }
    function button(text, title, cls = 'ytlf-button') {
        const element = node('button', cls, text);
        element.type = 'button';
        if (title) { element.title = title; element.setAttribute('aria-label', title); }
        return element;
    }
    function visible(element) {
        if (!element?.isConnected || element.hidden) return false;
        const r = element.getBoundingClientRect();
        const s = getComputedStyle(element);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }
    function quote(value) {
        return '"' + String(value).replace(/[\\"\x00-\x1f\x7f]/g, c => `\\${c.charCodeAt(0).toString(16)} `) + '"';
    }
    function capability() {
        let policy = null;
        try {
            const p = document.permissionsPolicy || document.featurePolicy;
            if (p?.allowsFeature) policy = p.allowsFeature('local-fonts');
        } catch (_) { /* The API itself remains the authority. */ }
        return {
            api: typeof fontWindow?.queryLocalFonts === 'function', secureContext: window.isSecureContext,
            receiver: apiReceiver, receiverIsUserscriptWindow: fontWindow === window,
            sandboxRequested: 'JavaScript', enumerationStage: lastEnumerationStage,
            permission, policy, visible: document.visibilityState,
            userActivation: navigator.userActivation?.isActive ?? null
        };
    }
    function validSelection(value) {
        if (!value || typeof value.family !== 'string' || !value.family.trim() || value.family.length > 250) return null;
        const faces = Array.isArray(value.faces) ? value.faces.filter(f => f && typeof f.fullName === 'string').map(f => ({
            family: value.family, fullName: short(f.fullName, 300),
            postscriptName: short(f.postscriptName, 300), style: short(f.style, 200)
        })) : [];
        return { family: value.family.trim(), source: value.source === 'manual' ? 'manual' : 'list', faces };
    }
    function saveSelection(value) {
        try { GM_setValue(KEY, value); log('settings.saved', { family: value?.family || null }); return true; }
        catch (e) { log('settings.save_failed', errorData(e), 'error'); return false; }
    }

    function defaultStylePrefs() {
        return {
            schema: 2, textColorEnabled: false, textColor: '#ffffff',
            shadowMode: 'youtube', shadowColor: '#000000', shadowOpacity: 100,
            shadowBlur: 2, shadowAngle: 45, shadowDistance: 2, shadowSpread: 0
        };
    }
    function clamp(value, min, max, fallback) {
        if (value === '' || value === null || value === undefined) return fallback;
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }
    function validHexColor(value, fallback = '#ffffff') {
        const v = String(value || '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
    }
    function rounded(n) { return Number(n.toFixed(3)); }
    function validStylePrefs(value) {
        const base = defaultStylePrefs();
        if (!value || typeof value !== 'object') return base;
        base.textColorEnabled = value.textColorEnabled === true;
        base.textColor = validHexColor(value.textColor, base.textColor);
        base.shadowMode = ['youtube', 'off', 'custom'].includes(value.shadowMode) ? value.shadowMode : 'youtube';
        base.shadowColor = validHexColor(value.shadowColor, base.shadowColor);
        base.shadowOpacity = clamp(value.shadowOpacity, 0, 100, base.shadowOpacity);
        base.shadowBlur = clamp(value.shadowBlur, 0, 20, base.shadowBlur);
        // v7.2's `angle` rotated the TEXT. Never reinterpret it as a shadow angle.
        // Keep the visible shadow displacement from its X/Y settings instead.
        if (value.schema !== 2 && ('shadowX' in value || 'shadowY' in value)) {
            const x = clamp(value.shadowX, -20, 20, 1), y = clamp(value.shadowY, -20, 20, 1);
            base.shadowDistance = rounded(Math.hypot(x, y));
            base.shadowAngle = x || y ? rounded((Math.atan2(y, x) * 180 / Math.PI + 360) % 360) : 45;
        } else {
            base.shadowDistance = clamp(value.shadowDistance, 0, 30, base.shadowDistance);
            base.shadowAngle = clamp(value.shadowAngle, 0, 360, base.shadowAngle);
        }
        base.shadowSpread = clamp(value.shadowSpread, 0, 8, base.shadowSpread);
        return base;
    }
    function saveStylePrefs(value) {
        try {
            GM_setValue(STYLE_KEY, value);
            styleError = ''; styleDirty = false;
            log('style.saved', { ...value });
            return true;
        } catch (e) {
            styleError = 'ใช้สไตล์แล้ว แต่บันทึกไม่ได้ — ดู Log';
            log('style.save_failed', errorData(e), 'error'); return false;
        }
    }
    function colorToRgba(hex, opacity) {
        const n = parseInt(validHexColor(hex, '#000000').slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`;
    }
    function shadowGeometry(p = stylePrefs) {
        const radians = p.shadowAngle * Math.PI / 180;
        return { x: rounded(Math.cos(radians) * p.shadowDistance),
            y: rounded(Math.sin(radians) * p.shadowDistance) };
    }
    function shadowPoints(p = stylePrefs) {
        const { x, y } = shadowGeometry(p);
        const points = [{ x, y }];
        // text-shadow has no widely supported spread parameter. Sample around
        // the shadow, NOT the DOM box; at most 33 layers, no cloned captions.
        // This approximates expansion; translucent overlaps can appear denser.
        const radius = p.shadowSpread;
        if (radius > 0) {
            const count = radius <= 4 ? 16 : 32;
            for (let i = 0; i < count; i++) {
                const a = i * 2 * Math.PI / count;
                points.push({ x: rounded(x + radius * Math.cos(a)), y: rounded(y + radius * Math.sin(a)) });
            }
        }
        return points;
    }
    function shadowCSS(p = stylePrefs) {
        if (p.shadowMode === 'youtube') return '';
        if (p.shadowMode === 'off' || p.shadowOpacity === 0) return 'none';
        const color = colorToRgba(p.shadowColor, p.shadowOpacity);
        return shadowPoints(p).map(pt => `${pt.x}px ${pt.y}px ${p.shadowBlur}px ${color}`).join(', ');
    }
    function styleDecls() {
        const decls = [];
        if (alias) decls.push(`font-family:${quote(alias)},sans-serif !important`);
        if (stylePrefs.textColorEnabled) decls.push(`color:${stylePrefs.textColor} !important`);
        const shadow = shadowCSS();
        if (shadow) decls.push(`text-shadow:${shadow} !important`);
        // Never rotate, skew, scale, or change display/geometry of the caption.
        return decls;
    }
    function refreshCaptionCSS() {
        const decls = styleDecls();
        if (!decls.length) {
            styleElement?.remove(); styleElement = null; return false;
        }
        if (!styleElement?.isConnected) {
            styleElement = node('style'); styleElement.id = 'ytlf-caption-style';
            (document.head || document.documentElement).append(styleElement);
        }
        const css = `${CAPTION} { ${decls.join('; ')}; }`;
        if (styleElement.textContent !== css) styleElement.textContent = css;
        return true;
    }
    function styleSummary() {
        return { ...stylePrefs, shadowOffset: shadowGeometry(),
            shadowLayers: stylePrefs.shadowMode === 'custom' && stylePrefs.shadowOpacity > 0 ? shadowPoints().length : 0,
            expansionMethod: 'text-shadow samples; approximate spread',
            textRotation: 'not applied' };
    }
    function applyStylePrefs(next, persist = true, source = 'ui') {
        const before = persist ? captionSnapshot() : null;
        const normalized = validStylePrefs(next);
        styleDirty ||= JSON.stringify(stylePrefs) !== JSON.stringify(normalized);
        stylePrefs = normalized;
        refreshCaptionCSS();
        if (persist && styleDirty) saveStylePrefs(stylePrefs);
        updateSelectionUI();
        if (persist) {
            log('style.applied', { source, style: styleSummary(), before, after: captionSnapshot() });
            pendingCaptionAudit = true;
            requestAnimationFrame(auditCaptionOnce);
        }
        // Color/shadow are paint-only changes. No resize/CC toggles needed.
    }
    function flushStyle(source) {
        if (styleDirty) applyStylePrefs(stylePrefs, true, source);
    }

    const uiCSS = `
/* Leave the native table/grid and its icon/label/content columns intact. */
.ytlf-entry > .ytp-menuitem-label { white-space:nowrap; }
.ytlf-entry-value { display:block; max-width:170px; margin-inline-start:auto; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.ytlf-entry:focus:not(:focus-visible) { outline:none; }
.ytlf-entry:focus-visible { outline:2px solid currentColor; outline-offset:-3px; }
.ytp-settings-menu[data-ytlf-open] {
    width:var(--ytlf-width)!important; height:var(--ytlf-height)!important;
    overflow:hidden!important; transition:none!important; pointer-events:auto!important;
}
.ytp-settings-menu[data-ytlf-open] > .ytp-popup-content { visibility:hidden!important; pointer-events:none!important; }
.ytlf-picker {
    position:absolute; inset:0; display:flex; flex-direction:column; overflow:hidden;
    box-sizing:border-box; font:14px/1.45 system-ui,sans-serif; color:#fff;
    text-align:start; z-index:2; cursor:auto; text-shadow:none;
}
.ytlf-picker *, .ytlf-picker *::before, .ytlf-picker *::after { box-sizing:border-box; }
.ytlf-picker [hidden] { display:none!important; }
.ytlf-picker button, .ytlf-picker input { font:inherit; letter-spacing:normal; text-transform:none; }
.ytlf-picker select { font:inherit; letter-spacing:normal; text-transform:none; color:#fff; background:#00000035; border:1px solid #ffffff50; border-radius:6px; padding:7px 9px; min-height:35px; }
.ytlf-picker button { color:inherit; cursor:pointer; border:0; margin:0; }
.ytlf-picker button:disabled { cursor:wait; opacity:.55; }
.ytlf-picker button:focus-visible, .ytlf-picker input:focus-visible, .ytlf-picker summary:focus-visible {
    outline:2px solid #8ab4f8; outline-offset:-2px;
}
.ytlf-header { display:flex; align-items:center; flex-shrink:0; gap:8px; min-height:44px; padding:4px 10px; border-bottom:1px solid #ffffff26; }
.ytlf-title { flex:1; font-weight:600; }
.ytlf-back { background:none; border-radius:6px; width:32px; height:34px; font-size:27px!important; }
.ytlf-button { border-radius:6px; padding:7px 10px; background:#ffffff16; white-space:nowrap; }
.ytlf-picker button:hover { background:#ffffff26; }
.ytlf-body { flex:1; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.ytlf-controls { padding:8px 10px 4px; flex-shrink:0; }
.ytlf-search-row, .ytlf-manual-row { display:flex; gap:6px; }
.ytlf-picker input { min-width:0; width:100%; flex:1; border:1px solid #ffffff50; border-radius:6px; padding:7px 9px; color:#fff; background:#00000035; height:35px; }
.ytlf-picker input[type="checkbox"] { flex:0 0 auto; width:16px; height:16px; padding:0; margin:0; }
.ytlf-picker input[type="color"] { flex:0 0 48px; width:48px; height:34px; padding:2px; cursor:pointer; }
.ytlf-picker input[type="range"] { padding:0; border:0; background:transparent; height:28px; accent-color:#8ab4f8; }
.ytlf-picker input:disabled, .ytlf-picker select:disabled { opacity:.5; }
.ytlf-picker select { color-scheme:dark; }
.ytlf-picker select option { color:#fff; background:#252525; }
.ytlf-directions { display:grid; grid-template-columns:repeat(3,40px); gap:3px; flex-shrink:0; }
.ytlf-dir { height:30px; border-radius:5px; background:#ffffff12; font-size:18px!important; }
.ytlf-dir[data-direction="center"] { font-size:12px!important; }
.ytlf-dir[aria-pressed="true"] { background:#ffffff32; outline:1px solid #8ab4f8; }
.ytlf-direction-row { display:flex; align-items:center; gap:12px; margin:8px 0; }
.ytlf-direction-controls { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; }
.ytlf-direction-controls .ytlf-field { flex-direction:row; align-items:center; justify-content:space-between; }
.ytlf-direction-controls input[type="number"] { flex:0 1 88px; width:88px; }
.ytlf-color-toggle { white-space:nowrap; }
.ytlf-style-status { font-size:12px; color:#ddd; min-height:17px; }
.ytlf-picker input::placeholder { color:#ddd; opacity:.85; }
.ytlf-status { font-size:12px; line-height:1.45; color:#ddd; padding:5px 0 1px; overflow-wrap:anywhere; }
.ytlf-status[data-error] { color:#ffcfaa; }
.ytlf-request { margin-top:5px!important; width:100%; }
.ytlf-list { flex:1; min-height:65px; overflow-y:auto; overscroll-behavior:contain; padding:4px 8px; scrollbar-width:thin; scrollbar-color:#aaa transparent; }
.ytlf-font { display:flex; align-items:center; text-align:start; gap:6px; width:100%; min-height:36px; padding:7px 8px; border-radius:5px; background:transparent; }
.ytlf-font::before { content:' '; width:18px; flex-shrink:0; }
.ytlf-font[aria-checked=true] { background:#ffffff18; }
.ytlf-font[aria-checked=true]::before { content:'✓'; }
.ytlf-font-name { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.ytlf-default { border-bottom:1px solid #ffffff24!important; border-radius:0; margin-bottom:3px!important; }
.ytlf-empty { padding:12px 10px; font-size:12px; color:#ddd; }
.ytlf-manual { flex-shrink:0; border-top:1px solid #ffffff26; padding:4px 10px; font-size:12px; }
.ytlf-manual summary { cursor:pointer; padding:4px 0; }
.ytlf-manual-row { padding:4px 0 6px; }
.ytlf-preview { flex-shrink:0; padding:12px 18px; border-top:1px solid #ffffff26; min-height:36px; font-size:18px; line-height:1.3; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }

.ytlf-tabs { flex-shrink:0; display:flex; gap:8px; padding:8px 10px 0; border-bottom:1px solid #ffffff18; }
.ytlf-tab { flex:1; text-align:center; border-radius:8px 8px 0 0; padding:8px 10px; background:#ffffff10; }
.ytlf-tab[aria-selected=true] { background:#ffffff24; font-weight:600; }
.ytlf-panels { flex:1; min-height:0; display:flex; flex-direction:column; }
.ytlf-pane { flex:1; min-height:0; }
.ytlf-font-pane { display:flex; flex-direction:column; overflow:hidden; }
.ytlf-style-pane { scrollbar-width:thin; scrollbar-color:#aaa transparent; overscroll-behavior:contain; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:10px; }
.ytlf-style-block { flex-shrink:0; border:1px solid #ffffff22; border-radius:8px; padding:8px; background:#ffffff08; }
.ytlf-style-title { font-weight:600; margin-bottom:6px; }
.ytlf-inline { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ytlf-inline label { display:flex; align-items:center; gap:6px; }
.ytlf-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:8px; margin-top:8px; }
.ytlf-grid-3 { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:8px; margin-top:8px; }
.ytlf-field { display:flex; flex-direction:column; gap:4px; font-size:12px; }
.ytlf-field input[type="number"], .ytlf-field input[type="text"], .ytlf-field input[type="range"] { width:100%; }
.ytlf-field input[type="color"] { flex:0 0 auto; width:100%; min-width:0; height:35px; border:1px solid #ffffff50; border-radius:6px; background:#00000035; padding:2px; }
.ytlf-muted { color:#ddd; font-size:12px; }
`;
    const uiStyle = node('style');
    uiStyle.id = 'ytlf-ui-style';
    uiStyle.textContent = uiCSS; // No innerHTML, eval, or Trusted Types policy.
    (document.head || document.documentElement).append(uiStyle);

    // Convert style *names* to CSS descriptors. No font bytes are read.
    // Unknown/localized axis names can need synthesis; log the mapping, not a false guarantee.
    function descriptors(face) {
        const style = norm(face.style || 'Regular').replace(/[\s_-]/g, '');
        let weight = '400';
        if (/extrablack|ultrablack/.test(style)) weight = '950';
        else if (/black|heavy/.test(style)) weight = '900';
        else if (/extrabold|ultrabold/.test(style)) weight = '800';
        else if (/semibold|demibold/.test(style)) weight = '600';
        else if (/bold/.test(style)) weight = '700';
        else if (/medium/.test(style)) weight = '500';
        else if (/extralight|ultralight/.test(style)) weight = '200';
        else if (/thin|hairline/.test(style)) weight = '100';
        else if (/light/.test(style)) weight = '300';
        const slant = /italic/.test(style) ? 'italic' : /oblique|slant/.test(style) ? 'oblique' : 'normal';
        let stretch = '100%';
        for (const [name, percent] of [
            ['ultracondensed','50%'], ['extracondensed','62.5%'], ['semicondensed','87.5%'], ['condensed','75%'],
            ['ultraexpanded','200%'], ['extraexpanded','150%'], ['semiexpanded','112.5%'], ['expanded','125%']
        ]) if (style.includes(name)) { stretch = percent; break; }
        return { weight, style: slant, stretch };
    }
    function manualFaces(family) {
        const compact = family.replace(/\s+/g, '');
        return ['Regular', 'Bold', 'Italic', 'Bold Italic'].map(style => {
            const suffix = style.replace(/\s/g, '');
            const names = style === 'Regular' ? [family, `${family} Regular`, compact, `${compact}-Regular`]
                : [`${family} ${style}`, `${compact}-${suffix}`, `${compact}${suffix}`];
            return { style, names, fullName: `${family} ${style}` };
        });
    }
    async function applyFont(value, persist = true) {
        const serial = ++applySerial;
        applying = !!value;
        applyError = '';
        const before = captionSnapshot();
        if (!value) {
            selected = null;
            alias = '';
            for (const f of loadedFaces) document.fonts.delete(f);
            loadedFaces = [];
            if (persist && !saveSelection(null)) applyError = 'คืนค่าแล้ว แต่บันทึกค่าไม่ได้ — ดู log';
            refreshCaptionCSS();
            updateSelectionUI();
            log('font.reset', { before, after: captionSnapshot(), style: styleSummary() });
            window.dispatchEvent(new Event('resize'));
            return;
        }
        log('font.load_begin', { family: value.family, source: value.source });
        updateSelectionUI();
        const nextAlias = `__YTLocalSubtitle_${serial}_${Math.round(started)}__`;
        try {
            const sourceFaces = value.faces.length ? value.faces : manualFaces(value.family);
            const unique = new Map();
            for (const face of sourceFaces) {
                const d = descriptors(face);
                const key = `${d.weight}/${d.style}/${d.stretch}`;
                if (!unique.has(key)) unique.set(key, { face, d });
            }
            const attempts = await Promise.all([...unique.values()].map(async ({ face, d }) => {
                const names = [...new Set((face.names || [face.postscriptName, face.fullName]).filter(Boolean))];
                try {
                    const font = new FontFace(nextAlias, names.map(n => `local(${quote(n)})`).join(', '), d);
                    await font.load();
                    return { font, name: names[0], descriptors: d };
                } catch (e) { return { name: names[0], descriptors: d, error: errorData(e) }; }
            }));
            if (serial !== applySerial) { log('font.superseded', { family: value.family }); return; }
            const good = attempts.filter(a => a.font);
            const failed = attempts.filter(a => !a.font);
            if (!good.length) log('font.faces_failed', { family: value.family, attempts: failed }, 'error');
            if (!good.length) throw new Error('LOCAL_FACE_UNAVAILABLE: ไม่พบชื่อฟอนต์นี้ หรือเบราว์เซอร์จำกัดการใช้ฟอนต์');
            for (const a of good) document.fonts.add(a.font);
            const previousFaces = loadedFaces;
            loadedFaces = good.map(a => a.font);
            alias = nextAlias;
            // Only font-family, color, and text-shadow are overridden.
            refreshCaptionCSS();
            for (const font of previousFaces) document.fonts.delete(font);
            selected = value;
            if (persist && !saveSelection(value)) applyError = 'ใช้ฟอนต์แล้ว แต่บันทึกค่าไม่ได้ — ดู log';
            log('font.applied', {
                family: value.family, alias, loaded: good.map(a => ({ name: a.name, ...a.descriptors })),
                failed: failed.map(a => ({ name: a.name, ...a.descriptors, error: a.error })),
                before, after: captionSnapshot(), style: styleSummary(), verification: 'loaded local faces + computed CSS; NOT a per-glyph font proof'
            });
            // Ask layout to measure again; do not toggle CC, seek, reload tracks, or change YouTube settings.
            window.dispatchEvent(new Event('resize'));
            log('caption.layout_requested', { method: 'window.resize', note: 'YouTube response is not guaranteed' });
            pendingCaptionAudit = true;
            requestAnimationFrame(auditCaptionOnce);
        } catch (e) {
            if (serial !== applySerial) return;
            applyError = 'ใช้ฟอนต์ไม่ได้: ตรวจชื่อฟอนต์หรือข้อจำกัดเบราว์เซอร์ (ดู log)';
            log('font.load_failed', { family: value.family, ...errorData(e) }, 'error');
        } finally {
            if (serial === applySerial) { applying = false; updateSelectionUI(); }
        }
    }

    function buildFamilies(fonts) {
        const map = new Map();
        for (const f of fonts) {
            if (!f.family) continue;
            const key = norm(f.family);
            if (!map.has(key)) map.set(key, { family: String(f.family), source: 'list', faces: [] });
            map.get(key).faces.push({ family: String(f.family), fullName: String(f.fullName || f.family),
                postscriptName: String(f.postscriptName || ''), style: String(f.style || 'Regular') });
        }
        return [...map.values()].sort((a, b) => collator.compare(a.family, b.family)).map(f => ({ ...f,
            search: norm([f.family, ...f.faces.flatMap(x => [x.fullName, x.postscriptName, x.style])].join('\n'))
        }));
    }
    async function readPermission() {
        try {
            if (!permissionObject) {
                permissionObject = await fontWindow.navigator.permissions.query({ name: 'local-fonts' });
                permissionObject.addEventListener('change', () => {
                    permission = permissionObject.state;
                    log('permission.changed', { state: permission });
                    if (permission === 'denied') { families = []; renderList(); }
                    updatePickerStatus();
                });
            }
            permission = permissionObject.state;
            log('permission.state', { state: permission });
        } catch (e) { log('permission.query_unavailable', errorData(e), 'warn'); }
        updatePickerStatus();
    }
    function enumerateFonts() {
        if (enumerating) return;
        const cap = capability();
        enumerationAttempts++;
        log('fonts.enumerate_begin', { ...cap, attempt: enumerationAttempts });
        enumerationError = '';
        if (!cap.api) {
            enumerationError = 'เบราว์เซอร์ไม่เปิด API รายชื่อฟอนต์ — ใช้ช่องพิมพ์ชื่อด้านล่าง';
            log('fonts.api_unavailable', cap, 'warn');
            updatePickerStatus(); return;
        }
        if (cap.policy === false) {
            enumerationError = 'หน้านี้ปิด local-fonts ด้วย Permissions Policy — ใช้ชื่อฟอนต์แทน';
            log('fonts.policy_blocked', cap, 'warn');
            updatePickerStatus(); return;
        }
        enumerating = true;
        updatePickerStatus();
        const time = performance.now();
        let request;
        // Keep user activation: no await/timer/message hop before this native call.
        // Binding only fixes the receiver. The browser still controls permission.
        lastEnumerationStage = 'invoke';
        try {
            request = Reflect.apply(fontWindow.queryLocalFonts, fontWindow, []);
            lastEnumerationStage = 'await-result';
            log('fonts.native_call', { receiver: apiReceiver, returnedPromise: typeof request?.then === 'function',
                userActivation: navigator.userActivation?.isActive ?? null });
        } catch (e) { request = Promise.reject(e); }
        Promise.resolve(request).then(fonts => {
            lastEnumerationStage = 'read-metadata';
            families = buildFamilies(fonts);
            enumerationCount++;
            if (!families.length) enumerationError = 'เบราว์เซอร์คืนรายการว่าง — ไม่ได้แปลว่าเครื่องไม่มีฟอนต์';
            log('fonts.enumerated', { faces: fonts.length, families: families.length,
                ms: Math.round(performance.now() - time), attempt: enumerationCount,
                note: 'Names not logged; browser may return a cached or restricted list' });
            lastEnumerationStage = 'done';
            renderList();
        }).catch(e => {
            const name = e?.name;
            const receiverError = name === 'TypeError' && /illegal invocation|incompatible receiver/i.test(String(e?.message));
            enumerationError = receiverError
                ? 'เรียก API ผิดบริบท — ตรวจว่าใช้รุ่น ' + VERSION + ' แล้วกด Log'
                : name === 'NotAllowedError'
                    ? 'ยังไม่ได้รับสิทธิ์ — อนุญาต “ฟอนต์ในเครื่อง” ในสิทธิ์ของ YouTube หรือพิมพ์ชื่อเอง'
                    : name === 'SecurityError'
                        ? 'อ่านรายการไม่ได้: สิทธิ์/นโยบาย/การคลิกของผู้ใช้ — ดู log'
                        : `อ่านรายการไม่ได้ (${name || 'Error'}) — ดู log`;
            log('fonts.enumerate_failed', { ...errorData(e), stage: lastEnumerationStage,
                classification: receiverError ? 'invalid_receiver' : name === 'NotAllowedError' ? 'permission_denied' : 'api_error',
                context: capability(), ms: Math.round(performance.now() - time) }, 'error');
            lastEnumerationStage = 'failed';
        }).finally(() => { enumerating = false; updatePickerStatus(); void readPermission(); });
    }

    function selectionName() { return selected?.family || 'ใช้ฟอนต์ของ YouTube'; }
    function updateSelectionUI() {
        for (const state of popups.values()) {
            for (const value of state.popup.querySelectorAll('.ytlf-entry-value')) {
                value.textContent = selected?.family || 'YouTube'; value.title = selectionName();
            }
        }
        if (!picker) return;
        picker.preview.style.fontFamily = alias ? `${quote(alias)},sans-serif` : 'system-ui,sans-serif';
        picker.preview.style.color = stylePrefs.textColorEnabled ? stylePrefs.textColor : '';
        picker.preview.style.textShadow = shadowCSS();
        picker.preview.title = selectionName();
        for (const element of picker.list.querySelectorAll('[data-font-family]'))
            element.setAttribute('aria-checked', String(element.dataset.fontFamily === (selected?.family || '')));
        picker.manualApply.disabled = applying;
        if (picker.styleInputs) {
            for (const [key, input] of Object.entries(picker.styleInputs)) {
                if (input.type === 'checkbox') input.checked = !!stylePrefs[key];
                // Don't clobber a partially typed number such as "0." on input.
                else if (!(document.activeElement === input && input.type === 'number')) input.value = String(stylePrefs[key]);
            }
            picker.angleRange.value = String(stylePrefs.shadowAngle);
            const custom = stylePrefs.shadowMode === 'custom';
            const centered = stylePrefs.shadowDistance === 0;
            picker.colorInput.disabled = !stylePrefs.textColorEnabled;
            for (const [key, input] of Object.entries(picker.styleInputs)) {
                if (key.startsWith('shadow') && key !== 'shadowMode') input.disabled = !custom;
            }
            picker.angleRange.disabled = !custom || centered;
            picker.styleInputs.shadowAngle.disabled = !custom || centered;
            for (const btn of picker.directionButtons) {
                btn.disabled = !custom;
                const key = btn.dataset.direction;
                const active = key === 'center' ? centered : !centered && (stylePrefs.shadowAngle % 360) === Number(key);
                btn.setAttribute('aria-pressed', String(custom && active));
            }
            picker.styleStatus.textContent = styleError || (custom
                ? (centered ? 'เงาอยู่กึ่งกลาง · ปรับขยายเงาและความฟุ้งได้' : 'องศาเปลี่ยนทิศทางเงาเท่านั้น · ตัวอักษรไม่หมุน')
                : stylePrefs.shadowMode === 'off' ? 'ปิดเงาของสคริปต์และ YouTube' : 'ใช้เงาและขอบตัวอักษรของ YouTube');
        }
        updatePickerStatus();
    }
    function updatePickerStatus() {
        if (!picker) return;
        const cap = capability();
        const error = styleError || applyError || enumerationError;
        picker.status.toggleAttribute('data-error', !!error);
        let message = error;
        if (!message && applying) message = 'กำลังใช้ฟอนต์…';
        if (!message && enumerating) message = 'กำลังอ่านรายชื่อฟอนต์…';
        if (!message && families.length) {
            const count = picker.list.querySelectorAll('[data-font-index]').length;
            message = `${count.toLocaleString()} / ${families.length.toLocaleString()} ตระกูล · ${selectionName()}`;
        }
        if (!message && !cap.api) message = 'เบราว์เซอร์ไม่เปิด API รายชื่อฟอนต์ — พิมพ์ชื่อเองได้';
        if (!message && permission === 'denied') message = 'สิทธิ์ถูกปฏิเสธ — เปลี่ยนสิทธิ์ของ YouTube หรือพิมพ์ชื่อเอง';
        if (!message) message = 'อ่านรายการต้องอนุญาตให้ youtube.com เข้าถึงฟอนต์';
        picker.status.textContent = message;
        picker.request.hidden = families.length > 0 || !cap.api;
        picker.request.disabled = enumerating;
        picker.refresh.disabled = enumerating || !cap.api;
        if (!cap.api) picker.manual.open = true;
    }
    function fontChoice(label, family, index) {
        const row = button('', label, `ytlf-font${index === null ? ' ytlf-default' : ''}`);
        row.setAttribute('role', 'menuitemradio');
        row.setAttribute('aria-checked', String(family === (selected?.family || '')));
        row.dataset.fontFamily = family;
        if (index !== null) row.dataset.fontIndex = String(index);
        row.append(node('span', 'ytlf-font-name', label));
        return row;
    }
    function renderList() {
        if (!picker) return;
        const query = norm(picker.search.value);
        const fragment = document.createDocumentFragment();
        fragment.append(fontChoice('ใช้ฟอนต์ของ YouTube', '', null));
        let count = 0;
        families.forEach((f, i) => {
            if (!query || f.search.includes(query)) { fragment.append(fontChoice(f.family, f.family, i)); count++; }
        });
        if (families.length && !count) fragment.append(node('div', 'ytlf-empty', 'ไม่พบชื่อที่ค้นหา'));
        picker.list.replaceChildren(fragment);
        updatePickerStatus();
    }
    function sizePicker() {
        if (!picker) return;
        const player = picker.state.player;
        const r = player.getBoundingClientRect();
        const bottom = parseFloat(getComputedStyle(picker.state.popup).bottom) || 60;
        const width = Math.max(120, Math.min(410, r.width - 24, innerWidth - 24));
        const height = Math.max(100, Math.min(560, r.height - bottom - 12, innerHeight - bottom - 20));
        for (const [name, value] of [['--ytlf-width', `${Math.floor(width)}px`], ['--ytlf-height', `${Math.floor(height)}px`]])
            if (picker.state.popup.style.getPropertyValue(name) !== value) picker.state.popup.style.setProperty(name, value);
    }
    function openPicker(state, panel, row) {
        if (picker) closePicker('reopen', false);
        const content = state.popup.querySelector(':scope > .ytp-popup-content') || panel.parentElement;
        const root = node('div', 'ytlf-picker');
        root.dataset.ytlfUi = 'picker';
        root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'ฟอนต์ในเครื่อง');
        const header = node('div', 'ytlf-header');
        const back = button('‹', 'กลับไปตัวเลือกคำบรรยาย', 'ytlf-back');
        const exportButton = button('Log', `ส่งออก log · รุ่น ${VERSION}`);
        header.append(back, node('span', 'ytlf-title', 'ฟอนต์และสไตล์คำบรรยาย'), exportButton);
        const tabs = node('div', 'ytlf-tabs'); tabs.setAttribute('role', 'tablist');
        const tabFont = button('ฟอนต์', 'เลือกฟอนต์', 'ytlf-tab');
        const tabStyle = button('สไตล์', 'สีและทิศทางเงา', 'ytlf-tab');
        tabFont.setAttribute('role', 'tab');
        tabStyle.setAttribute('role', 'tab');
        tabFont.setAttribute('aria-selected', 'true');
        tabStyle.setAttribute('aria-selected', 'false');
        tabs.append(tabFont, tabStyle);
        const body = node('div', 'ytlf-body');
        const panels = node('div', 'ytlf-panels');
        const fontPane = node('div', 'ytlf-pane ytlf-font-pane');
        const controls = node('div', 'ytlf-controls');
        const searchRow = node('div', 'ytlf-search-row');
        const search = node('input');
        search.type = 'search'; search.placeholder = 'ค้นหาชื่อฟอนต์'; search.autocomplete = 'off'; search.spellcheck = false;
        search.setAttribute('aria-label', 'ค้นหาชื่อฟอนต์');
        const refresh = button('↻', 'อ่านรายการอีกครั้ง (ฟอนต์ที่เพิ่งติดตั้งอาจต้องเปิดเบราว์เซอร์ใหม่)');
        searchRow.append(search, refresh);
        const status = node('div', 'ytlf-status'); status.setAttribute('role', 'status');
        const request = button('อ่านรายชื่อฟอนต์ในเครื่อง', '', 'ytlf-button ytlf-request');
        controls.append(searchRow, status, request);
        const list = node('div', 'ytlf-list'); list.setAttribute('role', 'menu'); list.setAttribute('aria-label', 'รายชื่อฟอนต์');
        const manual = node('details', 'ytlf-manual');
        manual.append(node('summary', '', 'พิมพ์ชื่อฟอนต์เอง · ไม่อ่านรายการ'));
        const manualRow = node('div', 'ytlf-manual-row');
        const manualInput = node('input');
        manualInput.placeholder = 'เช่น Tahoma หรือ TH Sarabun New'; manualInput.maxLength = 250;
        manualInput.setAttribute('aria-label', 'ชื่อฟอนต์ที่ติดตั้งในเครื่อง');
        manualInput.autocomplete = 'off'; manualInput.spellcheck = false;
        const manualApply = button('ใช้', 'ใช้ฟอนต์ตามชื่อที่พิมพ์');
        manualRow.append(manualInput, manualApply); manual.append(manualRow);
        fontPane.append(controls, list, manual);

        const stylePane = node('div', 'ytlf-pane ytlf-style-pane');
        stylePane.hidden = true;
        const styleInputs = {};
        function field(parent, label, key, type, min, max, step = 1) {
            const wrap = node('label', 'ytlf-field');
            const input = node('input'); input.type = type;
            if (min !== undefined) { input.min = String(min); input.max = String(max); input.step = String(step); }
            input.setAttribute('aria-label', label); input.dataset.styleKey = key;
            wrap.append(node('span', '', label), input); parent.append(wrap); styleInputs[key] = input;
            return input;
        }
        const colorBlock = node('div', 'ytlf-style-block');
        colorBlock.append(node('div', 'ytlf-style-title', 'สีตัวอักษร'));
        const colorLine = node('div', 'ytlf-inline');
        const colorLabel = node('label', 'ytlf-color-toggle');
        const colorToggle = node('input'); colorToggle.type = 'checkbox';
        colorLabel.append(colorToggle, document.createTextNode('กำหนดสีเอง'));
        const colorInput = node('input'); colorInput.type = 'color'; colorInput.setAttribute('aria-label', 'สีตัวอักษร');
        const colorReset = button('ใช้สี YouTube', 'ยกเลิกการบังคับสี');
        colorLine.append(colorLabel, colorInput, colorReset); colorBlock.append(colorLine);
        styleInputs.textColorEnabled = colorToggle; styleInputs.textColor = colorInput;

        const shadowBlock = node('div', 'ytlf-style-block');
        shadowBlock.append(node('div', 'ytlf-style-title', 'เงาอักษร'));
        const shadowMode = node('select'); shadowMode.setAttribute('aria-label', 'โหมดเงา');
        shadowMode.style.width = '100%';
        for (const [value, label] of [['youtube', 'ใช้เงา YouTube'], ['off', 'ปิดเงา'], ['custom', 'กำหนดเงาเอง']]) {
            const opt = node('option', '', label); opt.value = value; shadowMode.append(opt);
        }
        styleInputs.shadowMode = shadowMode;
        const shadowGrid = node('div', 'ytlf-grid-3');
        field(shadowGrid, 'สีเงา', 'shadowColor', 'color');
        field(shadowGrid, 'ความทึบ (%)', 'shadowOpacity', 'number', 0, 100);
        field(shadowGrid, 'ความฟุ้ง (px)', 'shadowBlur', 'number', 0, 20, 0.5);

        const directionRow = node('div', 'ytlf-direction-row');
        const directionPad = node('div', 'ytlf-directions'); directionPad.setAttribute('role', 'group');
        directionPad.setAttribute('aria-label', 'ทิศทางเงา');
        const directionButtons = [];
        for (const [key, glyph, label] of [
            ['225','↖','เงาซ้ายบน'], ['270','↑','เงาขึ้น'], ['315','↗','เงาขวาบน'],
            ['180','←','เงาซ้าย'], ['center','กลาง','เงากึ่งกลาง'], ['0','→','เงาขวา'],
            ['135','↙','เงาซ้ายล่าง'], ['90','↓','เงาลง'], ['45','↘','เงาขวาล่าง']
        ]) {
            const btn = button(glyph, label, 'ytlf-dir');
            btn.dataset.direction = key; btn.setAttribute('aria-pressed', 'false');
            directionButtons.push(btn); directionPad.append(btn);
        }
        const directionControls = node('div', 'ytlf-direction-controls');
        field(directionControls, 'องศาเงา (°)', 'shadowAngle', 'number', 0, 360);
        const angleRange = node('input'); angleRange.type = 'range';
        angleRange.min = '0'; angleRange.max = '360'; angleRange.step = '1';
        angleRange.setAttribute('aria-label', 'เลื่อนองศาเงา'); directionControls.append(angleRange);
        field(directionControls, 'ระยะเงา (px)', 'shadowDistance', 'number', 0, 30, 0.5);
        directionRow.append(directionPad, directionControls);
        const spreadGrid = node('div', 'ytlf-grid');
        field(spreadGrid, 'ขยายเงา / ขอบ (px)', 'shadowSpread', 'number', 0, 8, 0.5);
        spreadGrid.append(node('div', 'ytlf-muted', 'ระยะ 0 = อยู่กึ่งกลาง · ความฟุ้ง 0 = ขอบคม'));
        const styleStatus = node('div', 'ytlf-style-status'); styleStatus.setAttribute('role', 'status');
        shadowBlock.append(shadowMode, shadowGrid, directionRow, spreadGrid);
        const styleButtons = node('div', 'ytlf-inline');
        const styleReset = button('คืนสไตล์ YouTube', 'คืนสีและเงา โดยเก็บฟอนต์ที่เลือกไว้');
        styleButtons.append(styleReset);
        stylePane.append(colorBlock, shadowBlock, styleStatus, styleButtons);

        panels.append(fontPane, stylePane);
        const preview = node('div', 'ytlf-preview', 'ตัวอย่างคำบรรยาย · ABC 123');
        body.append(tabs, panels); root.append(header, body, preview);
        picker = { state, panel, row, root, content, oldInert: content.inert, search, refresh, request, status, list,
            manual, manualInput, manualApply, preview, oldWidth: state.popup.style.getPropertyValue('--ytlf-width'),
            oldHeight: state.popup.style.getPropertyValue('--ytlf-height'), tabFont, tabStyle, fontPane, stylePane,
            colorToggle, colorInput, colorReset, styleInputs, shadowMode, angleRange,
            directionButtons, styleStatus, styleReset, activeTab: 'font' };
        function switchTab(name) {
            if (!picker) return;
            flushStyle('tab'); picker.activeTab = name;
            const fontActive = name === 'font';
            picker.fontPane.hidden = !fontActive; picker.stylePane.hidden = fontActive;
            picker.tabFont.setAttribute('aria-selected', String(fontActive));
            picker.tabStyle.setAttribute('aria-selected', String(!fontActive));
            picker.tabFont.tabIndex = fontActive ? 0 : -1; picker.tabStyle.tabIndex = fontActive ? -1 : 0;
            sizePicker(); log('picker.tab', { tab: name });
        }
        function changeStyle(key, value, commit, source) {
            applyStylePrefs({ ...stylePrefs, [key]: value }, commit, source);
        }
        content.inert = true;
        state.popup.setAttribute('data-ytlf-open', '');
        state.popup.append(root);
        sizePicker();
        for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup'])
            root.addEventListener(type, e => e.stopPropagation());
        root.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
        back.addEventListener('click', () => closePicker('back'));
        exportButton.addEventListener('click', exportLogs);
        tabFont.addEventListener('click', () => switchTab('font'));
        tabStyle.addEventListener('click', () => switchTab('style'));
        refresh.addEventListener('click', enumerateFonts);
        request.addEventListener('click', enumerateFonts);
        search.addEventListener('input', renderList);
        list.addEventListener('click', e => {
            const target = e.target.closest('[data-font-family]');
            if (!target) return;
            if (!target.dataset.fontFamily) { void applyFont(null); return; }
            const family = families[Number(target.dataset.fontIndex)];
            if (family && family.family === target.dataset.fontFamily)
                void applyFont({ family: family.family, source: 'list', faces: family.faces });
        });
        manualApply.addEventListener('click', () => {
            const family = manualInput.value.trim();
            if (family) void applyFont({ family, source: 'manual', faces: [] });
            else manualInput.focus();
        });
        for (const [key, input] of Object.entries(styleInputs)) {
            const change = commit => {
                if (input.type === 'number' && (input.value === '' || !Number.isFinite(input.valueAsNumber))) return;
                changeStyle(key, input.type === 'checkbox' ? input.checked : input.value, commit, `ui.${key}`);
                if (commit && input.type === 'number') input.value = String(stylePrefs[key]);
            };
            if (!['checkbox', 'select-one'].includes(input.type)) input.addEventListener('input', () => change(false));
            input.addEventListener('change', () => change(true));
        }
        colorReset.addEventListener('click', () => changeStyle('textColorEnabled', false, true, 'ui.color_reset'));
        angleRange.addEventListener('input', () => changeStyle('shadowAngle', angleRange.value, false, 'ui.shadow_angle'));
        angleRange.addEventListener('change', () => changeStyle('shadowAngle', angleRange.value, true, 'ui.shadow_angle'));
        for (const btn of directionButtons) btn.addEventListener('click', () => {
            const key = btn.dataset.direction;
            const next = { ...stylePrefs };
            if (key === 'center') next.shadowDistance = 0;
            else { next.shadowAngle = Number(key); if (!next.shadowDistance) next.shadowDistance = 2; }
            applyStylePrefs(next, true, 'ui.shadow_direction');
        });
        styleReset.addEventListener('click', () => applyStylePrefs(defaultStylePrefs(), true, 'ui.style_reset'));
        renderList(); updateSelectionUI(); switchTab('font'); search.focus({ preventScroll: true });
        log('picker.open', { permission, cachedFamilies: families.length, context: capability(), style: styleSummary() });
        if (permission === 'granted') enumerateFonts();
        else void readPermission();
    }
    function closePicker(reason, restoreFocus = true) {
        if (!picker) return;
        flushStyle('picker.close');
        const old = picker; picker = null;
        old.root.remove(); old.content.inert = old.oldInert;
        old.state.popup.removeAttribute('data-ytlf-open');
        for (const [name, value] of [['--ytlf-width', old.oldWidth], ['--ytlf-height', old.oldHeight]]) {
            if (value) old.state.popup.style.setProperty(name, value);
            else old.state.popup.style.removeProperty(name);
        }
        log('picker.close', { reason });
        if (restoreFocus && visible(old.row)) old.row.focus({ preventScroll: true });
    }

    // Only intercept keyboard events inside our panel. YouTube shortcuts elsewhere are untouched.
    function pickerKey(e) {
        if (!picker || !picker.root.contains(e.target)) return;
        e.stopPropagation();
        if (e.type !== 'keydown') return;
        const target = e.target;
        if (e.key === 'Escape') { e.preventDefault(); closePicker('escape'); return; }
        if (e.key === 'Tab') {
            const all = [...picker.root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(visible);
            const i = all.indexOf(target); const step = e.shiftKey ? -1 : 1;
            e.preventDefault(); all[(i + step + all.length) % all.length]?.focus(); return;
        }
        if (e.key === 'Enter' && target === picker.manualInput) { e.preventDefault(); picker.manualApply.click(); return; }
        if ((target === picker.tabFont || target === picker.tabStyle) && ['ArrowLeft','ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const next = target === picker.tabFont ? picker.tabStyle : picker.tabFont;
            next.click(); next.focus(); return;
        }
        const inList = picker.list.contains(target);
        if ((target === picker.search || inList) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            if (target === picker.search && ['Home','End'].includes(e.key)) return;
            const rows = [...picker.list.querySelectorAll('button')];
            const index = rows.indexOf(target);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1
                : e.key === 'ArrowDown' ? (index + 1) % rows.length : (index - 1 + rows.length) % rows.length;
            e.preventDefault(); rows[next]?.focus(); return;
        }
        if ((e.key === 'Enter' || e.key === ' ') && target.tagName === 'BUTTON') { e.preventDefault(); target.click(); }
    }
    for (const type of ['keydown', 'keyup', 'keypress']) document.addEventListener(type, pickerKey, true);

    function menuSummary(panel) {
        const menu = panel.querySelector('.ytp-panel-menu');
        return {
            title: short(panel.querySelector('.ytp-panel-title')?.textContent, 80),
            rows: menu ? [...menu.children].filter(n => n.matches('.ytp-menuitem') && !n.matches(OWN)).map(n => ({
                label: short(n.querySelector('.ytp-menuitem-label')?.textContent, 120),
                value: short(n.querySelector('.ytp-menuitem-content')?.textContent, 120),
                role: n.getAttribute('role'), submenu: n.getAttribute('aria-haspopup') === 'true'
            })) : []
        };
    }
    function isCaptionOptions(panel) {
        const summary = menuSummary(panel);
        const children = summary.rows;
        if (!panel.querySelector('.ytp-panel-back-button') || panel.querySelector('.ytp-panel-options')) return false;
        if (children.length < 6) return false;
        if (children.some(r => familyLabels.has(norm(r.label))) && children.filter(r => r.submenu).length >= 5) return true;
        // Localization-independent fallback after the user clicked the native Options button.
        return optionTitles.has(norm(summary.title)) && children.length >= 8
            && children.filter(r => r.submenu).length >= 7
            && children.filter(r => /\d\s*[%％]/.test(r.value)).length >= 3;
    }
    function optionCells(reference, row) {
        const cells = reference ? [...reference.children] : [];
        const roles = ['ytp-menuitem-icon', 'ytp-menuitem-label', 'ytp-menuitem-content', 'ytp-menuitem-secondary-icon'];
        let schema = cells.map(c => roles.find(role => c.classList.contains(role))).filter(Boolean);
        if (!schema.includes('ytp-menuitem-label') || !schema.includes('ytp-menuitem-content'))
            schema = ['ytp-menuitem-label', 'ytp-menuitem-content'];
        for (const role of schema) {
            const cell = node('div', role);
            if (role === 'ytp-menuitem-label') cell.textContent = 'ฟอนต์ในเครื่อง';
            else if (role === 'ytp-menuitem-content') {
                const text = node('span', 'ytlf-entry-value', selected?.family || 'YouTube');
                text.title = selectionName(); cell.append(text);
            } else {
                // Keep empty icon/secondary-icon cells: they are columns, not decoration.
                cell.setAttribute('aria-hidden', 'true');
                const original = cells.find(c => c.classList.contains(role));
                if (original?.hidden) cell.hidden = true;
                if (original?.style.display) cell.style.display = original.style.display;
            }
            row.append(cell);
        }
    }
    function rowLayout(row) {
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { display: getComputedStyle(row).display, width: Math.round(r.width), height: Math.round(r.height),
            cells: [...row.children].map(c => {
                const box = c.getBoundingClientRect(), s = getComputedStyle(c);
                return { class: c.className, display: s.display, x: Math.round(box.x - r.x),
                    width: Math.round(box.width), height: Math.round(box.height), paddingLeft: s.paddingLeft,
                    paddingRight: s.paddingRight, whiteSpace: s.whiteSpace };
            }) };
    }
    function injectOption(state, panel) {
        const menu = panel.querySelector('.ytp-panel-menu');
        if (!menu) return;
        let data = optionMenus.get(menu);
        if (!data) {
            const row = node('div', 'ytp-menuitem ytlf-entry');
            row.dataset.ytlfUi = 'entry'; row.tabIndex = 0;
            row.setAttribute('role', 'menuitem'); row.setAttribute('aria-haspopup', 'true');
            const reference = [...menu.children].find(n => n.matches('.ytp-menuitem') && !n.matches(OWN));
            optionCells(reference, row);
            row.addEventListener('click', e => { e.stopPropagation(); openPicker(state, panel, row); });
            // Native keyboard navigation tracks its own items and would otherwise skip our row.
            menu.addEventListener('keydown', e => {
                const rows = [...menu.children].filter(n => n.matches('.ytp-menuitem') && visible(n));
                const current = e.target.closest('.ytp-menuitem');
                if (!rows.includes(current)) return;
                if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
                    e.preventDefault(); e.stopPropagation();
                    const i = rows.indexOf(current);
                    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1
                        : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
                    rows[next]?.focus();
                } else if (current === row && ['Enter',' ','ArrowRight'].includes(e.key)) {
                    e.preventDefault(); e.stopPropagation(); openPicker(state, panel, row);
                }
            }, true);
            data = { row }; optionMenus.set(menu, data);
        }
        if (data.row.parentElement !== menu) {
            // Keep every native node and handler. The native panel already supports vertical scrolling.
            const first = [...menu.children].find(n => n.matches('.ytp-menuitem') && !n.matches(OWN));
            if (first) first.after(data.row); else menu.append(data.row);
            log('menu.injected', { player: state.player.id, title: menuSummary(panel).title,
                nativeRows: menuSummary(panel).rows.length });
            requestAnimationFrame(() => {
                if (visible(data.row)) log('menu.entry_layout', { native: rowLayout(first), added: rowLayout(data.row) });
            });
        }
        if (state.expectTimer) { clearTimeout(state.expectTimer); state.expectTimer = null; }
    }
    function inspectPopup(state) {
        state.queued = false;
        if (!state.popup.isConnected) return;
        const shown = visible(state.popup);
        if (shown !== state.shown) {
            state.shown = shown;
            log(shown ? 'menu.shown' : 'menu.hidden', { player: state.player.id });
        }
        if (picker?.state === state) {
            if (!shown || !picker.panel.isConnected || !picker.content.contains(picker.panel)) closePicker('native_closed_or_replaced', false);
            else return;
        }
        if (!shown) return;
        const panels = [...state.popup.querySelectorAll('.ytp-panel')].filter(visible);
        const summaries = panels.map(menuSummary);
        const signature = JSON.stringify(summaries);
        if (signature !== state.signature) { state.signature = signature; log('menu.panel', { panels: summaries }); }
        for (const panel of panels) if (isCaptionOptions(panel)) injectOption(state, panel);
    }
    function schedulePopup(state) {
        if (!state.queued) { state.queued = true; requestAnimationFrame(() => inspectPopup(state)); }
    }
    function attachPopup(player, popup) {
        if (popups.has(popup)) return;
        const state = { player, popup, queued: false, shown: null, signature: '', expectTimer: null };
        const observer = new MutationObserver(records => {
            if (records.every(r => r.target.nodeType === 1 ? r.target.closest(OWN) : r.target.parentElement?.closest(OWN))) return;
            schedulePopup(state);
        });
        observer.observe(popup, { childList: true, subtree: true, attributes: true, characterData: true,
            attributeFilter: ['style', 'class', 'aria-hidden'] });
        state.observer = observer; popups.set(popup, state);
        popup.addEventListener('transitionend', () => schedulePopup(state));
        log('menu.attached', { player: player.id, popupId: popup.id });
        schedulePopup(state);
    }
    function auditCaptionOnce() {
        if (!pendingCaptionAudit || !document.querySelector(CAPTION)) return;
        pendingCaptionAudit = false;
        const snapshot = captionSnapshot();
        const mismatch = !!alias && snapshot.segments.some(s => !s.fontFamily.includes(alias));
        log(mismatch ? 'caption.font_mismatch' : 'caption.observed', snapshot, mismatch ? 'warn' : 'info');
    }
    function discoverPlayers() {
        discoveryQueued = false;
        for (const [player, observer] of players) if (!player.isConnected) { observer.disconnect(); players.delete(player); }
        for (const [popup, state] of popups) if (!popup.isConnected) {
            if (picker?.state === state) closePicker('player_removed', false);
            state.observer.disconnect(); if (state.expectTimer) clearTimeout(state.expectTimer); popups.delete(popup);
        }
        for (const player of document.querySelectorAll('.html5-video-player')) {
            if (!players.has(player)) {
                const observer = new MutationObserver(records => {
                    let findPopup = false;
                    for (const r of records) {
                        const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
                        if (target?.closest(OWN) || target?.closest('.ytp-settings-menu')) continue;
                        if (target?.closest('.ytp-caption-window-container')) { captionUpdates++; continue; }
                        if (r.addedNodes.length || r.removedNodes.length) findPopup = true;
                    }
                    if (findPopup) for (const p of player.querySelectorAll('.ytp-settings-menu')) attachPopup(player, p);
                    if (pendingCaptionAudit) requestAnimationFrame(auditCaptionOnce);
                });
                observer.observe(player, { childList: true, subtree: true });
                players.set(player, observer);
                log('player.attached', { id: player.id, classes: player.className,
                    playerVersion: player.getAttribute('data-version') });
            }
            for (const popup of player.querySelectorAll('.ytp-settings-menu')) attachPopup(player, popup);
        }
    }
    function scheduleDiscovery() {
        if (!discoveryQueued) { discoveryQueued = true; requestAnimationFrame(discoverPlayers); }
    }
    const discoveryObserver = new MutationObserver(() => {
        // O(1) fast path on ordinary page mutations; don't repeatedly scan the whole document.
        if (!players.size || [...players.keys()].some(p => !p.isConnected)) scheduleDiscovery();
    });
    discoveryObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    document.addEventListener('click', e => {
        const options = e.target.closest?.('.ytp-panel-options');
        if (!options) return;
        const popup = options.closest('.ytp-settings-menu');
        const state = popups.get(popup);
        if (!state) { scheduleDiscovery(); return; }
        optionTitles.add(norm(options.textContent));
        log('menu.native_options_clicked', { label: short(options.textContent), from: menuSummary(options.closest('.ytp-panel')) });
        if (state.expectTimer) clearTimeout(state.expectTimer);
        state.expectTimer = setTimeout(() => {
            state.expectTimer = null;
            if (visible(popup) && !popup.querySelector('.ytlf-entry'))
                log('menu.option_not_found', { panels: [...popup.querySelectorAll('.ytp-panel')].map(menuSummary) }, 'warn');
        }, 2000);
        schedulePopup(state);
    }, true);
    for (const type of ['yt-navigate-finish', 'yt-page-data-updated']) document.addEventListener(type, () => {
        closePicker('navigation', false); scheduleDiscovery(); pendingCaptionAudit = !!styleElement;
        log('page.navigation', { event: type, path: location.pathname });
    });
    document.addEventListener('fullscreenchange', () => {
        log('player.fullscreen', { active: !!document.fullscreenElement });
        sizePicker(); pendingCaptionAudit = !!styleElement; requestAnimationFrame(auditCaptionOnce);
    });
    window.addEventListener('resize', sizePicker, { passive: true });

    function captionSnapshot() {
        const nodes = [...document.querySelectorAll(CAPTION)];
        return { count: nodes.length, updates: captionUpdates, selected: selected?.family || null, alias,
            segments: nodes.slice(0, 4).map(el => {
                const s = getComputedStyle(el); const r = el.getBoundingClientRect();
                const parent = el.closest('.caption-window');
                return { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
                    fontStyle: s.fontStyle, fontStretch: s.fontStretch, fontVariant: s.fontVariant,
                    lineHeight: s.lineHeight, color: s.color, backgroundColor: s.backgroundColor,
                    opacity: s.opacity, textShadow: s.textShadow, transform: s.transform, lang: parent?.lang || '',
                    width: Math.round(r.width), height: Math.round(r.height), scrollWidth: el.scrollWidth,
                    containerWidth: parent ? Math.round(parent.getBoundingClientRect().width) : null };
            }) };
    }
    function diagnostics() {
        const data = {
            version: VERSION, userAgent: navigator.userAgent, language: navigator.language,
            host: location.hostname, path: location.pathname,
            videoId: location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null,
            manager: typeof GM_info !== 'undefined' ? { name: GM_info.scriptHandler, version: GM_info.version } : null,
            capability: capability(), selected, alias, applying, applyError, style: styleSummary(), styleError, styleDirty,
            fonts: { familiesInMemory: families.length, enumerating, enumerationCount, enumerationAttempts, enumerationError,
                lastEnumerationStage,
                loadedFaces: loadedFaces.map(f => ({ family: f.family, status: f.status, style: f.style, weight: f.weight, stretch: f.stretch })) },
            ui: { open: !!picker, viewport: { width: innerWidth, height: innerHeight },
                players: [...players.keys()].map(p => ({ id: p.id, connected: p.isConnected })),
                menus: [...popups.values()].filter(s => s.popup.isConnected).map(s => ({
                    shown: visible(s.popup), entries: s.popup.querySelectorAll('.ytlf-entry').length,
                    width: Math.round(s.popup.getBoundingClientRect().width), height: Math.round(s.popup.getBoundingClientRect().height),
                    panels: [...s.popup.querySelectorAll('.ytp-panel')].map(menuSummary),
                    addedRows: [...s.popup.querySelectorAll('.ytlf-entry')].map(rowLayout)
                })) },
            captions: captionSnapshot(),
            cssPresent: !!styleElement?.isConnected,
            verificationLimit: 'FontFace.load and computed CSS only. A font may lack characters; per-glyph rendering is not measured.'
        };
        log('diagnostics.snapshot', data);
        return data;
    }
    function exportLogs() {
        flushStyle('export');
        const snapshot = diagnostics();
        log('diagnostics.export', { entries: logs.length, dropped: droppedLogs });
        const report = { tool: 'YouTube Local Subtitle Font', version: VERSION, exportedAt: new Date().toISOString(),
            privacy: 'Contains browser/version, current video ID, selected font names, native menu labels and style metrics. No subtitle text, cookies, tokens, font binaries or complete font list.',
            snapshot, droppedLogs, logs: [...logs] };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = node('a'); link.href = url;
        link.download = `YTLocalFont-${VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    log('boot', { version: VERSION, userAgent: navigator.userAgent, context: capability(),
        manager: typeof GM_info !== 'undefined' ? `${GM_info.scriptHandler} ${GM_info.version}` : 'unavailable' });
    try {
        GM_registerMenuCommand('YouTube Font — ส่งออก log', exportLogs);
        GM_registerMenuCommand('YouTube Font — ตรวจสถานะใน Console', diagnostics);
        GM_registerMenuCommand('YouTube Font — คืนฟอนต์ YouTube', () => { void applyFont(null); });
        GM_registerMenuCommand('YouTube Font — คืนสีและเงา YouTube', () => applyStylePrefs(defaultStylePrefs(), true, 'manager.reset_style'));
    } catch (e) { log('manager.menu_failed', errorData(e), 'warn'); }
    try {
        const storedStyle = GM_getValue(STYLE_KEY, null);
        stylePrefs = validStylePrefs(storedStyle);
        if (storedStyle && storedStyle.schema !== 2) {
            log('style.migrated', { fromSchema: 1, toSchema: 2, ignoredTextAngle: storedStyle.angle ?? null,
                style: styleSummary() });
            styleDirty = true; saveStylePrefs(stylePrefs);
        }
    } catch (e) { stylePrefs = defaultStylePrefs(); log('style.read_failed', errorData(e), 'error'); }
    refreshCaptionCSS();
    try {
        const stored = GM_getValue(KEY, null);
        const value = validSelection(stored);
        if (value) void applyFont(value, false);
        else if (stored) log('settings.invalid', { action: 'ignored' }, 'warn');
        else refreshCaptionCSS();
    } catch (e) { log('settings.read_failed', errorData(e), 'error'); }
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushStyle('page.hidden'); });
    window.addEventListener('pagehide', () => flushStyle('pagehide'));
    void readPermission();
    pendingCaptionAudit = !!styleElement;
    discoverPlayers();
})();
