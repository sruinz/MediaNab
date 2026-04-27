// content_bridge.js — ISOLATED world
// 역할: MAIN world ↔ background (Service Worker) 메시지 중개
// ★ ArrayBuffer는 chrome.runtime.sendMessage로 전송 불가 → bytes 배열로 변환

(function () {
    'use strict';
    const DL_EVENTS = {
        chunk: '__medianab_chunk_v2__',
        allChunksSent: '__medianab_all_chunks_sent_v2__',
        progress: '__medianab_progress_v2__',
        status: '__medianab_status_v2__',
        download: '__medianab_download_v2__',
        downloadControl: '__medianab_download_control_v2__',
    };
    const LIVE_EVENTS = {
        chunk: '__medianab_live_chunk_v1__',
        finish: '__medianab_live_finish_v1__',
        progress: '__medianab_live_progress_v1__',
        status: '__medianab_live_status_v1__',
        start: '__medianab_live_record_v1__',
        control: '__medianab_live_record_control_v1__',
    };
    const PREVIEW_EVENTS = {
        fetchResource: '__medianab_fetch_preview_resource_v1__',
        fetchResourceResult: '__medianab_fetch_preview_resource_result_v1__',
    };
    const LOG_EVENT = '__medianab_debug_log_v1__';
    let _downloadBridgeQueue = Promise.resolve();

    function enqueueDownloadBridgeJob(job) {
        const run = async () => {
            try {
                await job();
            } catch (e) {
                console.warn('[MediaNab] bridge download job 오류:', e);
            }
        };
        _downloadBridgeQueue = _downloadBridgeQueue.then(run, run);
        return _downloadBridgeQueue;
    }

    function absolutizeUrl(url) {
        if (!url) return '';
        if (url.startsWith('data:') || url.startsWith('blob:')) return url;
        try {
            return new URL(url, location.href).href;
        } catch {
            return url;
        }
    }

    function firstSrcFromSrcset(srcset) {
        if (!srcset) return '';
        return (srcset.split(',')[0] || '').trim().split(/\s+/)[0] || '';
    }

    function extractCssUrl(value) {
        if (!value || value === 'none') return '';
        const match = value.match(/url\((['"]?)(.*?)\1\)/i);
        return match?.[2] || '';
    }

    function isDirectVideo(url) {
        return /\.(mp4|webm|flv|m4v|mkv)(\?|#|$)/i.test(url || '');
    }

    function isM3U8(url) {
        return /\.m3u8(\?|#|$)/i.test(url || '') ||
               /\/(playlist|master|index)\.m3u8/i.test(url || '') ||
               String(url || '').includes('/hls/');
    }

    function isBadThumbnailValue(url) {
        const value = String(url || '').trim();
        return !value ||
            value === ';' ||
            /^[;:,\s]+$/.test(value) ||
            /^(none|null|undefined|about:blank|javascript:)/i.test(value);
    }

    function isLikelyPlaceholderThumbnailUrl(url) {
        const value = String(url || '').trim();
        if (!value) return true;
        if (/^data:image\/svg\+xml/i.test(value)) return true;
        if (/^data:image\/(?:gif|png|webp);base64,/i.test(value) && value.length < 512) return true;
        const parsed = parseLooseUrl(value);
        const haystack = parsed
            ? `${parsed.hostname}${parsed.pathname}`.toLowerCase()
            : value.toLowerCase();
        return /(?:placeholder|no[-_]?image|blank|transparent|spacer|spinner|loading|grey|gray|default[-_]?poster|default[-_]?thumb|plyr\.svg|player\.svg|poster\.svg)/i.test(haystack);
    }

    function isThumbnailCandidate(url) {
        if (isBadThumbnailValue(url)) return '';
        const absolute = absolutizeUrl(url);
        if (isBadThumbnailValue(absolute)) return '';
        if (isLikelyPlaceholderThumbnailUrl(absolute)) return '';
        if (absolute.startsWith('data:image/')) return absolute;
        if (isDirectVideo(absolute) || isM3U8(absolute)) return '';
        return absolute;
    }

    function elementImageUrl(el) {
        if (!(el instanceof Element)) return '';
        if (el.tagName === 'IMG') {
            return isThumbnailCandidate(el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src') || firstSrcFromSrcset(el.getAttribute('srcset') || ''));
        }
        const attrs = ['poster', 'data-poster', 'data-thumbnail', 'data-thumb', 'data-preview', 'data-image', 'data-src', 'data-background', 'data-bg', 'content'];
        for (const attr of attrs) {
            const value = isThumbnailCandidate(el.getAttribute(attr) || '');
            if (value) return value;
        }
        return isThumbnailCandidate(extractCssUrl(getComputedStyle(el).backgroundImage || '') || extractCssUrl(el.style?.backgroundImage || ''));
    }

    function isVisibleElement(el) {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width >= 80 && rect.height >= 45;
    }

    function normalizePageTitleText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+-\s+YouTube$/i, '')
            .trim();
    }

    function cleanPageTitleCandidate(value) {
        let text = normalizePageTitleText(value);
        const youtubeUiMarkers = [
            '탭하여 음소거 해제',
            '검색정보쇼핑',
            '잠시 후 재생',
            '재생목록 포함',
            '공유재생목록',
            '•공유',
            '2배',
        ];
        let uiMarkerIndex = -1;
        for (const marker of youtubeUiMarkers) {
            const idx = text.indexOf(marker);
            if (idx > 0 && (uiMarkerIndex === -1 || idx < uiMarkerIndex)) uiMarkerIndex = idx;
        }
        if (uiMarkerIndex > 0) text = text.slice(0, uiMarkerIndex).trim();
        if (isYouTubeWatchPage() && isPollutedYouTubeUiTitle(text)) return '';
        if (!text || text.length < 3) return '';
        if (/^(youtube|youtube shorts|shorts|구독|좋아요|싫어요|댓글|공유|리믹스|저장|더보기|재생|일시중지)$/i.test(text)) return '';
        return text;
    }

    function splitPageTitleVariants(value) {
        const text = normalizePageTitleText(value);
        if (!text) return [];
        const variants = new Set();
        for (const separator of [/\s+\|\s+/g, /\s+-\s+/g, /\s+::\s+/g, /\s+»\s+/g, /\s+\/\s+/g]) {
            const parts = text.split(separator).map(part => normalizePageTitleText(part)).filter(Boolean);
            if (parts.length > 1) parts.forEach(part => variants.add(part));
        }
        variants.add(text);
        return Array.from(variants);
    }

    const MEDIA_TITLE_SCOPE_SELECTOR = [
        '#mypiRead',
        'article',
        'main',
        '[role="main"]',
        '[itemtype*="Article"]',
        '[itemtype*="Posting"]',
        '.article',
        '.post',
        '.entry',
        '.view',
        '.read',
        '.write',
        '.board',
        '.board-view',
        '.document',
        '.content',
        '.entry-content',
        '.post-content',
        '.article-content',
        '.view-content',
        '.view_content',
        '.xe_content',
        '.rd_body'
    ].join(',');

    const MEDIA_TITLE_BOUNDARY_SELECTOR = [
        '#mypiRead',
        'article',
        '[itemtype*="Article"]',
        '[itemtype*="Posting"]',
        '.article',
        '.post',
        '.entry',
        '.view',
        '.read',
        '.write',
        '.board-view'
    ].join(',');

    const MEDIA_TITLE_SELECTOR = [
        '#mypiRead td.m1 a',
        '#mypiRead td.m1',
        '[itemprop="headline"]',
        'h1',
        'h2',
        '.entry-title',
        '.post-title',
        '.article-title',
        '.view_subject',
        '.view-title',
        '.board-title',
        '.subject'
    ].join(',');

    const TITLE_NOISE_SELECTOR = [
        'nav',
        'aside',
        'footer',
        'header',
        '.comment',
        '.reply',
        '.sidebar',
        '.side',
        '.menu',
        '.profile',
        '.member',
        '.user',
        '.author',
        '.breadcrumb',
        '.cate',
        '.category',
        '.popular',
        '.rank',
        '.widget',
        '[role="navigation"]',
        '[role="complementary"]'
    ].join(',');

    function normalizeTitleSource(source = '') {
        return ['media-scoped', 'metadata', 'document', 'youtube-navigation', 'youtube-metadata', 'unknown'].includes(source)
            ? source
            : 'unknown';
    }

    function titleInfo(title = '', source = 'unknown') {
        const cleanTitle = cleanPageTitleCandidate(title);
        return cleanTitle ? { title: cleanTitle, source: normalizeTitleSource(source) } : { title: '', source: '' };
    }

    function textVariantsFromTitleNode(node) {
        if (!(node instanceof Element)) return [];
        return [
            node.getAttribute('data-title') || '',
            node.getAttribute('title') || '',
            node.textContent || '',
        ].filter(Boolean);
    }

    function isTitleNodeInsideNoise(node, scope = null) {
        if (!(node instanceof Element)) return true;
        const noise = node.closest(TITLE_NOISE_SELECTOR);
        if (!noise) return false;
        if (
            noise.matches('header') &&
            scope instanceof Element &&
            scope.contains(noise) &&
            node.closest(MEDIA_TITLE_BOUNDARY_SELECTOR) === scope
        ) {
            return false;
        }
        return noise !== node && !node.matches('article, main, [role="main"], #mypiRead');
    }

    function titleNodeBaseScore(node) {
        if (!(node instanceof Element)) return 0;
        if (node.matches('#mypiRead td.m1 a, #mypiRead td.m1')) return 140;
        if (node.matches('[itemprop="headline"]')) return 130;
        if (node.matches('h1')) return 125;
        if (node.matches('h2')) return 112;
        if (node.matches('.entry-title,.post-title,.article-title,.view_subject,.view-title,.board-title,.subject')) return 104;
        if (node.matches('.title,[data-title]')) return 86;
        return 40;
    }

    function scopedTitleScore(node, media = null) {
        let score = titleNodeBaseScore(node);
        if (!(node instanceof Element)) return score;
        if (media instanceof Element) {
            const relation = node.compareDocumentPosition(media);
            if (relation & Node.DOCUMENT_POSITION_FOLLOWING) score += 30;
            if (relation & Node.DOCUMENT_POSITION_PRECEDING) score -= 35;
            try {
                const nodeRect = node.getBoundingClientRect();
                const mediaRect = media.getBoundingClientRect();
                const gapAbove = mediaRect.top - nodeRect.bottom;
                if (gapAbove >= -48 && gapAbove <= 900) score += Math.max(0, 90 - Math.abs(gapAbove) / 5);
                if (nodeRect.top > mediaRect.top + 20) score -= 70;
                if (nodeRect.width >= Math.max(160, mediaRect.width * 0.35)) score += 8;
            } catch {}
        }
        return score;
    }

    function getScopedTitleInfo(scope, media = null) {
        if (!(scope instanceof Element)) return { title: '', source: '' };
        const nodes = [];
        if (scope.matches(MEDIA_TITLE_SELECTOR)) nodes.push(scope);
        nodes.push(...Array.from(scope.querySelectorAll(MEDIA_TITLE_SELECTOR)).slice(0, 80));

        const seen = new Set();
        let best = { title: '', score: -Infinity };
        for (const node of nodes) {
            if (!(node instanceof Element) || node === media || isTitleNodeInsideNoise(node, scope)) continue;
            for (const raw of textVariantsFromTitleNode(node)) {
                for (const variant of splitPageTitleVariants(raw)) {
                    const value = cleanPageTitleCandidate(variant);
                    if (!value || value.length > 180) continue;
                    const key = value.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const score = scopedTitleScore(node, media);
                    if (score > best.score || (score === best.score && value.length > best.title.length)) {
                        best = { title: value, score };
                    }
                }
            }
        }
        return best.title ? { title: best.title, source: 'media-scoped' } : { title: '', source: '' };
    }

    function getMediaScopedTitleInfo(media = null) {
        if (!(media instanceof Element)) return { title: '', source: '' };
        let current = media.parentElement;
        for (let depth = 0; current && current !== document.body && depth < 12; depth += 1) {
            if (current.closest?.('nav, aside, footer, header, [role="navigation"], [role="complementary"]')) break;
            const canOwnMedia = current.matches(MEDIA_TITLE_SCOPE_SELECTOR) || !!current.querySelector(MEDIA_TITLE_SELECTOR);
            if (canOwnMedia) {
                const scoped = getScopedTitleInfo(current, media);
                if (scoped.title) return scoped;
                if (current.matches(MEDIA_TITLE_BOUNDARY_SELECTOR)) break;
            }
            current = current.parentElement;
        }
        return { title: '', source: '' };
    }

    function getDocumentTitleInfo() {
        const seen = new Set();
        const firstClean = (rawValue) => {
            for (const variant of splitPageTitleVariants(rawValue)) {
                const value = cleanPageTitleCandidate(variant);
                if (!value) continue;
                const key = value.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                return value;
            }
            return '';
        };

        for (const selector of [
            'meta[property="og:title"]',
            'meta[name="twitter:title"]',
            'meta[property="twitter:title"]',
            'meta[itemprop="headline"]',
            'meta[name="title"]'
        ]) {
            const value = firstClean(document.querySelector(selector)?.content || '');
            if (value) return { title: value, source: 'metadata' };
        }

        const documentTitle = firstClean(document.title) || firstClean(document.querySelector('title')?.textContent || '');
        return documentTitle ? { title: documentTitle, source: 'document' } : { title: '', source: '' };
    }

    function getMediaTitleInfo(media = null) {
        const scoped = getMediaScopedTitleInfo(media);
        return scoped.title ? scoped : getDocumentTitleInfo();
    }

    function findNearbyTitleForVideo(video) {
        return getMediaScopedTitleInfo(video).title || '';
    }

    function isPollutedYouTubeUiTitle(value = '') {
        const text = normalizePageTitleText(value);
        if (!text) return false;
        const compact = text.replace(/\s+/g, '');
        if (/^(검색|superthanks|구매)/i.test(compact)) return true;
        if (/(탭하여음소거해제|검색정보쇼핑|잠시후재생|재생목록포함|공유재생목록)/i.test(compact)) return true;
        if (/(Super\s*Thanks|구매\|?@|검색[_\s"“”']|탭하여 음소거 해제|잠시 후 재생)/i.test(text)) return true;
        const uiHits = (compact.match(/구독|댓글|공유|리믹스|좋아요|싫어요|조회수|정보|쇼핑|음소거/g) || []).length;
        return uiHits >= 2;
    }

    function parseLooseUrl(url) {
        if (!url) return null;
        try {
            return new URL(url, location.href);
        } catch {
            return null;
        }
    }

    function extractYouTubeVideoId(url = location.href) {
        const u = parseLooseUrl(url);
        if (!u) return '';
        if (u.hostname === 'youtu.be') return u.pathname.split('/').filter(Boolean)[0] || '';
        if (!u.hostname.includes('youtube.com')) return '';
        if (u.pathname === '/watch') return u.searchParams.get('v') || '';
        if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/')) {
            return u.pathname.split('/').filter(Boolean)[1] || '';
        }
        return '';
    }

    function isYouTubeWatchPage(url = location.href) {
        const u = parseLooseUrl(url);
        return !!u && u.hostname.includes('youtube.com') && (
            (u.pathname === '/watch' && u.searchParams.has('v')) ||
            u.pathname.startsWith('/shorts/') ||
            u.pathname.startsWith('/live/')
        );
    }

    function isYouTubeShortsUrl(url = location.href) {
        const u = parseLooseUrl(url);
        return !!u && u.hostname.includes('youtube.com') && u.pathname.startsWith('/shorts/');
    }

    function extractYouTubeThumbnailVideoId(url = '') {
        const u = parseLooseUrl(url);
        if (!u || !u.hostname.includes('ytimg.com')) return '';
        const parts = u.pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(part => part === 'vi' || part === 'vi_webp');
        return idx >= 0 ? (parts[idx + 1] || '') : '';
    }

    const YOUTUBE_NAVIGATION_SEED_TTL = 20000;
    const YOUTUBE_RENDERER_SELECTOR = [
        'ytd-video-renderer',
        'ytd-compact-video-renderer',
        'ytd-rich-item-renderer',
        'ytd-rich-grid-media',
        'ytd-grid-video-renderer',
        'ytd-playlist-panel-video-renderer',
        'ytd-reel-video-renderer',
        'ytd-reel-item-renderer',
        'ytd-watch-card-rich-header-renderer',
        'ytd-compact-radio-renderer',
        'ytd-compact-playlist-renderer'
    ].join(',');
    const _youtubeNavigationSeeds = new Map();

    function buildYouTubeThumbnailUrlForId(videoId = '', pageUrl = location.href) {
        if (!videoId) return '';
        return isYouTubeShortsUrl(pageUrl)
            ? `https://i.ytimg.com/vi/${videoId}/oardefault.jpg`
            : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }

    function canonicalYouTubePageUrl(videoId = '', url = location.href) {
        if (!videoId) return '';
        const current = parseLooseUrl(url);
        if (current && extractYouTubeVideoId(current.href) === videoId) return current.href;
        return `https://www.youtube.com/watch?v=${videoId}`;
    }

    function normalizeYouTubeSeedThumbnail(videoId = '', thumbnail = '', pageUrl = location.href) {
        const clean = isThumbnailCandidate(thumbnail || '');
        const thumbnailVideoId = clean ? extractYouTubeThumbnailVideoId(clean) : '';
        if (clean && (!thumbnailVideoId || thumbnailVideoId === videoId)) return clean;
        return buildYouTubeThumbnailUrlForId(videoId, pageUrl);
    }

    function isYouTubeSeedControlNode(node) {
        return !!(node instanceof Element) && !!node.closest([
            'button',
            '[role="button"]',
            'ytd-menu-renderer',
            'yt-button-shape',
            'ytd-button-renderer',
            'ytd-toggle-button-renderer',
            'tp-yt-paper-icon-button',
            '#menu',
            '#buttons',
            '#actions',
            '#top-level-buttons-computed',
            '[class*="menu"]',
            '[class*="button"]'
        ].join(','));
    }

    function isYouTubeSeedTitleNode(node) {
        if (!(node instanceof Element) || isYouTubeSeedControlNode(node)) return false;
        if (node.matches('a#video-title, #video-title-link, yt-formatted-string#video-title, #video-title')) return true;
        if (node.matches('h1,h2,h3')) return !!node.querySelector('a[href*="/watch"], a[href*="/shorts/"], a[href*="/live/"], #video-title, yt-formatted-string#video-title');
        if (node.matches('h1 a[href*="/watch"], h2 a[href*="/watch"], h3 a[href*="/watch"], h1 a[href*="/shorts/"], h2 a[href*="/shorts/"], h3 a[href*="/shorts/"], h1 a[href*="/live/"], h2 a[href*="/live/"], h3 a[href*="/live/"]')) return true;
        return false;
    }

    function textValuesFromYouTubeTitleNode(node) {
        if (!isYouTubeSeedTitleNode(node)) return [];
        const values = [];
        if (node.matches('a#video-title, #video-title-link')) values.push(node.getAttribute('title') || '');
        values.push(node.textContent || '');
        return values;
    }

    function scoreYouTubeSeedTitleNode(node, value = '') {
        let score = Math.min(String(value || '').length, 90);
        if (!(node instanceof Element)) return score;
        if (node.matches('a#video-title, #video-title-link')) score += 120;
        if (node.matches('#video-title, yt-formatted-string#video-title')) score += 100;
        if (node.matches('h1,h2,h3')) score += 45;
        if (/[가-힣]/.test(value)) score += 10;
        return score;
    }

    function extractYouTubeSeedTitle(root, link = null) {
        const selectors = [
            'a#video-title',
            '#video-title-link',
            'yt-formatted-string#video-title',
            '#video-title',
            'h1',
            'h2',
            'h3',
            'h1 a[href*="/watch"], h2 a[href*="/watch"], h3 a[href*="/watch"]',
            'h1 a[href*="/shorts/"], h2 a[href*="/shorts/"], h3 a[href*="/shorts/"]',
            'h1 a[href*="/live/"], h2 a[href*="/live/"], h3 a[href*="/live/"]'
        ];
        const nodes = [];
        if (link instanceof Element && isYouTubeSeedTitleNode(link)) nodes.push(link);
        if (root instanceof Element) nodes.push(...Array.from(root.querySelectorAll(selectors.join(','))).filter(isYouTubeSeedTitleNode).slice(0, 40));
        const seen = new Set();
        let best = '';
        let bestScore = -Infinity;
        for (const node of nodes) {
            for (const raw of textValuesFromYouTubeTitleNode(node)) {
                for (const line of String(raw || '').split(/[\n\r]+/u)) {
                    const value = cleanPageTitleCandidate(line);
                    if (!value || value.length < 3 || value.length > 160) continue;
                    if (/(조회수|댓글|공유|구독|좋아요|싫어요|views?|comments?|share|subscribe)/i.test(value) && value.length < 32) continue;
                    const key = value.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const score = scoreYouTubeSeedTitleNode(node, value);
                    if (score > bestScore || (score === bestScore && value.length > best.length)) {
                        bestScore = score;
                        best = value;
                    }
                }
            }
        }
        return best;
    }

    function extractYouTubeSeedThumbnail(root, videoId = '', pageUrl = location.href) {
        const nodes = root instanceof Element
            ? Array.from(root.querySelectorAll('#thumbnail img, ytd-thumbnail img, yt-image img, img, [data-thumb], [data-thumbnail], [data-src], [style*="background"]')).slice(0, 80)
            : [];
        let best = '';
        let bestScore = -Infinity;
        for (const node of nodes) {
            if (!(node instanceof Element)) continue;
            const thumb = isThumbnailCandidate(elementImageUrl(node) || '');
            if (!thumb) continue;
            const thumbId = extractYouTubeThumbnailVideoId(thumb);
            if (thumbId && videoId && thumbId !== videoId) continue;
            const rect = node.getBoundingClientRect();
            const score = Math.max(0, rect.width) * Math.max(0, rect.height) +
                (node.closest('#thumbnail, ytd-thumbnail') ? 10000 : 0) +
                (thumbId === videoId ? 5000 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = thumb;
            }
        }
        return normalizeYouTubeSeedThumbnail(videoId, best, pageUrl);
    }

    function storeYouTubeNavigationSeed(seed = {}) {
        const videoId = String(seed.videoId || '').trim();
        const pageUrl = canonicalYouTubePageUrl(videoId, seed.pageUrl || location.href);
        const title = cleanPageTitleCandidate(seed.title || '');
        if (!videoId || !title) return null;
        const thumbnail = normalizeYouTubeSeedThumbnail(videoId, seed.thumbnail || '', pageUrl);
        if (!thumbnail) return null;
        const normalized = { videoId, pageUrl, title, thumbnail, ts: Date.now() };
        _youtubeNavigationSeeds.set(videoId, normalized);
        return normalized;
    }

    function pruneYouTubeNavigationSeeds() {
        const now = Date.now();
        for (const [videoId, seed] of _youtubeNavigationSeeds.entries()) {
            if (!seed?.ts || now - seed.ts > YOUTUBE_NAVIGATION_SEED_TTL) {
                _youtubeNavigationSeeds.delete(videoId);
            }
        }
    }

    function getYouTubeNavigationSeed(videoId = extractYouTubeVideoId(location.href)) {
        pruneYouTubeNavigationSeeds();
        const seed = videoId ? _youtubeNavigationSeeds.get(videoId) : null;
        if (!seed || Date.now() - seed.ts > YOUTUBE_NAVIGATION_SEED_TTL) return null;
        return seed;
    }

    function captureYouTubeNavigationSeedFromLink(link) {
        if (!(link instanceof HTMLAnchorElement)) return null;
        const href = link.href || link.getAttribute('href') || '';
        const videoId = extractYouTubeVideoId(href);
        if (!videoId) return null;
        const root = link.closest(YOUTUBE_RENDERER_SELECTOR) || link;
        const pageUrl = canonicalYouTubePageUrl(videoId, href);
        const title = extractYouTubeSeedTitle(root, link);
        if (!title) return null;
        const thumbnail = extractYouTubeSeedThumbnail(root, videoId, pageUrl);
        return storeYouTubeNavigationSeed({ videoId, pageUrl, title, thumbnail });
    }

    function rememberYouTubeNavigationSeedFromEvent(event) {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        let link = path.find(node => node instanceof HTMLAnchorElement && node.href);
        if (!link && event.target instanceof Element) {
            link = event.target.closest('a[href*="/watch"], a[href*="/shorts/"], a[href*="/live/"], a[href*="youtu.be/"]');
        }
        captureYouTubeNavigationSeedFromLink(link);
    }

    ['pointerdown', 'mousedown', 'click'].forEach(eventName => {
        document.addEventListener(eventName, rememberYouTubeNavigationSeedFromEvent, true);
    });

    function isVisibleTextElement(el) {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
            return false;
        }
        return Array.from(el.getClientRects()).some(rect => rect.width >= 24 && rect.height >= 6);
    }

    function getCurrentYouTubeMetaTitle() {
        const currentVideoId = extractYouTubeVideoId(location.href);
        const pageUrls = [
            document.querySelector('meta[property="og:url"]')?.content || '',
            document.querySelector('meta[name="twitter:url"]')?.content || '',
            document.querySelector('link[rel="canonical"]')?.href || '',
        ].filter(Boolean);
        if (currentVideoId && pageUrls.length) {
            const matchesCurrent = pageUrls.some(url => extractYouTubeVideoId(url) === currentVideoId);
            if (!matchesCurrent) return '';
        }
        return cleanPageTitleCandidate(
            document.querySelector('meta[property="og:title"]')?.content ||
            document.querySelector('meta[name="twitter:title"]')?.content ||
            document.querySelector('meta[name="title"]')?.content ||
            ''
        );
    }

    function getCurrentYouTubeDomTitle() {
        if (isYouTubeShortsUrl()) {
            const shortsTitle = getCurrentYouTubeShortsTitle();
            if (shortsTitle) return shortsTitle;
        }
        const scopedRoots = [
            document.querySelector('ytd-watch-metadata'),
            document.querySelector('#above-the-fold'),
            document.querySelector('ytd-watch-flexy'),
        ].filter(Boolean);
        const roots = scopedRoots.length ? scopedRoots : [document.body].filter(Boolean);
        const selectors = ['#video-title', '#title', 'h1 yt-formatted-string', 'h1', '[role="heading"]', '[title]'];
        const seen = new Set();
        let best = '';
        for (const root of roots.slice(0, 5)) {
            if (!(root instanceof Element)) continue;
            for (const node of Array.from(root.querySelectorAll(selectors.join(','))).slice(0, 40)) {
                if (!(node instanceof Element) || !isVisibleTextElement(node)) continue;
                const values = [node.getAttribute('title') || '', node.getAttribute('aria-label') || '', node.textContent || ''];
                for (const raw of values) {
                    const value = cleanPageTitleCandidate(raw);
                    const key = value.toLowerCase();
                    if (!value || seen.has(key)) continue;
                    if (/(조회수|댓글|공유|리믹스|구독|좋아요|싫어요|views?|comments?|share|subscribe)/i.test(value) && value.length < 32) continue;
                    seen.add(key);
                    if (!best || value.length > best.length) best = value;
                }
            }
        }
        return best;
    }

    function getCurrentYouTubePageTitleInfo() {
        const currentVideoId = extractYouTubeVideoId(location.href);
        const seed = getYouTubeNavigationSeed(currentVideoId);
        if (seed?.title) return titleInfo(seed.title, 'youtube-navigation');
        const metaTitle = getCurrentYouTubeMetaTitle();
        if (metaTitle) return titleInfo(metaTitle, 'youtube-metadata');
        if (isYouTubeShortsUrl()) {
            const shortsTitle = getCurrentYouTubeShortsTitle();
            if (shortsTitle) return titleInfo(shortsTitle, 'youtube-metadata');
        }
        return { title: '', source: '' };
    }

    function getCurrentYouTubeShortsRenderer() {
        const currentVideoId = extractYouTubeVideoId(location.href);
        if (currentVideoId) {
            for (const renderer of document.querySelectorAll('ytd-reel-video-renderer')) {
                if (!(renderer instanceof Element)) continue;
                const matchedLink = Array.from(renderer.querySelectorAll('a[href*="/shorts/"], a[href*="/watch"]'))
                    .some(link => extractYouTubeVideoId(link.href || link.getAttribute('href') || '') === currentVideoId);
                if (matchedLink) return renderer;
            }
        }
        const visibleVideo = getLargestVisibleVideo({ requireReady: false });
        return visibleVideo?.closest?.('ytd-reel-video-renderer') || null;
    }

    function getCurrentYouTubeShortsTitle() {
        const root = getCurrentYouTubeShortsRenderer();
        if (!(root instanceof Element)) return '';
        const selectors = [
            '#video-title',
            'h2',
            'h2 yt-formatted-string',
            'ytd-reel-player-header-renderer yt-formatted-string',
            'ytd-reel-player-overlay-renderer yt-formatted-string',
            '[class*="title"]'
        ];
        const seen = new Set();
        let best = '';
        let bestScore = -Infinity;

        for (const node of Array.from(root.querySelectorAll(selectors.join(','))).slice(0, 50)) {
            if (!(node instanceof Element) || !isVisibleTextElement(node)) continue;
            const values = [node.getAttribute('title') || '', node.textContent || ''];
            for (const raw of values) {
                for (const line of String(raw || '').split(/[\n\r]+/u)) {
                    const value = cleanPageTitleCandidate(line);
                    if (!value || value.length < 3 || value.length > 110) continue;
                    const key = value.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const rect = node.getBoundingClientRect();
                    const score = Math.min(value.length, 80) +
                        (/[가-힣]/.test(value) ? 12 : 0) +
                        (rect.top > window.innerHeight * 0.45 ? 24 : 0) +
                        (node.matches('h1,h2,#video-title,[class*="title"]') ? 18 : 0);
                    if (score > bestScore || (score === bestScore && value.length > best.length)) {
                        bestScore = score;
                        best = value;
                    }
                }
            }
        }
        return best;
    }

    function getCurrentPageTitleInfo({ sourceUrl = '', type = '' } = {}) {
        if (isYouTubeWatchPage()) {
            return getCurrentYouTubePageTitleInfo();
        }
        const matchedVideo = sourceUrl
            ? (findVideoBySourceUrl(sourceUrl, { requireReady: false }) || findVideoBySourceUrl(sourceUrl, { requireReady: true }))
            : null;
        if (matchedVideo) return getMediaTitleInfo(matchedVideo);
        if (type === 'mp4') {
            const visibleVideo = getLargestVisibleVideo({ requireReady: false });
            if (visibleVideo) return getMediaTitleInfo(visibleVideo);
        }
        return getDocumentTitleInfo();
    }

    function getCurrentPageTitle(options = {}) {
        return getCurrentPageTitleInfo(options).title;
    }

    function getPageThumbnailCandidate() {
        const selectors = [
            'meta[property="og:video:image"]',
            'meta[property="og:image"]',
            'meta[name="twitter:image"]',
            'meta[itemprop="image"]',
            'meta[name="thumbnail"]',
            'link[rel="image_src"]',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            const raw = el?.content || el?.getAttribute('content') || el?.getAttribute('src') || el?.getAttribute('href') || '';
            const url = isThumbnailCandidate(raw);
            if (!url) continue;
            if (isYouTubeWatchPage()) {
                const currentId = extractYouTubeVideoId(location.href);
                const thumbId = extractYouTubeThumbnailVideoId(url);
                if (currentId && thumbId && currentId !== thumbId) continue;
            }
            return url;
        }
        return '';
    }

    function thumbnailLogUrl(url) {
        try {
            const parsed = new URL(url, location.href);
            return `${parsed.hostname}${parsed.pathname}`.slice(0, 180);
        } catch {
            return String(url || '').slice(0, 180);
        }
    }

    function isPlainChromeBrowser() {
        const ua = navigator.userAgent || '';
        return /Chrome\//i.test(ua) && !/Edg\//i.test(ua);
    }

    function isChromeSensitiveThumbnailHost(url = '') {
        try {
            const parsed = new URL(url, location.href);
            return /(^|\.)pornhub\.com$/i.test(location.hostname) || /(^|\.)phncdn\.com$/i.test(parsed.hostname);
        } catch {
            return /pornhub|phncdn/i.test(String(url || location.href));
        }
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
        });
    }

    async function isLowInformationImageBlob(blob) {
        try {
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = 80;
            canvas.height = 45;
            const ctx = canvas.getContext('2d', { alpha: false });
            if (!ctx) return false;
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let count = 0;
            let sum = 0;
            let min = 255;
            let max = 0;
            for (let y = 0; y < canvas.height; y += 5) {
                for (let x = 0; x < canvas.width; x += 5) {
                    const idx = ((y * canvas.width) + x) * 4;
                    const lum = Math.round((data[idx] * 0.299) + (data[idx + 1] * 0.587) + (data[idx + 2] * 0.114));
                    sum += lum;
                    if (lum < min) min = lum;
                    if (lum > max) max = lum;
                    count += 1;
                }
            }
            if (!count) return false;
            const mean = sum / count;
            return mean < 12 && (max - min) < 18;
        } catch {
            return false;
        }
    }

    async function fetchOfficialThumbnailAsDataUrl(url) {
        const cleanUrl = isThumbnailCandidate(url);
        if (!cleanUrl || cleanUrl.startsWith('data:image/')) return cleanUrl;
        try {
            const resp = await fetch(cleanUrl, {
                credentials: 'include',
                cache: 'force-cache',
                referrer: location.href,
            });
            if (!resp.ok) return '';
            const type = resp.headers.get('content-type') || '';
            if (!type.startsWith('image/')) return '';
            const blob = await resp.blob();
            if (await isLowInformationImageBlob(blob)) {
                safeSendMessage({
                    action: 'debugLog',
                    level: 'warn',
                    scope: 'thumbnail.official',
                    message: 'Rejected low-information official thumbnail',
                    data: { candidate: thumbnailLogUrl(cleanUrl), page: location.href, ua: navigator.userAgent || '' },
                });
                return '';
            }
            return await blobToDataUrl(blob);
        } catch {
            return '';
        }
    }

    function collectOfficialThumbnailCandidates(primary = '', video = null) {
        const candidates = [];
        const push = (value) => {
            const clean = isThumbnailCandidate(value || '');
            if (clean && !candidates.includes(clean)) candidates.push(clean);
        };
        push(primary);
        push(getPageThumbnailCandidate());
        if (video instanceof HTMLVideoElement) {
            push(video.poster || video.getAttribute('poster') || '');
            push(findNearbyVideoThumbnail(video));
        }
        push(findLikelyPlayerThumbnail());
        return candidates;
    }

    async function resolveOfficialThumbnailForResponse(primary = '', video = null) {
        const candidates = collectOfficialThumbnailCandidates(primary, video);
        if (!candidates.length) return { thumbnail: '', rejectedPrimary: false };
        safeSendMessage({
            action: 'debugLog',
            level: 'info',
            scope: 'thumbnail.official',
            message: 'Official thumbnail validation queued',
            data: {
                primary: thumbnailLogUrl(primary || candidates[0]),
                count: candidates.length,
                page: location.href,
                ua: navigator.userAgent || '',
            },
        });
        for (const candidate of candidates) {
            const inlined = await fetchOfficialThumbnailAsDataUrl(candidate);
            if (!inlined || inlined === candidate) continue;
            safeSendMessage({
                action: 'debugLog',
                level: 'info',
                scope: 'thumbnail.official',
                message: 'Official thumbnail validated and inlined',
                data: { candidate: thumbnailLogUrl(candidate), page: location.href, ua: navigator.userAgent || '' },
            });
            return { thumbnail: inlined, rejectedPrimary: false };
        }
        return {
            thumbnail: '',
            rejectedPrimary: !!primary && isPlainChromeBrowser() && isChromeSensitiveThumbnailHost(primary),
        };
    }

    function getPageSnapshot({ type = '', sourceUrl = '' } = {}) {
        let thumbnail = '';
        let thumbnailKind = 'unknown';
        let rect = null;
        const pageTitleInfo = getCurrentPageTitleInfo({ sourceUrl, type });
        if (type === 'youtube') {
            const currentVideoId = extractYouTubeVideoId(location.href);
            const seed = getYouTubeNavigationSeed(currentVideoId);
            if (seed?.thumbnail) {
                thumbnail = seed.thumbnail;
                thumbnailKind = 'image';
            }
        }
        if (type === 'youtube' && isYouTubeShortsUrl()) {
            const video = getLargestVisibleVideo({ requireReady: false });
            if (video) {
                rect = rectPayloadForElement(video);
                thumbnail = thumbnail || isThumbnailCandidate(video.poster || video.getAttribute('poster') || '');
                if (thumbnail) thumbnailKind = 'image';
            }
        }
        if (type === 'hls') {
            thumbnail = getPageThumbnailCandidate();
            if (thumbnail) thumbnailKind = 'page-image';

            const matchedVideo = sourceUrl
                ? (findVideoBySourceUrl(sourceUrl, { requireReady: false }) || findVideoBySourceUrl(sourceUrl, { requireReady: true }))
                : null;
            const posterVideo = matchedVideo || getLargestVisibleVideo({ requireReady: false });
            if (posterVideo) {
                rect = rect || rectPayloadForElement(posterVideo);
            }
            if (!rect) {
                rect = rectPayloadForElement(findLikelyPlayerElement());
            }
            if (!thumbnail && posterVideo) {
                thumbnail = isThumbnailCandidate(posterVideo.poster || posterVideo.getAttribute('poster') || '') || findNearbyVideoThumbnail(posterVideo);
                if (thumbnail) thumbnailKind = 'poster-image';
            }
            if (!thumbnail) {
                const posterEl = findPosterLikeElement();
                rect = rect || rectPayloadForElement(posterEl);
                thumbnail = elementImageUrl(posterEl);
                if (thumbnail) thumbnailKind = 'poster-image';
            }
            if (!thumbnail) {
                thumbnail = findLikelyPlayerThumbnail();
                if (thumbnail) thumbnailKind = 'poster-image';
            }
        }
        if (!thumbnail && type !== 'youtube') {
            thumbnail = getPageThumbnailCandidate();
            if (thumbnail) thumbnailKind = 'image';
        }
        if (!thumbnail && type === 'youtube' && pageTitleInfo.title) {
            thumbnail = buildYouTubeThumbnailUrlForId(extractYouTubeVideoId(location.href), location.href);
            if (thumbnail) thumbnailKind = 'image';
        }
        return {
            pageTitle: pageTitleInfo.title,
            pageTitleSource: pageTitleInfo.source,
            thumbnail,
            thumbnailKind,
            rect,
        };
    }

    function findLikelyPlayerThumbnail() {
        const rootSelectors = [
            'video',
            '[class*="player"]',
            '[id*="player"]',
            '[class*="video"]',
            '[id*="video"]',
            '[class*="poster"]',
            '[class*="preview"]',
            '[class*="cover"]',
            '[class*="plyr"]',
            '[class*="jw"]',
            '[class*="vjs"]',
            '[class*="artplayer"]',
            '[class*="xgplayer"]',
            '[class*="dplayer"]',
        ];
        const candidateSelectors = [
            'img',
            '[poster]',
            '[data-poster]',
            '[data-thumbnail]',
            '[data-thumb]',
            '[data-preview]',
            '[data-image]',
            '[data-src]',
            '[data-background]',
            '[data-bg]',
            '[style*="background"]',
            '[class*="poster"]',
            '[class*="thumb"]',
            '[class*="preview"]',
            '[class*="cover"]',
        ];
        let bestUrl = '';
        let bestScore = -1;

        for (const root of document.querySelectorAll(rootSelectors.join(','))) {
            if (!(root instanceof Element) || !isVisibleElement(root)) continue;
            const rootRect = root.getBoundingClientRect();
            const rootArea = rootRect.width * rootRect.height;
            if (rootArea < 200 * 120) continue;

            const candidates = [root, ...root.querySelectorAll(candidateSelectors.join(','))];
            for (const candidate of candidates) {
                if (!(candidate instanceof Element) || !isVisibleElement(candidate)) continue;
                const url = elementImageUrl(candidate);
                if (!url) continue;

                const rect = candidate.getBoundingClientRect();
                const area = rect.width * rect.height;
                if (area < 120 * 68) continue;

                const left = Math.max(rootRect.left, rect.left);
                const right = Math.min(rootRect.right, rect.right);
                const top = Math.max(rootRect.top, rect.top);
                const bottom = Math.min(rootRect.bottom, rect.bottom);
                const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
                const classHint = /poster|thumb|thumbnail|preview|cover|player|video/i.test(
                    `${candidate.className || ''} ${candidate.id || ''} ${root.className || ''} ${root.id || ''}`
                ) ? 240 : 0;
                const score = overlap * 3 + Math.min(area, rootArea) + classHint;

                if (score > bestScore) {
                    bestScore = score;
                    bestUrl = url;
                }
            }
        }
        return bestUrl;
    }

    function findLikelyPlayerElement() {
        const rootSelectors = [
            'video',
            '[class*="player"]',
            '[id*="player"]',
            '[class*="video"]',
            '[id*="video"]',
            '[class*="poster"]',
            '[class*="preview"]',
            '[class*="cover"]',
            '[class*="plyr"]',
            '[class*="jw"]',
            '[class*="vjs"]',
            '[class*="artplayer"]',
            '[class*="xgplayer"]',
            '[class*="dplayer"]',
        ];
        const candidateSelectors = [
            'img',
            '[poster]',
            '[data-poster]',
            '[data-thumbnail]',
            '[data-thumb]',
            '[data-preview]',
            '[data-image]',
            '[data-src]',
            '[data-background]',
            '[data-bg]',
            '[style*="background"]',
            '[class*="poster"]',
            '[class*="thumb"]',
            '[class*="preview"]',
            '[class*="cover"]',
        ];
        let bestEl = null;
        let bestScore = -1;
        for (const root of document.querySelectorAll(rootSelectors.join(','))) {
            if (!(root instanceof Element) || !isVisibleElement(root)) continue;
            const rootRect = root.getBoundingClientRect();
            const rootArea = rootRect.width * rootRect.height;
            if (rootArea < 200 * 120) continue;

            const candidates = [root, ...root.querySelectorAll(candidateSelectors.join(','))];
            let bestCandidate = null;
            let bestCandidateScore = -1;

            for (const candidate of candidates) {
                if (!(candidate instanceof Element) || !isVisibleElement(candidate)) continue;
                const rect = candidate.getBoundingClientRect();
                const area = rect.width * rect.height;
                if (area < 120 * 68) continue;

                const left = Math.max(rootRect.left, rect.left);
                const right = Math.min(rootRect.right, rect.right);
                const top = Math.max(rootRect.top, rect.top);
                const bottom = Math.min(rootRect.bottom, rect.bottom);
                const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
                const imageHint = elementImageUrl(candidate) ? 320 : 0;
                const imgTagHint = candidate.tagName === 'IMG' ? 180 : 0;
                const classHint = /poster|thumb|thumbnail|preview|cover|player|video/i.test(
                    `${candidate.className || ''} ${candidate.id || ''} ${root.className || ''} ${root.id || ''}`
                ) ? 240 : 0;
                const score = overlap * 3 + Math.min(area, rootArea) + classHint + imageHint + imgTagHint;
                if (score > bestCandidateScore) {
                    bestCandidateScore = score;
                    bestCandidate = candidate;
                }
            }

            if (bestCandidate && bestCandidateScore > bestScore) {
                bestScore = bestCandidateScore;
                bestEl = bestCandidate;
            }
        }
        return bestEl;
    }

    function findNearbyVideoThumbnail(video) {
        if (!(video instanceof HTMLVideoElement)) return '';
        let node = video;
        for (let depth = 0; node && depth < 5; depth += 1) {
            if (node instanceof Element) {
                const candidates = [node, ...node.querySelectorAll('img, [poster], [data-poster], [data-thumbnail], [data-thumb], [data-preview], [data-image], [data-src], [data-background], [data-bg], [style*="background"], [class*="poster"], [class*="thumb"]')];
                for (const candidate of candidates) {
                    if (candidate === video || !(candidate instanceof Element)) continue;
                    const url = elementImageUrl(candidate);
                    if (url) return url;
                }
            }
            node = node.parentElement;
        }
        return '';
    }

    function getLargestVisibleVideo({ requireReady = false } = {}) {
        let best = null;
        let bestArea = 0;
        for (const video of document.querySelectorAll('video')) {
            if (!(video instanceof HTMLVideoElement) || !isVisibleElement(video)) continue;
            if (requireReady && video.readyState < 2) continue;
            const rect = video.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                best = video;
            }
        }
        return best;
    }

    function normalizeMediaUrlForMatch(url) {
        try {
            const parsed = new URL(url, location.href);
            parsed.hash = '';
            return parsed.href;
        } catch {
            return String(url || '');
        }
    }

    function findVideoBySourceUrl(sourceUrl, { requireReady = false } = {}) {
        const target = normalizeMediaUrlForMatch(sourceUrl);
        if (!target) return null;
        let best = null;
        let bestArea = 0;
        for (const video of document.querySelectorAll('video')) {
            if (!(video instanceof HTMLVideoElement)) continue;
            if (requireReady && video.readyState < 2) continue;
            const candidates = [
                video.currentSrc || '',
                video.src || '',
                ...Array.from(video.querySelectorAll('source')).map(source => source.src || source.getAttribute('src') || '')
            ].map(normalizeMediaUrlForMatch).filter(Boolean);
            if (!candidates.includes(target)) continue;
            if (!isVisibleElement(video)) continue;
            const rect = video.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                best = video;
            }
        }
        return best;
    }

    function rectPayloadForElement(el) {
        if (!(el instanceof Element) || !isVisibleElement(el)) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 45) return null;
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            dpr: window.devicePixelRatio || 1,
        };
    }

    function findPosterLikeElement() {
        const selectors = [
            '.plyr__poster',
            '.vjs-poster',
            '.jw-preview',
            '[class*="poster"]',
            '[class*="preview"]',
            '[class*="cover"]',
            'img'
        ];
        let best = null;
        let bestArea = 0;
        for (const el of document.querySelectorAll(selectors.join(','))) {
            if (!(el instanceof Element) || !isVisibleElement(el)) continue;
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                best = el;
            }
        }
        return best || findLikelyPlayerElement();
    }

    function scoreCanvasFrame(ctx, width, height) {
        try {
            const { data } = ctx.getImageData(0, 0, width, height);
            let count = 0;
            let sum = 0;
            let sumSq = 0;
            let min = 255;
            let max = 0;
            for (let y = 0; y < height; y += 6) {
                for (let x = 0; x < width; x += 6) {
                    const idx = ((y * width) + x) * 4;
                    const lum = Math.round((data[idx] * 0.299) + (data[idx + 1] * 0.587) + (data[idx + 2] * 0.114));
                    sum += lum;
                    sumSq += lum * lum;
                    if (lum < min) min = lum;
                    if (lum > max) max = lum;
                    count += 1;
                }
            }
            if (!count) return -Infinity;
            const mean = sum / count;
            const variance = Math.max(0, (sumSq / count) - (mean * mean));
            const range = max - min;
            let score = variance + (range * 3);
            if (mean < 28) score -= 600;
            else if (mean < 50) score -= 220;
            if (mean > 235) score -= 500;
            else if (mean > 220) score -= 180;
            if (range < 18) score -= 280;
            return score;
        } catch {
            return -Infinity;
        }
    }

    async function captureVideoFrame(video) {
        if (!(video instanceof HTMLVideoElement) || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
            return { dataUrl: '', score: -Infinity };
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 160;
            canvas.height = 90;
            const ctx = canvas.getContext('2d');
            if (!ctx) return { dataUrl: '', score: -Infinity };
            ctx.drawImage(video, 0, 0, 160, 90);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
            return dataUrl.startsWith('data:image/jpeg')
                ? { dataUrl, score: scoreCanvasFrame(ctx, 160, 90) }
                : { dataUrl: '', score: -Infinity };
        } catch {
            return { dataUrl: '', score: -Infinity };
        }
    }

    function isUsableFrameCandidate(candidate) {
        return !!candidate && !!candidate.dataUrl && Number.isFinite(candidate.score) && candidate.score >= 60;
    }

    // 확장 컨텍스트 유효성 체크 — 업데이트/재로드 후 기존 content script 에러 방지
    function isContextValid() {
        try { return !!chrome.runtime?.id; } catch { return false; }
    }
    function safeSendMessage(msg) {
        if (!isContextValid()) return Promise.resolve();
        return chrome.runtime.sendMessage(msg).catch(() => {});
    }

    function mediaInfoFromDetail(detail = {}) {
        const info = {};
        if (detail.mediaKey) info.mediaKey = String(detail.mediaKey);
        if (Number.isFinite(Number(detail.mediaIndex))) info.mediaIndex = Number(detail.mediaIndex);
        if (Array.isArray(detail.sourceUrls)) {
            info.sourceUrls = detail.sourceUrls.map(url => absolutizeUrl(url || '')).filter(Boolean);
        }
        if (detail.detectedOrigin) info.detectedOrigin = String(detail.detectedOrigin);
        return info;
    }

    window.addEventListener('__medianab_page_context_changed__', (e) => {
        safeSendMessage({
            action: 'pageContextChanged',
            tabUrl: e.detail?.tabUrl || location.href,
            reason: e.detail?.reason || 'content',
        });
    });
    // ── MAIN → background: 영상 감지 ──
    window.addEventListener('__medianab_detected__', (e) => {
        safeSendMessage({
            action: 'videoDetected',
            url: e.detail.url,
            type: e.detail.type,
            pageTitle: e.detail.pageTitle,
            titleSource: e.detail.titleSource || e.detail.pageTitleSource || '',
            thumbnail: e.detail.thumbnail || '',
            thumbnailKind: e.detail.thumbnailKind || 'unknown',
            previewUrl: e.detail.previewUrl || '',
            qualities: e.detail.qualities || null,
            isLive: e.detail.isLive,
            tabUrl: e.detail.tabUrl || location.href,
            ...mediaInfoFromDetail(e.detail || {})
        });
    });

    window.addEventListener(LOG_EVENT, (e) => {
        const d = e.detail || {};
        safeSendMessage({
            action: 'debugLog',
            level: d.level || 'info',
            scope: d.scope || 'content',
            message: d.message || '',
            data: d.data || {},
        });
    });

    // ── MAIN → background: 화질 목록 업데이트 (webRequest 감지 후 content.js 파싱 완료) ──
    window.addEventListener('__medianab_update_qualities__', (e) => {
        safeSendMessage({
            action: 'updateQualities',
            url: e.detail.url,
            qualities: e.detail.qualities,
            thumbnail: e.detail.thumbnail || '',
            thumbnailKind: e.detail.thumbnailKind || 'unknown',
            previewUrl: e.detail.previewUrl || '',
            pageTitle: e.detail.pageTitle || '',
            titleSource: e.detail.titleSource || e.detail.pageTitleSource || '',
            isLive: e.detail.isLive,
            tabUrl: e.detail.tabUrl || location.href,
            ...mediaInfoFromDetail(e.detail || {})
        });
    });

    // ── MAIN → background: 비디오 메타 (썸네일, 시간) ──
    window.addEventListener('__medianab_video_meta__', (e) => {
        safeSendMessage({
            action: 'videoMeta',
            thumbnail: e.detail.thumbnail,
            thumbnailKind: e.detail.thumbnailKind || 'unknown',
            duration: e.detail.duration,
            sourceUrl: e.detail.sourceUrl || '',
            sourceType: e.detail.sourceType || '',
            previewUrl: e.detail.previewUrl || '',
            previewKind: e.detail.previewKind || '',
            pageTitle: e.detail.pageTitle,
            titleSource: e.detail.titleSource || e.detail.pageTitleSource || '',
            tabUrl: e.detail.tabUrl || location.href,
            ...mediaInfoFromDetail(e.detail || {})
        });
    });

    // ── MAIN → background: 청크 릴레이 ──
    // ★ ArrayBuffer → Uint8Array → 일반 배열 변환 필수 (JSON 직렬화 가능)
    window.addEventListener(DL_EVENTS.chunk, (e) => {
        const { taskId, buf, index, total } = e.detail;
        if (!isContextValid()) return;
        enqueueDownloadBridgeJob(async () => {
            const bytes = Array.from(new Uint8Array(buf));
            const response = await safeSendMessage({ action: 'relayChunk', taskId, bytes, index, total });
            if (response?.ok === false) {
                window.dispatchEvent(new CustomEvent(DL_EVENTS.status, {
                    detail: {
                        taskId,
                        status: 'error',
                        error: response.error || 'Chunk relay failed',
                    }
                }));
            }
        });
    });

    // ── MAIN → background: 모든 청크 완료 ──
    window.addEventListener(DL_EVENTS.allChunksSent, (e) => {
        enqueueDownloadBridgeJob(async () => {
            const response = await safeSendMessage({
                action: 'allChunksSent',
                taskId: e.detail.taskId,
                fileName: e.detail.fileName,
                containerExt: e.detail.containerExt || 'ts'
            });
            if (response?.ok === false) {
                window.dispatchEvent(new CustomEvent(DL_EVENTS.status, {
                    detail: {
                        taskId: e.detail.taskId,
                        status: 'error',
                        error: response.error || 'Finalize failed',
                    }
                }));
            }
        });
    });

    // ── MAIN → background: 진행률 ──
    window.addEventListener(DL_EVENTS.progress, (e) => {
        safeSendMessage({
            action: 'downloadProgress',
            taskId: e.detail.taskId,
            percent: e.detail.percent,
            speed: e.detail.speed || '',
            eta: e.detail.eta || ''
        });
    });

    // ── MAIN → background: 상태 (error/cancelled) ──
    window.addEventListener(DL_EVENTS.status, (e) => {
        safeSendMessage({
            action: 'downloadStatus',
            taskId: e.detail.taskId,
            status: e.detail.status,
            error: e.detail.error
        });
    });

    window.addEventListener(LIVE_EVENTS.chunk, (e) => {
        const { taskId, buf, index, total } = e.detail;
        if (!isContextValid()) return;
        enqueueDownloadBridgeJob(async () => {
            const bytes = Array.from(new Uint8Array(buf));
            const response = await safeSendMessage({ action: 'relayChunk', taskId, bytes, index, total });
            if (response?.ok === false) {
                window.dispatchEvent(new CustomEvent(LIVE_EVENTS.status, {
                    detail: {
                        taskId,
                        status: 'error',
                        error: response.error || 'Live chunk relay failed',
                    }
                }));
            }
        });
    });

    window.addEventListener(LIVE_EVENTS.finish, (e) => {
        enqueueDownloadBridgeJob(async () => {
            const response = await safeSendMessage({
                action: 'allChunksSent',
                taskId: e.detail.taskId,
                fileName: e.detail.fileName,
                containerExt: e.detail.containerExt || 'ts'
            });
            if (response?.ok === false) {
                window.dispatchEvent(new CustomEvent(LIVE_EVENTS.status, {
                    detail: {
                        taskId: e.detail.taskId,
                        status: 'error',
                        error: response.error || 'Live finalize failed',
                    }
                }));
            }
        });
    });

    window.addEventListener(LIVE_EVENTS.progress, (e) => {
        safeSendMessage({
            action: 'liveRecordProgress',
            taskId: e.detail.taskId,
            status: e.detail.status || 'recording',
            elapsedSec: e.detail.elapsedSec || 0,
            filesize: e.detail.filesize || 0,
            speed: e.detail.speed || '',
        });
    });

    window.addEventListener(LIVE_EVENTS.status, (e) => {
        safeSendMessage({
            action: 'liveRecordStatus',
            taskId: e.detail.taskId,
            status: e.detail.status,
            error: e.detail.error,
        });
    });

    // ── background → MAIN: 다운로드 시작 명령 ──
    if (!isContextValid()) return;
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!isContextValid()) return false;
        // ── background → MAIN: 다운로드 시작 명령 ──
        if (msg.action === 'startDownloadInPage') {
            window.dispatchEvent(new CustomEvent(DL_EVENTS.download, {
                detail: {
                    taskId: msg.taskId,
                    m3u8Url: msg.url,
                    fileName: msg.fileName,
                    kind: 'hls'
                }
            }));
            sendResponse({ status: 'started' });
            return false;
        }

        if (msg.action === 'startDirectDownloadInPage') {
            window.dispatchEvent(new CustomEvent(DL_EVENTS.download, {
                detail: {
                    taskId: msg.taskId,
                    mediaUrl: msg.url,
                    fileName: msg.fileName,
                    containerExt: msg.containerExt || 'mp4',
                    kind: 'direct'
                }
            }));
            sendResponse({ status: 'started' });
            return false;
        }

        if (msg.action === 'downloadControl') {
            window.dispatchEvent(new CustomEvent(DL_EVENTS.downloadControl, {
                detail: {
                    taskId: msg.taskId,
                    status: msg.status || '',
                    error: msg.error || '',
                }
            }));
            sendResponse({ ok: true });
            return false;
        }

        if (msg.action === 'startLiveRecordInPage') {
            window.dispatchEvent(new CustomEvent(LIVE_EVENTS.start, {
                detail: {
                    taskId: msg.taskId,
                    m3u8Url: msg.url,
                    fileName: msg.fileName,
                    recordMode: msg.recordMode || 'now',
                    qualityLabel: msg.qualityLabel || '',
                    qualityResolution: msg.qualityResolution || '',
                    qualityBandwidth: Number(msg.qualityBandwidth || 0)
                }
            }));
            sendResponse({ status: 'started' });
            return false;
        }

        if (msg.action === 'liveRecordControl') {
            window.dispatchEvent(new CustomEvent(LIVE_EVENTS.control, {
                detail: {
                    taskId: msg.taskId,
                    status: msg.status || '',
                    error: msg.error || '',
                }
            }));
            sendResponse({ ok: true });
            return false;
        }

        // ── background → ISOLATED world: 썸네일 즉시 반환 ──
        if (msg.action === 'requestThumbnail') {
            (async () => {
                const type = msg.type || '';
                const sourceUrl = msg.sourceUrl || '';
                const snapshot = getPageSnapshot({ type, sourceUrl });
                let thumbnail = snapshot.thumbnail || '';
                let thumbnailKind = snapshot.thumbnailKind || 'unknown';
                let rect = snapshot.rect || null;
                const matchedVideo = sourceUrl
                    ? (findVideoBySourceUrl(sourceUrl, { requireReady: false }) || findVideoBySourceUrl(sourceUrl, { requireReady: true }))
                    : null;

                if (!thumbnail) {
                    try {
                        const video = matchedVideo || getLargestVisibleVideo({ requireReady: false }) || document.querySelector('video');
                        rect = rect || rectPayloadForElement(video);
                        thumbnail = isThumbnailCandidate(video?.poster || video?.getAttribute?.('poster') || '');
                        if (thumbnail) {
                            thumbnailKind = type === 'hls' ? 'poster-image' : 'image';
                        }
                    } catch {}
                }

                if (!thumbnail && type !== 'hls') {
                    try {
                        const video = findVideoBySourceUrl(sourceUrl, { requireReady: true }) || matchedVideo || getLargestVisibleVideo({ requireReady: true }) || document.querySelector('video');
                        if (video) {
                            const candidate = await captureVideoFrame(video);
                            if (isUsableFrameCandidate(candidate)) {
                                thumbnail = candidate.dataUrl;
                                thumbnailKind = 'frame';
                            }
                        }
                    } catch {}
                }

                if (type === 'hls' && thumbnail && !isPlainChromeBrowser()) {
                    const resolved = await resolveOfficialThumbnailForResponse(thumbnail, matchedVideo);
                    if (resolved.thumbnail) {
                        thumbnail = resolved.thumbnail;
                        thumbnailKind = 'page-image';
                    } else if (resolved.rejectedPrimary) {
                        thumbnail = '';
                        thumbnailKind = 'unknown';
                    }
                }

                const fallbackTitle = snapshot.pageTitle
                    ? { title: snapshot.pageTitle, source: snapshot.pageTitleSource || 'unknown' }
                    : getCurrentPageTitleInfo({ sourceUrl, type });
                sendResponse({
                    thumbnail,
                    thumbnailKind,
                    rect,
                    pageTitle: fallbackTitle.title,
                    pageTitleSource: fallbackTitle.source
                });
            })();
            return true;
        }

        if (msg.action === 'requestPageSnapshot') {
            sendResponse(getPageSnapshot({ type: msg.type || '', sourceUrl: msg.sourceUrl || '' }));
            return false;
        }

        // ── background → MAIN: m3u8 파싱 요청 (qualities + thumbnail) ──
        if (msg.action === 'fetchMetadata') {
            window.dispatchEvent(new CustomEvent('__medianab_fetch_metadata__', {
                detail: { url: msg.url, tabUrl: location.href }
            }));
            sendResponse({ ok: true });
            return false;
        }

        if (msg.action === 'fetchPreviewResourceInPage') {
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            let settled = false;
            let timer = 0;
            const finish = (payload) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                window.removeEventListener(PREVIEW_EVENTS.fetchResourceResult, onResult);
                sendResponse(payload);
            };
            const onResult = (event) => {
                const detail = event.detail || {};
                if (detail.requestId !== requestId) return;
                finish({
                    ok: !!detail.ok,
                    status: Number(detail.status || 0),
                    error: detail.error || '',
                    text: detail.text || '',
                    bytes: Array.isArray(detail.bytes) ? detail.bytes : [],
                    url: detail.url || msg.url || ''
                });
            };

            window.addEventListener(PREVIEW_EVENTS.fetchResourceResult, onResult);
            timer = setTimeout(() => {
                finish({
                    ok: false,
                    status: 0,
                    error: 'preview-page-fetch-timeout',
                    text: '',
                    bytes: [],
                    url: msg.url || ''
                });
            }, 20000);

            window.dispatchEvent(new CustomEvent(PREVIEW_EVENTS.fetchResource, {
                detail: {
                    requestId,
                    url: msg.url,
                    responseType: msg.responseType || 'text',
                    byterange: msg.byterange || null
                }
            }));
            return true;
        }

        return false;
    });

})();
