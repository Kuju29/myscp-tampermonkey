// ==UserScript==
// @name         YouTube Personal Playlist URL Exporter (.txt)
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  Export real YouTube video URLs from the current playlist panel to a TXT file
// @author       ChatGPT
// @match        https://www.youtube.com/*
// @icon         https://www.youtube.com/favicon.ico
// @updateURL    https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Personal%20Playlist%20URL%20Exporter%20(.txt)/YouTube%20Playlist%20URL%20Exporter%20(.txt).user.js
// @downloadURL  https://github.com/Kuju29/myscp-tampermonkey/raw/refs/heads/main/YouTube%20Personal%20Playlist%20URL%20Exporter%20(.txt)/YouTube%20Playlist%20URL%20Exporter%20(.txt).user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const IDS = {
        slot: 'tm-yt-export-slot-v3',
        button: 'tm-yt-export-btn-v3',
        style: 'tm-yt-export-style-v3'
    };

    const SELECTORS = {
        panel: 'ytd-playlist-panel-renderer#playlist',
        toolbar: 'ytd-playlist-panel-renderer#playlist #playlist-action-menu ytd-menu-renderer #top-level-buttons-computed',
        nativeButtons: 'ytd-playlist-panel-renderer#playlist #playlist-action-menu ytd-menu-renderer #top-level-buttons-computed > ytd-playlist-loop-button-renderer button, ytd-playlist-panel-renderer#playlist #playlist-action-menu ytd-menu-renderer #top-level-buttons-computed > ytd-toggle-button-renderer button',
        itemsWrap: 'ytd-playlist-panel-renderer#playlist #items.playlist-items, ytd-playlist-panel-renderer#playlist #items',
        videoLinks: 'ytd-playlist-panel-renderer#playlist #items a#wc-endpoint[href*="/watch?v="]',
        playlistTitle: [
            'ytd-playlist-panel-renderer#playlist h3 .title a',
            'ytd-playlist-panel-renderer#playlist h3 a[href*="/playlist?list="]',
            'ytd-playlist-panel-renderer#playlist .title'
        ]
    };

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function debounce(fn, wait = 200) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), wait);
        };
    }

    function ensureStyles() {
        if (document.getElementById(IDS.style)) return;

        const style = document.createElement('style');
        style.id = IDS.style;
        style.textContent = `
            #${IDS.slot} {
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
                flex: 0 0 auto;
            }

            #${IDS.button} {
                appearance: none;
                -webkit-appearance: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                border: none;
                outline: none;
                cursor: pointer;
                background: transparent;
                color: inherit;
                padding: 0;
                margin: 0;
                min-width: 0;
                position: relative;
            }

            #${IDS.button}[disabled] {
                opacity: 0.48;
                cursor: default;
                pointer-events: none;
            }

            #${IDS.button} .tm-icon-wrap {
                width: 24px;
                height: 24px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                pointer-events: none;
                flex: 0 0 auto;
            }

            #${IDS.button} svg {
                width: 24px;
                height: 24px;
                display: block;
                fill: currentColor;
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    function isPlaylistPage() {
        try {
            const url = new URL(location.href);
            return url.hostname.includes('youtube.com') && url.searchParams.has('list');
        } catch {
            return false;
        }
    }

    function getPanel() {
        return document.querySelector(SELECTORS.panel);
    }

    function getToolbar() {
        return document.querySelector(SELECTORS.toolbar);
    }

    function getReferenceButton() {
        const buttons = [...document.querySelectorAll(SELECTORS.nativeButtons)];
        return buttons[buttons.length - 1] || null;
    }

    function normalizeWatchUrl(rawHref) {
        if (!rawHref) return null;

        try {
            const url = new URL(rawHref, location.origin);
            const videoId = url.searchParams.get('v');
            if (!videoId) return null;
            return `https://www.youtube.com/watch?v=${videoId}`;
        } catch {
            return null;
        }
    }

    function getPlaylistName(panel) {
        for (const selector of SELECTORS.playlistTitle) {
            const el = panel.querySelector(selector);
            const text = el?.textContent?.trim();
            if (text) return text;
        }

        return document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim() || 'playlist';
    }

    function sanitizeFileName(name) {
        return name
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
    }

    async function ensureAllItemsLoaded(panel) {
        const scroller = panel.querySelector(SELECTORS.itemsWrap);
        if (!scroller) return;

        const previousScrollTop = scroller.scrollTop;
        let lastCount = 0;
        let stableRounds = 0;

        for (let i = 0; i < 50; i++) {
            const currentCount = panel.querySelectorAll(SELECTORS.videoLinks).length;

            if (currentCount === lastCount) {
                stableRounds += 1;
            } else {
                stableRounds = 0;
                lastCount = currentCount;
            }

            scroller.scrollTop = scroller.scrollHeight;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            await sleep(300);

            if (stableRounds >= 3) break;
        }

        scroller.scrollTop = previousScrollTop;
    }

    function collectVideoUrls(panel) {
        const links = [...panel.querySelectorAll(SELECTORS.videoLinks)];
        const urls = new Set();

        for (const link of links) {
            const normalized = normalizeWatchUrl(link.getAttribute('href'));
            if (normalized) urls.add(normalized);
        }

        return [...urls];
    }

    function downloadTxt(filename, text) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    }

    function createDownloadSvg() {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');

        const path = document.createElementNS(ns, 'path');
        path.setAttribute('fill', 'currentColor');
        path.setAttribute(
            'd',
            'M17 18v1H6v-1a1 1 0 10-2 0v2a1 1 0 001 1h13a1 1 0 001-1v-2a1 1 0 10-2 0ZM11 3v8.59L8.71 9.29a1 1 0 00-1.42 1.42l4 4a1 1 0 001.42 0l4-4a1 1 0 00-1.42-1.42L13 11.59V3a1 1 0 10-2 0Z'
        );

        svg.appendChild(path);
        return svg;
    }

    function createButton() {
        const button = document.createElement('button');
        button.id = IDS.button;
        button.type = 'button';
        button.title = 'ส่งออกลิงก์วิดีโอเป็น TXT';
        button.setAttribute('aria-label', 'ส่งออกลิงก์วิดีโอเป็น TXT');

        const iconWrap = document.createElement('span');
        iconWrap.className = 'tm-icon-wrap';
        iconWrap.appendChild(createDownloadSvg());
        button.appendChild(iconWrap);

        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            const panel = getPanel();
            if (!panel) return;

            try {
                button.disabled = true;

                await ensureAllItemsLoaded(panel);

                const urls = collectVideoUrls(panel);
                if (!urls.length) {
                    alert('ไม่พบลิงก์วิดีโอใน playlist panel');
                    return;
                }

                const playlistName = sanitizeFileName(getPlaylistName(panel));
                const exportDate = getExportDateString();
                const fileName = sanitizeFileName(`${playlistName} ${exportDate}`);

                downloadTxt(`${fileName}.txt`, urls.join('\n'));
            } catch (err) {
                console.error('[YT Playlist Exporter]', err);
            } finally {
                button.disabled = false;
            }
        }, true);

        return button;
    }

    function getExportDateString() {
        const now = new Date();
        const day = String(now.getDate()).padStart(2, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');

        const buddhistYear2 = String((now.getFullYear() + 543) % 100).padStart(2, '0');

        return `${day}-${month}-${buddhistYear2}`;
    }

    function syncButtonLook(button, referenceButton) {
        if (!button || !referenceButton) return;

        const cs = getComputedStyle(referenceButton);
        const rect = referenceButton.getBoundingClientRect();
        const refRenderer = referenceButton.closest('ytd-playlist-loop-button-renderer, ytd-toggle-button-renderer');
        const refRendererStyle = refRenderer ? getComputedStyle(refRenderer) : null;

        button.style.height = `${Math.round(rect.height || parseFloat(cs.height) || 36)}px`;
        button.style.width = `${Math.round(rect.width || parseFloat(cs.width) || 36)}px`;
        button.style.minWidth = `${Math.round(rect.width || parseFloat(cs.width) || 36)}px`;
        button.style.borderRadius = cs.borderRadius;
        button.style.padding = cs.padding;
        button.style.margin = '0';
        button.style.border = cs.border;
        button.style.background = cs.background;
        button.style.color = cs.color;
        button.style.backdropFilter = cs.backdropFilter;
        button.style.webkitBackdropFilter = cs.webkitBackdropFilter;
        button.style.boxShadow = cs.boxShadow;
        button.style.verticalAlign = cs.verticalAlign;
        button.style.font = cs.font;

        const slot = document.getElementById(IDS.slot);
        if (slot) {
            slot.style.marginLeft = refRendererStyle ? refRendererStyle.marginLeft : '0px';
            slot.style.marginRight = refRendererStyle ? refRendererStyle.marginRight : '0px';
        }
    }

    function ensureSlot(toolbar) {
        let slot = document.getElementById(IDS.slot);

        if (!slot) {
            slot = document.createElement('div');
            slot.id = IDS.slot;
            slot.className = 'style-scope ytd-menu-renderer';
        }

        if (!slot.querySelector('#' + IDS.button)) {
            slot.replaceChildren(createButton());
        }

        if (slot.parentElement !== toolbar) {
            toolbar.appendChild(slot);
        }

        return slot;
    }

    function cleanupOldNodes() {
        const oldIds = [
            'tm-yt-playlist-export-renderer',
            'tm-yt-playlist-export-btn',
            'tm-export-slot',
            'tm-export-btn'
        ];

        for (const id of oldIds) {
            document.getElementById(id)?.remove();
        }
    }

    function renderButton() {
        cleanupOldNodes();

        const panel = getPanel();
        const toolbar = getToolbar();

        if (!isPlaylistPage() || !panel || !toolbar) {
            document.getElementById(IDS.slot)?.remove();
            return;
        }

        const slot = ensureSlot(toolbar);
        const button = slot.querySelector('#' + IDS.button);
        const referenceButton = getReferenceButton();

        syncButtonLook(button, referenceButton);

        const hasUrls = collectVideoUrls(panel).length > 0;
        button.disabled = !hasUrls;
        button.setAttribute('aria-disabled', hasUrls ? 'false' : 'true');
    }

    const rerender = debounce(renderButton, 200);

    function hookHistoryEvents() {
        if (window.__tmYTPlaylistExportHistoryHookedV3) return;
        window.__tmYTPlaylistExportHistoryHookedV3 = true;

        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function (...args) {
            const result = originalPushState.apply(this, args);
            window.dispatchEvent(new Event('tm-location-change-v3'));
            return result;
        };

        history.replaceState = function (...args) {
            const result = originalReplaceState.apply(this, args);
            window.dispatchEvent(new Event('tm-location-change-v3'));
            return result;
        };

        window.addEventListener('popstate', () => {
            window.dispatchEvent(new Event('tm-location-change-v3'));
        });
    }

    function initObserver() {
        const observer = new MutationObserver(() => rerender());
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    function init() {
        ensureStyles();
        hookHistoryEvents();
        initObserver();

        window.addEventListener('tm-location-change-v3', rerender, true);
        window.addEventListener('yt-navigate-finish', rerender, true);
        window.addEventListener('ytd-page-data-updated', rerender, true);

        rerender();
        setTimeout(rerender, 800);
        setTimeout(rerender, 1800);
        setTimeout(rerender, 3000);
    }

    init();
})();
