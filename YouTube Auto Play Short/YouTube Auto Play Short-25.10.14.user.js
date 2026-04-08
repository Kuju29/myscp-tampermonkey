// ==UserScript==
// @name         YouTube Auto Play Short
// @version      26.04.08
// @description  Automatically pick and play short, high‑view videos (with optional language matching) when a video ends, falling back to endscreen if sidebar fails.
// @match        *://www.youtube.com/*
// @updateURL    https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Auto%20Play%20Short/YouTube%20Auto%20Play%20Short-25.10.14.user.js
// @downloadURL  https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Auto%20Play%20Short/YouTube%20Auto%20Play%20Short-25.10.14.user.js
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

    const SELECTORS = {
        settingsPanel: '#settings-panel',

        videoTitle: [
            'h1.ytd-watch-metadata',
            '#container > h1 > yt-formatted-string',
            'h1.title.ytd-watch-metadata'
        ].join(', '),

        sidebarItems: [
            'yt-lockup-view-model-wiz',
            'yt-lockup-view-model',
            'yt-lockup-view-model.ytd-item-section-renderer',
            'ytd-compact-video-renderer',
            'ytd-compact-playlist-renderer'
        ].join(', '),

        modern: {
            titleLink: [
                'a.yt-lockup-metadata-view-model__title',
                'a.yt-lockup-metadata-view-model-wiz__title',
                'a.ytLockupMetadataViewModelTitle'
            ].join(', '),

            contentImageLink: [
                'a.yt-lockup-view-model__content-image',
                'a.yt-lockup-view-model-wiz__content-image'
            ].join(', '),

            titleSpan: [
                '.yt-lockup-metadata-view-model__title span.yt-core-attributed-string',
                '.yt-lockup-metadata-view-model-wiz__title span.yt-core-attributed-string',
                '.yt-lockup-metadata-view-model__heading-reset [role="text"]',
                '.ytLockupMetadataViewModelTitle span.yt-core-attributed-string'
            ].join(', '),

            metadataContainer: [
                '.yt-lockup-view-model-wiz__metadata',
                '.yt-lockup-metadata-view-model__metadata',
                '.yt-lockup-metadata-view-model-wiz__metadata',
                '.yt-lockup-view-model__metadata'
            ].join(', '),

            metadataRow: [
                '.yt-content-metadata-view-model__metadata-row',
                '.yt-content-metadata-view-model-wiz__metadata-row',
                '.ytContentMetadataViewModelMetadataRow'
            ].join(', '),

            badgeDuration: [
                '.yt-thumbnail-bottom-overlay-view-model .badge-shape-wiz__text',
                '.yt-badge-shape__text',
                '.badge-shape__text'
            ].join(', '),

            watchedBar: [
                '.ytThumbnailOverlayProgressBarHostWatchedProgressBarHostWatchedProgressBarSegment',
                '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment'
            ].join(', ')
        },

        autoplayToggle: '.ytp-autonav-toggle-button-container .ytp-autonav-toggle-button',
        nextButton: '.ytp-next-button[aria-disabled="false"]',

        endscreenItem: '.html5-endscreen .ytp-videowall-still, .html5-endscreen .ytp-modern-videowall-still',
        endscreenTitle: '.ytp-videowall-still-info-title, .ytp-modern-videowall-still-info-title',
        endscreenAuthor: '.ytp-videowall-still-info-author, .ytp-modern-videowall-still-info-author',
        endscreenViewsDate: '.ytp-modern-videowall-still-view-count-and-date-info'
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

    function getVideoIdFromUrl(url){ const m=url.match(REGEX.videoId); return m?m[1]:null; }

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
        let t=text.replace(/,/g,'').trim();
        t=t.replace(/การดู/g,'').replace(/ครั้ง/g,'').replace(/views?/ig,'').trim();

        let factor=1;
        if (/แสน/.test(t)) { factor=100000; t=t.replace(/แสน/,'').trim(); }
        else if (/หมื่น/.test(t)) { factor=10000; t=t.replace(/หมื่น/,'').trim(); }
        else if (/พันล้าน/.test(t)) { factor=1e9; t=t.replace(/พันล้าน/,'').trim(); }
        else if (/ล้าน/.test(t)) { factor=1e6; t=t.replace(/ล้าน/,'').trim(); }
        else if (/พัน/.test(t)) { factor=1e3; t=t.replace(/พัน/,'').trim(); }

        if (/b$/i.test(t)) { factor=1e9; t=t.replace(/b$/i,''); }
        else if (/m$/i.test(t)) { factor=1e6; t=t.replace(/m$/i,''); }
        else if (/k$/i.test(t)) { factor=1e3; t=t.replace(/k$/i,''); }

        const num=parseFloat(t.replace(/[^\d\.]/g,''));
        if(!isFinite(num)) return 0;
        return Math.round(num*factor);
    }

    function parseUploadAge(text){
        if(!text) return 0;
        const t=text.toLowerCase().trim();
        if (/(อัปเดตแล้ววันนี้|วันนี้|ใหม่\b)/.test(t)) return 0;
        const mYear=t.match(REGEX.ageYear); if(mYear) return +mYear[1];
        const mMonth=t.match(REGEX.ageMonth); if(mMonth) return Math.floor(+mMonth[1]/12);
        const mWeek=t.match(REGEX.ageWeek); if(mWeek) return Math.floor(+mWeek[1]/52);
        const mDay=t.match(REGEX.ageDay); if(mDay) return Math.floor(+mDay[1]/365);
        const mHour=t.match(REGEX.ageHour); if(mHour) return 0;
        const mMin=t.match(REGEX.ageMinute); if(mMin) return 0;
        return 0;
    }

    function getVideoInfo(item){
        const titleLink =
              item.querySelector(SELECTORS.modern.titleLink) ||
              item.querySelector(SELECTORS.modern.contentImageLink);

        const titleSpan = item.querySelector(SELECTORS.modern.titleSpan);
        const heading =
              item.querySelector('.yt-lockup-metadata-view-model__heading-reset') ||
              item.querySelector('.ytLockupMetadataViewModelHeadingReset');

        const title =
              titleSpan?.textContent?.trim() ||
              heading?.getAttribute?.('title') ||
              titleLink?.getAttribute?.('title') ||
              titleLink?.getAttribute?.('aria-label') ||
              titleLink?.textContent?.trim() ||
              '';

        const rows = Array.from(item.querySelectorAll(SELECTORS.modern.metadataRow));

        let views = 0;
        let age = 0;

        for (const row of rows) {
            const parts = Array.from(row.querySelectorAll('span'))
            .map(el => el.textContent?.trim())
            .filter(Boolean);

            for (const txt of parts) {
                if (!views && /(การดู|views?|ครั้ง)/i.test(txt)) {
                    views = parseViews(txt);
                }
                if (!age && /(ปี|เดือน|สัปดาห์|วัน|ชั่วโมง|นาที|วันนี้|ใหม่|year|month|week|day|hour|min)/i.test(txt)) {
                    age = parseUploadAge(txt);
                }
            }

            if ((!views || !age) && parts.length === 0) {
                const txt = row.textContent.trim();
                if (!views && /(การดู|views?|ครั้ง)/i.test(txt)) views = parseViews(txt);
                if (!age && /(ปี|เดือน|สัปดาห์|วัน|ชั่วโมง|นาที|วันนี้|ใหม่|year|month|week|day|hour|min)/i.test(txt)) age = parseUploadAge(txt);
            }
        }

        const durationText = item.querySelector(SELECTORS.modern.badgeDuration)?.textContent?.trim() || '';
        const duration = parseDuration(durationText) || extractDurationFallbackFromAria(titleLink);

        const progress = !!item.querySelector(SELECTORS.modern.watchedBar);
        const href = titleLink?.getAttribute('href') || '';

        return { title, views, age, duration, progress, href };
    }

    /* =========================
 *  ENDSCREEN FALLBACK
 * ========================= */

    function parseViewsSimple(v){ return parseViews(v); }
    function getEndscreenData(node){
        const url = node.getAttribute('href') || '';
        const title = node.querySelector(SELECTORS.endscreenTitle)?.textContent.trim() || '';
        const author = node.querySelector(SELECTORS.endscreenAuthor)?.textContent.trim() || '';
        const durText = node.querySelector(SELECTORS.endscreenDuration)?.textContent.trim() || '0:00';
        const viewsDate = node.querySelector(SELECTORS.endscreenViewsDate)?.textContent.trim() || '';

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

        const sidebarItems=Array.from(document.querySelectorAll(SELECTORS.sidebarItems));
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

                element: item.querySelector(SELECTORS.modern.titleLink) || item.querySelector(SELECTORS.modern.contentImageLink),
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
