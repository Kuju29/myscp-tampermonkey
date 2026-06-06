// ==UserScript==
// @name         YouTube Auto Play Short
// @version      26.06.06
// @description  Automatically pick and play short, high‑view videos (with optional language matching) when a video ends, falling back to endscreen if sidebar fails.
// @match        *://www.youtube.com/*
// @updateURL    https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Auto%20Play%20Short/YouTube%20Auto%20Play%20Short.user.js
// @downloadURL  https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Auto%20Play%20Short/YouTube%20Auto%20Play%20Short.user.js
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /* =========================
 *  CONFIG / CONSTANTS
 * ========================= */

    const settingsKey = "youtubeAutoPlaySettings";
    const defaultSettings = {
        maxDuration: 600,
        minViews: 1_000_000,
        maxAgeYears: 99,
        neverwatched: true,
        detectLanguage: true,
        removeWhenReload: false,
        removewhanreload: false,
        debugDrops: false
    };

    const UNWATCHED_WEIGHT = 10;

    const STORAGE_KEYS = { playedIds: "playedVideoIds" };

    const selectorList = (...items) => items.filter(Boolean).join(', ');

    const SELECTORS = {
        settingsPanel: '#settings-panel',

        videoTitle: selectorList(
            'h1.ytd-watch-metadata',
            '#title h1 yt-formatted-string',
            '#container > h1 > yt-formatted-string',
            'h1.title.ytd-watch-metadata',
            'h1 [role="text"]',
            'h1'
        ),

        // Keep the search scoped to the watch-page sidebar first.
        // YouTube often changes exact class names, but these host tags/ids are much more stable.
        sidebarItems: selectorList(
            'ytd-watch-next-secondary-results-renderer yt-lockup-view-model',
            '#secondary yt-lockup-view-model',
            '#related yt-lockup-view-model',
            'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer',
            '#secondary ytd-compact-video-renderer',
            '#related ytd-compact-video-renderer',
            'ytd-watch-next-secondary-results-renderer ytd-compact-playlist-renderer',
            '#secondary ytd-compact-playlist-renderer',
            '#related ytd-compact-playlist-renderer'
        ),

        // Last resort only. Used when YouTube moves the sidebar outside the old containers.
        fallbackItems: selectorList(
            'yt-lockup-view-model',
            'ytd-compact-video-renderer',
            'ytd-compact-playlist-renderer'
        ),

        modern: {
            titleLink: selectorList(
                'a.ytLockupMetadataViewModelTitle[href*="/watch"]',
                'a.yt-lockup-metadata-view-model__title[href*="/watch"]',
                'a.yt-lockup-metadata-view-model-wiz__title[href*="/watch"]',
                'a[class*="LockupMetadata"][class*="Title"][href*="/watch"]',
                'a[class*="lockup-metadata"][class*="title"][href*="/watch"]',
                'h3 a[href*="/watch?v="]',
                'a[aria-label][href*="/watch?v="]'
            ),

            contentImageLink: selectorList(
                'a.ytLockupViewModelContentImage[href*="/watch"]',
                'a.yt-lockup-view-model__content-image[href*="/watch"]',
                'a.yt-lockup-view-model-wiz__content-image[href*="/watch"]',
                'a[class*="LockupViewModelContentImage"][href*="/watch"]',
                'a[class*="content-image"][href*="/watch"]',
                'a[href*="/watch?v="]'
            ),

            titleSpan: selectorList(
                '.ytLockupMetadataViewModelTitle [role="text"]',
                '.ytLockupMetadataViewModelTitle span',
                '.yt-lockup-metadata-view-model__title span.yt-core-attributed-string',
                '.yt-lockup-metadata-view-model-wiz__title span.yt-core-attributed-string',
                '.yt-lockup-metadata-view-model__heading-reset [role="text"]',
                '[class*="LockupMetadata"][class*="Title"] [role="text"]',
                '[class*="LockupMetadata"][class*="Title"] span',
                '[class*="lockup-metadata"][class*="title"] [role="text"]'
            ),

            heading: selectorList(
                '.ytLockupMetadataViewModelHeadingReset',
                '.yt-lockup-metadata-view-model__heading-reset',
                '[class*="LockupMetadata"][class*="HeadingReset"]',
                'h3[title]',
                'h3'
            ),

            metadataContainer: selectorList(
                '.ytLockupMetadataViewModelMetadata',
                '.yt-lockup-view-model-wiz__metadata',
                '.yt-lockup-metadata-view-model__metadata',
                '.yt-lockup-metadata-view-model-wiz__metadata',
                '.yt-lockup-view-model__metadata',
                '[class*="LockupMetadata"][class*="Metadata"]',
                '[class*="metadata"]'
            ),

            metadataRow: selectorList(
                '.ytContentMetadataViewModelMetadataRow',
                '.yt-content-metadata-view-model__metadata-row',
                '.yt-content-metadata-view-model-wiz__metadata-row',
                '[class*="ContentMetadata"][class*="MetadataRow"]',
                '[class*="metadata-row"]'
            ),

            metadataText: selectorList(
                '.ytContentMetadataViewModelMetadataText',
                '[class*="ContentMetadata"][class*="MetadataText"]',
                '[class*="metadata-text"]',
                'span[role="text"]',
                'span'
            ),

            badgeDuration: selectorList(
                '.ytBadgeShapeText',
                '.yt-badge-shape__text',
                '.badge-shape__text',
                '.badge-shape-wiz__text',
                '.yt-thumbnail-bottom-overlay-view-model .badge-shape-wiz__text',
                '[class*="BadgeShapeText"]',
                '[class*="badge"][class*="text"]',
                '[class*="Badge"][class*="Text"]'
            ),

            watchedBar: selectorList(
                '.ytThumbnailOverlayProgressBarHostWatchedProgressBarHostWatchedProgressBarSegment',
                '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment',
                '[class*="ProgressBar"][class*="Watched"]',
                '[class*="progress"][class*="watched"]'
            )
        },

        autoplayToggle: '.ytp-autonav-toggle-button-container .ytp-autonav-toggle-button, .ytp-autonav-toggle-button',
        nextButton: '.ytp-next-button[aria-disabled="false"]',

        endscreenItem: '.html5-endscreen .ytp-videowall-still, .html5-endscreen .ytp-modern-videowall-still',
        endscreenTitle: '.ytp-videowall-still-info-title, .ytp-modern-videowall-still-info-title',
        endscreenAuthor: '.ytp-videowall-still-info-author, .ytp-modern-videowall-still-info-author',
        endscreenDuration: '.ytp-videowall-still-info-duration, .ytp-modern-videowall-still-info-duration, .ytp-videowall-still-info-length, .ytp-modern-videowall-still-info-length',
        endscreenViewsDate: '.ytp-modern-videowall-still-view-count-and-date-info, .ytp-videowall-still-info-live, .ytp-videowall-still-info-author + div'
    };

    const EVENTS_TO_BLOCK = [
        "visibilitychange","webkitvisibilitychange","blur","hasFocus",
        "mouseleave","mouseout","mozvisibilitychange","msvisibilitychange"
    ];

    const BLUR_WHITELIST = [HTMLInputElement, HTMLAnchorElement, HTMLSpanElement, HTMLParagraphElement];
    const HOVER_BLACKLIST = [HTMLIFrameElement, HTMLHtmlElement, HTMLBodyElement, HTMLHeadElement, HTMLFrameSetElement, HTMLFrameElement];

    const REGEX = {
        videoId: /[?&]v=([^&]+)/,
        viewsSuffix: /(views?|การดู)/i,
        durationSplit: /:/,
        ageYear: /(\d+)\s*(ปี|year|years)/i,
        ageMonth: /(\d+)\s*(เดือน|month|months)/i,
        ageWeek: /(\d+)\s*(สัปดาห์|week|weeks)/i,
        ageDay: /(\d+)\s*(วัน|day|days)/i,
        ageHour: /(\d+)\s*(ชั่วโมง|hour|hours)/i,
        ageMinute: /(\d+)\s*(นาที|minute|minutes)/i
    };

    const LANG_PATTERNS = {
        thai: /[\u0E00-\u0E7F]/,
        lao: /[\u0E80-\u0EFF]/,
        korean: /[\uAC00-\uD7AF]/,
        japanese: /[\u3040-\u30FF]/,
        cjk: /[\u4E00-\u9FFF]/
    };

    /* =========================
 *  SETTINGS UI
 * ========================= */

    function loadSettings() {
        const saved = localStorage.getItem(settingsKey);
        if (!saved) return;
        try {
            const parsed = JSON.parse(saved);
            Object.assign(defaultSettings, parsed);
            if (parsed.removewhanreload && !parsed.removeWhenReload) {
                defaultSettings.removeWhenReload = true;
            }
        } catch(e){ console.error("Failed to parse settings:", e); }
    }

    function saveSettingsFromUI() {
        defaultSettings.maxDuration = parseInt(document.getElementById('setting-maxDuration').value, 10);
        defaultSettings.minViews = parseInt(document.getElementById('setting-minViews').value, 10);
        defaultSettings.maxAgeYears = parseInt(document.getElementById('setting-maxAgeYears').value, 10);
        defaultSettings.neverwatched = document.getElementById('setting-neverwatched').checked;
        defaultSettings.detectLanguage= document.getElementById('setting-detectLanguage').checked;
        defaultSettings.removeWhenReload = document.getElementById('setting-removeWhenReload').checked;
        defaultSettings.debugDrops = document.getElementById('setting-debugDrops').checked;
        localStorage.setItem(settingsKey, JSON.stringify(defaultSettings));
        console.log("Settings saved:", defaultSettings);
    }

    function createSettingsUI() {
        if (document.querySelector(SELECTORS.settingsPanel)) return;

        const div = (style={}) => { const d=document.createElement('div'); Object.assign(d.style, style); return d; };
        const label = (text) => { const l=document.createElement('label'); l.appendChild(document.createTextNode(text)); return l; };

        const container = document.createElement('div');
        container.id = 'settings-panel';
        Object.assign(container.style, {
            position:'fixed', top:'0', right:'0', width:'300px',
            background:'linear-gradient(135deg, rgb(24 24 25) 0%, rgb(84 27 141) 100%)',
            color:'#fff', borderRadius:'8px 0 0 8px', boxShadow:'0 2px 10px rgba(0,0,0,0.3)',
            padding:'20px', fontFamily:'sans-serif', fontSize:'14px', opacity:'0.95', zIndex:9999
        });

        const header = div({ textAlign:'right' });
        const closeBtn = document.createElement('button');
        closeBtn.id = 'close-settings';
        closeBtn.type = 'button';
        closeBtn.textContent = 'X';
        header.appendChild(closeBtn);
        container.appendChild(header);

        const title = document.createElement('h3');
        title.style.margin = '0 0 10px 0';
        title.textContent = 'Auto Short Play Settings';
        container.appendChild(title);

        const numField = (text, id, value) => {
            const wrap = div({ marginBottom:'5px' });
            const lab = label(text);
            const input = document.createElement('input');
            input.type = 'number';
            input.id = id;
            input.value = String(value);
            input.style.width = '100%';
            wrap.append(lab, input);
            return wrap;
        };

        const checkboxField = (text, id, checked) => {
            const wrap = div({ marginBottom:'5px' });
            const lab = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = id;
            input.checked = !!checked;
            lab.append(input, document.createTextNode(' ' + text));
            wrap.appendChild(lab);
            return wrap;
        };

        container.appendChild(numField('Max Duration (sec)', 'setting-maxDuration', defaultSettings.maxDuration));
        container.appendChild(numField('Min Views', 'setting-minViews', defaultSettings.minViews));
        container.appendChild(numField('Max Age (years)', 'setting-maxAgeYears', defaultSettings.maxAgeYears));
        container.appendChild(checkboxField('Prioritize Unwatched', 'setting-neverwatched', defaultSettings.neverwatched));
        container.appendChild(checkboxField('Language Match', 'setting-detectLanguage', defaultSettings.detectLanguage));
        container.appendChild(checkboxField('Reset Played on Reload', 'setting-removeWhenReload', defaultSettings.removeWhenReload));
        container.appendChild(checkboxField('Debug Dropped Items', 'setting-debugDrops', defaultSettings.debugDrops));

        const actions = div({ textAlign:'right', marginTop:'10px' });
        const saveBtn = document.createElement('button');
        saveBtn.id = 'save-settings';
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        actions.appendChild(saveBtn);
        container.appendChild(actions);

        document.body.appendChild(container);

        closeBtn.addEventListener('click', () => { container.style.display = 'none'; });
        saveBtn.addEventListener('click', () => { saveSettingsFromUI(); container.style.display = 'none'; });
    }
    function showSettingsUI(){ loadSettings(); if(!document.querySelector(SELECTORS.settingsPanel)) createSettingsUI(); else document.querySelector(SELECTORS.settingsPanel).style.display='block'; }
    if (typeof GM_registerMenuCommand!=='undefined') GM_registerMenuCommand("Short Play Settings", showSettingsUI);

    /* =========================
 *  UTILITIES
 * ========================= */

    const safeDefine=(o,k,d)=>{try{Object.defineProperty(o,k,d);}catch(e){}};

    function getVideoIdFromUrl(url){
        if (!url) return null;
        try {
            const u = new URL(url, location.origin);
            const fromQuery = u.searchParams.get('v');
            if (fromQuery) return fromQuery;
            const shorts = u.pathname.match(/\/shorts\/([^/?#]+)/);
            if (shorts) return shorts[1];
            const embed = u.pathname.match(/\/embed\/([^/?#]+)/);
            if (embed) return embed[1];
        } catch(e) {
            const m = String(url).match(REGEX.videoId);
            if (m) return m[1];
        }
        return null;
    }

    function parseDuration(str){
        if(!str) return 0;
        return str.trim().split(':').reverse().map(Number)
            .reduce((acc,v,i)=>acc+ (Number.isFinite(v)?v:0)*60**i,0);
    }

    function extractDurationFallbackFromAria(linkEl){
        if(!linkEl) return 0;
        const raw = (linkEl.getAttribute('aria-label') || '').trim();
        if(!raw) return 0;

        const aria = raw.replace(/\b(LIVE|Premiering|ชมสด)\b/gi,'').trim();

        const hms = (h=0,m=0,s=0) => (h*3600 + m*60 + s);

        let m = aria.match(/(\d+)\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})/);
        if(m) return hms(+m[1], +m[2], +m[3]);

        m = aria.match(/(?<!\d)(\d{1,3})\s*:\s*(\d{2})(?!\d)/);
        if(m) return hms(0, +m[1], +m[2]);

        // 2) ภาษา/สัญลักษณ์หลายแบบ (มีชั่วโมงก็รองรับ)
        // อังกฤษ: "1 hour 2 minutes 3 seconds", "1h 2m 3s", "1 hr 2 min"
        m = aria.match(/(\d+)\s*h(?:ours?)?(?:[,\s]+(\d+)\s*m(?:in(?:utes?)?)?)?(?:[,\s]+(\d+)\s*s(?:ec(?:onds?)?)?)?/i);
        if(m) return hms(+m[1], m[2]?+m[2]:0, m[3]?+m[3]:0);
        // อังกฤษ: "8 minutes, 21 seconds"
        m = aria.match(/(\d+)\s*minutes?(?:[,\s]+(\d+)\s*seconds?)?/i);
        if(m) return hms(0, +m[1], m[2]?+m[2]:0);
        // อังกฤษ: "X seconds" อย่างเดียว
        m = aria.match(/(\d+)\s*seconds?/i);
        if(m) return hms(0, 0, +m[1]);

        // ไทย: "1 ชั่วโมง 2 นาที 3 วินาที" / "8 นาที และ 21 วินาที"
        m = aria.match(/(\d+)\s*ชั่วโมง(?:\s*(\d+)\s*นาที)?(?:\s*(\d+)\s*วินาที)?/);
        if(m) return hms(+m[1], m[2]?+m[2]:0, m[3]?+m[3]:0);
        m = aria.match(/(\d+)\s*นาที(?:\s*(?:และ\s*)?(\d+)\s*วินาที)?/);
        if(m) return hms(0, +m[1], m[2]?+m[2]:0);
        m = aria.match(/(\d+)\s*วินาที/);
        if(m) return hms(0, 0, +m[1]);

        // ญี่ปุ่น: "1時間 2分 3秒"
        m = aria.match(/(\d+)\s*時間(?:\s*(\d+)\s*分)?(?:\s*(\d+)\s*秒)?/);
        if(m) return hms(+m[1], m[2]?+m[2]:0, m[3]?+m[3]:0);
        // เกาหลี: "1시간 2분 3초"
        m = aria.match(/(\d+)\s*시간(?:\s*(\d+)\s*분)?(?:\s*(\d+)\s*초)?/);
        if(m) return hms(+m[1], m[2]?+m[2]:0, m[3]?+m[3]:0);
        // จีน: "1小时 2分钟 3秒"
        m = aria.match(/(\d+)\s*小时(?:\s*(\d+)\s*分钟)?(?:\s*(\d+)\s*秒)?/);
        if(m) return hms(+m[1], m[2]?+m[2]:0, m[3]?+m[3]:0);

        // 3) กันรูปย่อแบบติดกัน เช่น "1h2m", "2m10s"
        m = aria.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
        if(m && (m[1]||m[2]||m[3])) return hms(m[1]?+m[1]:0, m[2]?+m[2]:0, m[3]?+m[3]:0);

        return 0;
    }


    function shuffleArray(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

    function pickRandom(a){ if(!a.length) return null; return a[Math.floor(Math.random()*a.length)]; }

    function detectLanguage(text) {
        if (!defaultSettings.detectLanguage) return 'unknown';

        let t = String(text || '').trim();
        if (!t) return 'unknown';

        t = t
            .replace(/【[^】]*】/g, ' ')
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/\([^)]*\b(?:official|audio|video|mv|lyrics?|ver\.?|version)\b[^)]*\)/ig, ' ')
            .replace(/\b(?:official|music|video|official music video|mv|lyrics?|audio)\b/ig, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const segments = t
        .split(/[-–—|:/]+/)
        .map(s => s.trim())
        .filter(Boolean);

        for (const seg of segments) {
            const lao = (seg.match(/[\u0E80-\u0EFF]/g) || []).length;
            const thai = (seg.match(/[\u0E00-\u0E7F]/g) || []).length;
            const korean = (seg.match(/[\uAC00-\uD7AF]/g) || []).length;
            const japanese = (seg.match(/[\u3040-\u30FF]/g) || []).length;
            const chinese = (seg.match(/[\u4E00-\u9FFF]/g) || []).length;

            const bestNonLatin = [
                ['lao', lao],
                ['thai', thai],
                ['korean', korean],
                ['japanese', japanese],
                ['chinese', chinese]
            ].sort((a, b) => b[1] - a[1])[0];

            if (bestNonLatin[1] > 0) return bestNonLatin[0];
        }

        if (/[A-Za-z]/.test(t)) return 'latin';

        return 'unknown';
    }

    function getCurrentVideoLanguage() {
        const el = document.querySelector(SELECTORS.videoTitle)
        || document.querySelector('#title h1 yt-formatted-string')
        || document.querySelector('h1 > yt-formatted-string');

        if (el) {
            const t = (el.textContent || '').trim();
            return detectLanguage(t);
        }
        return 'unknown';
    }


 /* =========================
 *  PARSERS
 * ========================= */

    function parseViews(text){
        if(!text) return 0;
        let t = String(text)
            .replace(/\u00a0/g, ' ')
            .replace(/,/g, '')
            .replace(/การดู/g, '')
            .replace(/ครั้ง/g, '')
            .replace(/views?/ig, '')
            .trim();

        // Prefer a number that is directly attached to a view unit. This prevents
        // "7.5 ล้าน 3 ปีที่แล้ว" from becoming 75,300,000 by accident.
        let m = t.match(/(\d+(?:\.\d+)?)\s*(พันล้าน|ล้าน|แสน|หมื่น|พัน|[kmb])/i);
        let numText = m?.[1];
        let unit = m?.[2] || '';

        if (!numText) {
            m = t.match(/(\d+(?:\.\d+)?)/);
            numText = m?.[1];
        }

        const num = parseFloat(numText || '');
        if(!isFinite(num)) return 0;

        let factor = 1;
        unit = String(unit).toLowerCase();
        if (unit === 'พันล้าน' || unit === 'b') factor = 1e9;
        else if (unit === 'ล้าน' || unit === 'm') factor = 1e6;
        else if (unit === 'แสน') factor = 100000;
        else if (unit === 'หมื่น') factor = 10000;
        else if (unit === 'พัน' || unit === 'k') factor = 1e3;

        return Math.round(num * factor);
    }

    function isAgeText(text){
        return /(ปี|เดือน|สัปดาห์|สัปดา|วัน|ชั่วโมง|ชม\.?|นาที|วิ(?:นาที)?|ที่แล้ว|วันนี้|ใหม่\b|year|month|week|day|hour|hr\b|minute|min\b|second|sec\b|ago|streamed)/i.test(String(text || ''));
    }

    function isDurationText(text){
        return /^\s*\d{1,3}:\d{2}(?::\d{2})?\s*$/.test(String(text || ''));
    }

    function isLikelyViewsText(text){
        const t = String(text || '').trim();
        if (!/\d/.test(t)) return false;
        if (isDurationText(t) || isAgeText(t)) return false;
        return /(การดู|views?\b|ล้าน|แสน|หมื่น|พัน|\b[kmb]\b)/i.test(t) || /^\d+(?:[.,]\d+)?$/.test(t);
    }

    function getTextParts(root, selector='span'){
        return Array.from(root?.querySelectorAll?.(selector) || [])
            .map(el => el.textContent?.trim())
            .filter(Boolean);
    }

    function findDurationText(root){
        const parts = getTextParts(root, SELECTORS.modern.badgeDuration)
            .concat(getTextParts(root, '[aria-label]'));
        return parts.find(isDurationText) || '';
    }

    function findBestWatchLink(item){
        const selectors = [
            SELECTORS.modern.titleLink,
            SELECTORS.modern.contentImageLink,
            'a[aria-label][href*="/watch"]',
            'a[href*="/watch?v="]',
            'a[href*="/shorts/"]'
        ];

        for (const sel of selectors) {
            const links = Array.from(item.querySelectorAll(sel));
            const link = links.find(a => getVideoIdFromUrl(a.getAttribute('href') || a.href));
            if (link) return link;
        }
        return null;
    }

    function parseUploadAge(text){
        if(!text) return 0;
        const t = String(text).toLowerCase().trim();
        if (/(อัปเดตแล้ววันนี้|วันนี้|ใหม่\b|just now|moments ago)/i.test(t)) return 0;

        let m = t.match(/(\d+)\s*(ปี|years?|yr\b)/i); if(m) return +m[1];
        m = t.match(/(\d+)\s*(เดือน|months?|mo\b)/i); if(m) return Math.floor(+m[1] / 12);
        m = t.match(/(\d+)\s*(สัปดาห์|สัปดา|weeks?|wk\b)/i); if(m) return Math.floor(+m[1] / 52);
        m = t.match(/(\d+)\s*(วัน|days?)/i); if(m) return Math.floor(+m[1] / 365);
        m = t.match(/(\d+)\s*(ชั่วโมง|ชม\.?|hours?|hrs?|hr\b)/i); if(m) return 0;
        m = t.match(/(\d+)\s*(นาที|minutes?|mins?|min\b)/i); if(m) return 0;
        m = t.match(/(\d+)\s*(วินาที|seconds?|secs?|sec\b)/i); if(m) return 0;
        return 0;
    }

    function getVideoInfo(item){
        const titleLink = findBestWatchLink(item);
        const titleSpan = item.querySelector(SELECTORS.modern.titleSpan);
        const heading = item.querySelector(SELECTORS.modern.heading);

        const title =
              titleSpan?.textContent?.trim() ||
              heading?.getAttribute?.('title') ||
              heading?.textContent?.trim() ||
              titleLink?.getAttribute?.('title') ||
              titleLink?.getAttribute?.('aria-label') ||
              titleLink?.textContent?.trim() ||
              '';

        const rows = Array.from(item.querySelectorAll(SELECTORS.modern.metadataRow));
        const metadataNodes = rows.length ? rows : Array.from(item.querySelectorAll(SELECTORS.modern.metadataContainer));

        let views = 0;
        let age = 0;

        for (const row of metadataNodes) {
            const parts = getTextParts(row, SELECTORS.modern.metadataText);
            const rowText = row.textContent?.trim() || '';
            if (!parts.length && rowText) parts.push(rowText);

            const ageIndex = parts.findIndex(txt => isAgeText(txt));
            if (!age && ageIndex >= 0) age = parseUploadAge(parts[ageIndex]);

            if (!views) {
                // New YouTube TH UI often shows only "7.5 ล้าน" without "การดู".
                // In metadata rows, view count usually appears right before the age text.
                const beforeAge = ageIndex >= 0 ? parts.slice(0, ageIndex).reverse() : [];
                const viewText = beforeAge.find(isLikelyViewsText) || parts.find(txt => /(การดู|views?\b)/i.test(txt));
                if (viewText) views = parseViews(viewText);
            }

            // Fallback for collapsed row text such as "7.5 ล้าน 3 ปีที่แล้ว".
            if (!views && isAgeText(rowText) && /\d/.test(rowText)) {
                views = parseViews(rowText);
            }
        }

        const durationText = findDurationText(item);
        const duration = parseDuration(durationText) || extractDurationFallbackFromAria(titleLink);

        const progress = !!item.querySelector(SELECTORS.modern.watchedBar);
        const href = titleLink?.getAttribute('href') || titleLink?.href || '';

        return { title, views, age, duration, progress, href, element: titleLink };
    }

    /* =========================
 *  ENDSCREEN FALLBACK
 * ========================= */

    function parseViewsSimple(v){ return parseViews(v); }
    function getEndscreenData(node){
        const url = node.getAttribute('href') || node.querySelector?.('a[href]')?.getAttribute('href') || '';
        const title = node.querySelector(SELECTORS.endscreenTitle)?.textContent.trim()
              || node.getAttribute('aria-label')
              || node.getAttribute('title')
              || '';
        const author = node.querySelector(SELECTORS.endscreenAuthor)?.textContent.trim() || '';
        const durText = node.querySelector(SELECTORS.endscreenDuration)?.textContent.trim()
              || findDurationText(node)
              || '0:00';
        const viewsDate = node.querySelector(SELECTORS.endscreenViewsDate)?.textContent.trim() || node.textContent || '';

        return {
            url,
            title,
            channel: author,
            views: parseViewsSimple(viewsDate),
            duration: parseDuration(durText)
        };
    }

    function fallbackToNextButton(){
        const btn = document.querySelector(SELECTORS.nextButton);
        if(!btn){
            console.log("[AutoShort] No next button");
            return;
        }
        console.log("[AutoShort] Clicking NEXT button");
        btn.click();
    }

    function pickVideoFromEndscreen(){
        const items = document.querySelectorAll(SELECTORS.endscreenItem);
        console.log("[AutoShort] Endscreen items:", items.length);

        if(!items.length){
            console.log("[AutoShort] No endscreen items -> fallback NEXT");
            fallbackToNextButton();
            return;
        }

        const currentLang = getCurrentVideoLanguage();
        const candidates = [];
        items.forEach(v=>{
            if(!v.closest('.html5-endscreen')) return;
            const d = getEndscreenData(v);
            if(d.duration < defaultSettings.maxDuration && d.views >= defaultSettings.minViews){
                candidates.push({
                    duration: d.duration,
                    views: d.views,
                    age: 0,
                    lang: detectLanguage(d.title),
                    title: d.title,
                    element: v
                });
            }
        });

        if(!candidates.length){ fallbackToNextButton(); return; }

        const sameLang = candidates.filter(c => matchesLanguage(c.lang, currentLang));
        const pool = sameLang.length ? sameLang : candidates;

        pickRandom(pool)?.element?.click();
    }


    /* =========================
 *  AUTOPLAY CORE
 * ========================= */

    let playedVideoIds=[];
    try{
        const stored=sessionStorage.getItem(STORAGE_KEYS.playedIds);
        if(stored) playedVideoIds=JSON.parse(stored);
    }catch(e){}

    function savePlayedVideoIds(){
        sessionStorage.setItem(STORAGE_KEYS.playedIds, JSON.stringify(playedVideoIds));
    }

    function matchesLanguage(videoLang, currentLang) {
        if (!defaultSettings.detectLanguage) return true;
        if (currentLang === 'unknown') return true;
        return videoLang === currentLang;
    }

    function mainAutoPlay(){
        console.log("== [AutoShort mainAutoPlay] ==");
        const autoplayBtn=document.querySelector(SELECTORS.autoplayToggle);
        if(!autoplayBtn) return;
        if(autoplayBtn.getAttribute('aria-checked')!=='false'){ return; }
        if(location.href.includes('list=')) return; // Skip playlists

        let sidebarItems=Array.from(document.querySelectorAll(SELECTORS.sidebarItems));
        if(!sidebarItems.length){
            sidebarItems = Array.from(document.querySelectorAll(SELECTORS.fallbackItems))
                .filter(item => item.closest('ytd-watch-next-secondary-results-renderer, #secondary, #related') || document.querySelector('ytd-watch-next-secondary-results-renderer, #secondary, #related') === null);
        }
        if(!sidebarItems.length){
            console.log("[AutoShort] No sidebar items -> using endscreen");
            pickVideoFromEndscreen(); return;
        }

        const videoData = sidebarItems.map(item=>{
            const info = getVideoInfo(item);
            if(!info || !info.title) return null;
            const videoId = getVideoIdFromUrl(info.href||'');
            const lang = detectLanguage(info.title);
            return {
                duration: info.duration,
                views: info.views,
                age: info.age,
                lang,
                title: info.title,
                videoId,

                element: info.element || findBestWatchLink(item),
                progress: info.progress
            };
        }).filter(Boolean);

        console.log("[AutoShort] Raw items:", videoData);

        const currentLang=getCurrentVideoLanguage();

        if (defaultSettings.debugDrops) {
            videoData.forEach(v=>{
                const reasons=[];
                if (v.duration >= defaultSettings.maxDuration) reasons.push('duration');
                if (v.views < defaultSettings.minViews) reasons.push('views');
                if (!matchesLanguage(v.lang,currentLang)) reasons.push(`lang(${v.lang}!=${currentLang})`);
                if (!v.videoId) reasons.push('noId');
                if (playedVideoIds.includes(v.videoId)) reasons.push('played');
                if (v.age > defaultSettings.maxAgeYears) reasons.push('age');
                if (reasons.length) console.debug('[DROP]', v.title, reasons.join('|'), v);
            });
        }

        const candidates=videoData.filter(v =>
                                          v.duration < defaultSettings.maxDuration &&
                                          v.views >= defaultSettings.minViews &&
                                          matchesLanguage(v.lang, currentLang) &&
                                          v.videoId &&
                                          v.element &&
                                          !playedVideoIds.includes(v.videoId) &&
                                          v.age <= defaultSettings.maxAgeYears
                                         );

        if(!candidates.length){
            console.log("[AutoShort] No candidates => endscreen fallback");
            pickVideoFromEndscreen(); return;
        }

        const weighted = defaultSettings.neverwatched
        ? candidates.flatMap(v => Array(v.progress ? 1 : UNWATCHED_WEIGHT).fill(v))
        : candidates;

        const picked=pickRandom(weighted);
        if(!picked){ pickVideoFromEndscreen(); return; }

        console.log("[AutoShort] Filtered:", candidates);
        console.log("[AutoShort] Playing:", picked.element?.href || picked.element?.getAttribute('href'));
        playedVideoIds.push(picked.videoId);
        savePlayedVideoIds();
        picked.element?.click();
    }

    /* =========================
 *  VISIBILITY BLOCK
 * ========================= */

    (function overrideVisibility(){
        if (typeof unsafeWindow!=='undefined'){
            unsafeWindow.onblur=null; unsafeWindow.blurred=false;
            unsafeWindow.document.hasFocus=()=>true;
            unsafeWindow.window.onFocus=()=>true;
        } else {
            window.onblur=null;
            document.hasFocus=()=>true;
            window.onFocus=()=>true;
        }
        ['hidden','mozHidden','msHidden','webkitHidden'].forEach(k=>safeDefine(document,k,{get:()=>false}));
        safeDefine(document,'visibilityState',{get:()=> 'visible'});
        safeDefine(document,'webkitVisibilityState',{get:()=> 'visible'});
        if (typeof unsafeWindow!=='undefined') unsafeWindow.document.onvisibilitychange=undefined;
        else document.onvisibilitychange=undefined;

        const handler=e=>{
            if(e.type==='blur' && (BLUR_WHITELIST.some(t=>e.target instanceof t) ||
                                   (e.target.classList && e.target.classList.contains('ql-editor')))) return;
            if(['mouseleave','mouseout'].includes(e.type) && !HOVER_BLACKLIST.some(t=>e.target instanceof t)) return;
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        };
        EVENTS_TO_BLOCK.forEach(ev=>{
            window.addEventListener(ev,handler,true);
            document.addEventListener(ev,handler,true);
        });
    })();

    /* =========================
 *  INIT & OBSERVER
 * ========================= */

    let lastUrl=location.href;
    function shouldRunScript(){
        return location.hostname==='www.youtube.com' &&
            location.href.includes('watch?') &&
            !location.href.includes('&list=');
    }
    function init(){
        if(!shouldRunScript()) return;
        loadSettings();
        const currentId=getVideoIdFromUrl(location.href);
        if(currentId && !playedVideoIds.includes(currentId)){
            playedVideoIds.push(currentId); savePlayedVideoIds();
        }
        const video=document.querySelector('video');
        if(video && !video.dataset.autoPlayEventAdded){
            video.dataset.autoPlayEventAdded='true';
            video.addEventListener('ended', ()=> mainAutoPlay());
        }
    }
    const observer=new MutationObserver(()=>{
        if(location.href!==lastUrl){
            lastUrl=location.href;
            setTimeout(()=>{ if(shouldRunScript()) init(); },1500);
        }
    });
    function startObserver(){
        if(document.body) observer.observe(document.body,{childList:true,subtree:true});
        else document.addEventListener('DOMContentLoaded',()=>observer.observe(document.body,{childList:true,subtree:true}));
    }
    function delayedInit(){ setTimeout(init,500); }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',delayedInit);
    else delayedInit();
    startObserver();

    if(defaultSettings.removeWhenReload || defaultSettings.removewhanreload){
        window.addEventListener('beforeunload',()=>sessionStorage.removeItem(STORAGE_KEYS.playedIds));
    }

})();
