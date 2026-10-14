// ==UserScript==
// @name         Google Translate + Gemma AI (HF)
// @namespace    https://openai.com/
// @version      1.6.2
// @description  คำแปล AI ใต้ Google Translate เลือกโมเดล Hugging Face ได้ พร้อมจัดการคำขอล่าสุด การพิมพ์เร็ว และการยกเลิก
// @author       OpenAI
// @match        https://translate.google.com/*
// @match        https://translate.google.co.th/*
// @updateURL    https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/Google%20Translate%20%2B%20Gemma%20AI%20(HF)/Google%20Translate%20%2B%20Gemma%20AI%20(HF).user.js
// @downloadURL  https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/Google%20Translate%20%2B%20Gemma%20AI%20(HF)/Google%20Translate%20%2B%20Gemma%20AI%20(HF).user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      router.huggingface.co
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const DEFAULT_SYSTEM_PROMPT = `You are a highly skilled multilingual translator with native-level fluency across languages. You understand nuance, tone, idioms, slang, cultural context, politeness levels, and natural phrasing in both the source and target languages.

Translate the user’s text into the target language in a way that sounds natural, fluent, and native-like, not literal or word-for-word. Preserve the original meaning, intent, tone, emotion, register, formatting, punctuation style, and line breaks.

Adapt idioms, slang, jokes, cultural references, and expressions into natural equivalents in the target language when appropriate. If a phrase should remain unchanged, such as a name, brand, technical term, URL, code, command, or placeholder, keep it unchanged.

Use the most natural wording that a native speaker of the target language would actually say or write. Avoid robotic, overly literal, awkward, or machine-translated phrasing.

Do not add explanations, notes, alternatives, quotation marks, or extra commentary. Return only the final translated text.`;

    // One owner per request. Only its exact revision may change the UI/cache/retry state.
    const VERSION = '1.6.2';
    const API = 'https://router.huggingface.co/v1';
    const SETTINGS_KEY = 'gt_ai_settings_v2';
    const MODELS_KEY = 'gt_ai_models_v2';
    const BOX_ID = 'tm-gemma-ai-box';
    const MODAL_ID = 'tm-gemma-settings-modal';
    const DEFAULTS = Object.freeze({
        enabled: true, token: '', model: 'google/gemma-3-27b-it',
        systemPrompt: DEFAULT_SYSTEM_PROMPT, debounceMs: 800,
        maxTokens: 4096, timeoutSeconds: 120, debug: false
    });
    const MIN_INTERVAL = 1800;
    const CACHE_TTL = 30 * 60 * 1000;
    const CACHE_LIMIT = 40;
    const CACHE_CHARS = 400000;
    const MODEL_TTL = 6 * 60 * 60 * 1000;
    const MAX_INPUT_CHARS = 30000;
    const MAX_AUTO_RETRIES = 1;
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const owned = node => !!(node?.nodeType === 1 ? node : node?.parentElement)?.closest(`#${BOX_ID}, #${MODAL_ID}`);
    const numberIn = (value, fallback, min, max) => Number.isFinite(Number(value))
        ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
    const modelValid = value => /^[\w.-]+\/[\w.-]+(?::[\w.-]+)?$/.test(value) && value.length <= 200;

    function normalizeSettings(value = {}) {
        return {
            enabled: value.enabled !== false,
            token: String(value.token || '').trim(),
            model: modelValid(String(value.model || '').trim()) ? String(value.model).trim() : DEFAULTS.model,
            systemPrompt: String(value.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT,
            debounceMs: numberIn(value.debounceMs, 800, 250, 5000),
            maxTokens: numberIn(value.maxTokens, 4096, 256, 32768),
            timeoutSeconds: numberIn(value.timeoutSeconds, 120, 15, 300),
            debug: value.debug === true
        };
    }

    function loadSettings() {
        const stored = GM_getValue(SETTINGS_KEY, null);
        if (stored && typeof stored === 'object') return normalizeSettings(stored);
        // Preserve the original script identity and migrate existing preferences once.
        const migrated = normalizeSettings({
            token: GM_getValue('hf_token', ''),
            enabled: GM_getValue('ai_enabled', true),
            systemPrompt: GM_getValue('ai_system_prompt', DEFAULT_SYSTEM_PROMPT)
        });
        GM_setValue(SETTINGS_KEY, migrated);
        return migrated;
    }

    let settings = loadSettings();
    let settingsEpoch = 0;
    let revision = 0;
    let currentKey = '';
    let confirmedSameLanguage = '';
    let active = null;
    let pending = null;
    let requestNumber = 0;
    let nextAllowedAt = 0;
    let cooldownUntil = 0;
    let providerBlock = '';
    let composing = false;
    let suspended = false;
    let scheduleTimer = null;
    let scanTimer = null;
    let pollTimer = null;
    let copyTimer = null;
    let cacheChars = 0;
    const cache = new Map();
    const ui = {};
    let view = { phase: 'idle', text: 'รอข้อความต้นฉบับ…', status: 'รอข้อความ', copy: '' };
    let modal = null;
    let modelRequest = null;
    let modelGeneration = 0;
    let modelCatalog = null;
    let returnFocus = null;
    let draftBase = '';

    function log(event, detail = '', debugOnly = false) {
        if (debugOnly && !settings.debug) return;
        console.info(`%c[GT AI]%c ${event}${detail ? ' · ' + detail : ''}`,
            'color:#0b57d0;font-weight:700', 'color:inherit');
    }

    function node(tag, attrs = {}, children = []) {
        const element = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'text') element.textContent = value;
            else if (key === 'class') element.className = value;
            else if (key === 'checked') element.checked = !!value;
            else element.setAttribute(key, String(value));
        }
        for (const child of [].concat(children)) element.append(child);
        return element;
    }

    function button(text, title, handler, className = '') {
        const result = node('button', { type: 'button', text, title, 'aria-label': title, class: className });
        result.addEventListener('click', handler);
        return result;
    }

    function textIfChanged(element, value) {
        if (element.textContent !== value) element.textContent = value;
    }

    function visible(element) {
        return element?.isConnected && !element.closest('[hidden], [aria-hidden="true"]') && element.getClientRects().length > 0;
    }

    // Keep page-specific selectors here. Never read our own inputs or stale display text.
    function sourceElement() {
        const eligible = element => !owned(element) && visible(element) && !element.disabled && !element.readOnly;
        for (const selector of ['textarea.er8xn', 'textarea[jsname="lKng5e"]']) {
            const found = $$(selector).find(eligible);
            if (found) return found;
        }
        const areas = $$('textarea').filter(eligible);
        if (areas.length === 1) return areas[0];
        const editable = $$('[role="textbox"][contenteditable="true"]').filter(eligible);
        return editable.length === 1 ? editable[0] : null;
    }

    function resultElement() {
        const candidates = $$('.QcsUad').filter(element => !owned(element) && visible(element));
        return candidates.find(element => $('.usGWQd, .ryNqvb, [data-language-for-alternatives]', element))
            || (candidates.length === 1 ? candidates[0] : null);
    }

    function languages(url) {
        // Read selected tabs when Google has not written language parameters to the URL.
        const groups = $$('[role="tablist"]').filter(element => !owned(element) && visible(element));
        const selectedCode = group => $('[data-language-code][aria-selected="true"]', group || document)?.getAttribute('data-language-code');
        const selected = groups.map(selectedCode).filter(Boolean);
        const targetProbe = $('[data-language-for-alternatives]', resultElement() || document);
        const sl = url.searchParams.get('sl') || (selected.length >= 2 ? selected[0] : '') || 'auto';
        const tl = url.searchParams.get('tl') || (selected.length >= 2 ? selected[1] : '')
            || targetProbe?.getAttribute('data-language-for-alternatives') || '';
        const valid = code => /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(code);
        const differs = (param, code) => param && code && param.toLowerCase() !== code.toLowerCase();
        const changing = selected.length >= 2 && (differs(url.searchParams.get('sl'), selected[0])
            || differs(url.searchParams.get('tl'), selected[1]));
        return { sl: sl === 'auto' || valid(sl) ? sl : '', tl: valid(tl) && tl !== 'auto' ? tl : '', changing };
    }

    function sameLanguage(a, b) {
        const aliases = { iw: 'he', in: 'id', ji: 'yi', jw: 'jv' };
        const canonical = code => {
            const value = String(code || '').toLowerCase();
            return aliases[value] || value;
        };
        // Keep script/region variants distinct (e.g. zh-CN and zh-TW).
        return !!a && a !== 'auto' && canonical(a) === canonical(b);
    }

    function comparableText(text) {
        return String(text || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
    }

    function alreadyTargetLanguage(input, text, sl, tl) {
        const identity = JSON.stringify([sl, tl, text]);
        if (confirmedSameLanguage && confirmedSameLanguage !== identity) confirmedSameLanguage = '';
        if (sameLanguage(sl, tl)) return true;
        if (!input || !text.trim()) return false;
        // Keep a confirmed decision through Google's temporary DOM replacements.
        // Editing text or either language invalidates it; never carry it to new text.
        if (confirmedSameLanguage === identity) return true;
        const sourceRoot = input.closest('.rm1UF');
        // An explicit source selection may be wrong. Google's "Translate from"
        // suggestion carries the actual language in data-sl, in every UI locale.
        const suggestion = $$('[data-sl][role="button"]', sourceRoot || document)
            .find(element => !owned(element) && visible(element));
        const autoSource = sl === 'auto' ? input.closest('[lang]') : null;
        const detected = suggestion?.getAttribute('data-sl')
            || (autoSource && autoSource !== document.documentElement ? autoSource.getAttribute('lang') : '');
        if (!sameLanguage(detected, tl)) return false;

        // Language badges can lag behind rapid edits. A badge alone must NEVER
        // block a new input: also require Google's target-language result to
        // match the CURRENT full input, not a previous source or result.
        const result = resultElement();
        if (!result) return false;
        const expected = comparableText(text);
        const speech = $$('[data-location="2"][data-text][data-language-code]', result)
            .find(element => visible(element) && sameLanguage(element.getAttribute('data-language-code'), tl));
        if (speech && comparableText(speech.getAttribute('data-text')) === expected) {
            confirmedSameLanguage = identity;
            return true;
        }
        const output = $$('.HwtZe[lang]', result)
            .find(element => visible(element) && sameLanguage(element.getAttribute('lang'), tl));
        if (output && comparableText($$('.ryNqvb', output).filter(visible)
            .map(element => element.textContent).join(' ')) === expected) {
            confirmedSameLanguage = identity;
            return true;
        }
        return false;
    }

    function snapshot() {
        const url = new URL(location.href);
        const mode = url.searchParams.get('op') || 'translate';
        const input = sourceElement();
        const text = input ? String('value' in input ? input.value : input.textContent).replace(/\r\n?/g, '\n') : '';
        const { sl, tl, changing } = languages(url);
        let blocked = '';
        if (suspended) blocked = 'suspended';
        else if (!settings.enabled) blocked = 'disabled';
        else if (!['translate', 'text'].includes(mode)) blocked = 'mode';
        else if (!input) blocked = 'missing';
        else if (composing) blocked = 'composing';
        else if (!text.trim()) blocked = 'empty';
        else if (changing) blocked = 'switching';
        else if (!tl || !sl) blocked = 'language';
        else if (alreadyTargetLanguage(input, text, sl, tl)) blocked = 'same';
        else if (!settings.token) blocked = 'token';
        else if (text.length > MAX_INPUT_CHARS) blocked = 'long';
        else if (navigator.onLine === false) blocked = 'offline';
        return {
            text, sl, tl, blocked, input,
            key: JSON.stringify([settingsEpoch, mode, sl, tl, text, blocked])
        };
    }

    const blockedViews = {
        suspended: ['พักการทำงาน', 'พักอยู่'], disabled: ['AI translation ปิดอยู่ — เปิดได้ในตั้งค่า', 'ปิดอยู่'],
        mode: ['รองรับการแปลข้อความในหน้านี้', 'โหมดอื่น'], missing: ['กำลังรอช่องข้อความของ Google Translate', 'รอหน้าเว็บ'],
        composing: ['รอพิมพ์อักษรให้เสร็จ…', 'กำลังพิมพ์'], empty: ['รอข้อความต้นฉบับ…', 'รอข้อความ'],
        language: ['เลือกภาษาปลายทางใน Google Translate ก่อนเริ่มแปล', 'รอภาษา'],
        switching: ['รอ Google Translate เปลี่ยนภาษาให้เสร็จ…', 'กำลังเปลี่ยนภาษา'],
        same: ['ข้อความนี้เป็นภาษาปลายทางอยู่แล้ว จึงไม่ต้องแปลซ้ำ', 'ภาษาเดียวกัน'],
        token: ['ใส่ Hugging Face token ในตั้งค่าเพื่อเริ่มแปล', 'รอ Token'],
        long: [`ข้อความยาวเกิน ${MAX_INPUT_CHARS.toLocaleString()} ตัวอักษร กรุณาแบ่งข้อความ`, 'ข้อความยาวเกิน'],
        offline: ['ไม่มีอินเทอร์เน็ต — จะตรวจข้อความล่าสุดเมื่อเชื่อมต่ออีกครั้ง', 'ออฟไลน์']
    };

    function setView(phase, text, status, copy = '') {
        view = { phase, text, status, copy };
        render();
    }

    function clearCache() { cache.clear(); cacheChars = 0; }
    function removeCache(key) {
        const entry = cache.get(key);
        if (entry) cacheChars -= entry.size;
        cache.delete(key);
    }
    function pruneCache() {
        const now = Date.now();
        for (const [key, entry] of cache) if (now - entry.at > CACHE_TTL) removeCache(key);
    }
    function cached(key) {
        pruneCache();
        const entry = cache.get(key);
        if (!entry) return null;
        cache.delete(key); cache.set(key, entry);
        return entry.text;
    }
    function remember(key, text) {
        removeCache(key); pruneCache();
        const size = key.length + text.length;
        if (size > CACHE_CHARS) return;
        cache.set(key, { text, at: Date.now(), size }); cacheChars += size;
        while (cache.size > CACHE_LIMIT || cacheChars > CACHE_CHARS) removeCache(cache.keys().next().value);
    }

    function invalidate(reason) {
        revision++;
        clearTimeout(scheduleTimer); scheduleTimer = null; pending = null;
        const previous = active;
        active = null; // Release ownership BEFORE abort callbacks can run.
        if (previous) {
            previous.transport.abort();
            log(`Request #${previous.id} cancelled`, reason);
        }
    }

    function reconcile(force = false) {
        if (suspended) return;
        const next = snapshot();
        const changed = next.key !== currentKey;
        // Repeated retry clicks cannot create a second in-flight request.
        if (!changed && force && (active || pending)) return;
        if (changed || force) {
            invalidate(changed ? 'Input or settings changed' : 'Manual retry');
            currentKey = next.key;
            log('Input state updated', `Revision ${revision} | ${next.sl} → ${next.tl} | ${next.text.length} chars | ${next.blocked || 'ready'}`, true);
            if (force) { removeCache(next.key); providerBlock = ''; }
            if (next.blocked) {
                const [text, status] = blockedViews[next.blocked];
                setView('idle', text, status);
            } else if (providerBlock) {
                setView('error', providerBlock, 'ตรวจการตั้งค่า');
            } else {
                const hit = !force && cached(next.key);
                if (hit !== null && hit !== false) {
                    log('Cached translation reused', `${next.sl} → ${next.tl}`, true);
                    setView('ready', hit, 'จากข้อความเดิม', hit);
                }
                else {
                    pending = { snapshot: next, revision, attempt: 0, due: Date.now() + (force ? 0 : settings.debounceMs) };
                    armPending();
                }
            }
        } else if (pending && !active) armPending();
        render();
    }

    function armPending() {
        clearTimeout(scheduleTimer); scheduleTimer = null;
        if (!pending || active || suspended) return;
        if (document.hidden) {
            setView('waiting', 'พักคำขอใหม่ไว้จนกว่าจะกลับมาที่แท็บนี้', 'พักแท็บเบื้องหลัง');
            return;
        }
        const due = Math.max(pending.due, nextAllowedAt, cooldownUntil);
        const wait = Math.max(0, due - Date.now());
        const limited = cooldownUntil > Date.now();
        const retrying = pending.attempt > 0;
        setView('waiting', limited ? 'ผู้ให้บริการจำกัดคำขอชั่วคราว ระบบจะลองเฉพาะข้อความล่าสุดเมื่อครบเวลา'
            : retrying ? 'การเชื่อมต่อขัดข้องชั่วคราว กำลังรอลองอีกครั้ง…' : 'รอข้อความหยุดเปลี่ยนก่อนเริ่มแปล…',
        limited ? `รอ ${Math.ceil(wait / 1000)} วินาที` : retrying ? 'รอลองอีกครั้ง' : 'กำลังรอ');
        const job = pending;
        scheduleTimer = setTimeout(() => {
            scheduleTimer = null;
            if (pending !== job || job.revision !== revision) return;
            if (Math.max(job.due, nextAllowedAt, cooldownUntil) > Date.now()) { armPending(); return; }
            const latest = snapshot();
            if (latest.key !== job.snapshot.key || latest.blocked) { reconcile(); return; }
            if (document.hidden) { armPending(); return; }
            pending = null;
            startRequest(job);
        }, Math.min(wait, 2147483647));
    }

    function isCurrent(job) {
        return active === job && job.revision === revision && !suspended && snapshot().key === job.snapshot.key;
    }

    function apiError(code, message, extra = {}) {
        return Object.assign(new Error(message), { code, ...extra });
    }

    function retryDelay(raw, fallback) {
        const headers = {};
        for (const line of String(raw || '').split(/\r?\n/)) {
            const split = line.indexOf(':');
            if (split > 0) headers[line.slice(0, split).trim().toLowerCase()] = line.slice(split + 1).trim();
        }
        const value = headers['retry-after'];
        if (value && /^\d+(?:\.\d+)?$/.test(value)) return Math.max(1000, Number(value) * 1000);
        if (value && Number.isFinite(Date.parse(value))) return Math.max(1000, Date.parse(value) - Date.now());
        const rate = (headers.ratelimit || '').match(/(?:^|[;,])\s*t=(\d+)/i);
        return rate ? Math.max(1000, Number(rate[1]) * 1000) : fallback;
    }

    function httpMessage(status) {
        return ({
            400: 'โมเดลไม่รองรับคำขอหรือการตั้งค่านี้ ลองเปลี่ยนโมเดลหรือลดขนาดคำตอบ',
            401: 'Token ไม่ถูกต้องหรือหมดอายุ กรุณาตรวจในตั้งค่า',
            402: 'เครดิตของ Hugging Face หรือผู้ให้บริการไม่เพียงพอ',
            403: 'บัญชีไม่มีสิทธิ์ใช้โมเดลหรือ Inference Providers นี้',
            404: 'ไม่พบโมเดลที่เลือกหรือยังไม่มีผู้ให้บริการรองรับ',
            413: 'ข้อความยาวเกินขีดจำกัดของผู้ให้บริการ',
            422: 'โมเดลไม่รองรับพารามิเตอร์หรือขนาดข้อความนี้',
            429: 'ผู้ให้บริการจำกัดจำนวนคำขอ กรุณารอตามเวลาที่แจ้ง',
            502: 'ผู้ให้บริการเชื่อมต่อโมเดลไม่สำเร็จ',
            503: 'โมเดลหรือผู้ให้บริการไม่พร้อมใช้งานชั่วคราว',
            504: 'ผู้ให้บริการหมดเวลารอโมเดล'
        })[status] || `เรียก Hugging Face ไม่สำเร็จ (HTTP ${status})`;
    }

    function requestJSON(path, { token = '', payload, timeout = 20000 } = {}) {
        let handle;
        let settled = false;
        let watchdog;
        let rejectOnce;
        const promise = new Promise((resolve, reject) => {
            const finish = (error, value) => {
                if (settled) return;
                settled = true; clearTimeout(watchdog);
                error ? reject(error) : resolve(value);
            };
            rejectOnce = error => finish(error);
            watchdog = setTimeout(() => {
                finish(apiError('timeout', 'หมดเวลารอคำแปล กดแปลใหม่เพื่อลองอีกครั้ง'));
                try { handle?.abort(); } catch { /* Already settled. */ }
            }, timeout);
            try {
                handle = GM_xmlhttpRequest({
                    method: payload ? 'POST' : 'GET', url: API + path,
                    headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}),
                        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    data: payload ? JSON.stringify(payload) : undefined,
                    timeout,
                    onload(response) {
                        if (settled) return;
                        const status = response.status;
                        // Classify HTTP before parsing: error bodies may be HTML, including 429.
                        if (status < 200 || status >= 300) {
                            finish(apiError('http', httpMessage(status), {
                                status, retryable: [429, 502, 503, 504].includes(status),
                                retryMs: retryDelay(response.responseHeaders, status === 429 ? 45000 : 3000)
                            }));
                            return;
                        }
                        try { finish(null, JSON.parse(response.responseText)); }
                        catch { finish(apiError('json', 'ผู้ให้บริการส่งข้อมูลที่อ่านไม่ได้ กรุณาลองใหม่')); }
                    },
                    onerror: () => finish(apiError('network', 'เชื่อมต่อ Hugging Face ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ต')),
                    ontimeout: () => finish(apiError('timeout', 'หมดเวลารอคำแปล กดแปลใหม่เพื่อลองอีกครั้ง')),
                    onabort: () => finish(apiError('abort', 'Cancelled'))
                });
            } catch { finish(apiError('transport', 'เริ่มคำขอไม่ได้ กรุณาตรวจสิทธิ์ของ Tampermonkey')); }
        });
        return {
            promise,
            abort() {
                if (settled) return;
                rejectOnce(apiError('abort', 'Cancelled'));
                try { handle?.abort(); } catch { /* Cancellation does not depend on the GM callback. */ }
            }
        };
    }

    function translationFrom(data) {
        const choice = data?.choices?.[0];
        if (choice?.finish_reason === 'length') throw apiError('truncated', 'คำตอบถูกตัดเพราะถึงขนาดสูงสุด เพิ่ม “ขนาดคำตอบสูงสุด” ในตั้งค่าแล้วแปลใหม่');
        if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw apiError('refused', 'โมเดลปฏิเสธคำขอนี้ ไม่มีคำแปลให้แสดง');
        const content = choice?.message?.content;
        const text = (typeof content === 'string' ? content : Array.isArray(content)
            ? content.map(part => typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : '').join('') : '').trim();
        if (!text) throw apiError('empty', 'โมเดลไม่ส่งคำแปลกลับมา ลองเพิ่มขนาดคำตอบหรือเลือกโมเดลอื่น');
        return text;
    }

    async function startRequest(pendingJob) {
        const snapshotSettings = { ...settings };
        const snap = pendingJob.snapshot;
        const payload = {
            model: snapshotSettings.model, max_tokens: snapshotSettings.maxTokens, stream: false,
            messages: [
                { role: 'system', content: snapshotSettings.systemPrompt },
                { role: 'user', content: `Translate the following text from ${snap.sl === 'auto' ? 'the detected source language' : snap.sl} to ${snap.tl}. The selected source language is only a hint and may be incorrect; identify the actual language of the text. If the entire text is already in the target language, return it exactly as provided without paraphrasing, polishing, correcting, or reformatting it. For mixed-language text, translate only the parts that need translation and preserve parts already in the target language. Output only the translation text.\n\n${snap.text}` }
            ]
        };
        const job = { ...pendingJob, id: ++requestNumber, startedAt: Date.now(), model: snapshotSettings.model };
        active = job;
        nextAllowedAt = Date.now() + MIN_INTERVAL;
        job.transport = requestJSON('/chat/completions', {
            token: snapshotSettings.token, payload, timeout: snapshotSettings.timeoutSeconds * 1000
        });
        setView('loading', 'AI กำลังแปลข้อความล่าสุด…', 'กำลังแปล');
        log(`Request #${job.id} started`, `${job.model} | ${snap.sl} → ${snap.tl} | ${snap.text.length} chars`);
        try {
            const data = await job.transport.promise;
            if (!isCurrent(job)) return;
            const translated = translationFrom(data);
            if (comparableText(translated) === comparableText(snap.text)) {
                setView('idle', 'คำตอบไม่เปลี่ยนจากต้นฉบับ จึงไม่มีคำแปลใหม่ให้แสดง', 'ข้อความไม่เปลี่ยน');
                return;
            }
            remember(snap.key, translated);
            setView('ready', translated, 'พร้อมคัดลอก', translated);
            log(`Request #${job.id} completed`, `${((Date.now() - job.startedAt) / 1000).toFixed(1)}s`);
        } catch (error) {
            if (!isCurrent(job) || error.code === 'abort') return;
            log(`Request #${job.id} failed`, `${error.code || 'unknown'}${error.status ? ' HTTP ' + error.status : ''}`);
            if ([401, 402, 403, 404].includes(error.status)) providerBlock = error.message;
            if (error.status === 429 || (error.retryable && error.retryMs > 3000)) {
                cooldownUntil = Math.max(cooldownUntil, Date.now() + error.retryMs);
            }
            if (error.retryable && job.attempt < MAX_AUTO_RETRIES) {
                pending = { snapshot: snap, revision: job.revision, attempt: job.attempt + 1,
                    due: Date.now() + error.retryMs + Math.floor(Math.random() * 500) };
                setView('waiting', 'รอลองใหม่อีก 1 ครั้งสำหรับข้อความล่าสุด', 'รอลองอีกครั้ง');
            } else setView('error', error.message || 'เกิดข้อผิดพลาด กรุณากดแปลใหม่', 'แปลไม่สำเร็จ');
        } finally {
            if (active === job) {
                active = null;
                // A DOM/URL change may precede its event: re-check even if its callback was discarded.
                if (snapshot().key !== currentKey) reconcile();
                else if (pending) armPending();
                else render();
            }
        }
    }

    function cancelTranslation() {
        invalidate('Stopped by user');
        setView('stopped', 'หยุดแล้ว — กดแปลใหม่ หรือแก้ข้อความเพื่อเริ่มครั้งถัดไป', 'หยุดแล้ว');
    }

    function applySettings(value, remote = false) {
        const next = normalizeSettings(value);
        if (JSON.stringify(next) === JSON.stringify(settings)) return;
        const tokenChanged = next.token !== settings.token;
        if (!remote) GM_setValue(SETTINGS_KEY, next); // One atomic preferences record.
        settings = next; settingsEpoch++;
        providerBlock = '';
        if (tokenChanged) cooldownUntil = 0;
        clearCache();
        log('Settings updated', remote ? 'From another tab' : next.model);
        reconcile();
        if (remote && modal?.open) ui.settingsStatus.textContent = 'ตั้งค่าถูกเปลี่ยนจากอีกแท็บ กรุณาปิดแล้วเปิดใหม่ก่อนบันทึก';
    }

    function pageTheme(result = resultElement(), probe = null) {
        const native = probe || sourceElement() || result || document.body;
        const color = getComputedStyle(native).color;
        const rgb = value => {
            if (!/^rgba?\(/i.test(value || '')) return null;
            const parts = value.match(/[\d.]+/g)?.map(Number);
            return parts?.length >= 3 && (parts.length < 4 || parts[3] >= 0.99) ? parts.slice(0, 3) : null;
        };
        const brightness = channels => (channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722) / 255;
        let background = null;
        for (let element = result || native; element; element = element.parentElement) {
            background = rgb(getComputedStyle(element).backgroundColor);
            if (background) break;
        }
        const foreground = rgb(color);
        const dark = background ? brightness(background) < 0.5 : foreground ? brightness(foreground) > 0.6 : false;
        return { mode: dark ? 'dark' : 'light', color: foreground ? color : dark ? '#e8eaed' : '#202124' };
    }

    function syncTheme(result, probe) {
        // Google can use a different theme from the OS. Follow the rendered page only.
        const theme = pageTheme(result, probe);
        for (const element of [ui.box, modal]) {
            if (element && element.dataset.theme !== theme.mode) element.dataset.theme = theme.mode;
        }
        if (ui.box && ui.box.style.getPropertyValue('--gt-text') !== theme.color) {
            ui.box.style.setProperty('--gt-text', theme.color);
        }
    }

    function mount() {
        if (!ui.box) {
            ui.box = node('section', { id: BOX_ID, 'aria-label': 'คำแปล AI' });
            ui.title = node('span', { class: 'gt-model' });
            ui.status = node('span', { class: 'gt-status', role: 'status', 'aria-live': 'polite' });
            ui.answer = node('div', { class: 'gt-answer', dir: 'auto' });
            ui.copy = button('คัดลอก', 'คัดลอกคำแปล AI', copyTranslation);
            ui.stop = button('หยุด', 'หยุดคำขอแปลปัจจุบัน', cancelTranslation);
            ui.retry = button('แปลใหม่', 'แปลข้อความล่าสุดอีกครั้ง', () => reconcile(true));
            ui.open = button('⚙', 'ตั้งค่า AI translation', openSettings, 'gt-gear');
            ui.note = node('span', { class: 'gt-note', role: 'status' });
            ui.box.append(
                node('div', { class: 'gt-head' }, [node('span', { class: 'gt-badge', text: 'AI' }), ui.title, ui.status, ui.open]),
                ui.answer,
                node('div', { class: 'gt-actions' }, [ui.note, ui.stop, ui.retry, ui.copy])
            );
        }
        const result = resultElement();
        const parent = result || document.body;
        if (ui.box.parentElement !== parent) parent.append(ui.box);
        ui.box.classList.toggle('gt-floating', !result);
        ui.box.hidden = !sourceElement() && !result;
        const probe = result && $$('.ryNqvb, .eDXd3b', result).find(element => !owned(element) && visible(element));
        if (probe) {
            const style = getComputedStyle(probe);
            ui.answer.style.fontSize = style.fontSize;
            ui.answer.style.lineHeight = style.lineHeight;
        }
        syncTheme(result, probe);
    }

    function render() {
        if (suspended || !document.body) return;
        mount();
        textIfChanged(ui.title, settings.model);
        ui.title.title = settings.model;
        textIfChanged(ui.status, view.status);
        textIfChanged(ui.answer, view.text);
        if (ui.box.dataset.phase !== view.phase) ui.box.dataset.phase = view.phase;
        ui.copy.disabled = !view.copy;
        ui.stop.hidden = !(active || pending);
        ui.retry.disabled = !!(active || pending) || !!snapshot().blocked;
    }

    async function copyTranslation() {
        const value = view.copy;
        if (!value) return;
        try {
            if (typeof GM_setClipboard === 'function') GM_setClipboard(value, 'text');
            else await navigator.clipboard.writeText(value);
            textIfChanged(ui.note, 'คัดลอกแล้ว');
        } catch { textIfChanged(ui.note, 'คัดลอกไม่ได้ กรุณาเลือกข้อความแล้วคัดลอก'); }
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => textIfChanged(ui.note, ''), 1800);
    }

    function field(label, input, hint = '') {
        return node('div', { class: 'gt-field' }, [
            node('label', { for: input.id, text: label }), input,
            ...(hint ? [node('p', { class: 'gt-hint', text: hint })] : [])
        ]);
    }

    function createSettings() {
        if (modal) return;
        modal = node('dialog', { id: MODAL_ID, 'aria-labelledby': 'gt-ai-title' });
        const form = node('form');
        ui.token = node('input', { id: 'gt-ai-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'hf_…' });
        ui.model = node('input', { id: 'gt-ai-model', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '200' });
        ui.models = node('select', { id: 'gt-ai-model-list', 'aria-label': 'เลือกโมเดล' });
        ui.search = node('input', { type: 'search', placeholder: 'ค้นหาชื่อโมเดล', 'aria-label': 'ค้นหาโมเดล' });
        ui.refreshModels = button('โหลดรายการ', 'โหลดรายการโมเดลล่าสุดจาก Hugging Face', () => loadModels(true));
        ui.modelStatus = node('p', { class: 'gt-hint', role: 'status' });
        ui.enabled = node('input', { id: 'gt-ai-enabled', type: 'checkbox' });
        ui.prompt = node('textarea', { id: 'gt-ai-prompt', rows: '7', spellcheck: 'false' });
        ui.delay = node('input', { id: 'gt-ai-delay', type: 'number', min: '250', max: '5000', step: '50', required: '' });
        ui.tokens = node('input', { id: 'gt-ai-tokens', type: 'number', min: '256', max: '32768', step: '1', required: '' });
        ui.timeout = node('input', { id: 'gt-ai-timeout', type: 'number', min: '15', max: '300', step: '1', required: '' });
        ui.debug = node('input', { id: 'gt-ai-debug', type: 'checkbox' });
        ui.settingsStatus = node('div', { class: 'gt-save-status', role: 'status' });
        const advanced = node('details', { class: 'gt-advanced' }, [
            node('summary', { text: 'การทำงานและ System prompt' }),
            node('div', { class: 'gt-grid' }, [
                field('รอหยุดพิมพ์ (ms)', ui.delay, 'ค่าเริ่มต้น 800 ms'),
                field('ขนาดคำตอบสูงสุด (tokens)', ui.tokens, 'ค่าเริ่มต้น 4,096 tokens'),
                field('เวลารอ API (วินาที)', ui.timeout, 'ค่าเริ่มต้น 120 วินาที')
            ]),
            field('System prompt', ui.prompt, 'ปรับแนวทางการแปลได้ โดยระบบยังระบุภาษาปลายทางให้ทุกคำขอ'),
            button('คืนค่า prompt เริ่มต้น', 'คืนค่า prompt ในแบบฟอร์มนี้', () => { ui.prompt.value = DEFAULT_SYSTEM_PROMPT; }),
            node('label', { class: 'gt-check', for: ui.debug.id }, [ui.debug, 'แสดง log วินิจฉัยเพิ่มเติมใน Console'])
        ]);
        ui.modelField = field('Model ID', ui.model, 'ระบุชื่อเต็ม เช่น google/gemma-3-27b-it หรือชื่อโมเดล:ชื่อผู้ให้บริการ');
        form.append(
            node('header', { class: 'gt-dialog-head' }, [
                node('div', {}, [node('h2', { id: 'gt-ai-title', text: 'ตั้งค่าคำแปล AI' }),
                    node('p', { class: 'gt-hint', text: `Hugging Face · รุ่น ${VERSION}` })]),
                button('×', 'ปิดหน้าตั้งค่า', closeSettings, 'gt-gear')
            ]),
            node('div', { class: 'gt-dialog-body' }, [
                node('label', { class: 'gt-check', for: ui.enabled.id }, [ui.enabled, 'เปิดใช้คำแปล AI ใต้คำแปล Google']),
                field('Hugging Face Token', ui.token, 'ใช้ Token ที่มีสิทธิ์ Inference Providers'),
                button('ล้าง Token ในแบบฟอร์ม', 'ล้าง Token เมื่อกดบันทึก', () => { ui.token.value = ''; }),
                node('div', { class: 'gt-field' }, [
                    node('label', { for: ui.models.id, text: 'โมเดลที่ใช้แปล' }),
                    node('div', { class: 'gt-search-row' }, [ui.search, ui.refreshModels]), ui.models, ui.modelStatus
                ]),
                ui.modelField,
                node('p', { class: 'gt-hint', text: 'รายการจาก Hugging Face; สิทธิ์ใช้งานและโควตาขึ้นกับบัญชีของคุณ' }),
                advanced
            ]),
            node('footer', {}, [ui.settingsStatus, node('div', { class: 'gt-actions' }, [
                button('ยกเลิก', 'ปิดโดยไม่บันทึก', closeSettings),
                node('button', { type: 'submit', class: 'gt-primary', text: 'บันทึกการตั้งค่า' })
            ])])
        );
        modal.append(form); document.body.append(modal);
        ui.search.addEventListener('input', refreshModelOptions);
        ui.models.addEventListener('change', () => {
            const custom = ui.models.value === '__custom__';
            if (!custom) ui.model.value = ui.models.value;
            ui.modelField.hidden = !custom;
            if (custom) ui.model.focus();
        });
        modal.addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
        modal.addEventListener('click', event => {
            if (event.target === modal) {
                const r = modal.getBoundingClientRect();
                if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeSettings();
            }
        });
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (draftBase !== JSON.stringify(settings)) {
                ui.settingsStatus.textContent = 'ค่าถูกเปลี่ยนจากอีกแท็บ กรุณาปิดแล้วเปิดตั้งค่าใหม่';
                return;
            }
            if (!modelValid(ui.model.value.trim())) {
                ui.modelField.hidden = false;
                ui.settingsStatus.textContent = 'กรอก Model ID รูปแบบองค์กร/ชื่อโมเดล'; ui.model.focus(); return;
            }
            if (ui.token.value.trim() && !/^hf_[A-Za-z0-9]+$/.test(ui.token.value.trim())) {
                ui.settingsStatus.textContent = 'รูปแบบ Token ไม่ถูกต้อง ควรเริ่มด้วย hf_'; ui.token.focus(); return;
            }
            if (!form.reportValidity()) return;
            try {
                applySettings({ enabled: ui.enabled.checked, token: ui.token.value, model: ui.model.value,
                    systemPrompt: ui.prompt.value, debounceMs: ui.delay.value, maxTokens: ui.tokens.value,
                    timeoutSeconds: ui.timeout.value, debug: ui.debug.checked });
                closeSettings();
            } catch { ui.settingsStatus.textContent = 'บันทึกไม่สำเร็จ กรุณาตรวจว่า Tampermonkey ยังทำงานอยู่'; }
        });
    }

    function readModelCatalog() {
        if (modelCatalog) return modelCatalog;
        const stored = GM_getValue(MODELS_KEY, null);
        if (stored && Array.isArray(stored.ids) && Number.isFinite(stored.at)) {
            modelCatalog = { at: stored.at, ids: stored.ids.filter(id => typeof id === 'string' && modelValid(id)).slice(0, 2000) };
        }
        return modelCatalog;
    }

    function refreshModelOptions() {
        const selected = ui.model.value || settings.model;
        const query = ui.search.value.trim().toLowerCase();
        const ids = (readModelCatalog()?.ids || []).filter(id => id.toLowerCase().includes(query));
        const options = [...new Set([selected, ...ids])].filter(modelValid);
        ui.models.replaceChildren(...options.map(id => node('option', { value: id, text: id })),
            node('option', { value: '__custom__', text: 'ระบุ Model ID เอง…' }));
        ui.models.value = selected;
    }

    async function loadModels(force = false) {
        const stored = readModelCatalog();
        refreshModelOptions();
        if (!force && stored && Date.now() - stored.at < MODEL_TTL) {
            ui.modelStatus.textContent = `${stored.ids.length} โมเดล · กดโหลดรายการเพื่ออัปเดต`;
            return;
        }
        modelRequest?.abort();
        const generation = ++modelGeneration;
        const request = requestJSON('/models');
        modelRequest = request;
        ui.refreshModels.disabled = true;
        ui.modelStatus.textContent = 'กำลังโหลดรายการโมเดล…';
        try {
            const data = await request.promise;
            if (generation !== modelGeneration || !modal.open) return;
            if (!Array.isArray(data.data)) throw apiError('catalog', 'รายการโมเดลไม่อยู่ในรูปแบบที่รองรับ');
            const ids = [...new Set(data.data.filter(item =>
                typeof item.id === 'string' && modelValid(item.id)
                && (!item.architecture?.output_modalities || item.architecture.output_modalities.includes('text'))
                && (!Array.isArray(item.providers) || item.providers.some(provider => !provider.status || provider.status === 'live'))
            ).map(item => item.id))].sort((a, b) => a.localeCompare(b)).slice(0, 2000);
            if (!ids.length) throw apiError('catalog', 'ยังไม่พบโมเดลแปลข้อความที่พร้อมให้บริการ');
            modelCatalog = { ids, at: Date.now() }; GM_setValue(MODELS_KEY, modelCatalog);
            const custom = ui.models.value === '__custom__';
            refreshModelOptions();
            if (custom) ui.models.value = '__custom__';
            ui.modelStatus.textContent = `${ids.length} โมเดล · อัปเดตแล้ว`;
        } catch (error) {
            if (generation !== modelGeneration || error.code === 'abort') return;
            ui.modelStatus.textContent = `${error.message} — ยังระบุ Model ID เองได้`;
        } finally {
            if (generation === modelGeneration) { modelRequest = null; ui.refreshModels.disabled = false; }
        }
    }

    function openSettings() {
        createSettings();
        if (modal.open) return;
        returnFocus = document.activeElement;
        draftBase = JSON.stringify(settings);
        ui.token.value = settings.token; ui.model.value = settings.model;
        ui.enabled.checked = settings.enabled; ui.prompt.value = settings.systemPrompt;
        ui.delay.value = settings.debounceMs; ui.tokens.value = settings.maxTokens;
        ui.timeout.value = settings.timeoutSeconds; ui.debug.checked = settings.debug;
        ui.search.value = ''; ui.settingsStatus.textContent = ''; ui.modelField.hidden = true;
        ui.refreshModels.disabled = false;
        refreshModelOptions();
        syncTheme();
        modal.showModal(); ui.models.focus();
        loadModels();
    }

    function closeSettings() {
        if (!modal) return;
        modelGeneration++; modelRequest?.abort(); modelRequest = null;
        modal.close();
        ui.token.value = ''; // Do not retain a token in a closed page form.
        if (returnFocus?.isConnected) returnFocus.focus();
    }

    GM_addStyle(`
        #${BOX_ID}, #${MODAL_ID} { --gt-text:#202124; --gt-muted:#62666c; --gt-bg:#fff; --gt-line:#dadce0;
            --gt-accent:#0b57d0; color:var(--gt-text); font-family:Roboto,Arial,sans-serif; box-sizing:border-box; }
        #${BOX_ID} *, #${MODAL_ID} * { box-sizing:border-box; }
        #${BOX_ID} [hidden], #${MODAL_ID} [hidden], #${BOX_ID}[hidden] { display:none!important; }
        #${BOX_ID} { margin:10px 0 0; border-top:1px solid var(--gt-line); padding:12px 24px 8px; clear:both; }
        #${BOX_ID}.gt-floating { position:fixed; bottom:16px; right:16px; width:min(480px,calc(100vw - 32px));
            max-height:45vh; overflow:auto; background:var(--gt-bg); border:1px solid var(--gt-line); border-radius:16px;
            box-shadow:0 6px 24px #0002; z-index:10000; }
        #${BOX_ID} .gt-head { display:flex; gap:8px; align-items:center; margin-bottom:10px; }
        #${BOX_ID} .gt-badge { color:var(--gt-accent); background:#1a73e815; padding:3px 7px; border-radius:6px; font-size:11px; font-weight:700; }
        #${BOX_ID} .gt-model { flex:1; min-width:0; font-size:12px; color:var(--gt-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        #${BOX_ID} .gt-status { color:var(--gt-muted); font-size:12px; white-space:nowrap; }
        #${BOX_ID} .gt-answer { color:var(--gt-text); font-size:24px; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
        #${BOX_ID}:not([data-phase="ready"]) .gt-answer { font-size:15px!important; line-height:1.6!important; color:var(--gt-muted); }
        #${BOX_ID}[data-phase="error"] .gt-answer, #${BOX_ID}[data-phase="error"] .gt-status { color:#b3261e; }
        #${BOX_ID} .gt-actions, #${MODAL_ID} .gt-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; margin-top:12px; }
        #${BOX_ID} .gt-note { margin-right:auto; font-size:12px; color:#137333; }
        #${BOX_ID} button, #${MODAL_ID} button { font:500 13px/1.4 Roboto,Arial,sans-serif; cursor:pointer; border:1px solid var(--gt-line);
            color:var(--gt-text); background:transparent; border-radius:20px; min-height:36px; padding:7px 14px; }
        #${BOX_ID} button:hover, #${MODAL_ID} button:hover { background:#1a73e80d; }
        #${BOX_ID} button:disabled, #${MODAL_ID} button:disabled { opacity:.45; cursor:default; }
        #${BOX_ID} button:focus-visible, #${MODAL_ID} :focus-visible { outline:2px solid var(--gt-accent); outline-offset:2px; }
        #${BOX_ID} .gt-gear, #${MODAL_ID} .gt-gear { border:0; font-size:20px; width:36px; height:36px; padding:0; flex-shrink:0; }
        #${MODAL_ID} { color-scheme:light; width:min(640px,calc(100vw - 24px)); max-height:calc(100dvh - 32px); padding:0; border:1px solid var(--gt-line);
            border-radius:20px; background:var(--gt-bg); box-shadow:0 16px 48px #0003; overflow:auto; }
        #${MODAL_ID}::backdrop { background:#20212480; }
        #${MODAL_ID} form { margin:0; }
        #${MODAL_ID} .gt-dialog-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:20px 24px 14px; border-bottom:1px solid var(--gt-line); }
        #${MODAL_ID} h2 { margin:0 0 4px; font-size:21px; line-height:1.4; font-weight:600; }
        #${MODAL_ID} .gt-dialog-body { padding:18px 24px; }
        #${MODAL_ID} .gt-field { margin:16px 0 10px; }
        #${MODAL_ID} label { display:block; font-size:14px; font-weight:500; margin-bottom:7px; }
        #${MODAL_ID} input:not([type="checkbox"]), #${MODAL_ID} textarea, #${MODAL_ID} select {
            width:100%; min-height:42px; color:var(--gt-text); background:var(--gt-bg); border:1px solid var(--gt-line);
            border-radius:8px; padding:10px 12px; font:14px/1.5 Roboto,Arial,sans-serif; }
        #${MODAL_ID} textarea { resize:vertical; }
        #${MODAL_ID} .gt-hint { color:var(--gt-muted); font-size:12px; line-height:1.6; margin:5px 0 0; }
        #${MODAL_ID} .gt-check { display:flex; align-items:center; gap:10px; font-weight:400; margin:8px 0 12px; }
        #${MODAL_ID} input[type="checkbox"] { width:18px; height:18px; accent-color:var(--gt-accent); }
        #${MODAL_ID} .gt-search-row { display:flex; gap:8px; margin-bottom:8px; }
        #${MODAL_ID} .gt-search-row input { min-width:0; flex:1; }
        #${MODAL_ID} .gt-search-row button { flex-shrink:0; }
        #${MODAL_ID} .gt-grid { display:grid; grid-template-columns:1fr 1fr; column-gap:16px; }
        #${MODAL_ID} .gt-advanced { border-top:1px solid var(--gt-line); margin-top:20px; padding-top:16px; }
        #${MODAL_ID} summary { cursor:pointer; font-size:14px; font-weight:500; }
        #${MODAL_ID} footer { position:sticky; bottom:0; background:var(--gt-bg); border-top:1px solid var(--gt-line); padding:12px 24px 18px; }
        #${MODAL_ID} footer .gt-actions { margin-top:0; }
        #${MODAL_ID} .gt-save-status { color:#b3261e; font-size:13px; line-height:1.5; }
        #${MODAL_ID} .gt-save-status:not(:empty) { margin-bottom:10px; }
        #${MODAL_ID} .gt-primary { background:var(--gt-accent); color:#fff; border-color:var(--gt-accent); }
        #${MODAL_ID} .gt-primary:hover { background:#0849b4; }
        #${BOX_ID}[data-theme="dark"], #${MODAL_ID}[data-theme="dark"] {
            --gt-text:#e8eaed; --gt-muted:#b2b8c2; --gt-bg:#202124; --gt-line:#5f6368; --gt-accent:#8ab4f8; }
        #${BOX_ID}[data-theme="dark"][data-phase="error"] .gt-answer,
        #${BOX_ID}[data-theme="dark"][data-phase="error"] .gt-status,
        #${MODAL_ID}[data-theme="dark"] .gt-save-status { color:#f2b8b5; }
        #${BOX_ID}[data-theme="dark"] .gt-note { color:#81c995; }
        #${MODAL_ID}[data-theme="dark"] { color-scheme:dark; }
        #${MODAL_ID}[data-theme="dark"] .gt-primary { color:#162947; }
        #${MODAL_ID}[data-theme="dark"] .gt-primary:hover { background:#aecbfa; }
        @media(max-width:600px) {
            #${BOX_ID} { padding:12px 16px 8px; }
            #${MODAL_ID} .gt-dialog-head, #${MODAL_ID} .gt-dialog-body, #${MODAL_ID} footer { padding-left:16px; padding-right:16px; }
            #${MODAL_ID} .gt-grid { grid-template-columns:1fr; }
            #${BOX_ID} .gt-status { max-width:110px; white-space:normal; text-align:right; }
        }
    `);

    // Events signal changes; a low-frequency watchdog catches SPA history/property updates.
    // Neither path forces retranslation or extends the input debounce without a new snapshot.
    function queueScan() {
        if (suspended || scanTimer !== null) return;
        scanTimer = setTimeout(() => { scanTimer = null; reconcile(); }, 50);
    }

    const observer = new MutationObserver(records => {
        if (records.some(record => {
            if (owned(record.target)) return false;
            if (record.type === 'childList' && !record.removedNodes.length && record.addedNodes.length
                && [...record.addedNodes].every(owned)) return false;
            return true;
        })) queueScan();
    });

    function observe() {
        observer.observe(document.documentElement, { subtree:true, childList:true, characterData:true,
            attributes:true, attributeFilter:['aria-selected', 'data-language-code', 'data-language-for-alternatives',
                'data-sl', 'lang', 'data-text'] });
    }

    function poll() {
        clearTimeout(pollTimer); pollTimer = null;
        if (suspended || document.hidden) return;
        pollTimer = setTimeout(() => {
            pollTimer = null;
            if (composing && document.activeElement !== sourceElement()) composing = false;
            reconcile(); pruneCache(); poll();
        }, 1000);
    }

    document.addEventListener('input', event => {
        if (owned(event.target)) return;
        if (event.target === sourceElement()) {
            if (event.isComposing) composing = true;
            reconcile();
        } else queueScan();
    }, true);
    document.addEventListener('compositionstart', event => {
        if (event.target === sourceElement()) { composing = true; reconcile(); }
    }, true);
    document.addEventListener('compositionend', event => {
        if (event.target === sourceElement() || composing) { composing = false; reconcile(); }
    }, true);
    document.addEventListener('focusout', event => {
        if (composing && !owned(event.target)) { composing = false; queueScan(); }
    }, true);
    document.addEventListener('click', event => { if (!owned(event.target)) queueScan(); }, true);
    document.addEventListener('visibilitychange', () => {
        reconcile(); poll();
    });
    for (const event of ['popstate', 'hashchange', 'online', 'offline', 'focus']) window.addEventListener(event, () => { reconcile(); poll(); });
    window.addEventListener('pagehide', () => {
        suspended = true; invalidate('Page suspended');
        observer.disconnect(); clearTimeout(scanTimer); scanTimer = null;
        clearTimeout(pollTimer); pollTimer = null; clearTimeout(copyTimer);
        closeSettings();
    });
    window.addEventListener('pageshow', () => {
        if (!suspended) return;
        suspended = false; composing = false;
        if (view.phase === 'loading' || view.phase === 'waiting') currentKey = '';
        observe(); reconcile(); poll();
    });
    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(SETTINGS_KEY, (_name, _old, value, remote) => {
            if (remote && value && typeof value === 'object') applySettings(value, true);
        });
    }
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('AI translation: ตั้งค่า', openSettings);
        GM_registerMenuCommand('AI translation: แปลใหม่', () => reconcile(true));
        GM_registerMenuCommand('AI translation: เปิด/ปิด', () => applySettings({ ...settings, enabled: !settings.enabled }));
        GM_registerMenuCommand('AI translation: ล้างแคชชั่วคราว', () => { clearCache(); log('Translation cache cleared'); });
    }
    observe(); reconcile(); poll();
    log(`Ready v${VERSION}`, 'Latest input only; bounded retries; no text or tokens in logs');
})();
