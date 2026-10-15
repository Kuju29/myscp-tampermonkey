// ==UserScript==
// @name         YouTube Auto Play Short
// @version      2026.10.15.2
// @description  Play short recommendations within your limits. Scoped DOM adapters, guarded playback, and readable English diagnostics.
// @match        *://www.youtube.com/*
// @icon         https://www.youtube.com/favicon.ico
// @updateURL    https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Auto%20Play%20Short/YouTube%20Auto%20Play%20Short.user.js
// @downloadURL  https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Auto%20Play%20Short/YouTube%20Auto%20Play%20Short.user.js
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * Rebuild 2026.10.15.2
 * Flow: page adapter -> evidence -> one candidate per video -> filters -> selection -> playback.
 * Primary selection uses filters; fallback uses Next, then random endscreen recommendations.
 * A route change is not proof of media readiness. Old ended events cannot own a new route.
 * Start from a song: recommendations come from YouTube. Title script is not audio language
 * or proof that a recommendation is music. No network requests. Read-only page data with route validation; DOM fallbacks remain available.
 *
 * Saved settings and this tab's played IDs keep their original storage keys.
 * fallbackNext enables unfiltered Next and endscreen fallback when primary selection is empty.
 * No visibility spoofing, global event blocking, automatic unmute, or retry of a denied play().
 * DOM/ARIA are not a YouTube compatibility contract: when evidence is insufficient, stop
 * and explain why. All site-specific selectors live in DOM below.
 */
(() => {
    'use strict';

    // 1. Configuration and persistent state
    const VERSION = '2026.10.15.2';
    const KEYS = { settings: 'youtubeAutoPlaySettings', played: 'playedVideoIds',
        ticket: 'autoShortVerifiedHandoffV2', previous: 'autoShortPreviousReviewV2' };
    const DEFAULTS = Object.freeze({ maxDuration: 600, minViews: 1000000, maxAgeYears: 99,
        neverwatched: true, detectLanguage: true, removeWhenReload: false,
        debugDrops: false, enabled: true, requireAutoplayOff: true, fallbackNext: true });
    const LIMITS = Object.freeze({ cards: 200, links: 800, textNodes: 500, history: 2000, logs: 200 });
    const RETRIES = [400, 900];
    const UNWATCHED_WEIGHT = 10;
    const DOM = Object.freeze({
        watch: 'ytd-watch-flexy:not([hidden])', player: '#movie_player',
        video: 'video', preview: 'ytd-miniplayer, #inline-preview-player, .ytp-ad-preview-container',
        sidebar: 'ytd-watch-next-secondary-results-renderer, #related, #secondary, aside',
        cards: 'yt-lockup-view-model, ytd-compact-video-renderer, ytd-compact-playlist-renderer',
        endscreen: '.html5-endscreen, .ytp-fullscreen-grid-main-content', endCard: '.ytp-videowall-still, .ytp-modern-videowall-still',
        title: '#video-title, h3, h2, [role="heading"], .ytp-videowall-still-info-title, .ytp-modern-videowall-still-info-title',
        currentTitle: 'ytd-watch-metadata h1, #above-the-fold h1',
        metadata: '#metadata-line, [class*="metadata-row"], [class*="MetadataRow"], .ytp-modern-videowall-still-view-count-and-date-info',
        duration: 'ytd-thumbnail-overlay-time-status-renderer, [class*="duration"], [class*="info-length"], [class*="badge-shape"], [class*="BadgeShape"]',
        progress: 'ytd-thumbnail-overlay-resume-playback-renderer, [class*="ProgressBar"][class*="Watched"], [class*="progress"][class*="watched"]',
        adCard: 'ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-in-feed-ad-layout-renderer',
        excluded: '#comments, ytd-comments, ytd-miniplayer, #inline-preview-player, #yt-autoshort-settings',
        controls: '.ytp-chrome-controls, [role="toolbar"]',
        autoplay: '.ytp-autonav-toggle-button, [data-tooltip-target-id="ytp-autonav-toggle-button"]',
        next: '.ytp-next-button, [rel="next"]',
        live: '[overlay-style="LIVE"], [overlay-style="UPCOMING"], .badge-style-type-live-now',
        adPlayer: '.ad-showing, .ad-interrupting'
    });
    const logEntries = [];
    const mediaRecords = new WeakMap();
    const state = { route: null, epoch: 0, navigating: false, boundary: null, player: null,
        video: null, binding: null, attempt: null, serial: 0, ticket: null, review: null,
        previous: null, status: 'Waiting for the main video.', statusKey: '', panel: null };
    let settings = { ...DEFAULTS };
    let played = new Set();
    let syncTimer = null;
    let navigationTimer = null;

    const norm = value => digitText(value).replace(/\s+/g, ' ').trim();
    const text = node => norm(node?.textContent);
    const short = (value, max = 180) => norm(value).slice(0, max);
    const all = (root, selector) => root ? [...root.querySelectorAll(selector)] : [];
    const validId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);
    const sourceOf = video => video?.currentSrc || video?.getAttribute('src') || '';
    const errorInfo = error => ({ name: error?.name || 'Error', message: short(error?.message || error, 400) });

    function storage(kind, key, value) {
        try {
            const store = kind === 'local' ? localStorage : sessionStorage;
            if (arguments.length < 3) return JSON.parse(store.getItem(key) || 'null');
            if (value === null) store.removeItem(key);
            else store.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            log('Storage unavailable', { kind, key, ...errorInfo(error) }, 'warn');
            return null;
        }
    }
    function normalizeSettings(raw) {
        const out = { ...DEFAULTS };
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
        for (const [key, min, max] of [['maxDuration', 1, 86400], ['minViews', 0, 1e15], ['maxAgeYears', 0, 999]]) {
            const v = raw[key], n = Number(v);
            if (v !== '' && v !== null && typeof v !== 'boolean' && Number.isFinite(n) && n >= min && n <= max) out[key] = n;
        }
        for (const key of Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k] === 'boolean')) {
            if (typeof raw[key] === 'boolean') out[key] = raw[key];
        }
        if (!Object.hasOwn(raw, 'removeWhenReload')) out.removeWhenReload = raw.removewhanreload === true;
        return out;
    }
    function remember(id) {
        if (!validId(id) || played.has(id)) return;
        played.add(id);
        if (played.size > LIMITS.history) played.delete(played.values().next().value);
        storage('session', KEYS.played, [...played]);
    }
    function watchURL(value) {
        if (!value) return null;
        try {
            const url = new URL(value, location.origin), id = url.searchParams.get('v');
            if (!['https:', 'http:'].includes(url.protocol) || !['www.youtube.com', 'youtube.com'].includes(url.hostname)
                || url.pathname !== '/watch' || !validId(id)) return null;
            return { id, playlist: url.searchParams.has('list'), url: `https://www.youtube.com/watch?v=${id}` };
        } catch (_) { return null; }
    }
    function route() {
        const url = new URL(location.href), target = watchURL(url.href);
        return { id: target?.id || null, eligible: !!target && !target.playlist,
            key: `${url.pathname}:${target?.id || ''}:${url.searchParams.has('list')}` };
    }

    // Locale helpers use the browser's ICU data, not a fixed list of translated age words.
    const intlCache = new Map();
    const digitText = value => String(value ?? '').normalize('NFKC').replace(/\p{Nd}/gu, c => {
        const cp = c.codePointAt(0); let first = cp;
        while (first > 0 && /\p{Nd}/u.test(String.fromCodePoint(first - 1))) first--;
        return String((cp - first) % 10);
    }).replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
    const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function pageLocale() {
        return document.documentElement.lang || navigator.language || 'en';
    }
    function localeTools(locale = pageLocale()) {
        if (intlCache.has(locale)) return intlCache.get(locale);
        const out = { compact: [], ages: [], exactAges: new Map() };
        try {
            const nf = new Intl.NumberFormat(locale), parts = nf.formatToParts(12345.6);
            out.group = parts.find(p => p.type === 'group')?.value || ',';
            out.decimal = parts.find(p => p.type === 'decimal')?.value || '.';
            const numeric = new Set(['integer', 'decimal', 'fraction', 'group']);
            for (const display of ['short', 'long']) {
                const fmt = new Intl.NumberFormat(locale, { notation: 'compact', compactDisplay: display });
                for (const power of [3, 4, 5, 6, 7, 8, 9, 12]) for (const multiplier of [1, 2, 5]) {
                    const value = multiplier * 10 ** power, ps = fmt.formatToParts(value);
                    if (!ps.some(p => p.type === 'compact')) continue;
                    const rendered = ps.filter(p => numeric.has(p.type)).map(p => p.value).join('');
                    const n = localeNumber(rendered, out);
                    if (!n) continue;
                    let inserted = false, pattern = '';
                    for (const p of ps) {
                        if (numeric.has(p.type)) { if (!inserted) pattern += '([0-9][0-9.,٬٫ ]*)'; inserted = true; }
                        else pattern += escapeRE(digitText(p.value).replace(/\s+/g, ' ')).replace(/ /g, '\\s*');
                    }
                    out.compact.push({ re: new RegExp('^' + pattern + '$', 'i'), factor: value / n });
                }
            }
            for (const style of ['long', 'short', 'narrow']) {
                const fmt = new Intl.RelativeTimeFormat(locale, { style, numeric: 'always' });
                const natural = new Intl.RelativeTimeFormat(locale, { style, numeric: 'auto' });
                for (const [unit, scale] of [['year',1],['month',1/12],['week',1/52],['day',1/365],['hour',1/8760],['minute',1/525600],['second',1/31536000]]) {
                    for (const n of [0, 1, 2, 3, 5, 11, 21, 100]) {
                        const ps = fmt.formatToParts(-n, unit); let inserted = false, pattern = '';
                        for (const p of ps) {
                            if (numeric.has(p.type)) { if (!inserted) pattern += '([0-9][0-9.,٬٫ ]*)'; inserted = true; }
                            else pattern += escapeRE(digitText(p.value).replace(/\s+/g, ' ')).replace(/ /g, '\\s*');
                        }
                        if (inserted) out.ages.push({ re: new RegExp('^' + pattern + '$', 'i'), scale });
                        const literal = norm(natural.format(-n, unit));
                        if (!/[0-9]/.test(literal)) out.exactAges.set(literal.toLowerCase(), n * scale);
                    }
                }
            }
        } catch (_) { /* Unsupported locales retain legacy parsers and structured numbers. */ }
        if (intlCache.size >= 8) intlCache.delete(intlCache.keys().next().value);
        intlCache.set(locale, out); return out;
    }
    function localeNumber(value, tools = localeTools()) {
        let raw = digitText(value).trim();
        if (tools.group) raw = raw.split(tools.group).join('');
        if (tools.decimal) raw = raw.replace(tools.decimal, '.');
        raw = raw.replace(/\s/g, '');
        return /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
    }
    function localizedCount(value) {
        const t = norm(value), tools = localeTools();
        for (const rule of tools.compact) {
            const m = t.match(rule.re); if (!m) continue;
            const n = localeNumber(m[1], tools);
            if (n !== null) return Math.round(n * rule.factor);
        }
        const n = localeNumber(t, tools);
        return Number.isSafeInteger(n) ? n : null;
    }
    function localizedAge(value) {
        const t = norm(value), tools = localeTools();
        if (tools.exactAges.has(t.toLowerCase())) return tools.exactAges.get(t.toLowerCase());
        for (const rule of tools.ages) {
            const m = t.match(rule.re); if (!m) continue;
            const n = localeNumber(m[1], tools); if (n !== null) return n * rule.scale;
        }
        return null;
    }

    // Read only known recommendation containers, never scan arbitrary commands/history.
    const dataText = v => typeof v === 'string' ? norm(v) : norm(v?.simpleText ?? v?.content ?? v?.runs?.map(r => r.text || '').join(''));
    function walkData(root, visit, limit = 1800) {
        const queue = [root], seen = new Set(); let i = 0;
        for (; i < queue.length && i < limit; i++) {
            const node = queue[i];
            if (!node || typeof node !== 'object' || seen.has(node)) continue;
            seen.add(node); if (visit(node) === false) continue;
            for (const [key, value] of Object.entries(node)) {
                if (/menu|tracking|logging|feedback|framework|adSlot|promoted|sponsored/i.test(key)) continue;
                if (value && typeof value === 'object' && queue.length < limit) queue.push(value);
            }
        }
        return i >= limit;
    }
    function structuredCard(raw, source) {
        const id = raw.videoId || (raw.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? raw.contentId : null);
        if (!validId(id)) return null;
        const endpoint = raw.navigationEndpoint?.watchEndpoint
            || raw.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
        if (endpoint?.videoId && endpoint.videoId !== id) return null;
        const c = { id, url: `https://www.youtube.com/watch?v=${id}`,
            title: dataText(raw.title || raw.metadata?.lockupMetadataViewModel?.title),
            sources: [source], adapters: ['page-data'], links: [], watched: false,
            playlist: !!endpoint?.playlistId, live: raw.isLive === true || !!raw.upcomingEventData,
            evidence: { duration: [], views: [], age: [] }, conflicts: [], dataEpoch: state.epoch };
        const add = (field, value, rank, via) => {
            if (Number.isFinite(value) && value >= 0) c.evidence[field].push({ value, rank, raw: String(value), via: source + '/' + via });
        };
        const number = v => typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
        add('duration', number(raw.lengthSeconds ?? raw.lengthInSeconds), 5, 'numeric-duration');
        add('views', number(raw.viewCount), 5, 'numeric-views');
        add('duration', parseDuration(dataText(raw.lengthText)), 3, 'duration');
        add('views', parseViews(dataText(raw.viewCountText || raw.shortViewCountText), true), 3, 'views');
        add('age', parseAge(dataText(raw.publishedTimeText)), 3, 'age');
        // Machine-readable dates, when supplied, avoid localized age words entirely.
        if (typeof raw.publishedTime === 'string' && /^\d{4}-\d\d-\d\d(?:T|$)/.test(raw.publishedTime)) {
            const stamp = Date.parse(raw.publishedTime);
            if (stamp <= Date.now()) add('age', (Date.now() - stamp) / 31557600000, 5, 'date');
        }
        walkData(raw.thumbnailOverlays || raw.contentImage, node => {
            const overlay = node.thumbnailOverlayTimeStatusRenderer || node.thumbnailBadgeViewModel;
            if (overlay) {
                add('duration', parseDuration(dataText(overlay.text)), 3, 'overlay-clock');
                if (/LIVE|UPCOMING/.test(overlay.style || overlay.badgeStyle || '')) c.live = true;
            }
            const progress = node.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched
                ?? node.thumbnailOverlayProgressBarViewModel?.startPercent;
            if (progress > 0) c.watched = true;
        }, 160);
        const rows = raw.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
        for (const row of rows) {
            const parts = row.metadataParts || [];
            const hasAge = parts.some(p => parseAge(dataText(p.text)) !== null);
            for (const p of parts) {
                add('age', parseAge(dataText(p.text)), 3, 'metadata-age');
                if (hasAge || p.leadingIcon?.name === 'PLAY_ARROW_OUTLINED')
                    add('views', parseViews(dataText(p.text), true), 3, 'metadata-views');
            }
        }
        return c;
    }
    function structuredCandidates() {
        const out = [], diagnostics = { roots: 0, stale: 0, capped: false, unavailable: false };
        let page, watchData;
        try { page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; watchData = watchRoot()?.data; }
        catch (_) { diagnostics.unavailable = true; return { candidates: out, diagnostics }; }
        const roots = new Set();
        // ytInitialData may remain from an older SPA route: require its own current video ID.
        try { for (const root of [watchData, page.ytInitialData]) if (root && typeof root === 'object') roots.add(root); }
        catch (_) { diagnostics.unavailable = true; }
        for (const root of roots) {
            if (root.currentVideoEndpoint?.watchEndpoint?.videoId !== state.route?.id) { diagnostics.stale++; continue; }
            diagnostics.roots++;
            const next = root.contents?.twoColumnWatchNextResults || root.contents?.singleColumnWatchNextResults;
            const sidebar = next?.secondaryResults;
            const endscreen = root.playerOverlays?.playerOverlayRenderer?.endScreen;
            for (const [container, source] of [[sidebar, 'Sidebar'], [endscreen, 'Endscreen']]) {
                const capped = walkData(container, node => {
                    const raw = node.compactVideoRenderer || node.videoRenderer || node.endScreenVideoRenderer || node.lockupViewModel;
                    if (!raw) return;
                    const c = structuredCard(raw, source); if (c && out.length < LIMITS.cards) out.push(c);
                    return false;
                });
                diagnostics.capped ||= capped;
            }
            if (settings.fallbackNext) {
                const sets = next?.autoplay?.autoplay?.sets || [];
                const endpoint = sets[0]?.autoplayVideo?.watchEndpoint;
                if (validId(endpoint?.videoId) && !endpoint.playlistId) {
                    const c = structuredCard({ videoId: endpoint.videoId }, 'Next');
                    if (c) out.push(c);
                }
            }
        }
        return { candidates: out, diagnostics };
    }

    // 2. English diagnostics: all candidates remain visible; raw evidence is exportable.
    function log(event, details = {}, level = 'info') {
        logEntries.push({ at: new Date().toISOString(), event, level, details });
        if (logEntries.length > LIMITS.logs) logEntries.shift();
        const color = level === 'warn' ? '#d99a23' : level === 'error' ? '#e65c5c' : '#39a9db';
        console[level](`%c[AutoShort]%c ${event}`, `color:${color};font-weight:bold`, 'color:inherit', ...(Object.keys(details).length ? [details] : []));
    }
    function setStatus(message, level = 'info') {
        state.status = message;
        const status = state.panel?.querySelector('[role="status"]');
        if (status) status.textContent = message;
        if (state.statusKey !== message) { state.statusKey = message; log(message, {}, level); }
    }
    function clock(value) {
        if (!Number.isFinite(value)) return 'Unknown';
        const n = Math.round(value), h = Math.floor(n / 3600), m = Math.floor(n / 60) % 60, s = n % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    }
    function candidateRow(c, reasons, selectedId, pool) {
        return { Title: c.title || '(unknown)', Duration: clock(c.duration),
            Views: c.views === null ? 'Unknown' : c.views.toLocaleString('en-US'),
            Age: c.age === null ? 'Unknown' : `${Number(c.age.toFixed(2))} y`,
            Language: c.language, Watched: c.watched ? 'Yes' : 'No indicator', Source: c.sources.join(' + '),
            Result: c.id === selectedId ? 'SELECTED' : reasons.length ? reasons.join(' | ')
                : pool.has(c.id) ? 'Eligible' : 'Eligible backup', URL: c.url };
    }
    function showReview(review, selectedId = null) {
        const pool = new Set(review.poolIds);
        console.group(`%c[AutoShort] Candidate review · ${review.candidates.length} unique · ${pool.size} in selection pool`, 'color:#39a9db;font-weight:bold');
        console.info(`Current: ${review.title || '(unknown title)'} | Title script: ${review.language}`);
        console.info(`Rules: duration < ${clock(settings.maxDuration)} (${settings.maxDuration}s) | views >= ${settings.minViews.toLocaleString('en-US')} | age <= ${settings.maxAgeYears}y | language match: ${settings.detectLanguage ? 'ON' : 'OFF'}`);
        console.table(review.candidates.map(c => candidateRow(c, c.reasons, selectedId, pool)));
        if (settings.debugDrops) console.info('Parser evidence', review.candidates.map(c => ({ id: c.id, adapters: c.adapters, evidence: c.evidence })));
        console.info('Discovery', review.discovery);
        console.groupEnd();
    }

    // 3. Pure parsers: no title guesses, no missing-value-to-zero conversion.
    function parseDuration(value) {
        const t = norm(value);
        if (!/^\d{1,4}:\d{2}(?::\d{2})?$/.test(t)) return null;
        const p = t.split(':').map(Number);
        if (p.at(-1) > 59 || (p.length === 3 && p[1] > 59)) return null;
        const seconds = p.reduce((a, b) => a * 60 + b, 0);
        return seconds > 0 ? seconds : null;
    }
    function parseSpokenDuration(value) {
        const t = norm(value);
        if (parseDuration(t) !== null) return parseDuration(t);
        const units = /([0-9]+)\s*(hours?|hrs?|ชั่วโมง|時間|시간|小时|小時|minutes?|mins?|นาที|分鐘|分钟|분|分|seconds?|secs?|วินาที|초|秒)(?![A-Za-z])/gi;
        const matches = [...t.matchAll(units)];
        if (!matches.length) return null;
        let remainder = t.replace(units, '').replace(/[,\s]|\band\b|และ/gi, '');
        if (remainder) return null; // Relative ages or a mixed title are not durations.
        let total = 0, lastFactor = Infinity;
        for (const m of matches) {
            const factor = /^(hours?|hrs?|ชั่วโมง|時間|시간|小时|小時)$/i.test(m[2]) ? 3600
                : /^(minutes?|mins?|นาที|分鐘|分钟|분|分)$/i.test(m[2]) ? 60 : 1;
            if (factor >= lastFactor) return null;
            lastFactor = factor;
            total += Number(m[1]) * factor;
        }
        return total > 0 ? total : null;
    }
    function durationFromLabel(label, title = '') {
        let t = norm(label);
        if (title && t.startsWith(norm(title))) t = t.slice(norm(title).length).trim();
        const direct = parseSpokenDuration(t);
        if (direct !== null) return direct;
        // A title can itself contain "3:30". Only an explicit duration prefix is safe here.
        const marked = t.match(/(?:duration|ความยาว)\s*:?\s*(.+)$/i);
        return marked ? parseSpokenDuration(marked[1]) : null;
    }
    function parseAmount(raw, compact = false) {
        let t = norm(raw).replace(/\s/g, '');
        if (/^\d{1,3}(?:,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
        else if (!compact && /^\d{1,3}(?:\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
        else if (t.includes(',') && t.includes('.')) return null;
        else t = t.replace(',', '.');
        const n = Number(t);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }
    function parseViews(value, allowBare = false) {
        let t = norm(value).toLowerCase();
        if (/^(no views|ยังไม่มีการดู|ไม่มีการดู|ไม่มีการรับชม)$/.test(t)) return 0;
        if (allowBare) { const local = localizedCount(t); if (local !== null) return local; }
        const labelled = /^(?:การดู|รับชม|조회수)\s*/.test(t) || /\s*(?:views?|ครั้ง|回視聴|次观看|次觀看)$/.test(t);
        if (!allowBare && !labelled) return null;
        t = t.replace(/^(?:การดู|รับชม|조회수)\s*/, '').replace(/\s*(?:views?|ครั้ง|回視聴|次观看|次觀看)$/, '').trim();
        const match = t.match(/^([0-9]+(?:[.,][0-9]+)*(?: [0-9]{3})*)\s*(พันล้าน|ล้าน|แสน|หมื่น|พัน|billion|million|thousand|[kmb]|億|亿|万|萬|천|만|억)?$/i);
        if (!match) return null;
        const n = parseAmount(match[1], !!match[2]);
        const factor = { 'พันล้าน': 1e9, billion: 1e9, b: 1e9, 'ล้าน': 1e6, million: 1e6, m: 1e6,
            'แสน': 1e5, 'หมื่น': 1e4, 'พัน': 1e3, thousand: 1e3, k: 1e3, '億': 1e8, '亿': 1e8,
            '万': 1e4, '萬': 1e4, '천': 1e3, '만': 1e4, '억': 1e8 }[match[2]] || 1;
        return n === null ? null : Math.round(n * factor);
    }
    function parseAge(value) {
        const t = norm(value).toLowerCase().replace(/^(?:streamed|premiered|เผยแพร่|สตรีมเมื่อ)\s*/, '');
        const local = localizedAge(t); if (local !== null) return local;
        if (/^(today|just now|moments ago|วันนี้|ใหม่)$/.test(t)) return 0;
        if (!/(?:ago|ที่แล้ว|ก่อน|前|전|전에)$/.test(t)) return null;
        const units = [['years?|yrs?|ปี|年|년', 1], ['months?|mos?|เดือน|か月|ヶ月|个月|個月|개월', 1 / 12],
            ['weeks?|wks?|สัปดาห์|สัปดา|週間|周|週|주', 1 / 52], ['days?|วัน|日|일', 1 / 365],
            ['hours?|hrs?|ชั่วโมง|ชม\\.?|時間|시간|小时|小時', 1 / 8760],
            ['minutes?|mins?|นาที|分鐘|分钟|분|分', 1 / 525600], ['seconds?|secs?|วินาที|초|秒', 1 / 31536000]];
        for (const [unit, scale] of units) {
            const m = t.match(new RegExp('^(\\d+(?:\\.\\d+)?)\\s*(?:' + unit + ')\\s*(?:ago|ที่แล้ว|ก่อน|前|전|전에)$', 'i'));
            if (m) return Number(m[1]) * scale;
        }
        return null;
    }
    function titleLanguage(value) {
        const t = norm(value).replace(/\[[^\]]*\]|【[^】]*】/g, ' ').replace(/\b(official|music|video|mv|lyrics?|audio|subs?)\b/ig, '');
        const th = (t.match(/[\u0e00-\u0e7f]/g) || []).length, lao = (t.match(/[\u0e80-\u0eff]/g) || []).length;
        if (th || lao) return th >= lao ? 'Thai' : 'Lao';
        if (/[\uac00-\ud7af]/.test(t)) return 'Korean';
        if (/[\u3040-\u30ff]/.test(t)) return 'Japanese';
        if (/[\u4e00-\u9fff]/.test(t)) return 'CJK';
        const scripts = ['Latin', 'Cyrillic', 'Arabic', 'Hebrew', 'Greek', 'Devanagari', 'Bengali', 'Tamil', 'Telugu',
            'Kannada', 'Malayalam', 'Gujarati', 'Gurmukhi', 'Oriya', 'Sinhala', 'Myanmar', 'Khmer', 'Tibetan',
            'Georgian', 'Armenian', 'Ethiopic', 'Mongolian'];
        let best = 'Unknown', count = 0;
        for (const script of scripts) {
            const n = (t.match(new RegExp('\\p{Script=' + script + '}', 'gu')) || []).length;
            if (n > count) { best = script; count = n; }
        }
        return best;
    }
    function languageMatches(a, b) {
        return a === b || (['CJK', 'Japanese'].includes(a) && ['CJK', 'Japanese'].includes(b));
    }

    // 4. Site adapter. All searches are bounded and scoped to recommendation surfaces.
    function visible(node) {
        if (!node?.isConnected || node.closest('[hidden], [aria-hidden="true"]')) return false;
        const css = getComputedStyle(node);
        return css.display !== 'none' && css.visibility !== 'hidden' && !!node.getClientRects().length;
    }
    function watchRoot() { return document.querySelector(DOM.watch); }
    function mainPlayer() {
        const root = watchRoot();
        return root?.querySelector(DOM.player) || all(document, DOM.player).find(p => !p.closest(DOM.preview) && visible(p)) || null;
    }
    function mainVideo(player) {
        const videos = all(player, DOM.video).filter(v => !v.closest(DOM.preview));
        const playing = videos.filter(v => visible(v) && !v.paused && !v.ended);
        if (playing.length === 1) return playing[0];
        const shown = videos.filter(visible);
        return shown.length === 1 ? shown[0] : videos.length === 1 ? videos[0] : null;
    }
    function isAd() { return !!state.player?.matches(DOM.adPlayer); }
    function pageMediaMatches() {
        const id = watchRoot()?.getAttribute('video-id');
        return !id || id === state.route?.id;
    }
    function currentTitle() {
        const root = watchRoot() || document;
        const el = all(root, DOM.currentTitle).find(n => !n.closest('[hidden]') && text(n));
        return text(el) || norm(document.title).replace(/\s+-\s+YouTube$/i, '');
    }
    function autoplayState() {
        const player = state.player;
        if (!player) return 'unknown';
        const nodes = new Set(all(player, DOM.autoplay));
        for (const node of all(player, '[role="switch"], [aria-checked], [aria-pressed]')) {
            const label = norm(node.getAttribute('aria-label') || node.getAttribute('title'));
            if (/autoplay|เล่นอัตโนมัติ|自動再生|자동\s*재생|自动播放|自動播放/i.test(label)) nodes.add(node);
        }
        const values = [];
        for (const node of nodes) {
            for (const el of [node, ...all(node, '[aria-checked], [aria-pressed]')]) {
                const value = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
                if (value === 'true' || value === 'false') values.push(value);
            }
        }
        if (values.includes('true')) return 'on';
        return values.includes('false') ? 'off' : 'unknown';
    }
    function nextLinks() {
        const links = new Set(all(state.player, DOM.next + ', [aria-keyshortcuts]'));
        for (const el of [...links]) if (!el.matches(DOM.next) && !/shift\s*\+\s*n/i.test(el.getAttribute('aria-keyshortcuts') || '')) links.delete(el);
        for (const el of all(state.player, 'a[href][aria-label], a[href][title]')) {
            if (/^(next|next video|ถัดไป|วิดีโอถัดไป|次へ|다음)(?:\s*\(|$)/i.test(norm(el.getAttribute('aria-label') || el.getAttribute('title')))) links.add(el);
        }
        return [...links].filter(n => watchURL(n.getAttribute('href')) && !n.closest('[disabled], [aria-disabled="true"], [inert]'));
    }
    function watchLinks(node) {
        return [node, ...all(node, 'a[href]')].filter(n => n.matches?.('a[href]') && watchURL(n.getAttribute('href')));
    }
    function hasThumbnail(node) {
        return !!node.querySelector('img, [style*="background-image"]') || !!node.style?.backgroundImage;
    }
    function semanticCards(scope) {
        const cards = new Set();
        for (const link of all(scope, 'a[href]').slice(0, LIMITS.links)) {
            const url = watchURL(link.getAttribute('href'));
            if (!url || link.closest(DOM.excluded + ', ' + DOM.controls)) continue;
            let card = link;
            for (let parent = link.parentElement, depth = 0; parent && parent !== scope && depth < 7; parent = parent.parentElement, depth++) {
                const links = watchLinks(parent);
                if (links.length > 16 || links.some(a => watchURL(a.getAttribute('href')).id !== url.id)) break;
                card = parent;
                if (parent.matches('article, [role="listitem"], ' + DOM.cards)) break;
            }
            if (hasThumbnail(card) || card.querySelector(DOM.title)) cards.add(card);
        }
        return [...cards];
    }
    function discover() {
        const root = watchRoot() || document, entries = [], seen = new Set();
        const add = (node, source, adapter) => {
            if (seen.has(node) || node.closest(DOM.excluded) || node.closest(DOM.adCard)) return;
            if (source === 'Sidebar' && node.closest('[hidden], [aria-hidden="true"]')) return;
            seen.add(node); entries.push({ node, source, adapter });
        };
        const scopes = all(root, DOM.sidebar).filter(n => !n.closest(DOM.excluded));
        // Known host tags still work if the sidebar container is renamed.
        for (const node of all(root, DOM.cards)) {
            if (!node.closest(DOM.player) && (scopes.some(s => s.contains(node)) || root !== document)) add(node, 'Sidebar', 'host');
        }
        for (const scope of scopes.filter((n, _, a) => !a.some(other => other !== n && other.contains(n)))) {
            for (const node of semanticCards(scope)) {
                if (!entries.some(e => e.node.contains(node) || node.contains(e.node))) add(node, 'Sidebar', 'structure');
            }
        }
        // Structural fallback if sidebar host tags and containers were renamed.
        if (root !== document) for (const node of semanticCards(root)) {
            if (!state.player?.contains(node) && !node.contains(state.player)
                && !entries.some(e => e.node.contains(node) || node.contains(e.node))) add(node, 'Sidebar', 'structure-root');
        }
        for (const node of all(state.player, DOM.endCard)) add(node, 'Endscreen', 'host');
        const endRoots = all(state.player, DOM.endscreen);
        for (const scope of endRoots) for (const node of semanticCards(scope)) {
            if (!entries.some(e => e.node.contains(node) || node.contains(e.node))) add(node, 'Endscreen', 'structure');
        }
        // Renamed endscreen hosts: only thumbnail links, never player controls.
        for (const node of all(state.player, 'a[href]')) {
            if (watchURL(node.getAttribute('href')) && hasThumbnail(node) && !node.closest(DOM.controls)
                && !entries.some(e => e.node.contains(node))) add(node, 'Endscreen', 'thumbnail-link');
        }
        if (settings.fallbackNext) for (const node of nextLinks()) add(node, 'Next', 'verified-link');
        return { entries: entries.slice(0, LIMITS.cards), capped: Math.max(0, entries.length - LIMITS.cards) };
    }
    function fragments(node) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), parts = [];
        let n, count = 0;
        while ((n = walker.nextNode()) && count++ < LIMITS.textNodes) {
            const value = norm(n.nodeValue), el = n.parentElement;
            if (value && el && !el.closest('script,style,button,[role="button"],svg')) parts.push({ value, el });
        }
        return parts;
    }
    function readCard({ node, source, adapter }) {
        const links = watchLinks(node), ids = new Set(links.map(a => watchURL(a.getAttribute('href')).id));
        if (ids.size !== 1) return null; // Never combine metadata across neighboring videos.
        const target = watchURL(links[0].getAttribute('href'));
        const titleNode = node.querySelector(DOM.title);
        const textLink = links.find(a => !hasThumbnail(a) && text(a));
        const title = text(titleNode) || norm(titleNode?.getAttribute('title')) || norm(textLink?.getAttribute('title'))
            || text(textLink) || norm(node.getAttribute('title')) || norm(links.find(a => a.hasAttribute('title'))?.getAttribute('title'))
            || norm(node.querySelector('img[alt]')?.getAttribute('alt'));
        const c = { id: target.id, url: target.url, title, playlist: links.every(a => watchURL(a.getAttribute('href')).playlist),
            sources: [source], adapters: [adapter], links, watched: false, live: node.getAttribute('data-is-live') === 'true' || all(node, DOM.live).some(visible),
            evidence: { duration: [], views: [], age: [] }, conflicts: [] };
        const add = (field, value, raw, via, rank = 1) => {
            if (value !== null && Number.isFinite(value) && c.evidence[field].length < 20) c.evidence[field].push({ value, raw: short(raw, 120), via: `${source}/${via}`, rank });
        };
        const parts = fragments(node);
        if (source === 'Next') {
            c.title ||= norm(node.getAttribute('data-tooltip-text')) || 'YouTube Next';
            add('duration', parseDuration(node.getAttribute('data-duration')), node.getAttribute('data-duration'), 'next-duration', 3);
        }
        for (const row of all(node, DOM.metadata)) {
            const segments = text(row).split(/\s*[•·]\s*/);
            if (segments.length > 1) for (const segment of segments) {
                add('views', parseViews(segment, true), segment, 'metadata-segment', 3);
                add('age', parseAge(segment), segment, 'metadata-segment', 3);
            }
        }
        const isTitle = el => !!(titleNode?.contains(el) || el.closest('h1,h2,h3,h4,[role="heading"]') || (textLink && textLink.contains(el)));
        const isChannel = el => { const a = el.closest('a[href]'); return !!a && !watchURL(a.getAttribute('href')); };
        const metaParts = parts.filter(p => !isTitle(p.el) && !isChannel(p.el)
            && (!p.el.closest('a[href]') || p.el.closest('a[href]') === node));
        const ageParts = metaParts.filter(p => parseAge(p.value) !== null);
        for (const p of parts) {
            if (isTitle(p.el) || isChannel(p.el)) continue;
            const inThumbnail = hasThumbnail(p.el.closest('a[href]') || node) && !!p.el.closest('a[href]');
            if (inThumbnail || p.el.closest(DOM.duration)) add('duration', parseDuration(p.value), p.value, 'clock', 3);
            else if (!p.el.closest('a[href]')) add('duration', parseDuration(p.value), p.value, 'structural-clock', 2);
            if (/^(live|upcoming|premiere|ไลฟ์สด|ถ่ายทอดสด|กำลังถ่ายทอดสด|รอชม|พรีเมียร์)$/i.test(p.value) && visible(p.el) && node.getAttribute('data-is-live') !== 'false' && !p.el.closest('.ytp-modern-videowall-still-info-live')) c.live = true;
        }
        for (const p of metaParts) {
            add('views', parseViews(p.value), p.value, 'labelled-views', 3);
            add('age', parseAge(p.value), p.value, 'relative-age', 2);
            const row = p.el.closest(DOM.metadata);
            const sameRowAsAge = ageParts.some(a => a.el !== p.el && (a.el.parentElement === p.el.parentElement
                || (p.el.parentElement?.parentElement === a.el.parentElement && p.el.parentElement !== node)));
            if (row || sameRowAsAge) add('views', parseViews(p.value, true), p.value, 'metadata-count', 2);
            // One text node can contain both pieces after a UI redesign.
            const combined = p.value.match(/^(.+?)\s+(\d+(?:\.\d+)?\s*[^\d]+(?:ago|ที่แล้ว|前|전))$/i);
            if (combined && parseAge(combined[2]) !== null) {
                add('views', parseViews(combined[1], true), combined[1], 'count-before-age', 2);
                add('age', parseAge(combined[2]), combined[2], 'relative-age', 2);
            }
        }
        for (const el of new Set([node, ...links, ...all(node, '[aria-label]').slice(0, 40)])) {
            const label = norm(el.getAttribute('aria-label'));
            if (!label || isChannel(el)) continue;
            // Never mine arbitrary numbers from a mixed title/label.
            add('duration', durationFromLabel(label, title), label, 'accessible-duration', 1);
            if (label !== title && !isTitle(el)) {
                add('views', parseViews(label), label, 'accessible-views', 3);
                add('age', parseAge(label), label, 'accessible-age', 2);
            }
        }
        c.watched = all(node, DOM.progress).some(el => {
            const width = el.style.width;
            return width ? parseFloat(width) > 0 : visible(el);
        });
        return c;
    }
    function resolveEvidence(c) {
        for (const field of ['duration', 'views', 'age']) {
            const evidence = c.evidence[field];
            const rank = Math.max(0, ...evidence.map(e => e.rank));
            const values = [...new Set(evidence.filter(e => e.rank === rank).map(e => e.value))];
            c[field] = values.length ? (field === 'age' ? Math.max(...values) : Math.min(...values)) : null;
            if (field === 'duration' && values.length > 1) { c.duration = null; c.conflicts.push('Conflicting duration'); }
        }
        c.language = titleLanguage(c.title);
        return c;
    }
    function collectCandidates() {
        const { entries, capped } = discover(), byId = new Map();
        const structured = structuredCandidates();
        const discovery = { structured: structured.diagnostics, cards: entries.length, unique: 0, unreadable: 0, capped, adapters: {} };
        const merge = c => {
            if (!c) { discovery.unreadable++; return; }
            const previous = byId.get(c.id);
            if (!previous) { byId.set(c.id, c); return; }
            previous.title ||= c.title;
            previous.playlist &&= c.playlist;
            previous.watched ||= c.watched;
            previous.live ||= c.live;
            if (c.dataEpoch === state.epoch) previous.dataEpoch = c.dataEpoch;
            previous.sources = [...new Set([...previous.sources, ...c.sources])];
            previous.adapters = [...new Set([...previous.adapters, ...c.adapters])];
            previous.links.push(...c.links);
            for (const field of ['duration', 'views', 'age']) previous.evidence[field].push(...c.evidence[field]);
        };
        for (const c of structured.candidates) merge(c);
        for (const entry of entries) {
            const name = `${entry.source}/${entry.adapter}`;
            discovery.adapters[name] = (discovery.adapters[name] || 0) + 1;
            try {
                const attached = entry.node.data;
                const raw = attached?.lockupViewModel || attached?.compactVideoRenderer || attached;
                const c = raw && structuredCard(raw, entry.source);
                if (c && watchLinks(entry.node).some(a => watchURL(a.getAttribute('href'))?.id === c.id)) {
                    c.adapters = ['element-data']; merge(c);
                }
            } catch (_) { discovery.structured.unavailable = true; }
            try { merge(readCard(entry)); }
            catch (error) { discovery.unreadable++; log('Card parser failed', { adapter: name, ...errorInfo(error) }, 'warn'); }
        }
        discovery.unique = byId.size;
        return { candidates: [...byId.values()].map(resolveEvidence), discovery };
    }

    // 5. Primary filters and explicitly unfiltered fallback are separate policies.
    function fallbackReasons(c) {
        const reasons = [];
        if (!watchURL(c.url) || c.id === state.route?.id) reasons.push('Invalid or current video');
        if (c.playlist || c.live) reasons.push('Playlist or live');
        if (c.dataEpoch !== state.epoch && !c.links.some(el => el.isConnected && watchURL(el.getAttribute('href'))?.id === c.id
            && !el.closest('[disabled], [aria-disabled="true"], [inert]'))) reasons.push('Unavailable link');
        return reasons;
    }
    function fallbackPool(candidates, failed = new Set()) {
        const safe = candidates.filter(c => !failed.has(c.id) && !fallbackReasons(c).length);
        const next = safe.find(c => c.sources.includes('Next'));
        if (next) return { pool: [next], mode: 'Next fallback' };
        const end = safe.filter(c => c.sources.includes('Endscreen'));
        const fresh = end.filter(c => !played.has(c.id));
        return { pool: fresh.length ? fresh : end, mode: 'Endscreen fallback' };
    }
    function rejectionReasons(c, language) {
        const reasons = [...c.conflicts];
        if (!c.title) reasons.push('Missing title');
        if (c.id === state.route?.id) reasons.push('Current video');
        if (played.has(c.id)) reasons.push('Already played in this tab');
        if (c.playlist) reasons.push('Playlist or mix');
        if (c.live) reasons.push('Live or upcoming');
        if (c.duration === null) reasons.push('Unknown duration');
        else if (c.duration <= 0 || c.duration >= settings.maxDuration) reasons.push('Duration limit');
        if (settings.minViews > 0 && c.views === null) reasons.push('Unknown views');
        else if (c.views !== null && c.views < settings.minViews) reasons.push('Views below minimum');
        if (settings.maxAgeYears < 99 && c.age === null) reasons.push('Unknown upload age');
        else if (c.age !== null && c.age > settings.maxAgeYears) reasons.push('Upload age limit');
        if (settings.detectLanguage && (language === 'Unknown' || c.language === 'Unknown')) reasons.push('Unknown title language');
        else if (settings.detectLanguage && !languageMatches(c.language, language)) reasons.push('Title language mismatch');
        return reasons;
    }
    function reviewCandidates() {
        const { candidates, discovery } = collectCandidates(), title = currentTitle(), language = titleLanguage(title);
        for (const c of candidates) c.reasons = rejectionReasons(c, language);
        const eligible = candidates.filter(c => !c.reasons.length);
        const source = ['Sidebar', 'Endscreen', 'Next'].find(s => eligible.some(c => c.sources.includes(s)));
        const pool = source ? eligible.filter(c => c.sources.includes(source)) : [];
        const serializable = candidates.map(({ links, ...c }) => ({ ...c, readStatus: !c.title || c.duration === null || c.views === null ? 'Incomplete metadata' : 'Readable' }));
        const review = { at: new Date().toISOString(), videoId: state.route?.id, title, language, discovery,
            selectedSource: source || null, poolIds: pool.map(c => c.id), candidates: serializable };
        state.review = review;
        return { pool, review, candidates };
    }
    function weightedPick(pool, random = Math.random) {
        const weight = c => settings.neverwatched && !c.watched ? UNWATCHED_WEIGHT : 1;
        let n = random() * pool.reduce((sum, c) => sum + weight(c), 0);
        return pool.find(c => (n -= weight(c)) < 0) || pool.at(-1) || null;
    }

    // 6. Playback controller. Only this section may navigate or request play().
    function record(video) {
        if (!mediaRecords.has(video)) mediaRecords.set(video, { serial: 0, loading: false });
        return mediaRecords.get(video);
    }
    function cancelAttempt(reason) {
        const a = state.attempt;
        if (!a) return;
        a.timers.forEach(clearTimeout);
        state.attempt = null;
        if (a.status !== 'committed') log('Selection cancelled', { reason, attempt: a.id });
    }
    function boundary() {
        const b = state.binding;
        return b ? { video: b.video, source: b.source, serial: b.serial } : state.video
            ? { video: state.video, source: sourceOf(state.video), serial: record(state.video).serial } : null;
    }
    function suspend(reason) {
        state.boundary = boundary();
        state.epoch++;
        state.binding = null;
        cancelAttempt(reason);
    }
    function baseGate() {
        if (!settings.enabled) return 'Script disabled';
        if (!state.route?.eligible) return 'Outside a standalone watch page';
        if (state.navigating) return 'Navigation in progress';
        if (!state.video?.isConnected || !state.player?.contains(state.video)) return 'Main video unavailable';
        if (!pageMediaMatches()) return 'Waiting for current page metadata';
        if (isAd()) return 'Advertisement playing';
        if (state.video.loop) return 'Loop enabled';
        const autoplay = autoplayState();
        if (autoplay === 'on') return 'YouTube Autoplay is ON; turn it OFF to use AutoShort';
        if (autoplay === 'unknown' && settings.requireAutoplayOff) return 'Autoplay state unknown; no automatic navigation';
        return '';
    }
    function endedGate() {
        const reason = baseGate(), b = state.binding, v = state.video;
        if (reason) return reason;
        if (!b?.armed || b.video !== v || b.epoch !== state.epoch || b.source !== sourceOf(v) || b.serial !== record(v).serial) return 'Waiting for current media';
        if (!v.ended || v.seeking || !Number.isFinite(v.duration) || v.duration <= 0 || v.currentTime < v.duration - 0.3) return 'Main video has not finished';
        return '';
    }
    function syncPage(source = 'tick') {
        const r = route();
        if (state.route?.key !== r.key) {
            if (state.route && !state.navigating && !state.boundary) state.boundary = boundary();
            state.epoch++;
            state.binding = null;
            cancelAttempt('Route changed');
            state.route = r;
            if (state.ticket && r.id !== state.ticket.from && r.id !== state.ticket.target) clearTicket('User chose a different video');
            if (state.ticket?.target === r.id && !state.ticket.arrived) {
                state.ticket.arrived = true;
                clearTimeout(navigationTimer);
                log('Target URL reached; waiting for media', { videoId: r.id });
            }
            if (r.eligible) log('Watch page', { videoId: r.id, source });
        }
        const player = r.eligible ? mainPlayer() : null, video = mainVideo(player);
        if (state.video !== video || state.player !== player) {
            cancelAttempt('Main player replaced');
            state.binding = null;
            state.player = player; state.video = video;
        }
        if (!video) return;
        const media = record(video), src = sourceOf(video), old = state.boundary;
        const changed = !old || old.video !== video || old.source !== src || media.serial > old.serial;
        if (state.binding && (state.binding.source !== src || state.binding.serial !== media.serial || isAd())) {
            state.binding = null;
            cancelAttempt('Media source changed');
        }
        if (!state.binding && !state.navigating && changed && !media.loading && pageMediaMatches()
            && !isAd() && video.readyState >= 2 && !video.ended && src) {
            state.binding = { video, source: src, serial: media.serial, epoch: state.epoch, armed: true, handled: false };
            state.boundary = null;
            setStatus('Main video ready. Waiting for playback to finish.');
        }
        if (state.binding && !video.paused && !video.ended && !isAd()) {
            remember(r.id);
            if (state.ticket?.arrived && state.ticket.target === r.id) {
                log('Playback confirmed', { videoId: r.id, title: currentTitle() });
                clearTicket();
            }
        }
        maybePlay();
    }
    function handleMedia(event) {
        const video = event.target;
        if (!video?.matches?.(DOM.video) || !video.closest(DOM.player) || video.closest(DOM.preview)) return;
        const media = record(video);
        if (['emptied', 'loadstart'].includes(event.type)) { media.serial++; media.loading = true; }
        if (['loadedmetadata', 'loadeddata', 'canplay', 'playing'].includes(event.type)) media.loading = false;
        syncPage(event.type);
        if (video !== state.video) return;
        if (event.type === 'ended') onEnded('media.ended');
        if (event.type === 'playing' && !video.ended && state.binding) {
            cancelAttempt('Playback resumed');
            state.binding.handled = false;
        }
        if (event.type === 'pause' && state.ticket?.arrived && state.binding) clearTicket('Playback paused');
    }
    function onEnded(source) {
        const reason = endedGate();
        if (reason) { setStatus(reason); return; }
        if (state.binding.handled || state.attempt) return;
        state.binding.handled = true;
        remember(state.route.id);
        const a = { id: ++state.serial, epoch: state.epoch, video: state.video, pass: 0,
            status: 'selecting', timers: new Set(), signature: '', failed: new Set() };
        state.attempt = a;
        log('Main video ended', { attempt: a.id, videoId: state.route.id, source });
        later(a, () => selectNext(a), 0);
    }
    function later(a, fn, ms) {
        const timer = setTimeout(() => { a.timers.delete(timer); if (state.attempt === a) fn(); }, ms);
        a.timers.add(timer);
    }
    function attemptValid(a) {
        return state.attempt === a && state.epoch === a.epoch && state.video === a.video && !endedGate();
    }
    function selectNext(a) {
        syncPage('selection');
        if (!attemptValid(a)) { cancelAttempt('Playback conditions changed'); return; }
        a.pass++;
        const { pool, review, candidates } = reviewCandidates(), selected = weightedPick(pool.filter(c => !a.failed.has(c.id)));
        const signature = JSON.stringify(review.candidates);
        if (signature !== a.signature || a.pass === 1) { a.signature = signature; showReview(review, selected?.id); }
        if (selected) { navigate(selected, a); return; }
        const potentiallyIncomplete = !review.candidates.length || review.candidates.some(c => c.reasons.length
            && c.reasons.every(r => /^(Unknown|Missing)/.test(r)));
        if ((potentiallyIncomplete || settings.fallbackNext) && a.pass <= RETRIES.length) {
            log('Waiting briefly for recommendation metadata', { pass: a.pass, maxPasses: RETRIES.length + 1 });
            later(a, () => selectNext(a), RETRIES[a.pass - 1]);
            return;
        }
        if (settings.fallbackNext) {
            const fallback = fallbackPool(candidates, a.failed);
            const candidate = fallback.pool[Math.floor(Math.random() * fallback.pool.length)];
            if (candidate) {
                review.selectionMode = fallback.mode;
                review.poolIds = fallback.pool.map(c => c.id);
                log(fallback.mode, { title: candidate.title, ignoredFilters: candidate.reasons });
                showReview(review, candidate.id);
                navigate(candidate, a, true); return;
            }
        }
        a.status = 'finished';
        setStatus(settings.fallbackNext ? 'No usable Next or endscreen recommendation.' : 'No eligible track; fallback is disabled.', 'warn');
    }
    function clearTicket(reason = '') {
        clearTimeout(navigationTimer);
        navigationTimer = null;
        state.ticket = null;
        storage('session', KEYS.ticket, null);
        if (reason) log('Automatic handoff stopped', { reason });
    }
    function navigate(candidate, a, fallback = false) {
        if (!attemptValid(a) || a.status === 'committed' || (fallback ? fallbackReasons(candidate) : rejectionReasons(candidate, titleLanguage(currentTitle()))).length) return;
        a.status = 'committed';
        const ticket = { from: state.route.id, target: candidate.id, url: candidate.url,
            at: Date.now(), epoch: state.epoch, arrived: false, playRequested: false };
        state.ticket = ticket;
        storage('session', KEYS.ticket, ticket);
        const previous = { review: state.review, logs: logEntries.slice(-20) };
        storage('session', KEYS.previous, previous);
        log('Selected track', { title: candidate.title, duration: clock(candidate.duration), views: candidate.views, url: candidate.url });
        const link = candidate.links.find(el => {
            const u = watchURL(el.getAttribute('href'));
            return el.isConnected && u?.id === candidate.id && !u.playlist && !el.closest('[disabled], [aria-disabled="true"], [inert]')
                && (!el.target || el.target === '_self');
        });
        try {
            if (link && !fallback) link.click();
            else location.assign(candidate.url);
        } catch (error) { log('Navigation failed', errorInfo(error), 'error'); clearTicket(); a.failed.add(candidate.id); a.status = 'selecting'; later(a, () => selectNext(a), 0); return; }
        // One retry of the SAME validated target, only if no route transition started.
        navigationTimer = setTimeout(() => {
            syncPage('navigation-check');
            if (state.ticket !== ticket || ticket.arrived) return;
            if (state.epoch === ticket.epoch && !state.navigating && state.route.id === ticket.from && !endedGate()) {
                log('Link click was ignored; opening the same verified URL', { url: ticket.url });
                try { location.assign(ticket.url); } catch (error) { log('Navigation failed', errorInfo(error), 'error'); clearTicket(); }
            } else clearTicket('Navigation did not reach the target; no forced retry');
        }, 2200);
    }
    function maybePlay() {
        const t = state.ticket, v = state.video;
        if (!t) return;
        if (Date.now() - t.at > 20000) { clearTicket('Handoff timed out'); return; }
        if (!t.arrived || t.target !== state.route?.id || t.playRequested || !state.binding || baseGate()) return;
        if (!v.paused || v.ended || v.readyState < 2) return;
        if (v.currentTime > 1) { clearTicket('Respecting an existing playback position'); return; }
        t.playRequested = true;
        try {
            Promise.resolve(v.play()).catch(error => {
                if (state.ticket !== t) return;
                log('Automatic play was blocked; press Play once', errorInfo(error), 'warn');
                clearTicket();
            });
        } catch (error) { log('Automatic play was blocked; press Play once', errorInfo(error), 'warn'); clearTicket(); }
    }
    function navigationStart() {
        if (!state.navigating) suspend('Navigation started');
        state.navigating = true;
    }
    function navigationFinish() { state.navigating = false; syncPage('navigation-finish'); }
    function scheduleSync() {
        if (!syncTimer) syncTimer = setTimeout(() => { syncTimer = null; syncPage('page-update'); }, 100);
    }

    // 7. Settings and export. Native DOM creation avoids HTML injection / Trusted Types.
    function element(tag, value = '') {
        const el = document.createElement(tag); el.textContent = value; return el;
    }
    function button(label, callback) {
        const el = element('button', label); el.type = 'button'; el.addEventListener('click', callback); return el;
    }
    function inspect() {
        syncPage('inspect');
        const { review } = reviewCandidates(); showReview(review);
        log('Controller state', snapshot());
        return review;
    }
    function snapshot() {
        return { version: VERSION, route: state.route, epoch: state.epoch, navigating: state.navigating,
            status: state.status, gate: baseGate(), armed: !!state.binding?.armed, nativeAutoplay: autoplayState(),
            player: state.player?.id || null, video: state.video ? { ended: state.video.ended, paused: state.video.paused,
                readyState: state.video.readyState, currentTime: state.video.currentTime, duration: state.video.duration,
                loop: state.video.loop, ad: isAd() } : null,
            settings, playedCount: played.size, attempt: state.attempt ? { id: state.attempt.id, pass: state.attempt.pass, status: state.attempt.status } : null };
    }
    function exportLog() {
        inspect();
        const report = { tool: 'YouTube Auto Play Short', version: VERSION, at: new Date().toISOString(),
            snapshot: snapshot(), review: state.review, previous: state.previous, logs: logEntries,
            limitations: 'Page data and DOM metadata. Title script is not audio language or a music classifier. No cookies, full page HTML, or media URLs included.' };
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }));
        const link = element('a'); link.href = url; link.download = `AutoShort-${VERSION}-${Date.now()}.json`;
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
        log('Diagnostics exported');
    }
    function showSettings() {
        if (!document.body) { document.addEventListener('DOMContentLoaded', showSettings, { once: true }); return; }
        state.panel?.remove();
        const root = element('section'); root.id = 'yt-autoshort-settings'; root.setAttribute('role', 'dialog');
        root.setAttribute('aria-label', 'AutoShort settings');
        const style = element('style', `
#yt-autoshort-settings{position:fixed;top:16px;right:16px;z-index:2147483647;width:min(390px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:20px;border:1px solid #555;border-radius:12px;background:#202124;color:#f1f1f1;font:14px/1.5 system-ui,sans-serif;color-scheme:dark;box-sizing:border-box}
#yt-autoshort-settings h3{margin:0;font-size:18px}#yt-autoshort-settings p{font-size:12px;color:#b9c2ce}#yt-autoshort-settings label{display:block;margin:12px 0}#yt-autoshort-settings input[type=number]{display:block;width:100%;box-sizing:border-box;padding:8px;margin-top:4px;background:#141516;border:1px solid #666;border-radius:5px;color:inherit;font:inherit}#yt-autoshort-settings input[type=checkbox]{margin-right:8px}#yt-autoshort-settings button{font:inherit;color:inherit;background:#35393d;border:1px solid #687077;border-radius:6px;padding:7px 10px;cursor:pointer}#yt-autoshort-settings button:focus-visible,#yt-autoshort-settings input:focus-visible{outline:2px solid #59b9ed;outline-offset:2px}#yt-autoshort-settings .as-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}#yt-autoshort-settings [role=status]{font-size:12px;margin-top:14px;color:#8dd1f6}
`);
        const head = element('div'); head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px';
        const close = button('Close', () => root.remove()); head.append(element('h3', 'AutoShort'), close);
        const form = element('form'), inputs = {};
        const field = (key, label, min, max, step = '1') => {
            const wrap = element('label'), input = element('input'); input.name = key; inputs[key] = input;
            if (typeof DEFAULTS[key] === 'boolean') { input.type = 'checkbox'; input.checked = settings[key]; wrap.append(input, document.createTextNode(label)); }
            else { input.type = 'number'; input.min = min; input.max = max; input.step = step; input.required = true;
                input.value = settings[key]; wrap.append(document.createTextNode(label), input); }
            form.append(wrap);
        };
        field('enabled', 'Enable AutoShort');
        field('maxDuration', 'Duration must be shorter than (seconds)', 1, 86400);
        const durationHint = element('p');
        const updateHint = () => { durationHint.textContent = `${clock(Number(inputs.maxDuration.value))} · 600 seconds = 10 minutes. The limit is exclusive.`; };
        inputs.maxDuration.addEventListener('input', updateHint); updateHint(); form.append(durationHint);
        field('minViews', 'Minimum views', 0, 1e15);
        field('maxAgeYears', 'Maximum upload age (years; 99 ignores unknown age)', 0, 999, '0.1');
        field('neverwatched', 'Prefer videos without a watched indicator (10:1)');
        field('detectLanguage', 'Match title writing system');
        field('removeWhenReload', 'Reset this tab’s played list on a real reload');
        field('requireAutoplayOff', 'Require a readable YouTube Autoplay OFF switch');
        field('fallbackNext', 'If no match: use Next, then random endscreen video (ignore filters)');
        field('debugDrops', 'Show parser evidence in the console');
        form.append(element('p', 'Start from a song and turn YouTube Autoplay OFF. Filters apply first. With fallback enabled, Next and then random endscreen recommendations bypass duration, views, age and language filters. Music type and audio language cannot be verified from titles. Playlists and Shorts feeds are left to YouTube.'));
        const actions = element('div'); actions.className = 'as-actions';
        const save = element('button', 'Save settings'); save.type = 'submit';
        actions.append(save, button('Inspect candidates', inspect), button('Export log', exportLog)); form.append(actions);
        form.addEventListener('submit', event => {
            event.preventDefault(); if (!form.reportValidity()) return;
            settings = normalizeSettings(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : Number(el.value)])));
            const persisted = storage('local', KEYS.settings, settings);
            cancelAttempt('Settings changed'); clearTicket();
            setStatus(persisted ? 'Settings saved. Applied from the next playback cycle.' : 'Settings active in this tab; persistent storage is unavailable.', persisted ? 'info' : 'warn');
        });
        const status = element('div', state.status); status.setAttribute('role', 'status');
        root.append(style, head, element('p', `Version ${VERSION} · Filtered selection + optional fallback`), form, status);
        for (const type of ['keydown', 'click', 'pointerdown', 'pointerup']) root.addEventListener(type, event => {
            event.stopPropagation(); if (type === 'keydown' && event.key === 'Escape') root.remove();
        });
        document.body.append(root); state.panel = root; close.focus();
    }

    // Start. Capture listeners also work when YouTube replaces the main <video>.
    settings = normalizeSettings(storage('local', KEYS.settings));
    const history = storage('session', KEYS.played);
    played = new Set(Array.isArray(history) ? history.filter(validId).slice(-LIMITS.history) : []);
    if (settings.removeWhenReload && performance.getEntriesByType('navigation')[0]?.type === 'reload') {
        played.clear(); storage('session', KEYS.played, []);
    }
    const savedTicket = storage('session', KEYS.ticket);
    if (savedTicket && validId(savedTicket.target) && validId(savedTicket.from) && Date.now() - savedTicket.at >= 0
        && Date.now() - savedTicket.at < 20000 && route().id === savedTicket.target) {
        state.ticket = { ...savedTicket, arrived: true, playRequested: false };
    } else storage('session', KEYS.ticket, null);
    state.previous = storage('session', KEYS.previous);
    log(`Ready · v${VERSION}`, { settings, policy: 'Filtered recommendations first; optional unfiltered Next, then random endscreen fallback.' });
    for (const type of ['ended', 'playing', 'pause', 'emptied', 'loadstart', 'loadedmetadata', 'loadeddata', 'canplay']) {
        document.addEventListener(type, handleMedia, true);
    }
    document.addEventListener('yt-navigate-start', navigationStart);
    document.addEventListener('yt-navigate-finish', navigationFinish);
    for (const type of ['yt-page-data-updated', 'yt-player-updated']) document.addEventListener(type, scheduleSync);
    window.addEventListener('popstate', () => { suspend('History navigation'); state.navigating = false; syncPage('popstate'); });
    window.addEventListener('pageshow', () => syncPage('pageshow'));
    window.addEventListener('storage', event => {
        if (event.key === KEYS.settings) { settings = normalizeSettings(storage('local', KEYS.settings)); cancelAttempt('Settings changed in another tab'); clearTicket(); }
    });
    // A trusted manual action owns playback. Synthetic navigation clicks do not count.
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, event => {
        if (!event.isTrusted) return;
        if (state.ticket) clearTicket('Manual interaction');
        cancelAttempt('Manual interaction');
    }, true);
    const tick = () => {
        syncPage('heartbeat');
        if (state.route?.eligible && state.video?.ended) onEnded('ended-recovery');
    };
    setInterval(tick, 1500); // No recommendation scanning or DOM-wide observer on this heartbeat.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => syncPage('ready'), { once: true });
    else syncPage('ready');
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Short Play Settings', showSettings);
        GM_registerMenuCommand('Short Play — Inspect candidates', inspect);
        GM_registerMenuCommand('Short Play — Export log', exportLog);
    }
})();
