// ==UserScript==
// @name         Google Translate + Gemma AI (HF)
// @namespace    https://openai.com/
// @version      1.5.1
// @description  แทรกคำแปลจาก AI (google/gemma-3-27b-it ผ่าน Hugging Face) ไว้ใต้คำแปลของ Google Translate ในกล่องเดียวกัน
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
// @connect      api-inference.huggingface.co
// ==/UserScript==

(function () {
    'use strict';

    const MODEL_ID = 'google/gemma-3-27b-it';
    const ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';
    const CLASSIC_URL = `https://api-inference.huggingface.co/models/${MODEL_ID}`;

    const KEY_TOKEN = 'hf_token';
    const KEY_ENABLED = 'ai_enabled';
    const KEY_SYSTEM_PROMPT = 'ai_system_prompt';

    const DEFAULT_SYSTEM_PROMPT = `You are a highly skilled multilingual translator with native-level fluency across languages. You understand nuance, tone, idioms, slang, cultural context, politeness levels, and natural phrasing in both the source and target languages.

Translate the user’s text into the target language in a way that sounds natural, fluent, and native-like, not literal or word-for-word. Preserve the original meaning, intent, tone, emotion, register, formatting, punctuation style, and line breaks.

Adapt idioms, slang, jokes, cultural references, and expressions into natural equivalents in the target language when appropriate. If a phrase should remain unchanged, such as a name, brand, technical term, URL, code, command, or placeholder, keep it unchanged.

Use the most natural wording that a native speaker of the target language would actually say or write. Avoid robotic, overly literal, awkward, or machine-translated phrasing.

Do not add explanations, notes, alternatives, quotation marks, or extra commentary. Return only the final translated text.`;

    const DEFAULT_USER_PROMPT =
        'Translate the following text from {{sourceLang}} to {{targetLang}}. Output only the translation text.\n\n{{text}}';

    const AI_BOX_ID = 'tm-gemma-ai-box';
    const AI_MODAL_ID = 'tm-gemma-settings-modal';

    const cache = new Map();
    let activeRequest = null;
    let activeKey = '';
    let refreshTimer = null;
    let lastSeenHref = location.href;
    let rateLimitedUntil = 0;
    let rateLimitReason = '';
    let retryAfterTimer = null;
    let lastApiCallAt = 0;

    const MIN_API_INTERVAL_MS = 1800;

    GM_addStyle(`

    #${AI_BOX_ID} {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(60,64,67,.16);
      font-family: Roboto, Arial, sans-serif;
    }

    #${AI_BOX_ID} .tm-gemma-head,
    #${AI_BOX_ID} .tm-gemma-body-wrap,
    #${AI_BOX_ID} .tm-gemma-toolbar {
      box-sizing: border-box;
    }

    #${AI_BOX_ID} .tm-gemma-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      min-height: 20px;
      padding-left: 24px;
      padding-right: 28px;
    }

    #${AI_BOX_ID} .tm-gemma-body-wrap,
    #${AI_BOX_ID} .tm-gemma-toolbar {
      padding-left: 28px;
      padding-right: 28px;
    }

    #${AI_BOX_ID} .tm-gemma-meta {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    #${AI_BOX_ID} .tm-gemma-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      height: 20px;
      padding: 0 8px;
      background: rgba(26,115,232,.10);
      color: #0b57d0;
      font: 700 11px/20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: .2px;
      flex-shrink: 0;
    }

    #${AI_BOX_ID} .tm-gemma-title {
      color: #5f6368;
      font-size: 12px;
      line-height: 20px;
      font-weight: 500;
      white-space: nowrap;
    }

    #${AI_BOX_ID} .tm-gemma-status-chip {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 0;
      font: 500 12px/20px Roboto, Arial, sans-serif;
      border: 0;
      background: transparent;
      color: #5f6368;
      flex-shrink: 0;
    }

    #${AI_BOX_ID} .tm-gemma-status-chip.is-loading {
      color: #5f6368;
    }

    #${AI_BOX_ID} .tm-gemma-status-chip.is-error {
      color: #b3261e;
    }

    #${AI_BOX_ID} .tm-gemma-status-chip.is-success {
      color: #137333;
    }

    #${AI_BOX_ID} .tm-gemma-body-wrap {
      position: relative;
      min-height: 40px;
      padding-top: 2px;
    }

    #${AI_BOX_ID} .tm-gemma-body {
      margin: 0;
      display: block;
      width: 100%;
      color: #202124;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
      font-family: Roboto, Arial, sans-serif;
      font-size: inherit;
      font-weight: 400;
      line-height: inherit;
      letter-spacing: 0;
    }

    #${AI_BOX_ID} .tm-gemma-muted {
      color: #5f6368;
      font-size: 16px;
      line-height: 1.45;
      font-weight: 400;
    }

    #${AI_BOX_ID} .tm-gemma-error {
      color: #b3261e;
      font-size: 16px;
      line-height: 1.45;
      font-weight: 400;
    }

    #${AI_BOX_ID} .tm-gemma-toolbar {
      margin-top: 6px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      min-height: 40px;
      flex-wrap: wrap;
    }

    #${AI_BOX_ID} .tm-gemma-actions {
      display: flex;
      align-items: center;
      gap: 0;
      margin-left: auto;
      flex-wrap: wrap;
    }

    #${AI_BOX_ID} .tm-gemma-icon-btn {
      width: 40px;
      height: 40px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #5f6368;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: background-color .15s ease, color .15s ease, transform .15s ease;
    }

    #${AI_BOX_ID} .tm-gemma-icon-btn:hover {
      background: #f1f3f4;
      color: #202124;
    }

    #${AI_BOX_ID} .tm-gemma-icon-btn:active {
      transform: scale(.97);
    }

    #${AI_BOX_ID} .tm-gemma-icon-btn svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
      display: block;
    }

    #${AI_BOX_ID} .tm-gemma-copy-note {
      margin-right: auto;
      font-size: 12px;
      color: #137333;
      opacity: 0;
      transform: translateY(2px);
      transition: opacity .18s ease, transform .18s ease;
    }

    #${AI_BOX_ID} .tm-gemma-copy-note.show {
      opacity: 1;
      transform: translateY(0);
    }

    #${AI_MODAL_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: none;
      background: rgba(0,0,0,.42);
      align-items: center;
      justify-content: center;
      padding: 20px;
      box-sizing: border-box;
    }

    #${AI_MODAL_ID}.show {
      display: flex;
    }

    #${AI_MODAL_ID} .tm-gemma-card {
      width: min(560px, 100%);
      background: #fff;
      color: #1f1f1f;
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 18px 48px rgba(0,0,0,.24);
      font-family: Roboto, Arial, sans-serif;
    }

    #${AI_MODAL_ID} h3 {
      margin: 0 0 8px;
      font-size: 18px;
      line-height: 1.3;
    }

    #${AI_MODAL_ID} p {
      margin: 0 0 10px;
      color: #5f6368;
      font-size: 13px;
      line-height: 1.5;
    }

    #${AI_MODAL_ID} label {
      display: block;
      margin: 12px 0 6px;
      font-size: 13px;
      font-weight: 600;
    }

    #${AI_MODAL_ID} input[type="password"],
    #${AI_MODAL_ID} input[type="text"],
    #${AI_MODAL_ID} textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid rgba(60,64,67,.25);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
    }

    #${AI_MODAL_ID} input[type="password"]:focus,
    #${AI_MODAL_ID} input[type="text"]:focus,
    #${AI_MODAL_ID} textarea:focus {
      border-color: #1a73e8;
      box-shadow: 0 0 0 3px rgba(26,115,232,.12);
    }

    #${AI_MODAL_ID} textarea {
      width: 100%;
      min-height: 92px;
      resize: vertical;
      line-height: 1.45;
      font-family: Roboto, Arial, sans-serif;
    }

    #${AI_MODAL_ID} .tm-gemma-check {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      font-size: 14px;
    }

    #${AI_MODAL_ID} .tm-gemma-row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 14px;
      flex-wrap: wrap;
    }

    #${AI_MODAL_ID} .tm-gemma-btn {
      border: 1px solid rgba(60,64,67,.18);
      background: #fff;
      color: #1f1f1f;
      border-radius: 999px;
      padding: 6px 12px;
      cursor: pointer;
      font: 600 12px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #${AI_MODAL_ID} .tm-gemma-btn:hover {
      background: #f8f9fa;
    }

    #${AI_MODAL_ID} .tm-gemma-status {
      margin-top: 8px;
      min-height: 18px;
      color: #5f6368;
      font-size: 12px;
    }

    #${AI_MODAL_ID} code {
      background: #f1f3f4;
      padding: 2px 6px;
      border-radius: 6px;
      font-size: 12px;
    }
    @media (max-width: 720px) {

      #${AI_BOX_ID} .tm-gemma-head,
      #${AI_BOX_ID} .tm-gemma-body-wrap,
      #${AI_BOX_ID} .tm-gemma-toolbar {
        padding-left: 16px;
        padding-right: 16px;
      }

      #${AI_BOX_ID} .tm-gemma-body {
        font-size: 20px;
        line-height: 1.42;
      }

      #${AI_BOX_ID} .tm-gemma-muted,
      #${AI_BOX_ID} .tm-gemma-error {
        font-size: 16px;
      }

      #${AI_BOX_ID} .tm-gemma-toolbar {
        gap: 6px;
      }
    }

  `);

    function getEnabled() {
        const stored = GM_getValue(KEY_ENABLED, true);
        return stored !== false;
    }

    function setEnabled(value) {
        GM_setValue(KEY_ENABLED, !!value);
    }

    function getToken() {
        return String(GM_getValue(KEY_TOKEN, '') || '').trim();
    }

    function setToken(value) {
        GM_setValue(KEY_TOKEN, String(value || '').trim());
    }

    function getSystemPrompt() {
        return String(GM_getValue(KEY_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT) || DEFAULT_SYSTEM_PROMPT);
    }

    function setSystemPrompt(value) {
        GM_setValue(KEY_SYSTEM_PROMPT, String(value || '').trim() || DEFAULT_SYSTEM_PROMPT);
    }

    function resetPrompts() {
        setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
    }

    function debounce(fn, wait) {
        return function debounced(...args) {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function qs(sel, root = document) {
        return root.querySelector(sel);
    }

    function qsa(sel, root = document) {
        return Array.from(root.querySelectorAll(sel));
    }

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs || {})) {
            if (value == null) continue;
            if (key === 'text') {
                node.textContent = String(value);
            } else if (key === 'class') {
                node.className = String(value);
            } else if (key === 'for') {
                node.htmlFor = String(value);
            } else if (key === 'checked') {
                node.checked = !!value;
            } else if (key === 'value') {
                node.value = String(value);
            } else if (key === 'type') {
                node.type = String(value);
            } else if (key === 'placeholder') {
                node.placeholder = String(value);
            } else if (key === 'role') {
                node.setAttribute('role', String(value));
            } else if (key === 'ariaModal') {
                node.setAttribute('aria-modal', String(value));
            } else if (key === 'ariaLabel') {
                node.setAttribute('aria-label', String(value));
            } else if (key === 'dataAction') {
                node.dataset.action = String(value);
            } else {
                node.setAttribute(key, String(value));
            }
        }

        const childList = Array.isArray(children) ? children : [children];
        for (const child of childList) {
            if (child == null) continue;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
    }


    function svgEl(tag, attrs = {}) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [key, value] of Object.entries(attrs || {})) {
            if (value == null) continue;
            node.setAttribute(key, String(value));
        }
        return node;
    }

    function createIcon(paths, viewBox = '0 0 24 24') {
        const svg = svgEl('svg', { viewBox, focusable: 'false', 'aria-hidden': 'true' });
        for (const d of paths) {
            svg.appendChild(svgEl('path', { d }));
        }
        return svg;
    }

    function createIconButton(action, title, icon) {
        const button = el('button', {
            type: 'button',
            class: 'tm-gemma-icon-btn',
            dataAction: action,
            ariaLabel: title,
            title
        });
        button.appendChild(icon);
        return button;
    }

    function setAiStatus(type, text) {
        const box = ensureAiBox();
        if (!box) return;
        const chip = qs('.tm-gemma-status-chip', box);
        if (!chip) return;

        chip.classList.remove('is-loading', 'is-error', 'is-success');

        if (type === 'loading') {
            chip.textContent = text || 'กำลังแปล';
            chip.classList.add('is-loading');
            return;
        }
        if (type === 'error') {
            chip.textContent = text || 'ผิดพลาด';
            chip.classList.add('is-error');
            return;
        }
        chip.textContent = text || 'พร้อมใช้งาน';
        chip.classList.add('is-success');
    }

    function setCopyNote(text, visible = true) {
        const box = ensureAiBox();
        if (!box) return;
        const note = qs('.tm-gemma-copy-note', box);
        if (!note) return;
        note.textContent = text || '';
        note.classList.toggle('show', !!visible);
        if (visible) {
            clearTimeout(setCopyNote._timer);
            setCopyNote._timer = setTimeout(() => {
                note.classList.remove('show');
            }, 1600);
        }
    }

    function getGoogleTextProbe(resultBox = getResultBox()) {
        if (!resultBox) return null;

        const root = qs('.usGWQd', resultBox) || resultBox;

        const candidates = [
            qs('.eDXd3b', root),
            qs('[lang]', root),
            qs('.W297wb', root),
            qs('.ryNqvb', root),
            root
        ].filter(Boolean);

        return candidates.find(node => {
            const text = (node.textContent || '').trim();
            const rect = node.getBoundingClientRect();
            return text.length > 0 && rect.width > 0 && rect.height > 0;
        }) || root;
    }

    function syncAiLayout(box = document.getElementById(AI_BOX_ID)) {
        const resultBox = getResultBox();
        if (!box || !resultBox) return;

        const body = qs('.tm-gemma-body', box);
        const probe = getGoogleTextProbe(resultBox);

        if (!body || !probe) return;

        const cs = getComputedStyle(probe);

        body.style.setProperty('font-family', cs.fontFamily || 'Roboto, Arial, sans-serif', 'important');
        body.style.setProperty('font-size', cs.fontSize || 'inherit', 'important');
        body.style.setProperty('font-weight', cs.fontWeight || '400', 'important');
        body.style.setProperty('line-height', cs.lineHeight || 'normal', 'important');
        body.style.setProperty('letter-spacing', cs.letterSpacing || 'normal', 'important');
    }

    async function copyText(text) {
        const value = cleanText(text);
        if (!value) throw new Error('ไม่มีข้อความให้คัดลอก');

        if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(value, 'text');
            return;
        }

        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return;
        }

        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
    }

    function cleanText(text) {
        return String(text || '')
            .replace(/\u200b/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function parseResponseHeaders(raw) {
        const headers = {};
        String(raw || '')
            .split(/\r?\n/)
            .forEach((line) => {
            const idx = line.indexOf(':');
            if (idx <= 0) return;
            const key = line.slice(0, idx).trim().toLowerCase();
            const value = line.slice(idx + 1).trim();
            if (key) headers[key] = value;
        });
        return headers;
    }

    function readRetrySeconds(headers, fallbackSeconds = 45) {
        const retryAfter = headers['retry-after'];
        if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter);

        const rateLimit = headers['ratelimit'] || '';
        const match = rateLimit.match(/(?:^|;)\s*t=(\d+)/i);
        if (match) return Number(match[1]);

        return fallbackSeconds;
    }

    function armRetryAfterRateLimit(seconds) {
        clearTimeout(retryAfterTimer);
        const safeSeconds = Math.max(3, Math.min(300, Number(seconds) || 45));
        rateLimitedUntil = Date.now() + safeSeconds * 1000;
        retryAfterTimer = setTimeout(() => {
            retryAfterTimer = null;
            if (Date.now() >= rateLimitedUntil) {
                rateLimitedUntil = 0;
                rateLimitReason = '';
                scheduleRefresh(true);
            }
        }, safeSeconds * 1000 + 200);
    }

    function getRateLimitWaitText() {
        const remain = Math.max(1, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
        return `รอ ${remain}s`;
    }

    function getLangParams() {
        const url = new URL(location.href);
        return {
            sl: url.searchParams.get('sl') || 'auto',
            tl: url.searchParams.get('tl') || 'auto'
        };
    }

    function getSourceText() {
        const candidates = [
            'textarea.er8xn',
            '[jsname="lKng5e"]',
            '.QFw9Te .D5aOJc.vJwDU',
            '.QFw9Te .D5aOJc.Hapztf'
        ];

        for (const selector of candidates) {
            const el = qs(selector);
            if (!el) continue;
            const value = 'value' in el ? el.value : el.textContent;
            const text = cleanText(value);
            if (text) return text;
        }

        return '';
    }

    function getResultBox() {
        return (
            qs('.QcsUad.GeWPTc.BDJ8fb.BLojaf.sMVRZe.hCXDsb.wneUed') ||
            qs('.QcsUad.GeWPTc.BDJ8fb.sMVRZe.hCXDsb.wneUed') ||
            qs('.QcsUad.GeWPTc.sMVRZe.hCXDsb.wneUed') ||
            qs('.QcsUad.GeWPTc.hCXDsb.wneUed') ||
            qs('.QcsUad.wneUed')
        );
    }

    function extractGoogleResultText(box) {
        if (!box) return '';

        const spanTexts = qsa('.usGWQd .ryNqvb', box)
        .map(el => cleanText(el.textContent))
        .filter(Boolean);

        if (spanTexts.length) {
            return cleanText(spanTexts.join(' '));
        }

        const textarea = qs('.usGWQd textarea', box);
        if (textarea && cleanText(textarea.value)) {
            return cleanText(textarea.value);
        }

        const display = qs('.usGWQd .eDXd3b', box);
        if (display && cleanText(display.textContent)) {
            return cleanText(display.textContent);
        }

        return '';
    }


    function ensureSettingsModal() {
        let modal = document.getElementById(AI_MODAL_ID);
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = AI_MODAL_ID;

        const card = el('div', {
            class: 'tm-gemma-card',
            role: 'dialog',
            ariaModal: 'true',
            ariaLabel: 'Gemma AI settings'
        });

        const title = el('h3', { text: 'ตั้งค่า Gemma AI' });
        const desc1 = el('p');
        desc1.append('ใส่ Hugging Face token ของคุณเพื่อเรียก ');
        desc1.appendChild(el('code', { text: MODEL_ID }));

        const desc2 = el('p', {
            text: 'ถ้ายังไม่มี token ให้สร้างแบบ fine-grained และเปิดสิทธิ์ Inference Providers ก่อนใช้งาน'
        });

        const tokenLabel = el('label', { for: 'tm-gemma-token', text: 'Hugging Face Token' });
        const tokenInput = el('input', {
            id: 'tm-gemma-token',
            type: 'password',
            placeholder: 'hf_...'
        });

        const systemPromptLabel = el('label', {
            for: 'tm-gemma-system-prompt',
            text: 'System prompt'
        });
        const systemPromptInput = el('textarea', {
            id: 'tm-gemma-system-prompt',
            placeholder: DEFAULT_SYSTEM_PROMPT,
            rows: '4'
        });

        const promptHint = el('p', {
            text: 'แก้ได้เฉพาะ System prompt เท่านั้น — ระบบจะจำค่าไว้หลังปิดเบราว์เซอร์'
        });

        const checkLabel = el('label', { class: 'tm-gemma-check' });
        const enabledInput = el('input', {
            id: 'tm-gemma-enabled',
            type: 'checkbox'
        });
        const enabledSpan = el('span', { text: 'เปิดใช้งาน AI translation' });
        checkLabel.append(enabledInput, enabledSpan);

        const status = el('div', {
            class: 'tm-gemma-status',
            id: 'tm-gemma-settings-status'
        });

        const row = el('div', { class: 'tm-gemma-row' });
        const clearBtn = el('button', {
            type: 'button',
            class: 'tm-gemma-btn',
            id: 'tm-gemma-clear',
            text: 'ล้างคีย์'
        });
        const resetPromptBtn = el('button', {
            type: 'button',
            class: 'tm-gemma-btn',
            id: 'tm-gemma-reset-prompt',
            text: 'รีเซ็ต System prompt'
        });
        const closeBtn = el('button', {
            type: 'button',
            class: 'tm-gemma-btn',
            id: 'tm-gemma-close',
            text: 'ปิด'
        });
        const saveBtn = el('button', {
            type: 'button',
            class: 'tm-gemma-btn',
            id: 'tm-gemma-save',
            text: 'บันทึก'
        });
        row.append(clearBtn, resetPromptBtn, closeBtn, saveBtn);

        card.append(
            title,
            desc1,
            desc2,
            tokenLabel,
            tokenInput,
            systemPromptLabel,
            systemPromptInput,
            promptHint,
            checkLabel,
            status,
            row
        );
        modal.appendChild(card);

        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeSettingsModal();
        });

        document.documentElement.appendChild(modal);

        closeBtn.addEventListener('click', closeSettingsModal);

        clearBtn.addEventListener('click', () => {
            setToken('');
            tokenInput.value = '';
            setSettingsStatus('ล้างคีย์แล้ว');
            scheduleRefresh();
        });

        saveBtn.addEventListener('click', () => {
            const token = tokenInput.value.trim();
            const enabled = enabledInput.checked;
            setToken(token);
            setEnabled(enabled);
            setSystemPrompt(systemPromptInput.value);
            setSettingsStatus(token ? 'บันทึกแล้ว' : 'บันทึกแล้ว (ยังไม่มีคีย์)');
            cache.clear();
            scheduleRefresh(true);
        });

        resetPromptBtn.addEventListener('click', () => {
            resetPrompts();
            systemPromptInput.value = getSystemPrompt();
            setSettingsStatus('รีเซ็ต System prompt แล้ว');
            cache.clear();
            scheduleRefresh(true);
        });

        return modal;
    }

    function setSettingsStatus(text) {
        const status = qs('#tm-gemma-settings-status');
        if (status) status.textContent = text || '';
    }

    function openSettingsModal() {
        const modal = ensureSettingsModal();
        qs('#tm-gemma-token', modal).value = getToken();
        qs('#tm-gemma-enabled', modal).checked = getEnabled();
        qs('#tm-gemma-system-prompt', modal).value = getSystemPrompt();
        setSettingsStatus('');
        modal.classList.add('show');
    }

    function closeSettingsModal() {
        const modal = ensureSettingsModal();
        modal.classList.remove('show');
    }


    function ensureAiBox() {
        const resultBox = getResultBox();
        if (!resultBox) return null;

        let box = document.getElementById(AI_BOX_ID);
        if (box && !resultBox.contains(box)) {
            box.remove();
            box = null;
        }

        if (!box) {
            box = document.createElement('div');
            box.id = AI_BOX_ID;
            box.dataset.copyValue = '';

            const head = el('div', { class: 'tm-gemma-head' });
            const meta = el('div', { class: 'tm-gemma-meta' });
            const badge = el('span', { class: 'tm-gemma-badge', text: 'AI' });
            const title = el('div', { class: 'tm-gemma-title', text: 'Gemma 3 27B · คำแปล AI' });
            meta.append(badge, title);

            const statusChip = el('div', {
                class: 'tm-gemma-status-chip is-loading',
                text: 'กำลังรอ'
            });

            head.append(meta, statusChip);

            const bodyWrap = el('div', { class: 'tm-gemma-body-wrap' });
            const body = el('div', {
                class: 'tm-gemma-body tm-gemma-muted',
                text: 'รอข้อความ…'
            });
            bodyWrap.appendChild(body);

            const toolbar = el('div', { class: 'tm-gemma-toolbar' });
            const actions = el('div', { class: 'tm-gemma-actions' });

            const copyBtn = createIconButton('copy', 'คัดลอกคำแปล AI', createIcon([
                'M16,20H5V6H3v14c0,1.1,0.9,2,2,2h11V20z',
                'M20,16V4c0-1.1-0.9-2-2-2H9C7.9,2,7,2.9,7,4v12c0,1.1,0.9,2,2,2h9 C19.1,18,20,17.1,20,16z',
                'M18,16H9V4h9V16z'
            ]));

            const retryBtn = createIconButton('retry', 'แปลใหม่', createIcon([
                'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'
            ]));

            const settingsBtn = createIconButton('settings', 'ตั้งค่า', createIcon([
                'M19.14,12.94c0.04-0.31,0.06-0.63,0.06-0.94s-0.02-0.63-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.4,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.3-0.6-0.22l-2.39,0.96c-0.5-0.38-1.05-0.69-1.66-0.94L14.46,2.8C14.43,2.57,14.23,2.4,14,2.4h-4c-0.24,0-0.43,0.17-0.46,0.4L9.17,5.35c-0.61,0.24-1.17,0.56-1.66,0.94L5.12,5.33c-0.22-0.09-0.48,0-0.6,0.22L2.6,8.87c-0.12,0.21-0.07,0.47,0.12,0.61l2.03,1.58C4.71,11.37,4.69,11.69,4.69,12s0.02,0.63,0.06,0.94L2.72,14.52c-0.18,0.14-0.23,0.4-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.3,0.6,0.22l2.39-0.96c0.5,0.38,1.05,0.69,1.66,0.94l0.37,2.55c0.03,0.23,0.22,0.4,0.46,0.4h4c0.24,0,0.43-0.17,0.46-0.4l0.37-2.55c0.61-0.24,1.17-0.56,1.66-0.94l2.39,0.96c0.22,0.09,0.48,0,0.6-0.22l1.92-3.32c0.12-0.21,0.07-0.47-0.12-0.61L19.14,12.94z',
                'M12,15.5c-1.93,0-3.5-1.57-3.5-3.5s1.57-3.5,3.5-3.5s3.5,1.57,3.5,3.5S13.93,15.5,12,15.5z'
            ]));

            actions.append(copyBtn, retryBtn, settingsBtn);

            const copyNote = el('div', {
                class: 'tm-gemma-copy-note',
                text: ''
            });

            toolbar.append(copyNote, actions);
            box.append(head, bodyWrap, toolbar);

            box.addEventListener('click', async (event) => {
                const btn = event.target.closest('[data-action]');
                if (!btn) return;
                const action = btn.getAttribute('data-action');
                if (action === 'settings') {
                    openSettingsModal();
                    return;
                }
                if (action === 'retry') {
                    scheduleRefresh(true);
                    return;
                }
                if (action === 'copy') {
                    try {
                        const value = box.dataset.copyValue || qs('.tm-gemma-body', box)?.textContent || '';
                        await copyText(value);
                        setCopyNote('คัดลอกแล้ว');
                    } catch (err) {
                        setCopyNote(`คัดลอกไม่ได้: ${err.message || 'ไม่ทราบสาเหตุ'}`);
                    }
                }
            });

            const anchor = qs('.usGWQd', resultBox) || resultBox.firstElementChild || resultBox;
            if (anchor && anchor.parentElement === resultBox) {
                anchor.insertAdjacentElement('afterend', box);
            } else {
                resultBox.appendChild(box);
            }
            syncAiLayout(box);
        }

        return box;
    }


    function setAiMessage(text, opts = {}) {
        const box = ensureAiBox();
        if (!box) return;
        const body = qs('.tm-gemma-body', box);
        if (!body) return;

        const cleaned = cleanText(text);
        body.textContent = cleaned;
        body.classList.toggle('tm-gemma-muted', !!opts.muted);
        body.classList.toggle('tm-gemma-error', !!opts.error);
        box.dataset.copyValue = opts.copyable === false ? '' : cleaned;
        setCopyNote('', false);
        syncAiLayout(box);

        if (opts.error) {
            setAiStatus('error', 'ผิดพลาด');
        } else if (opts.muted) {
            setAiStatus('loading', opts.statusText || 'กำลังรอ');
        } else {
            setAiStatus('success', opts.statusText || 'พร้อมคัดลอก');
        }
    }

    function renderUserPrompt(sourceText, sl, tl) {
        const sourceLabel = sl === 'auto' ? 'the detected source language' : sl;
        const targetLabel = tl === 'auto' ? 'the selected target language' : tl;

        return DEFAULT_USER_PROMPT
            .replaceAll('{{sourceLang}}', sourceLabel)
            .replaceAll('{{targetLang}}', targetLabel)
            .replaceAll('{{text}}', sourceText);
    }

    function buildMessages(sourceText, sl, tl) {
        return [
            {
                role: 'system',
                content: getSystemPrompt()
            },
            {
                role: 'user',
                content: renderUserPrompt(sourceText, sl, tl)
            }
        ];
    }

    function parseRouterResponse(payload) {
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content === 'string') return cleanText(content);
        if (Array.isArray(content)) {
            const joined = content
            .map(part => (typeof part === 'string' ? part : part?.text || ''))
            .join('');
            return cleanText(joined);
        }
        return '';
    }

    function parseClassicResponse(payload) {
        if (Array.isArray(payload) && payload[0] && typeof payload[0].generated_text === 'string') {
            return cleanText(payload[0].generated_text);
        }
        if (payload && typeof payload.generated_text === 'string') {
            return cleanText(payload.generated_text);
        }
        return '';
    }

    function requestJson(url, body) {
        let requestHandle = null;

        const promise = new Promise((resolve, reject) => {
            requestHandle = GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`
        },
          data: JSON.stringify(body),
          timeout: 120000,
          onload: (response) => {
              let json;
              try {
                  json = JSON.parse(response.responseText || '{}');
              } catch (err) {
                  reject(new Error('API ส่งข้อมูลกลับมาเป็น JSON ไม่สำเร็จ'));
                  return;
              }

              if (response.status >= 200 && response.status < 300) {
                  resolve(json);
                  return;
              }

              const headers = parseResponseHeaders(response.responseHeaders);
              if (response.status === 429) {
                  const waitSeconds = readRetrySeconds(headers, 45);
                  rateLimitReason = json?.error || json?.message || '429 Too Many Requests';
                  armRetryAfterRateLimit(waitSeconds);
                  reject(new Error(`ติดลิมิตจาก Hugging Face กรุณารอประมาณ ${waitSeconds} วินาที`));
                  return;
              }

              const message = json?.error || json?.message || `HTTP ${response.status}`;
              reject(new Error(String(message)));
          },
          ontimeout: () => reject(new Error('หมดเวลารอจาก Hugging Face')),
          onerror: () => reject(new Error('เรียก Hugging Face ไม่สำเร็จ')),
          onabort: () => reject(new Error('aborted'))
      });
    });

      return {
          promise,
          abort() {
              try {
                  requestHandle?.abort();
              } catch (_) {
                  // no-op
              }
          }
      };
  }

    async function translateWithRouter(sourceText, sl, tl) {
        const payload = {
            model: MODEL_ID,
            messages: buildMessages(sourceText, sl, tl),
            temperature: 0.2,
            max_tokens: 256,
            stream: false
        };
        const req = requestJson(ROUTER_URL, payload);
        activeRequest = req;
        const data = await req.promise;
        const text = parseRouterResponse(data);
        if (!text) throw new Error('Router ไม่ส่งข้อความคำแปลกลับมา');
        return text;
    }

    async function translateWithClassic(sourceText, sl, tl) {
        const prompt = `${getSystemPrompt()}\n\n${renderUserPrompt(sourceText, sl, tl)}`;

        const payload = {
            inputs: prompt,
            options: { wait_for_model: true },
            parameters: {
                max_new_tokens: 256,
                return_full_text: false,
                temperature: 0.2
            }
        };

        const req = requestJson(CLASSIC_URL, payload);
        activeRequest = req;
        const data = await req.promise;
        const text = parseClassicResponse(data);
        if (!text) throw new Error('Classic API ไม่ส่งข้อความคำแปลกลับมา');
        return text;
    }

    async function translateText(sourceText, sl, tl) {
        const delta = Date.now() - lastApiCallAt;
        if (delta < MIN_API_INTERVAL_MS) {
            await sleep(MIN_API_INTERVAL_MS - delta);
        }
        lastApiCallAt = Date.now();
        try {
            return await translateWithRouter(sourceText, sl, tl);
        } catch (routerErr) {
            try {
                return await translateWithClassic(sourceText, sl, tl);
            } catch (classicErr) {
                throw new Error(`${routerErr.message} | fallback: ${classicErr.message}`);
            }
        }
    }

    function abortActiveRequest() {
        if (activeRequest && typeof activeRequest.abort === 'function') {
            try {
                activeRequest.abort();
            } catch (_) {
                // no-op
            }
        }
        activeRequest = null;
    }

    async function runTranslation(force = false) {
        ensureSettingsModal();

        const sourceText = getSourceText();
        const resultBox = getResultBox();

        if (!resultBox) return;

        if (rateLimitedUntil > Date.now()) {
            setAiMessage(rateLimitReason || 'ติดลิมิตชั่วคราวจาก Hugging Face', { muted: true, copyable: false, statusText: getRateLimitWaitText() });
            return;
        }

        if (!getEnabled()) {
            abortActiveRequest();
            activeKey = '';
            setAiMessage('AI translation ปิดอยู่ — กดปุ่มเฟืองเพื่อเปิดใช้งาน', { muted: true, copyable: false, statusText: 'ปิดอยู่' });
            return;
        }

        const token = getToken();
        if (!token) {
            abortActiveRequest();
            activeKey = '';
            setAiMessage('ยังไม่ได้ตั้งค่า Hugging Face token — กดปุ่มเฟือง', { muted: true, copyable: false, statusText: 'รอคีย์' });
            return;
        }

        if (!sourceText) {
            abortActiveRequest();
            activeKey = '';
            setAiMessage('รอข้อความต้นฉบับ…', { muted: true, copyable: false, statusText: 'รอข้อความ' });
            return;
        }

        const googleText = extractGoogleResultText(resultBox);
        if (!googleText) {
            abortActiveRequest();
            activeKey = '';
            setAiMessage('รอคำแปลของ Google…', { muted: true, copyable: false, statusText: 'รอ Google' });
            return;
        }

        ensureAiBox();

        const { sl, tl } = getLangParams();
        const key = `${sl}|${tl}|${sourceText}`;

        if (!force && cache.has(key)) {
            setAiMessage(cache.get(key));
            return;
        }

        if (!force && activeKey === key) {
            return;
        }

        abortActiveRequest();
        activeKey = key;
        setAiMessage('AI กำลังแปล…', { muted: true, copyable: false, statusText: 'กำลังแปล' });

        const requestPromise = translateText(sourceText, sl, tl);

        try {
            const translated = await requestPromise;
            if (activeKey !== key) return;
            cache.set(key, translated);
            setAiMessage(translated);
        } catch (err) {
            if (String(err?.message || '') === 'aborted') return;
            if (activeKey !== key) return;
            setAiMessage(`เกิดข้อผิดพลาด: ${err.message || 'ไม่ทราบสาเหตุ'}`, { error: true, copyable: false });
        } finally {
            if (activeKey === key) activeRequest = null;
        }
    }

    const scheduleRefresh = debounce((force = false) => {
        runTranslation(force).catch((err) => {
            setAiMessage(`เกิดข้อผิดพลาด: ${err.message || 'ไม่ทราบสาเหตุ'}`, { error: true, copyable: false });
        });
    }, 500);

    function observePage() {
        const observer = new MutationObserver((mutations) => {
            const hasRelevantChange = mutations.some((m) => {
                const el = m.target instanceof Element ? m.target : m.target.parentElement;
                if (!el) return false;

                if (el.closest(`#${AI_BOX_ID}`) || el.closest(`#${AI_MODAL_ID}`)) {
                    return false;
                }

                return true;
            });

            if (!hasRelevantChange) return;

            syncAiLayout();
            scheduleRefresh(false);
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    function hookHistory() {
        const fire = () => {
            if (location.href !== lastSeenHref) {
                lastSeenHref = location.href;
                scheduleRefresh(true);
            }
        };

        const originalPushState = history.pushState;
        history.pushState = function patchedPushState(...args) {
            const result = originalPushState.apply(this, args);
            fire();
            return result;
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function patchedReplaceState(...args) {
            const result = originalReplaceState.apply(this, args);
            fire();
            return result;
        };

        window.addEventListener('popstate', fire);
        setInterval(fire, 1000);
    }

    function registerMenu() {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('Gemma AI: ตั้งค่า', openSettingsModal);
            GM_registerMenuCommand('Gemma AI: แปลใหม่', () => scheduleRefresh(true));
            GM_registerMenuCommand('Gemma AI: เปิด/ปิด', () => {
                setEnabled(!getEnabled());
                scheduleRefresh(true);
            });
        }
    }

    function boot() {
        ensureSettingsModal();
        registerMenu();
        hookHistory();
        observePage();
        scheduleRefresh(true);
    }

    boot();
})();
