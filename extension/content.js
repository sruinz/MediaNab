// content.js — MAIN world
// 역할:
//   1. fetch/XHR 인터셉션 → m3u8 URL 감지
//   2. <video> 요소 모니터링 → 썸네일, 재생시간, 현재 src 캡처
//   3. HLS 세그먼트 fetch 대행 (다운로드 시)

(function () {
    'use strict';

    // ── URL 정규화 (쿼리 제거, 해시 제거) → 중복 방지용 키 ──
    function normalizeGoogleVideoManifestKey(url) {
        try {
            const raw = String(url || '');
            const absolute = /^[a-z][a-z\d+.-]*:/i.test(raw)
                ? raw
                : (/^(?:www\.)?manifest\.googlevideo\.com\//i.test(raw) ? `https://${raw}` : raw);
            const u = new URL(absolute, location.href);
            if (u.hostname !== 'manifest.googlevideo.com') return '';
            const typeMatch = raw.match(/\/hls_(variant|playlist)(?:\/|$)/i) || u.pathname.match(/\/hls_(variant|playlist)(?:\/|$)/i);
            const idMatch = raw.match(/\/id\/([^/?#]+)/i) || u.pathname.match(/\/id\/([^/?#]+)/i);
            const itagMatch = raw.match(/\/itag\/([^/?#]+)/i) || u.pathname.match(/\/itag\/([^/?#]+)/i);
            const type = typeMatch ? `hls_${typeMatch[1].toLowerCase()}` : 'hls';
            const videoId = idMatch?.[1] || u.searchParams.get('id') || '';
            const itag = itagMatch?.[1] || u.searchParams.get('itag') || '';
            return `${u.origin}/api/manifest/${type}${videoId ? `/id/${videoId}` : ''}${itag ? `/itag/${itag}` : ''}`;
        } catch {
            return '';
        }
    }

    function normalizeUrl(url) {
        try {
            const googleVideoKey = normalizeGoogleVideoManifestKey(url);
            if (googleVideoKey) return googleVideoKey;
            const u = new URL(url);
            if (u.hostname.includes('youtube.com')) {
                if (u.pathname === '/watch') {
                    return `${u.origin}${u.pathname}?v=${u.searchParams.get('v') || ''}`;
                }
                if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/')) {
                    return `${u.origin}${u.pathname}`;
                }
            }
            return u.origin + u.pathname; // 쿼리/해시 제거
        } catch { return url; }
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

    function currentPageMediaIdentityKey() {
        try {
            const u = new URL(location.href);
            u.hash = '';
            return `${u.origin}${u.pathname}${u.search || ''}`;
        } catch {
            return String(location.href || '').split('#')[0] || '';
        }
    }

    const _videoMediaIdentity = new WeakMap();
    let _videoMediaIdentitySeq = 0;

    function collectVideoSourceUrls(video) {
        const candidates = [
            video?.currentSrc || '',
            video?.src || '',
            ...Array.from(video?.querySelectorAll?.('source') || []).map(source => source.src || source.getAttribute('src') || '')
        ];
        return Array.from(new Set(candidates
            .map(src => absolutizeUrl(src || ''))
            .filter(src => src && !src.startsWith('blob:') && !src.startsWith('data:') && isVideoUrl(src))));
    }

    function getVideoMediaIdentity(video) {
        if (!(video instanceof HTMLVideoElement)) return null;
        const pageKey = currentPageMediaIdentityKey();
        const domIndex = Array.from(document.querySelectorAll('video')).indexOf(video);
        let identity = _videoMediaIdentity.get(video);
        if (!identity || identity.pageKey !== pageKey) {
            const mediaIndex = domIndex >= 0 ? domIndex : _videoMediaIdentitySeq++;
            identity = {
                pageKey,
                mediaIndex,
                mediaKey: `${pageKey}#video:${mediaIndex}`
            };
            _videoMediaIdentity.set(video, identity);
        }
        return {
            mediaKey: identity.mediaKey,
            mediaIndex: identity.mediaIndex,
            sourceUrls: collectVideoSourceUrls(video),
            detectedOrigin: 'dom'
        };
    }

    function serializeMediaInfo(mediaInfo = null) {
        if (!mediaInfo || typeof mediaInfo !== 'object') return {};
        const out = {};
        if (mediaInfo.mediaKey) out.mediaKey = String(mediaInfo.mediaKey);
        if (Number.isFinite(Number(mediaInfo.mediaIndex))) out.mediaIndex = Number(mediaInfo.mediaIndex);
        if (Array.isArray(mediaInfo.sourceUrls)) {
            out.sourceUrls = Array.from(new Set(mediaInfo.sourceUrls.map(url => absolutizeUrl(url || '')).filter(Boolean)));
        }
        if (mediaInfo.detectedOrigin) out.detectedOrigin = String(mediaInfo.detectedOrigin);
        return out;
    }

    function medianabLog(level, scope, message, data = {}) {
        try {
            window.dispatchEvent(new CustomEvent('__medianab_debug_log_v1__', {
                detail: { level, scope, message, data }
            }));
        } catch {}
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

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result || '');
            reader.onerror = () => reject(reader.error || new Error('Failed to convert blob to data url'));
            reader.readAsDataURL(blob);
        });
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

    function elementImageUrl(el) {
        if (!(el instanceof Element)) return '';
        const tag = el.tagName;
        if (tag === 'IMG') {
            return sanitizeThumbnailUrl(el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src') || firstSrcFromSrcset(el.getAttribute('srcset') || ''));
        }
        const attrs = [
            'poster', 'data-poster', 'data-thumbnail', 'data-thumb', 'data-preview',
            'data-image', 'data-src', 'data-background', 'data-bg', 'content'
        ];
        for (const attr of attrs) {
            const value = sanitizeThumbnailUrl(el.getAttribute(attr) || '');
            if (value) return value;
        }
        const bg = sanitizeThumbnailUrl(extractCssUrl(getComputedStyle(el).backgroundImage || '') || extractCssUrl(el.style?.backgroundImage || ''));
        if (bg) return bg;
        return '';
    }

    function rectOverlapArea(a, b) {
        const left = Math.max(a.left, b.left);
        const right = Math.min(a.right, b.right);
        const top = Math.max(a.top, b.top);
        const bottom = Math.min(a.bottom, b.bottom);
        return Math.max(0, right - left) * Math.max(0, bottom - top);
    }

    function bestThumbnailNearVideo(video) {
        if (!(video instanceof HTMLVideoElement)) return '';

        const roots = [];
        let node = video;
        for (let depth = 0; node && depth < 5; depth += 1) {
            if (node instanceof Element) roots.push(node);
            node = node.parentElement;
        }

        const videoRect = video.getBoundingClientRect();
        for (const root of roots) {
            const rootRect = root.getBoundingClientRect();
            const candidates = [root, ...root.querySelectorAll('img, canvas, [poster], [data-poster], [data-thumbnail], [data-thumb], [data-preview], [data-image], [data-src], [data-background], [data-bg], [style*="background"], [class*="poster"], [class*="thumb"]')];
            let bestUrl = '';
            let bestScore = -1;

            for (const candidate of candidates) {
                if (candidate === video || !(candidate instanceof Element) || !isVisibleElement(candidate)) continue;
                const url = elementImageUrl(candidate);
                if (!url) continue;

                const rect = candidate.getBoundingClientRect();
                const overlap = rectOverlapArea(rect, videoRect);
                const rootOverlap = rectOverlapArea(rect, rootRect);
                const area = rect.width * rect.height;
                const classHint = /poster|thumb|thumbnail|preview/i.test(candidate.className || '') ? 120 : 0;
                const score = overlap * 4 + rootOverlap + Math.min(area, rootRect.width * rootRect.height) + classHint;

                if (score > bestScore) {
                    bestScore = score;
                    bestUrl = url;
                }
            }

            if (bestUrl) return bestUrl;
        }

        return '';
    }

    function findNearbyThumbnailForVideo(video) {
        return bestThumbnailNearVideo(video);
    }

    function bestLikelyPlayerThumbnail() {
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

                const overlap = rectOverlapArea(rect, rootRect);
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

    function isM3U8(url) {
        return /\.m3u8(\?|#|$)/i.test(url) ||
               /\/(playlist|master|index)\.m3u8/i.test(url) ||
               url.includes('/hls/');
    }
    function isDirectVideo(url) {
        return /\.(mp4|webm|flv|m4v|mkv)(\?|#|$)/i.test(url);
    }
    function isTsSegment(url) {
        return /\.(ts|aac|fmp4|m4s)(\?|#|$)/i.test(url) || /\/seg[-_]\d+/i.test(url);
    }
    function isSubPlaylist(url) {
        return /\/\d{3,4}p\//i.test(url);
    }
    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        if (isTsSegment(url)) return false; // TS 세그먼트 제외
        return isM3U8(url) || isDirectVideo(url);
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
        let haystack = value.toLowerCase();
        try {
            const parsed = new URL(value, location.href);
            haystack = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
        } catch {}
        return /(?:placeholder|no[-_]?image|blank|transparent|spacer|spinner|loading|grey|gray|default[-_]?poster|default[-_]?thumb|plyr\.svg|player\.svg|poster\.svg)/i.test(haystack);
    }

    function sanitizeThumbnailUrl(url) {
        if (isBadThumbnailValue(url)) return '';
        const absolute = absolutizeUrl(url);
        if (isBadThumbnailValue(absolute)) return '';
        if (isLikelyPlaceholderThumbnailUrl(absolute)) return '';
        if (absolute.startsWith('data:image/')) return absolute;
        if (isVideoUrl(absolute)) return '';
        return absolute;
    }

    function sanitizePreviewUrl(url) {
        const absolute = absolutizeUrl(url);
        if (!absolute) return '';
        if (absolute.startsWith('data:video/')) return absolute;
        if (isTsSegment(absolute) || isM3U8(absolute)) return '';
        return isDirectVideo(absolute) ? absolute : '';
    }

    function isYouTubeHostName(hostname = '') {
        const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
        return host === 'youtube.com' ||
            host.endsWith('.youtube.com') ||
            host === 'youtube-nocookie.com' ||
            host.endsWith('.youtube-nocookie.com') ||
            host === 'youtu.be';
    }

    function isYouTubeWatchPage(url = location.href) {
        try {
            const u = new URL(url, location.href);
            if (u.hostname === 'youtu.be') return !!u.pathname.split('/').filter(Boolean)[0];
            if (!isYouTubeHostName(u.hostname)) return false;
            return (
                (u.pathname === '/watch' && u.searchParams.has('v')) ||
                u.pathname.startsWith('/shorts/') ||
                u.pathname.startsWith('/live/') ||
                u.pathname.startsWith('/embed/') ||
                u.pathname.startsWith('/v/')
            );
        } catch {}
        return false;
    }

    function extractYouTubeVideoId(url = location.href) {
        try {
            const u = new URL(url, location.href);
            if (u.hostname === 'youtu.be') return u.pathname.split('/').filter(Boolean)[0] || '';
            if (!isYouTubeHostName(u.hostname)) return '';
            if (u.pathname === '/watch') return u.searchParams.get('v') || '';
            if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/')) {
                return u.pathname.split('/').filter(Boolean)[1] || '';
            }
            if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/v/')) {
                return u.pathname.split('/').filter(Boolean)[1] || '';
            }
        } catch {}
        return '';
    }

    function isYouTubeShortsUrl(url = location.href) {
        try {
            const u = new URL(url, location.href);
            return u.hostname.includes('youtube.com') && u.pathname.startsWith('/shorts/');
        } catch {}
        return false;
    }

    function extractYouTubeThumbnailVideoId(url = '') {
        try {
            const u = new URL(url, location.href);
            if (!/ytimg\.com$/i.test(u.hostname) && !u.hostname.includes('ytimg.com')) return '';
            const parts = u.pathname.split('/').filter(Boolean);
            const viIndex = parts.findIndex(part => part === 'vi' || part === 'vi_webp');
            return viIndex >= 0 ? (parts[viIndex + 1] || '') : '';
        } catch {}
        return '';
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
    let _youtubeLastCapturedSeedSignature = '';
    let _youtubeLastSeedSignature = '';

    function buildYouTubeThumbnailUrlForId(videoId = '', pageUrl = location.href) {
        if (!videoId) return '';
        return isYouTubeShortsUrl(pageUrl)
            ? `https://i.ytimg.com/vi/${videoId}/oardefault.jpg`
            : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }

    function canonicalYouTubePageUrl(videoId = '', url = location.href) {
        if (!videoId) return '';
        try {
            const current = new URL(url, location.href);
            if (
                extractYouTubeVideoId(current.href) === videoId &&
                (
                    current.hostname === 'youtu.be' ||
                    current.pathname === '/watch' ||
                    current.pathname.startsWith('/shorts/') ||
                    current.pathname.startsWith('/live/')
                )
            ) {
                return current.href;
            }
        } catch {}
        return `https://www.youtube.com/watch?v=${videoId}`;
    }

    function canonicalExternalYouTubePageUrl(videoId = '') {
        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
    }

    function normalizeYouTubeSeedThumbnail(videoId = '', thumbnail = '', pageUrl = location.href) {
        const clean = sanitizeThumbnailUrl(thumbnail || '');
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
        let bestTitle = '';
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
                    if (score > bestScore || (score === bestScore && value.length > bestTitle.length)) {
                        bestScore = score;
                        bestTitle = value;
                    }
                }
            }
        }
        return bestTitle;
    }

    function extractYouTubeSeedThumbnail(root, videoId = '', pageUrl = location.href) {
        const nodes = [];
        if (root instanceof Element) {
            nodes.push(...Array.from(root.querySelectorAll('#thumbnail img, ytd-thumbnail img, yt-image img, img, [data-thumb], [data-thumbnail], [data-src], [style*="background"]')).slice(0, 80));
        }
        let best = '';
        let bestScore = -Infinity;
        for (const node of nodes) {
            if (!(node instanceof Element)) continue;
            const thumb = sanitizeThumbnailUrl(elementImageUrl(node) || '');
            if (!thumb) continue;
            const thumbId = extractYouTubeThumbnailVideoId(thumb);
            if (thumbId && videoId && thumbId !== videoId) continue;
            const rect = node.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            const hint = node.closest('#thumbnail, ytd-thumbnail') ? 10000 : 0;
            const score = area + hint + (thumbId === videoId ? 5000 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = thumb;
            }
        }
        return normalizeYouTubeSeedThumbnail(videoId, best, pageUrl);
    }

    function storeYouTubeNavigationSeed(seed = {}, reason = '') {
        const videoId = String(seed.videoId || '').trim();
        const pageUrl = canonicalYouTubePageUrl(videoId, seed.pageUrl || location.href);
        const title = cleanPageTitleCandidate(seed.title || '');
        if (!videoId || !title) return null;
        const thumbnail = normalizeYouTubeSeedThumbnail(videoId, seed.thumbnail || '', pageUrl);
        if (!thumbnail) return null;
        const normalized = { videoId, pageUrl, title, thumbnail, ts: Date.now(), reason };
        const signature = `${videoId}|${title}|${thumbnail}`;
        const shouldLog = signature !== _youtubeLastCapturedSeedSignature;
        _youtubeLastCapturedSeedSignature = signature;
        _youtubeNavigationSeeds.set(videoId, normalized);
        if (shouldLog) {
            medianabLog('info', 'youtube.navigation', 'YouTube navigation seed captured', {
                videoId,
                title,
                hasThumbnail: !!thumbnail,
                reason,
            });
        }
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

    function captureYouTubeNavigationSeedFromLink(link, reason = 'interaction') {
        if (!(link instanceof HTMLAnchorElement)) return null;
        const href = link.href || link.getAttribute('href') || '';
        const videoId = extractYouTubeVideoId(href);
        if (!videoId) return null;
        const root = link.closest(YOUTUBE_RENDERER_SELECTOR) || link;
        const pageUrl = canonicalYouTubePageUrl(videoId, href);
        const title = extractYouTubeSeedTitle(root, link);
        if (!title) return null;
        const thumbnail = extractYouTubeSeedThumbnail(root, videoId, pageUrl);
        return storeYouTubeNavigationSeed({ videoId, pageUrl, title, thumbnail }, reason);
    }

    function rememberYouTubeNavigationSeedFromEvent(event) {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        let link = path.find(node => node instanceof HTMLAnchorElement && node.href);
        if (!link && event.target instanceof Element) {
            link = event.target.closest('a[href*="/watch"], a[href*="/shorts/"], a[href*="/live/"], a[href*="youtu.be/"]');
        }
        captureYouTubeNavigationSeedFromLink(link, event.type || 'interaction');
    }

    ['pointerdown', 'mousedown', 'click'].forEach(eventName => {
        document.addEventListener(eventName, rememberYouTubeNavigationSeedFromEvent, true);
    });

    function parsePlayerResponseCandidate(value) {
        if (!value) return null;
        if (typeof value === 'object') return value;
        if (typeof value === 'string') {
            try {
                return JSON.parse(value);
            } catch {}
        }
        return null;
    }

    function getYouTubePlayerResponse() {
        const candidates = [
            window.ytInitialPlayerResponse,
            window.ytplayer?.config?.args?.raw_player_response,
            window.ytplayer?.config?.args?.player_response,
            window.ytcfg?.data_?.PLAYER_VARS?.player_response,
        ];
        for (const candidate of candidates) {
            const parsed = parsePlayerResponseCandidate(candidate);
            if (parsed?.videoDetails || parsed?.streamingData) return parsed;
        }
        return null;
    }

    function extractDirectYoutubeStreamUrl(format) {
        const directUrl = absolutizeUrl(format?.url || '');
        if (directUrl) return directUrl;
        const cipher = String(format?.signatureCipher || format?.cipher || '');
        if (!cipher) return '';
        try {
            const params = new URLSearchParams(cipher);
            const baseUrl = absolutizeUrl(params.get('url') || '');
            if (!baseUrl) return '';
            const sig = params.get('sig') || params.get('signature') || '';
            const sp = params.get('sp') || 'signature';
            if (!sig) return '';
            const resolved = new URL(baseUrl);
            resolved.searchParams.set(sp, sig);
            return resolved.href;
        } catch {}
        return '';
    }

    function parseYoutubeMimeInfo(mimeType = '') {
        const value = String(mimeType || '').toLowerCase();
        const match = value.match(/^([^;]+)/);
        const mime = match ? match[1] : '';
        const ext = mime.includes('/') ? mime.split('/')[1] : '';
        return { mime, ext };
    }

    function normalizeYoutubeQualityLabel(height = 0, fps = 0) {
        if (!height) return '';
        return `${height}p${fps > 45 ? '60' : ''}`;
    }

    function getBestYoutubeAudioFormat(adaptiveFormats = []) {
        const audioFormats = adaptiveFormats
            .map((format) => {
                const url = extractDirectYoutubeStreamUrl(format);
                if (!url) return null;
                const mimeInfo = parseYoutubeMimeInfo(format?.mimeType || '');
                const hasAudio = (format?.audioQuality || '').length || mimeInfo.mime.startsWith('audio/');
                const hasVideo = !!(format?.height || format?.width || '').toString().length || mimeInfo.mime.startsWith('video/');
                if (!hasAudio || hasVideo) return null;
                return {
                    url,
                    ext: mimeInfo.ext || 'm4a',
                    bitrate: Number(format?.bitrate || format?.averageBitrate || format?.audioSampleRate || 0),
                    score: mimeInfo.ext === 'mp4' || mimeInfo.ext === 'm4a' ? 2 : 1,
                };
            })
            .filter(Boolean);

        audioFormats.sort((a, b) => (b.score - a.score) || (b.bitrate - a.bitrate));
        return audioFormats[0] || null;
    }

    function buildYouTubeDirectQualities(playerResponse) {
        const streaming = playerResponse?.streamingData || {};
        const formats = Array.isArray(streaming?.formats) ? streaming.formats : [];
        const adaptiveFormats = Array.isArray(streaming?.adaptiveFormats) ? streaming.adaptiveFormats : [];
        const bestAudio = getBestYoutubeAudioFormat(adaptiveFormats);
        const qualityMap = new Map();

        const registerQuality = (quality) => {
            if (!quality?.url || !quality?.label) return;
            const existing = qualityMap.get(quality.label);
            const score = Number(quality.height || 0) * 10 + Number(quality.fps || 0) + (quality.audioUrl ? 100000 : 0);
            if (!existing || score >= existing._score) {
                qualityMap.set(quality.label, { ...quality, _score: score });
            }
        };

        for (const format of formats) {
            const url = extractDirectYoutubeStreamUrl(format);
            const height = Number(format?.height || 0);
            const fps = Number(format?.fps || 0);
            const label = normalizeYoutubeQualityLabel(height, fps);
            if (!url || !label) continue;
            const mimeInfo = parseYoutubeMimeInfo(format?.mimeType || '');
            registerQuality({
                label,
                resolution: (format?.width && format?.height) ? `${format.width}x${format.height}` : '',
                url,
                ext: mimeInfo.ext || 'mp4',
                height,
                fps,
                source: 'youtube-page-direct',
            });
        }

        if (bestAudio) {
            for (const format of adaptiveFormats) {
                const url = extractDirectYoutubeStreamUrl(format);
                const height = Number(format?.height || 0);
                const fps = Number(format?.fps || 0);
                const mimeInfo = parseYoutubeMimeInfo(format?.mimeType || '');
                const hasVideo = height > 0 || mimeInfo.mime.startsWith('video/');
                const hasAudio = !!(format?.audioQuality || '').length || mimeInfo.mime.startsWith('audio/');
                const label = normalizeYoutubeQualityLabel(height, fps);
                if (!url || !label || !hasVideo || hasAudio) continue;
                registerQuality({
                    label,
                    resolution: (format?.width && format?.height) ? `${format.width}x${format.height}` : '',
                    url,
                    audioUrl: bestAudio.url,
                    ext: mimeInfo.ext || 'mp4',
                    audioExt: bestAudio.ext || 'm4a',
                    height,
                    fps,
                    source: 'youtube-page-merged',
                });
            }
        }

        return [...qualityMap.values()]
            .sort((a, b) => (Number(b.height || 0) - Number(a.height || 0)) || (Number(b.fps || 0) - Number(a.fps || 0)))
            .map(({ _score, ...quality }) => quality);
    }

    function getYouTubePageThumbnail(playerResponse) {
        const thumbs =
            playerResponse?.videoDetails?.thumbnail?.thumbnails ||
            playerResponse?.microformat?.playerMicroformatRenderer?.thumbnail?.thumbnails ||
            [];
        const best = [...thumbs]
            .filter(Boolean)
            .sort((a, b) => (Number(b.width || 0) * Number(b.height || 0)) - (Number(a.width || 0) * Number(a.height || 0)))[0];
        return sanitizeThumbnailUrl(best?.url || '');
    }

    function normalizePageTitleText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .trim();
    }

    function hostLabelFromLocation() {
        try {
            const host = location.hostname.replace(/^www\./i, '');
            return host.split('.').slice(0, -1).join(' ') || host.split('.')[0] || '';
        } catch {
            return '';
        }
    }

    function cleanPageTitleCandidate(value) {
        let text = normalizePageTitleText(value);
        if (!text || text.length < 3) return '';
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
        text = text
            .replace(/\s*[-|]\s*(YouTube|YouTube Shorts|TikTok|Instagram|Facebook|Twitter|X)$/i, '')
            .trim();
        text = text
            .replace(/^(?:\s*[\[［【][^\]］】]{1,20}[\]］】]\s*)+/u, '')
            .replace(/^(?:\s*\((?:[^)]{1,12})\)\s*)+/u, '')
            .replace(/^[^\p{L}\p{N}]+/u, '')
            .trim();
        text = text
            .replace(/\s*(?:\d{4}[./_-]\d{1,2}[./_-]\d{1,2}(?:\s*(?:AM|PM|오전|오후))?(?:\s+\d{1,2}[:._]\d{2}(?::\d{2})?)?)\s*$/iu, '')
            .replace(/\s*\(\d{1,4}\)\s*$/u, '')
            .replace(/\s*(?:\d{4}[./_-]\d{1,2}[./_-]\d{1,2}(?:\s*(?:AM|PM|오전|오후))?(?:\s+\d{1,2}[:._]\d{2}(?::\d{2})?)?)\s*$/iu, '')
            .trim();
        if (!text || text.length < 3) return '';
        const lower = text.toLowerCase();
        const hostLabel = normalizePageTitleText(hostLabelFromLocation()).toLowerCase();
        if (hostLabel && (lower === hostLabel || lower === `${hostLabel}.com`)) return '';
        if (/^(youtube|shorts|facebook|instagram|tiktok|twitter|x)$/i.test(text)) return '';
        if (/^(시청 기록|기록|watch history|history)$/i.test(text)) return '';
        if (/^category[_\s-]*\d+$/i.test(text)) return '';
        if (/(^|\s)(function\s+\w+\s*\(|window\.open\(|adsbygoogle|googlesyndication|return false|javascript:)/i.test(text)) return '';
        if (/(돌아가기|아래로|위로|목록|댓글|복사|추천|공유)(\s+(돌아가기|아래로|위로|목록|댓글|복사|추천|공유))+/.test(text)) return '';
        return text;
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

    function splitPageTitleVariants(value) {
        const text = normalizePageTitleText(value);
        if (!text) return [];
        const variants = new Set();
        const separators = [/\s+\|\s+/g, /\s+-\s+/g, /\s+::\s+/g, /\s+»\s+/g, /\s+\/\s+/g];
        for (const separator of separators) {
            const parts = text.split(separator).map(part => normalizePageTitleText(part)).filter(Boolean);
            if (parts.length > 1) {
                parts.forEach(part => variants.add(part));
            }
        }
        variants.add(text);
        return Array.from(variants);
    }

    function scorePageTitleCandidate(text, source = '', node = null, depth = 0) {
        if (!text) return -10000;
        let score = Math.min(text.length, 80);
        if (text.length < 6) score -= 25;
        if (text.length > 110) score -= 10;
        if (/\s/.test(text)) score += 12;
        if (/[가-힣]/.test(text)) score += 10;
        if (/[0-9]/.test(text)) score += 4;
        if (/[[\]【】「」『』()]/.test(text)) score += 18;
        if (source === 'document') score += 30;
        if (source === 'meta') score += 22;
        if (source === 'heading') score += 28;
        if (/^(category|video|mp4|download|file)$/i.test(text)) score -= 90;
        if (/^category[_\s-]*\d+$/i.test(text)) score -= 120;
        if (/(카테고리|게시판|커뮤니티|블로그|갤러리|forum|community|board|gallery|category)/i.test(text)) score -= 24;

        if (node instanceof Element) {
            const hint = `${node.tagName || ''} ${node.id || ''} ${node.className || ''}`.toLowerCase();
            if (/entry|post|article|subject|title|view|write|read|headline|content/.test(hint)) score += 24;
            if (/comment|reply|footer|header|nav|menu|sidebar|side|profile|avatar|nick|member|user|author|point|level|breadcrumb|cate|category|popular|rank|widget/.test(hint)) score -= 80;
            if (node.closest('article, main, [role="main"], .article, .post, .view, .write, .read, .board, .content, .entry')) score += 18;
            if (node.closest('header, nav, aside, footer, .comment, .reply, .sidebar, .side, .menu, .profile, .member, .user, .author, .breadcrumb, .cate, .category, .popular, .rank, .widget')) score -= 90;
        }

        score -= depth * 6;
        return score;
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
        const values = [];
        if (!(node instanceof Element)) return values;
        const dataTitle = node.getAttribute('data-title') || '';
        const titleAttr = node.getAttribute('title') || '';
        if (dataTitle) values.push(dataTitle);
        if (titleAttr) values.push(titleAttr);
        values.push(node.textContent || '');
        return values;
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
                const dedupeKey = value.toLowerCase();
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                return value;
            }
            return '';
        };

        const metaSelectors = [
            'meta[property="og:title"]',
            'meta[name="twitter:title"]',
            'meta[property="twitter:title"]',
            'meta[itemprop="headline"]',
            'meta[name="title"]'
        ];
        for (const selector of metaSelectors) {
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

    function getBestPageTitleInfo() {
        if (isYouTubeWatchPage()) {
            return getCurrentYouTubePageTitleInfo();
        }
        return getDocumentTitleInfo();
    }

    function getBestPageTitle() {
        const info = getBestPageTitleInfo();
        return info.title || normalizePageTitleText(document.title) || 'video';
    }

    const DETECTED = new Set();
    const INLINE_THUMBNAIL_INFLIGHT = new Set();

    // ── og:image / twitter:image 메타태그에서 썸네일 추출 ──
    function getPageThumbnailCandidates() {
        const selectors = [
            'meta[property="og:video:image"]',
            'meta[property="og:image"]',
            'meta[name="twitter:image"]',
            'meta[name="thumbnail"]',
            'meta[itemprop="image"]',
            'link[rel="image_src"]'
        ];
        const candidates = [];
        const seen = new Set();
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const src = sanitizeThumbnailUrl(el?.getAttribute('content') || el?.getAttribute('src') || el?.getAttribute('href') || '');
                if (!src || seen.has(src)) continue;
                seen.add(src);
                candidates.push(src);
            }
        }
        return candidates;
    }

    function getPageThumbnail() {
        return getPageThumbnailCandidates()[0] || '';
    }

    function getOfficialThumbnailCandidates(video = null) {
        const candidates = [];
        const push = (value) => {
            const clean = sanitizeThumbnailUrl(value || '');
            if (clean && !candidates.includes(clean)) candidates.push(clean);
        };
        getPageThumbnailCandidates().forEach(push);
        if (video instanceof HTMLVideoElement) {
            push(video.poster || video.getAttribute('poster') || '');
            push(findNearbyThumbnailForVideo(video));
        }
        push(bestLikelyPlayerThumbnail());
        return candidates;
    }

    function getOfficialHlsThumbnail(video = null) {
        return getOfficialThumbnailCandidates(video)[0] || '';
    }

    function getCurrentYouTubeMetaTitle() {
        if (!isYouTubeWatchPage()) return '';
        const currentVideoId = extractYouTubeVideoId(location.href);
        const pageUrls = [
            document.querySelector('meta[property="og:url"]')?.content || '',
            document.querySelector('meta[name="twitter:url"]')?.content || '',
            document.querySelector('link[rel="canonical"]')?.href || '',
        ].filter(Boolean);
        const hasMatchingUrl = pageUrls.some(url => {
            const videoId = extractYouTubeVideoId(url);
            return currentVideoId && videoId && videoId === currentVideoId;
        });
        if (currentVideoId && pageUrls.length && !hasMatchingUrl) return '';

        const title = cleanPageTitleCandidate(
            document.querySelector('meta[property="og:title"]')?.content ||
            document.querySelector('meta[name="twitter:title"]')?.content ||
            document.querySelector('meta[name="title"]')?.content ||
            ''
        );
        return title && !/^youtube$/i.test(title) ? title : '';
    }

    function isVisibleTextElement(el) {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
            return false;
        }
        return Array.from(el.getClientRects()).some(rect => rect.width >= 24 && rect.height >= 6);
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
                best = video;
                bestArea = area;
            }
        }
        return best;
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
        if (!isYouTubeShortsUrl()) return '';
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
        let bestValue = '';
        let bestScore = -Infinity;

        for (const node of Array.from(root.querySelectorAll(selectors.join(','))).slice(0, 50)) {
            if (!(node instanceof Element) || !isVisibleTextElement(node)) continue;
            const values = [
                node.getAttribute('title') || '',
                node.textContent || '',
            ];
            for (const raw of values) {
                for (const line of String(raw || '').split(/[\n\r]+/u)) {
                    const value = cleanPageTitleCandidate(line);
                    if (!value || value.length < 3 || value.length > 110) continue;
                    const key = value.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const rect = node.getBoundingClientRect();
                    const score = scorePageTitleCandidate(value, 'heading', node, 0) +
                        (rect.top > window.innerHeight * 0.45 ? 24 : 0) +
                        (node.matches('h1,h2,#video-title,[class*="title"]') ? 18 : 0);
                    if (score > bestScore || (score === bestScore && value.length > bestValue.length)) {
                        bestScore = score;
                        bestValue = value;
                    }
                }
            }
        }
        return bestValue;
    }

    function getCurrentYouTubeDomTitle() {
        if (!isYouTubeWatchPage()) return '';
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
        const selectors = [
            '#video-title',
            '#title',
            'h1 yt-formatted-string',
            'h1',
            '[role="heading"]',
            '[title]',
            ...(isYouTubeShortsUrl() ? [] : ['[aria-label]']),
        ];
        const seen = new Set();
        let bestValue = '';
        let bestScore = -Infinity;
        const skipTitle = /^(youtube|shorts|구독|좋아요|싫어요|댓글|공유|리믹스|저장|더보기|재생|일시중지)$/i;

        const consider = (node, rootIndex) => {
            if (!(node instanceof Element) || !isVisibleTextElement(node)) return;
            const rawValues = [
                node.getAttribute('title') || '',
                node.getAttribute('aria-label') || '',
                node.textContent || '',
            ];
            for (const raw of rawValues) {
                const value = cleanPageTitleCandidate(raw);
                if (!value || value.length < 4 || value.length > 150 || skipTitle.test(value)) continue;
                if (/(조회수|댓글|공유|리믹스|구독|좋아요|싫어요|views?|comments?|share|subscribe)/i.test(value) && value.length < 32) continue;
                const key = value.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                const score = scorePageTitleCandidate(value, 'heading', node, rootIndex) + Math.max(0, 30 - rootIndex * 4);
                if (score > bestScore || (score === bestScore && value.length > bestValue.length)) {
                    bestScore = score;
                    bestValue = value;
                }
            }
        };

        roots.slice(0, 5).forEach((root, rootIndex) => {
            if (!(root instanceof Element)) return;
            Array.from(root.querySelectorAll(selectors.join(','))).slice(0, 40).forEach(node => consider(node, rootIndex));
        });
        return bestValue;
    }

    function getCurrentYouTubePageTitleInfo() {
        if (!isYouTubeWatchPage()) return { title: '', source: '' };
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

    function getCurrentYouTubePageTitleFallback() {
        return getCurrentYouTubePageTitleInfo().title || '';
    }

    // ── MP4 전용: 프리뷰/광고/샘플 URL 키워드 필터 (HLS는 적용 안 함) ──
    const PREVIEW_KEYWORDS = /\b(preview|trailer|sample|teaser|promo|snippet|thumb_?vid|preroll|midroll|postroll)\b/i;
    const AD_PATH_PATTERNS = /\/(ads?|advert|banner|commercials?|sponsor)\//i;
    function isPreviewUrl(url) {
        return PREVIEW_KEYWORDS.test(url) || AD_PATH_PATTERNS.test(url);
    }
    const MP4_THUMB_PROBING = new Set();
    const AUX_PREVIEW_PROBING = new Set();
    const VIDEO_CLIP_PROBING = new WeakSet();
    const HIDDEN_HLS_PREVIEW_PROBING = new Set();
    const HIDDEN_HLS_PREVIEW_READY = new Set();
    const HIDDEN_HLS_PREVIEW_ATTEMPTS = new Map();
    const HIDDEN_HLS_VISIBLE_FALLBACK = new WeakSet();
    const HLS_DOWNLOAD_CONTROL = new Map();
    const LIVE_RECORD_CONTROL = new Map();
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
    const PAGE_IDENTITY_TOKENS = Array.from(new Set(
        location.pathname
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(token => token.length >= 4)
    ));

    function matchesPageIdentity(value) {
        const haystack = String(value || '').toLowerCase();
        if (!haystack || !PAGE_IDENTITY_TOKENS.length) return false;
        return PAGE_IDENTITY_TOKENS.some(token => haystack.includes(token));
    }

    function previewSignalScore(url, node = null) {
        if (!url || !isDirectVideo(url) || isTsSegment(url)) return -1;
        let score = 0;
        if (isPreviewUrl(url)) score += 500;
        if (/\bpreview\b/i.test(url)) score += 160;
        if (/\b(sample|trailer|teaser|promo|snippet)\b/i.test(url)) score += 120;
        if (matchesPageIdentity(url)) score += 360;
        else if (PAGE_IDENTITY_TOKENS.length) score -= 900;
        if (node instanceof Element) {
            const hintText = `${node.id || ''} ${node.className || ''} ${node.getAttribute?.('data-preview') || ''} ${node.getAttribute?.('aria-label') || ''}`;
            if (/preview|sample|trailer|teaser|promo/i.test(hintText)) score += 260;
            if (/hidden|side/i.test(hintText)) score += 80;
            if (matchesPageIdentity(hintText)) score += 240;
            if (!isVisibleElement(node)) score -= 180;
            if (node.tagName === 'VIDEO') score += 40;
        }
        return score > 0 ? score : -1;
    }

    function hasVisibleHlsContext(exceptVideo = null) {
        return Array.from(document.querySelectorAll('video')).some((video) => {
            if (!(video instanceof HTMLVideoElement) || video === exceptVideo) return false;
            if (!isVisibleElement(video)) return false;
            const src = String(video.currentSrc || video.src || '');
            if (src.startsWith('blob:') && video.videoWidth > 0 && video.readyState >= 2) return true;
            const { sourceType } = classifyVideoSource(video);
            return sourceType === 'hls';
        });
    }

    function isLikelyAuxiliaryMp4(video, src) {
        if (!(video instanceof HTMLVideoElement)) return false;
        const cleanSrc = sanitizePreviewUrl(src);
        if (!cleanSrc) return false;
        if (!hasVisibleHlsContext(video)) return false;

        const duration = Number(video.duration || 0);
        const visible = isVisibleElement(video);
        const hintText = [
            video.id || '',
            video.className || '',
            video.getAttribute?.('data-preview') || '',
            video.getAttribute?.('data-video') || '',
            video.getAttribute?.('aria-label') || '',
            video.parentElement?.className || '',
            video.parentElement?.id || ''
        ].join(' ').toLowerCase();

        let score = 0;
        if (!visible) score += 3;
        if (duration > 0 && duration <= 20) score += 4;
        if (isPreviewUrl(cleanSrc)) score += 3;
        if (!matchesPageIdentity(cleanSrc)) score += 2;
        if (/preview|sample|trailer|teaser|promo|advert|ad-|banner|preroll|midroll|postroll/i.test(hintText)) score += 3;
        try {
            if (new URL(cleanSrc).hostname !== location.hostname) score += 1;
        } catch {}

        return score >= 6;
    }

    function findAuxPreviewVideoUrl() {
        let bestUrl = '';
        let bestScore = -1;
        const selectors = [
            'video',
            'source',
            'a[href]',
            '[data-preview]',
            '[data-video]',
            '[data-src]',
            '[src]'
        ];
        for (const node of document.querySelectorAll(selectors.join(','))) {
            if (!(node instanceof Element)) continue;
            const candidates = [];
            if (node instanceof HTMLVideoElement) {
                candidates.push(node.currentSrc || node.src || '');
                node.querySelectorAll('source').forEach((source) => candidates.push(source.src || source.getAttribute('src') || ''));
            } else if (node.tagName === 'SOURCE') {
                candidates.push(node.src || node.getAttribute('src') || '');
            } else {
                candidates.push(
                    node.getAttribute('href') || '',
                    node.getAttribute('src') || '',
                    node.getAttribute('data-preview') || '',
                    node.getAttribute('data-video') || '',
                    node.getAttribute('data-src') || ''
                );
            }
            for (const raw of candidates) {
                const candidate = sanitizePreviewUrl(raw);
                const score = previewSignalScore(candidate, node);
                if (score > bestScore) {
                    bestScore = score;
                    bestUrl = candidate;
                }
            }
        }
        return bestScore > 0 ? bestUrl : '';
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

    function captureVideoFrame(video) {
        if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 160;
            canvas.height = 90;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(video, 0, 0, 160, 90);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
            if (!dataUrl.startsWith('data:image/jpeg')) return null;
            return {
                dataUrl,
                score: scoreCanvasFrame(ctx, 160, 90)
            };
        } catch {
            return null;
        }
    }

    function isUsableFrameCandidate(candidate) {
        return !!candidate && Number.isFinite(candidate.score) && candidate.score >= 60;
    }

    function buildPreviewSampleTimes(duration) {
        const maxTime = Number(duration || 0);
        if (!Number.isFinite(maxTime) || maxTime <= 0.2) return [0.8, 1.6, 2.6];
        const raw = [
            0.6,
            1.1,
            1.8,
            2.8,
            maxTime * 0.08,
            maxTime * 0.16,
            maxTime * 0.28,
            maxTime * 0.42
        ];
        const clamped = raw
            .map((time) => Math.max(0.12, Math.min(maxTime - 0.08, time)))
            .filter((time) => Number.isFinite(time) && time > 0.1);
        return Array.from(new Set(clamped.map((time) => time.toFixed(2)))).map(Number);
    }

    async function probeMp4Thumbnail(url) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            let done = false;
            let timeoutId = 0;

            const finish = (thumbnail = '') => {
                if (done) return;
                done = true;
                if (timeoutId) clearTimeout(timeoutId);
                video.onloadedmetadata = null;
                video.onloadeddata = null;
                video.onseeked = null;
                video.onerror = null;
                try {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                    video.remove();
                } catch {}
                resolve(thumbnail || '');
            };

            const sampleTimes = (times) => {
                const queue = [...times];
                let best = null;

                const captureCurrentFrame = () => {
                    const candidate = captureVideoFrame(video);
                    if (!isUsableFrameCandidate(candidate)) return;
                    if (!best || candidate.score > best.score) {
                        best = candidate;
                    }
                };

                const next = () => {
                    if (done) return;
                    if (!queue.length) {
                        finish(best?.dataUrl || '');
                        return;
                    }
                    const nextTime = queue.shift();
                    video.onseeked = () => {
                        video.onseeked = null;
                        captureCurrentFrame();
                        next();
                    };
                    try {
                        if (Math.abs((video.currentTime || 0) - nextTime) < 0.05) {
                            video.onseeked = null;
                            captureCurrentFrame();
                            next();
                            return;
                        }
                        video.currentTime = nextTime;
                    } catch {
                        video.onseeked = null;
                        next();
                    }
                };

                captureCurrentFrame();
                next();
            };

            const startSampling = () => {
                const times = buildPreviewSampleTimes(video.duration);
                if (!times.length) {
                    const candidate = captureVideoFrame(video);
                    finish(isUsableFrameCandidate(candidate) ? candidate.dataUrl : '');
                    return;
                }
                sampleTimes(times);
            };

            video.preload = 'metadata';
            video.muted = true;
            video.playsInline = true;
            video.crossOrigin = 'anonymous';

            video.onloadedmetadata = () => {
                if (done) return;
                if (video.readyState >= 2) {
                    startSampling();
                    return;
                }
                video.onloadeddata = () => {
                    video.onloadeddata = null;
                    startSampling();
                };
            };
            video.onerror = () => finish('');
            timeoutId = setTimeout(() => finish(''), 8000);

            try {
                video.src = url;
                video.load();
            } catch {
                finish('');
            }
        });
    }

    function pickPreviewRecorderMimeType() {
        const candidates = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm'
        ];
        for (const mime of candidates) {
            try {
                if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(mime)) {
                    return mime;
                }
            } catch {}
        }
        return '';
    }

    async function probeVideoPreviewClip(video) {
        if (!(video instanceof HTMLVideoElement)) return '';
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
        if (typeof MediaRecorder === 'undefined') return '';
        if (typeof HTMLCanvasElement === 'undefined') return '';

        const mimeType = pickPreviewRecorderMimeType();
        if (!mimeType) return '';

        return new Promise((resolve) => {
            const frameRate = 12;
            const frameIntervalMs = Math.round(1000 / frameRate);
            const recordDurationMs = 1650;
            const originalPlaybackRate = Number(video.playbackRate || 1) || 1;
            const canvas = document.createElement('canvas');
            canvas.width = 160;
            canvas.height = 90;
            const ctx = canvas.getContext('2d');
            if (!ctx || typeof canvas.captureStream !== 'function') {
                resolve('');
                return;
            }
            ctx.imageSmoothingEnabled = true;

            let recorder;
            const stream = canvas.captureStream(frameRate);
            const chunks = [];
            let drawTimer = 0;
            let stopped = false;
            let drawnFrames = 0;

            const cleanup = () => {
                if (drawTimer) clearInterval(drawTimer);
                try { stream.getTracks().forEach(track => track.stop()); } catch {}
                try { video.playbackRate = originalPlaybackRate; } catch {}
            };

            const draw = () => {
                if (stopped) return;
                try {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                } catch {}
                drawnFrames += 1;
            };

            try {
                recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 420000 });
            } catch {
                resolve('');
                return;
            }

            recorder.ondataavailable = (event) => {
                if (event.data?.size) chunks.push(event.data);
            };

            recorder.onerror = () => {
                stopped = true;
                cleanup();
                resolve('');
            };

            recorder.onstop = async () => {
                stopped = true;
                cleanup();
                try {
                    if (!chunks.length) {
                        resolve('');
                        return;
                    }
                    const blob = new Blob(chunks, { type: mimeType });
                    if (blob.size < 1024 || drawnFrames < 6) {
                        resolve('');
                        return;
                    }
                    const dataUrl = await blobToDataUrl(blob);
                    resolve(typeof dataUrl === 'string' && dataUrl.startsWith('data:video/') ? dataUrl : '');
                } catch {
                    resolve('');
                }
            };

            draw();
            drawTimer = setInterval(draw, frameIntervalMs);
            try {
                video.playbackRate = Math.min(1.45, Math.max(1, originalPlaybackRate * 1.22));
                recorder.start(300);
            } catch {
                stopped = true;
                cleanup();
                resolve('');
                return;
            }
            setTimeout(() => {
                try {
                    if (recorder.state !== 'inactive') recorder.stop();
                } catch {}
            }, recordDurationMs);
        });
    }

    function waitForPreviewMoment(video, targetTime = 2.2, timeoutMs = 4500) {
        return new Promise((resolve) => {
            if (!(video instanceof HTMLVideoElement)) {
                resolve();
                return;
            }
            if (video.currentTime >= targetTime || video.paused || video.ended) {
                resolve();
                return;
            }

            let settled = false;
            let timer = 0;
            const finish = () => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                video.removeEventListener('timeupdate', onTimeUpdate);
                video.removeEventListener('seeked', onTimeUpdate);
                resolve();
            };
            const onTimeUpdate = () => {
                if (video.currentTime >= targetTime || video.paused || video.ended) {
                    finish();
                }
            };

            video.addEventListener('timeupdate', onTimeUpdate);
            video.addEventListener('seeked', onTimeUpdate);
            timer = setTimeout(finish, timeoutMs);
        });
    }

    function getRepresentativeVideoTime(video) {
        const duration = Number(video?.duration || 0);
        if (!Number.isFinite(duration) || duration <= 0) return 0;
        if (duration <= 30) return Math.max(1.2, Math.min(duration - 0.4, duration * 0.35));
        return Math.max(2.5, Math.min(duration - 0.8, duration * 0.55));
    }

    function waitForSeek(video, targetTime, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            if (!(video instanceof HTMLVideoElement) || !Number.isFinite(targetTime)) {
                reject(new Error('invalid-video'));
                return;
            }

            let settled = false;
            let timer = 0;
            const finish = (err = null) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                video.removeEventListener('seeked', onSeeked);
                video.removeEventListener('error', onError);
                if (err) reject(err);
                else resolve();
            };
            const onSeeked = () => finish();
            const onError = () => finish(new Error('seek-error'));

            video.addEventListener('seeked', onSeeked);
            video.addEventListener('error', onError);
            timer = setTimeout(() => finish(new Error('seek-timeout')), timeoutMs);

            try {
                if (Math.abs((video.currentTime || 0) - targetTime) < 0.05) {
                    finish();
                    return;
                }
                video.currentTime = targetTime;
            } catch (err) {
                finish(err instanceof Error ? err : new Error('seek-failed'));
            }
        });
    }

    function getPageHlsConstructor() {
        const candidates = [
            window.Hls,
            window.hlsjs?.Hls,
            window.HlsJs?.Hls,
            window.p2pml?.hlsjs?.Hls,
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'function') return candidate;
        }
        return null;
    }

    function createHiddenPreviewVideo() {
        const host = document.createElement('div');
        host.style.cssText = [
            'position:fixed',
            'left:-10000px',
            'top:0',
            'width:320px',
            'height:180px',
            'opacity:0',
            'pointer-events:none',
            'z-index:-1',
            'overflow:hidden',
            'contain:layout style paint',
        ].join(';');

        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
        video.style.cssText = 'width:320px;height:180px;object-fit:cover;background:#000;';
        host.appendChild(video);

        (document.documentElement || document.body || document.head).appendChild(host);
        return { host, video };
    }

    async function attachHiddenHlsSource(video, manifestUrl) {
        const absoluteUrl = absolutizeUrl(manifestUrl);
        if (!absoluteUrl || !isM3U8(absoluteUrl) || !(video instanceof HTMLVideoElement)) {
            return { ok: false, hls: null };
        }

        const HlsCtor = getPageHlsConstructor();
        let hls = null;

        const ok = await new Promise((resolve) => {
            let settled = false;
            let timer = 0;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                video.removeEventListener('loadeddata', onReady);
                video.removeEventListener('canplay', onReady);
                video.removeEventListener('playing', onReady);
                video.removeEventListener('error', onError);
                resolve(Boolean(value));
            };

            const onReady = () => {
                if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
                    finish(true);
                }
            };
            const onError = () => finish(false);

            video.addEventListener('loadeddata', onReady);
            video.addEventListener('canplay', onReady);
            video.addEventListener('playing', onReady);
            video.addEventListener('error', onError);
            timer = setTimeout(() => finish(video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0), 12000);

            if (HlsCtor && (typeof HlsCtor.isSupported !== 'function' || HlsCtor.isSupported())) {
                try {
                    hls = new HlsCtor({
                        autoStartLoad: true,
                        enableWorker: true,
                        lowLatencyMode: false,
                        startPosition: -1,
                    });
                    const events = HlsCtor.Events || {};
                    if (events.ERROR) {
                        hls.on(events.ERROR, (_evt, data) => {
                            if (data?.fatal) finish(false);
                        });
                    }
                    if (events.MEDIA_ATTACHED) {
                        hls.on(events.MEDIA_ATTACHED, () => {
                            try {
                                hls.loadSource(absoluteUrl);
                            } catch {
                                finish(false);
                            }
                        });
                    } else {
                        try {
                            hls.loadSource(absoluteUrl);
                        } catch {
                            finish(false);
                        }
                    }
                    hls.attachMedia(video);
                    return;
                } catch {
                    try { hls?.destroy?.(); } catch {}
                    hls = null;
                }
            }

            try {
                video.src = absoluteUrl;
                video.load();
            } catch {
                finish(false);
            }
        });

        return { ok, hls };
    }

    async function probeHiddenRepresentativeHlsAssets(video) {
        if (!(video instanceof HTMLVideoElement)) return { thumbnail: '', previewUrl: '' };
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return { thumbnail: '', previewUrl: '' };

        const duration = Number(video.duration || 0);
        const targetTime = getRepresentativeVideoTime(video);
        let thumbnail = '';
        let previewUrl = '';

        try {
            video.muted = true;
            try { video.pause(); } catch {}

            if (targetTime > 0.05 && Number.isFinite(duration) && duration > targetTime) {
                await waitForSeek(video, targetTime);
            }

            const frame = captureVideoFrame(video);
            if (frame?.dataUrl) thumbnail = frame.dataUrl;

            try { await video.play(); } catch {}
            const previewMoment = Number.isFinite(duration) && duration > 0
                ? Math.min(targetTime + 0.7, Math.max(duration - 0.08, targetTime))
                : targetTime + 0.7;
            await waitForPreviewMoment(video, previewMoment, 1600);
            previewUrl = await probeVideoPreviewClip(video);
        } catch {}

        try { video.pause(); } catch {}
        return { thumbnail, previewUrl };
    }

    async function probeHiddenHlsPreview(manifestUrl) {
        const absoluteUrl = absolutizeUrl(manifestUrl);
        if (!absoluteUrl || !isM3U8(absoluteUrl)) return false;

        const { host, video } = createHiddenPreviewVideo();
        let hls = null;
        try {
            const attachment = await attachHiddenHlsSource(video, absoluteUrl);
            hls = attachment.hls;
            if (!attachment.ok) return false;

            const { thumbnail, previewUrl } = await probeHiddenRepresentativeHlsAssets(video);
            if (!thumbnail && !previewUrl) return false;

            HIDDEN_HLS_PREVIEW_READY.add(absoluteUrl);
            window.dispatchEvent(new CustomEvent('__medianab_video_meta__', {
                detail: {
                    thumbnail,
                    thumbnailKind: thumbnail ? 'frame' : 'unknown',
                    duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
                    sourceUrl: absoluteUrl,
                    sourceType: 'hls',
                    previewUrl,
                    previewKind: 'hidden-video'
                }
            }));
            return true;
        } catch {}
        finally {
            try { hls?.destroy?.(); } catch {}
            try {
                video.pause();
                video.removeAttribute('src');
                video.load();
            } catch {}
            try { host.remove(); } catch {}
        }
        return false;
    }

    function hasPendingHiddenHlsPreview() {
        return HIDDEN_HLS_PREVIEW_PROBING.size > 0;
    }

    function maybeProbeHiddenHlsPreview(manifestUrl) {
        if (!manifestUrl) return;
        // Hidden HLS probing caused visible thumbnail churn while offscreen preview was running.
        // Keep HLS preview generation on the dedicated offscreen path only.
    }

    async function probeRepresentativeHlsAssets(video) {
        if (!(video instanceof HTMLVideoElement)) return { thumbnail: '', previewUrl: '' };
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return { thumbnail: '', previewUrl: '' };

        const duration = Number(video.duration || 0);
        const targetTime = getRepresentativeVideoTime(video);
        const previousTime = Number(video.currentTime || 0);
        const wasPaused = video.paused;
        const wasMuted = video.muted;

        let thumbnail = '';
        let previewUrl = '';

        try {
            video.muted = true;
            try { video.pause(); } catch {}

            if (targetTime > 0.05 && Number.isFinite(duration) && duration > targetTime) {
                await waitForSeek(video, targetTime);
                await waitForPreviewMoment(video, targetTime, 1200);
            }

            const frame = captureVideoFrame(video);
            if (frame?.dataUrl) thumbnail = frame.dataUrl;
            previewUrl = await probeVideoPreviewClip(video);
        } catch {}

        try {
            if (previousTime >= 0 && Number.isFinite(previousTime)) {
                await waitForSeek(video, Math.min(previousTime, Math.max(duration - 0.05, 0)));
            }
        } catch {}

        video.muted = wasMuted;
        if (!wasPaused) {
            try { await video.play(); } catch {}
        }

        return { thumbnail, previewUrl };
    }

    function maybeProbeVideoPreview(_video, sourceType, _sourceUrl = '') {
        if (sourceType !== 'hls') return;
        // Do not seek/play the user-visible HLS player just to capture an early preview.
    }

    function resolveExplicitTitleInfo(pageTitle = '', titleSource = 'unknown') {
        return titleInfo(pageTitle, titleSource || 'unknown');
    }

    function emitDetectedUpdate(url, qualities = null, thumbnail = '', thumbnailKind = 'unknown', previewUrl = '', pageTitle = '', tabUrl = location.href, titleSource = '', mediaInfo = null, options = {}) {
        if (!qualities && !thumbnail && !previewUrl && !pageTitle) return;
        const cleanThumb = sanitizeThumbnailUrl(thumbnail);
        const cleanPreview = sanitizePreviewUrl(previewUrl);
        const resolvedTitle = resolveExplicitTitleInfo(pageTitle, titleSource);
        const liveState = typeof options?.isLive === 'boolean' ? options.isLive : undefined;
        window.dispatchEvent(new CustomEvent('__medianab_update_qualities__', {
            detail: {
                url,
                qualities,
                thumbnail: cleanThumb,
                thumbnailKind,
                previewUrl: cleanPreview,
                pageTitle: resolvedTitle.title,
                titleSource: resolvedTitle.source,
                tabUrl,
                isLive: liveState,
                ...serializeMediaInfo(mediaInfo)
            }
        }));
        maybeInlineThumbnail(url, cleanThumb);
    }

    function maybeProbeMp4Thumbnail(url, key, mediaInfo = null) {
        if (MP4_THUMB_PROBING.has(key)) return;
        MP4_THUMB_PROBING.add(key);
        probeMp4Thumbnail(url).then((thumb) => {
            if (!thumb) return;
            emitDetectedUpdate(url, null, thumb, 'frame', '', '', location.href, '', mediaInfo);
        }).finally(() => {
            MP4_THUMB_PROBING.delete(key);
        });
    }

    function maybeProbeAuxPreview(url, previewUrl) {
        const cleanPreview = sanitizePreviewUrl(previewUrl);
        if (!cleanPreview || !isDirectVideo(cleanPreview) || isTsSegment(cleanPreview)) return;
        const taskKey = `${normalizeUrl(url)}|${cleanPreview}`;
        if (AUX_PREVIEW_PROBING.has(taskKey)) return;
        AUX_PREVIEW_PROBING.add(taskKey);
        probeMp4Thumbnail(cleanPreview).then((thumb) => {
            emitDetectedUpdate(url, null, thumb, thumb ? 'frame' : 'unknown', cleanPreview);
        }).finally(() => {
            AUX_PREVIEW_PROBING.delete(taskKey);
        });
    }

    function emitDetected(url, type, qualities = null, thumbnail = '', thumbnailKind = 'unknown', previewUrl = '', pageTitle = '', tabUrl = location.href, titleSource = '', mediaInfo = null, options = {}) {
        // MP4 타입만 프리뷰 필터 적용 (HLS는 절대 건드리지 않음)
        if (type !== 'hls' && isPreviewUrl(url)) return;
        const key = normalizeUrl(url);
        const isYouTubeEntry = type === 'youtube' || isYouTubeWatchPage(tabUrl || url);
        const isShortsEntry = isYouTubeShortsUrl(tabUrl || url);
        let resolvedTitle = resolveExplicitTitleInfo(pageTitle, titleSource);
        if (!resolvedTitle.title) {
            if (isYouTubeEntry) {
                const youtubeTitle = isShortsEntry ? '' : getCurrentYouTubePageTitleFallback();
                resolvedTitle = titleInfo(youtubeTitle, youtubeTitle ? 'youtube-metadata' : '');
            } else {
                resolvedTitle = getBestPageTitleInfo();
            }
        }
        thumbnail = sanitizeThumbnailUrl(thumbnail || '');
        previewUrl = sanitizePreviewUrl(previewUrl || '');
        if (DETECTED.has(key)) {
            emitDetectedUpdate(url, qualities, thumbnail, thumbnailKind, previewUrl, resolvedTitle.title, tabUrl, resolvedTitle.source, mediaInfo, options);
            if (type === 'hls') maybeProbeHiddenHlsPreview(url);
            if (type === 'mp4' && !thumbnail) maybeProbeMp4Thumbnail(url, key, mediaInfo);
            return;
        }
        DETECTED.add(key);
        const liveState = typeof options?.isLive === 'boolean' ? options.isLive : undefined;
        window.dispatchEvent(new CustomEvent('__medianab_detected__', {
            detail: { url, type, pageTitle: resolvedTitle.title, titleSource: resolvedTitle.source, thumbnail, thumbnailKind, qualities, previewUrl, tabUrl, isLive: liveState, ...serializeMediaInfo(mediaInfo) }
        }));
        maybeInlineThumbnail(url, thumbnail);
        if (type === 'hls') maybeProbeHiddenHlsPreview(url);

        // 일반 MP4 썸네일이 비어있으면, 실제 비디오 프레임 캡처를 1회 시도
        if (type === 'mp4' && !thumbnail) maybeProbeMp4Thumbnail(url, key, mediaInfo);
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
        return /Chrome\//i.test(ua) && !/(Edg|OPR|Opera|Brave)\//i.test(ua);
    }

    function isChromeSensitiveThumbnailHost(url = '') {
        try {
            const host = new URL(url, location.href).hostname || '';
            return /(^|\.)phncdn\.com$/i.test(host) || /(^|\.)pornhub\.com$/i.test(host);
        } catch {
            return /phncdn|pornhub/i.test(String(url || ''));
        }
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
            const range = max - min;
            return mean < 12 && range < 18;
        } catch {
            return false;
        }
    }

    async function fetchThumbnailAsDataUrl(url) {
        const cleanUrl = sanitizeThumbnailUrl(url);
        if (!cleanUrl || cleanUrl.startsWith('data:image/')) return cleanUrl;

        try {
            const resp = await fetch(cleanUrl, {
                credentials: 'include',
                cache: 'force-cache',
                referrer: location.href
            });
            if (!resp.ok) return '';
            const type = resp.headers.get('content-type') || '';
            if (!type.startsWith('image/')) return '';
            const blob = await resp.blob();
            if (await isLowInformationImageBlob(blob)) {
                medianabLog('warn', 'thumbnail.inline', 'Rejected low-information official thumbnail', {
                    candidate: thumbnailLogUrl(cleanUrl),
                    page: location.href,
                });
                return '';
            }
            return await blobToDataUrl(blob);
        } catch {
            return '';
        }
    }

    function maybeInlineThumbnail(url, thumbnail, extraCandidates = []) {
        const cleanThumb = sanitizeThumbnailUrl(thumbnail);
        if (!url || cleanThumb.startsWith('data:image/') || cleanThumb.startsWith('blob:')) return;
        if (!cleanThumb && !(Array.isArray(extraCandidates) && extraCandidates.length)) return;
        const candidates = Array.from(new Set([
            cleanThumb,
            ...extraCandidates,
            ...getOfficialThumbnailCandidates()
        ].map(candidate => sanitizeThumbnailUrl(candidate || '')).filter(Boolean)));
        if (!candidates.length) return;
        if (isPlainChromeBrowser() && (isM3U8(url) || candidates.some(isChromeSensitiveThumbnailHost))) {
            medianabLog('info', 'thumbnail.inline', 'Official thumbnail inline delegated to background', {
                url: normalizeUrl(url),
                primary: thumbnailLogUrl(cleanThumb || candidates[0]),
                count: candidates.length,
                page: location.href,
                ua: navigator.userAgent || '',
            });
            return;
        }

        const taskKey = `${normalizeUrl(url)}|${candidates.join('|').slice(0, 500)}`;
        if (INLINE_THUMBNAIL_INFLIGHT.has(taskKey)) return;
        INLINE_THUMBNAIL_INFLIGHT.add(taskKey);

        medianabLog('info', 'thumbnail.inline', 'Official thumbnail candidates queued', {
            url: normalizeUrl(url),
            primary: thumbnailLogUrl(cleanThumb || candidates[0]),
            count: candidates.length,
            page: location.href,
            ua: navigator.userAgent || '',
        });

        (async () => {
            for (const candidate of candidates) {
                const inlined = await fetchThumbnailAsDataUrl(candidate);
                if (!inlined || inlined === candidate) continue;
                medianabLog('info', 'thumbnail.inline', 'Official thumbnail inlined', {
                    url: normalizeUrl(url),
                    candidate: thumbnailLogUrl(candidate),
                    page: location.href,
                    ua: navigator.userAgent || '',
                });
                window.dispatchEvent(new CustomEvent('__medianab_update_qualities__', {
                    detail: {
                        url,
                        qualities: null,
                        thumbnail: inlined,
                        thumbnailKind: 'page-image'
                    }
                }));
                return;
            }
            medianabLog('warn', 'thumbnail.inline', 'Official thumbnail inline failed', {
                url: normalizeUrl(url),
                primary: thumbnailLogUrl(cleanThumb || candidates[0]),
                count: candidates.length,
                page: location.href,
                ua: navigator.userAgent || '',
            });
        })().finally(() => {
            INLINE_THUMBNAIL_INFLIGHT.delete(taskKey);
        });
    }

    // ── 마스터 m3u8 파싱 → 화질 목록 추출 ──
    function parseMasterM3U8(text, baseUrl) {
        const lines = text.split('\n').map(l => l.trim());
        const streams = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bwMatch  = lines[i].match(/BANDWIDTH=(\d+)/);
                const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                const nameMatch= lines[i].match(/NAME="([^"]+)"/);
                const nextLine = lines[i + 1];
                if (nextLine && !nextLine.startsWith('#') && nextLine.trim()) {
                    const fullUrl = resolvePlaylistUrl(baseUrl, nextLine);
                    const bw     = bwMatch  ? parseInt(bwMatch[1])  : 0;
                    const res    = resMatch ? resMatch[1] : '';
                    const height = res ? parseInt(res.split('x')[1]) : 0;
                    const label  = nameMatch ? nameMatch[1] : (height ? `${height}p` : `${Math.round(bw / 1000)}k`);
                    streams.push({ label, url: fullUrl, bandwidth: bw, resolution: res });
                }
            }
        }
        streams.sort((a, b) => b.bandwidth - a.bandwidth);
        return streams.length ? streams : null;
    }

    function isYouTubeHlsManifestUrl(url) {
        try {
            const u = new URL(url, location.href);
            const host = (u.hostname || '').toLowerCase();
            return host.includes('googlevideo.com') || host.includes('youtube.com') || host.includes('youtube-nocookie.com');
        } catch {}
        return false;
    }

    function buildYouTubeLiveFetchOptions(url, options = {}) {
        if (!isYouTubeHlsManifestUrl(url)) return options;
        return {
            ...options,
            cache: options.cache || 'no-store',
            credentials: 'include',
            referrer: location.href,
            referrerPolicy: 'strict-origin-when-cross-origin',
        };
    }

    async function fetchYouTubeLiveResource(url, options = {}) {
        const enhancedOptions = buildYouTubeLiveFetchOptions(url, options);
        try {
            return await _fetch(url, enhancedOptions);
        } catch (e) {
            if (!isYouTubeHlsManifestUrl(url)) throw e;
            medianabLog('warn', 'youtube.live.fetch', 'Credentialed live fetch threw, retrying without credentials', {
                url: String(url || '').slice(0, 220),
                error: e?.message || String(e),
            });
            return _fetch(url, options);
        }
    }

    function preferredHlsHeight(preference = {}) {
        const resHeight = String(preference.qualityResolution || '').match(/x(\d{3,4})/i);
        if (resHeight) return parseInt(resHeight[1], 10) || 0;
        const labelHeight = String(preference.qualityLabel || '').match(/(\d{3,4})p/i);
        return labelHeight ? (parseInt(labelHeight[1], 10) || 0) : 0;
    }

    function selectPreferredHlsStream(masterText, baseUrl, preference = {}) {
        const streams = parseMasterM3U8(masterText, baseUrl) || [];
        if (!streams.length) return '';

        const wantedLabel = String(preference.qualityLabel || '').toLowerCase();
        const wantedResolution = String(preference.qualityResolution || '').toLowerCase();
        const wantedHeight = preferredHlsHeight(preference);
        const wantedBandwidth = Number(preference.qualityBandwidth || 0);

        const scored = streams.map((stream) => {
            const label = String(stream.label || '').toLowerCase();
            const resolution = String(stream.resolution || '').toLowerCase();
            const height = resolution.includes('x') ? parseInt(resolution.split('x')[1], 10) || 0 : 0;
            let score = Number(stream.bandwidth || 0);
            if (wantedResolution && resolution === wantedResolution) score += 10_000_000_000;
            if (wantedHeight && height === wantedHeight) score += 8_000_000_000;
            if (wantedLabel && label === wantedLabel) score += 6_000_000_000;
            if (wantedLabel && label.includes(wantedLabel)) score += 4_000_000_000;
            if (wantedBandwidth > 0) score -= Math.abs(Number(stream.bandwidth || 0) - wantedBandwidth);
            return { stream, score };
        });

        scored.sort((a, b) => (b.score - a.score) || (Number(b.stream.bandwidth || 0) - Number(a.stream.bandwidth || 0)));
        return scored[0]?.stream?.url || '';
    }

    async function resolveFreshYouTubeLiveMediaUrl(originalUrl, preference = {}) {
        if (!isYouTubeWatchPage() || !isYouTubeHlsManifestUrl(originalUrl)) return '';
        const playerResponse = getYouTubePlayerResponse();
        const freshManifestUrl = absolutizeUrl(playerResponse?.streamingData?.hlsManifestUrl || '');
        if (!freshManifestUrl) {
            medianabLog('warn', 'youtube.live.refresh', 'Fresh live manifest missing from player response', {
                originalUrl,
                href: location.href,
            });
            return '';
        }

        try {
            medianabLog('info', 'youtube.live.refresh', 'Fetching fresh live manifest', {
                manifest: freshManifestUrl,
                qualityLabel: preference.qualityLabel || '',
                qualityResolution: preference.qualityResolution || '',
            });
            const res = await fetchYouTubeLiveResource(freshManifestUrl, { cache: 'no-store' });
            if (!res.ok) {
                medianabLog('error', 'youtube.live.refresh', 'Fresh live manifest fetch failed', {
                    manifest: freshManifestUrl,
                    status: res.status,
                });
                return '';
            }
            const text = await res.text();
            if (text.includes('#EXT-X-STREAM-INF')) {
                const selected = selectPreferredHlsStream(text, freshManifestUrl, preference) || freshManifestUrl;
                medianabLog('info', 'youtube.live.refresh', 'Fresh live stream selected', {
                    selected,
                    streamCount: (parseMasterM3U8(text, freshManifestUrl) || []).length,
                });
                return selected;
            }
            medianabLog('info', 'youtube.live.refresh', 'Fresh live media playlist selected', { manifest: freshManifestUrl });
            return freshManifestUrl;
        } catch (e) {
            medianabLog('error', 'youtube.live.refresh', 'Fresh live manifest refresh threw', {
                manifest: freshManifestUrl,
                error: e?.message || String(e),
            });
        }
        return '';
    }

    // ── fetch 인터셉션 ──
    // mp4: 직접 감지 / m3u8: 응답 clone 파싱으로 화질 포함 감지
    const _fetch = window.fetch;
    window.fetch = async function (...args) {
        const url = (args[0] instanceof Request ? args[0].url : String(args[0] || ''));
        const promise = _fetch.apply(this, args);

        // MP4/직접 링크
        if (isDirectVideo(url) && !isTsSegment(url)) {
            emitDetected(url, 'mp4');
        }

        // m3u8: TS 세그먼트 제외, 응답을 clone해서 화질 파싱 (추가 네트워크 요청 없음)
        if (url.includes('.m3u8') && !isTsSegment(url)) {
            promise.then(async (res) => {
                try {
                    const text = await res.clone().text();
                    const key  = normalizeUrl(url);
                    if (text.includes('#EXT-X-STREAM-INF')) {
                        // 마스터 → 화질 파싱
                        const qualities = parseMasterM3U8(text, url);
                        const officialThumb = isYouTubeHlsManifestUrl(url) ? '' : getOfficialHlsThumbnail();
                        const officialKind = officialThumb ? 'page-image' : 'unknown';
                        if (!DETECTED.has(key)) {
                            emitDetected(url, 'hls', qualities, officialThumb, officialKind, '');
                        } else {
                            // 이미 webRequest가 감지했으면 화질/썸네일 함께 업데이트
                            const title = getBestPageTitleInfo();
                            emitDetectedUpdate(url, qualities, officialThumb, officialKind, '', title.title, location.href, title.source);
                        }
                        if (officialThumb) maybeInlineThumbnail(url, officialThumb, getOfficialThumbnailCandidates());
                    } else if (text.includes('#EXTINF') && !DETECTED.has(key)) {
                        // 미디어 플레이리스트 (서브 화질 URL)
                        // isSubPlaylist로 필터 (마스터가 먼저 감지됐을 것)
                        if (!isSubPlaylist(url)) {
                            const officialThumb = isYouTubeHlsManifestUrl(url) ? '' : getOfficialHlsThumbnail();
                            emitDetected(url, 'hls', null, officialThumb, officialThumb ? 'page-image' : 'unknown', '');
                            if (officialThumb) maybeInlineThumbnail(url, officialThumb, getOfficialThumbnailCandidates());
                        }
                    }
                } catch {}
            }).catch(() => {});
        }

        return promise;
    };

    // ── XHR 인터셉션 ──
    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        const urlStr = String(url || '');
        if (isDirectVideo(urlStr) && !isTsSegment(urlStr)) emitDetected(urlStr, 'mp4');
        return _open.call(this, method, url, ...rest);
    };

    // ── <video> 요소 모니터링 → 썸네일 & 재생시간 캡처 ──
    function classifyVideoSource(video) {
        const src = getVideoDirectSource(video);
        if (src && !src.startsWith('blob:') && !src.startsWith('data:') && isDirectVideo(src)) {
            return { sourceUrl: src, sourceType: 'mp4' };
        }
        const rawSrc = String(video?.currentSrc || video?.src || '');
        if (rawSrc && isM3U8(rawSrc)) {
            return { sourceUrl: rawSrc, sourceType: 'hls' };
        }
        if (rawSrc && rawSrc.startsWith('blob:')) {
            return { sourceUrl: '', sourceType: 'hls' };
        }
        const sourceEls = Array.from(video?.querySelectorAll?.('source') || []);
        const hlsSource = sourceEls.find(source => isM3U8(source.src || source.getAttribute('src') || '') || /mpegurl|application\/vnd\.apple\.mpegurl/i.test(source.type || ''));
        if (hlsSource) {
            const hlsUrl = absolutizeUrl(hlsSource.src || hlsSource.getAttribute('src') || '');
            if (hlsUrl && isM3U8(hlsUrl)) return { sourceUrl: hlsUrl, sourceType: 'hls' };
            return { sourceUrl: '', sourceType: 'hls' };
        }
        return { sourceUrl: '', sourceType: '' };
    }

    function getVideoDirectSource(video) {
        const candidates = [
            video?.currentSrc || '',
            video?.src || '',
            ...Array.from(video?.querySelectorAll?.('source') || []).map(source => source.src || source.getAttribute('src') || '')
        ];
        for (const candidate of candidates) {
            const src = absolutizeUrl(candidate);
            if (src && !src.startsWith('blob:') && !src.startsWith('data:') && isDirectVideo(src) && !isTsSegment(src)) {
                return src;
            }
        }
        return '';
    }

    function captureVideoInfo(video) {
        const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const { sourceUrl, sourceType } = classifyVideoSource(video);
        const mediaTitle = getMediaTitleInfo(video);
        const mediaInfo = getVideoMediaIdentity(video);
        const officialCandidates = sourceType === 'hls' ? getOfficialThumbnailCandidates(video) : [];
        const pageThumbnail = sourceType === 'hls' ? (officialCandidates[0] || '') : '';

        let thumbnail = sanitizeThumbnailUrl(
            pageThumbnail ||
            video.poster ||
            video.getAttribute('poster') ||
            findNearbyThumbnailForVideo(video) ||
            (sourceType === 'hls' ? bestLikelyPlayerThumbnail() : '')
        );
        let thumbnailKind = thumbnail
            ? (pageThumbnail && thumbnail === pageThumbnail ? 'page-image' : (sourceType === 'hls' ? 'poster-image' : 'image'))
            : 'unknown';

        const tryFrameCapture = () => {
            if (video.videoWidth <= 0 || video.readyState < 2) return false;
            try {
                const candidate = captureVideoFrame(video);
                if (isUsableFrameCandidate(candidate)) {
                    thumbnail = candidate.dataUrl;
                    thumbnailKind = 'frame';
                    return true;
                }
            } catch {}
            return false;
        };

        if (!thumbnail && sourceType !== 'hls') {
            tryFrameCapture();
        }
        if (thumbnail || duration) {
            window.dispatchEvent(new CustomEvent('__medianab_video_meta__', {
                detail: {
                    thumbnail,
                    thumbnailKind,
                    duration,
                    sourceUrl,
                    sourceType,
                    pageTitle: mediaTitle.title,
                    titleSource: mediaTitle.source,
                    ...serializeMediaInfo(mediaInfo)
                }
            }));
        }
        if (sourceType === 'hls' && sourceUrl && thumbnail) {
            maybeInlineThumbnail(sourceUrl, thumbnail, officialCandidates);
        }
        maybeProbeVideoPreview(video, sourceType, sourceUrl);
    }

    const _watchedVideos = new WeakSet();
    const _thumbRetryTimers = new WeakMap();

    function scheduleThumbnailRetries(video, src) {
        if (!(video instanceof HTMLVideoElement) || !src) return;
        const prev = _thumbRetryTimers.get(video) || [];
        prev.forEach(id => clearTimeout(id));
        const mediaInfo = getVideoMediaIdentity(video);

        const timers = [400, 1200, 2500].map(delay => setTimeout(async () => {
            let thumb = sanitizeThumbnailUrl(video.poster || video.getAttribute('poster') || '');
            let thumbKind = thumb ? 'image' : 'unknown';
            if (!thumb && video.videoWidth > 0 && video.readyState >= 2) {
                const candidate = captureVideoFrame(video);
                if (isUsableFrameCandidate(candidate)) {
                    thumb = candidate.dataUrl;
                    thumbKind = 'frame';
                }
            }
            if (thumb) emitDetectedUpdate(src, null, thumb, thumbKind, '', '', location.href, '', mediaInfo);
        }, delay));

        _thumbRetryTimers.set(video, timers);
    }

    function watchVideo(video) {
        if (_watchedVideos.has(video)) return;
        _watchedVideos.add(video);

        const tryCapture = () => captureVideoInfo(video);
        // video.src에서 직접 비디오 URL 감지 (blob: 제외)
        // 각 video 요소의 poster/canvas를 개별 썸네일로 매핑
        const trySrcDetect = () => {
            const src = getVideoDirectSource(video);
            const mediaTitle = getMediaTitleInfo(video);
            const mediaInfo = getVideoMediaIdentity(video);
            if (src && !src.startsWith('blob:') && !src.startsWith('data:') && isDirectVideo(src)) {
                const preferredTitle = mediaTitle.title;
                if (preferredTitle) {
                    emitDetectedUpdate(src, null, '', 'unknown', '', preferredTitle, location.href, mediaTitle.source, mediaInfo);
                }
                if (hasVisibleHlsContext(video) && !isVisibleElement(video) && !(Number(video.duration || 0) > 0)) {
                    return;
                }
                if (isLikelyAuxiliaryMp4(video, src)) {
                    return;
                }
                // 해당 video의 poster 먼저
                let thumb = video.poster || '';
                let thumbKind = thumb ? 'image' : 'unknown';
                thumb = sanitizeThumbnailUrl(thumb);
                if (thumb) thumbKind = 'image';
                // poster 없으면 canvas 스냅샷
                if (!thumb && video.videoWidth > 0 && video.readyState >= 2) {
                    try {
                        const candidate = captureVideoFrame(video);
                        if (isUsableFrameCandidate(candidate)) {
                            thumb = candidate.dataUrl;
                            thumbKind = 'frame';
                        }
                    } catch {}
                }
                emitDetected(src, 'mp4', null, thumb, thumbKind, '', mediaTitle.title, location.href, mediaTitle.source, mediaInfo);
                if (!thumb) scheduleThumbnailRetries(video, src);
            }
        };

        video.addEventListener('loadedmetadata', () => { tryCapture(); trySrcDetect(); });
        video.addEventListener('loadeddata', () => { tryCapture(); trySrcDetect(); });
        video.addEventListener('playing', () => { tryCapture(); trySrcDetect(); });
        // poster/src 속성 변화 감시 (동적 로딩)
        new MutationObserver(() => { tryCapture(); trySrcDetect(); }).observe(video, {
            attributes: true, attributeFilter: ['poster', 'src', 'currentSrc'], childList: true, subtree: true
        });
        if (video.readyState >= 1) { tryCapture(); trySrcDetect(); }
    }

    function scanVideos() {
        document.querySelectorAll('video').forEach(watchVideo);
    }

    const YOUTUBE_EXTERNAL_SELECTOR = [
        'a[href*="youtube.com/watch"]',
        'a[href*="youtube.com/shorts/"]',
        'a[href*="youtube.com/live/"]',
        'a[href*="youtube.com/embed/"]',
        'a[href*="youtube-nocookie.com/embed/"]',
        'a[href*="youtu.be/"]',
        'iframe[src*="youtube.com/embed/"]',
        'iframe[src*="youtube-nocookie.com/embed/"]',
        'iframe[src*="youtu.be/"]',
        'embed[src*="youtube.com/"]',
        'embed[src*="youtube-nocookie.com/"]',
        'object[data*="youtube.com/"]',
        'object[data*="youtube-nocookie.com/"]'
    ].join(',');
    const YOUTUBE_EXTERNAL_TITLE_SELECTOR = [
        'h1',
        'h2',
        'h3',
        '[itemprop="headline"]',
        '.entry-title',
        '.post-title',
        '.article-title',
        '.view_subject',
        '.view-title',
        '.board-title',
        '.subject',
        '.title',
        '[data-title]',
        'figcaption'
    ].join(',');
    const YOUTUBE_EXTERNAL_SCOPE_SELECTOR = [
        'article',
        'section',
        'li',
        'figure',
        '.post',
        '.entry',
        '.card',
        '.item',
        '.video',
        '.media',
        '.thumb',
        '[class*="post"]',
        '[class*="card"]',
        '[class*="video"]',
        '[class*="media"]',
        '[class*="thumb"]'
    ].join(',');
    const YOUTUBE_EXTERNAL_SCAN_LIMIT = 40;
    let _youtubeExternalScanTimer = 0;
    let _youtubeExternalLastSignature = '';

    function getYouTubeExternalUrlFromElement(el) {
        if (!(el instanceof Element)) return '';
        if (el instanceof HTMLAnchorElement) return el.href || el.getAttribute('href') || '';
        return el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href') || '';
    }

    function getYouTubeExternalScope(el) {
        if (!(el instanceof Element)) return null;
        const scope = el.closest(YOUTUBE_EXTERNAL_SCOPE_SELECTOR);
        if (scope && scope !== document.documentElement && scope !== document.body) return scope;
        return el.parentElement || el;
    }

    function textCandidatesFromElement(el) {
        if (!(el instanceof Element)) return [];
        return [
            el.getAttribute('title') || '',
            el.getAttribute('aria-label') || '',
            el.getAttribute('data-title') || '',
            el.textContent || ''
        ];
    }

    function isGenericYouTubeTitle(value = '') {
        const text = normalizePageTitleText(value).toLowerCase();
        return !text ||
            /^(youtube|youtube video|youtube video player|watch on youtube|동영상|유튜브|유튜브 영상)$/i.test(text) ||
            /^https?:\/\//i.test(text);
    }

    function extractExternalYouTubeTitle(el, scope) {
        const nodes = [];
        if (el instanceof Element) nodes.push(el);
        if (scope instanceof Element && scope !== el) {
            nodes.push(...Array.from(scope.querySelectorAll(YOUTUBE_EXTERNAL_TITLE_SELECTOR)).slice(0, 24));
        }
        let best = '';
        for (const node of nodes) {
            for (const raw of textCandidatesFromElement(node)) {
                for (const line of String(raw || '').split(/[\n\r]+/u)) {
                    const candidate = cleanPageTitleCandidate(line);
                    if (!candidate || isGenericYouTubeTitle(candidate)) continue;
                    if (!best || candidate.length > best.length) best = candidate;
                }
            }
        }
        return best;
    }

    function extractExternalYouTubeThumbnail(scope, videoId = '', pageUrl = '') {
        if (!(scope instanceof Element)) return buildYouTubeThumbnailUrlForId(videoId, pageUrl);
        const nodes = Array.from(scope.querySelectorAll('img, [data-thumb], [data-thumbnail], [data-src], [style*="background"]')).slice(0, 40);
        let best = '';
        let bestArea = -1;
        for (const node of nodes) {
            if (!(node instanceof Element)) continue;
            const thumb = sanitizeThumbnailUrl(elementImageUrl(node) || '');
            if (!thumb) continue;
            const thumbId = extractYouTubeThumbnailVideoId(thumb);
            if (videoId && thumbId && thumbId !== videoId) continue;
            if (!thumbId && /ytimg\.com/i.test(thumb)) continue;
            if (!thumbId && best) continue;
            const rect = node.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (thumbId === videoId || area > bestArea) {
                best = thumb;
                bestArea = area;
            }
        }
        return normalizeYouTubeSeedThumbnail(videoId, best, pageUrl);
    }

    function isExternalYouTubeScanAllowed() {
        try {
            return !isYouTubeHostName(location.hostname);
        } catch {
            return true;
        }
    }

    function scanExternalYouTubeLinks(reason = 'scan') {
        if (!isExternalYouTubeScanAllowed()) return;
        const seen = new Set();
        const candidates = [];
        for (const el of Array.from(document.querySelectorAll(YOUTUBE_EXTERNAL_SELECTOR))) {
            const rawUrl = getYouTubeExternalUrlFromElement(el);
            const videoId = extractYouTubeVideoId(rawUrl);
            if (!videoId || seen.has(videoId)) continue;
            seen.add(videoId);
            const pageUrl = canonicalExternalYouTubePageUrl(videoId);
            if (!pageUrl) continue;
            const scope = getYouTubeExternalScope(el);
            const title = extractExternalYouTubeTitle(el, scope);
            const thumbnail = extractExternalYouTubeThumbnail(scope, videoId, pageUrl);
            candidates.push({ pageUrl, videoId, title, thumbnail });
            if (candidates.length >= YOUTUBE_EXTERNAL_SCAN_LIMIT) break;
        }
        const signature = candidates.map(item => `${item.videoId}|${item.title}|${item.thumbnail}`).join('\n');
        if (!signature || signature === _youtubeExternalLastSignature) return;
        _youtubeExternalLastSignature = signature;
        medianabLog('info', 'youtube.external', 'External YouTube links emitted', {
            count: candidates.length,
            reason,
        });
        for (const item of candidates) {
            emitDetected(
                item.pageUrl,
                'youtube',
                null,
                item.thumbnail,
                item.thumbnail ? 'image' : 'unknown',
                '',
                item.title,
                location.href,
                item.title ? 'youtube-navigation' : ''
            );
        }
    }

    function scheduleExternalYouTubeLinkScan(delay = 300, reason = 'dom') {
        if (!isExternalYouTubeScanAllowed()) return;
        clearTimeout(_youtubeExternalScanTimer);
        _youtubeExternalScanTimer = setTimeout(() => {
            scanExternalYouTubeLinks(reason);
        }, delay);
    }

    let _youtubeSyncTimer = 0;
    let _youtubeLastSignature = '';
    let _youtubeLastLiveManifest = '';
    let _youtubeNoPlayerLogAt = 0;
    let _youtubeLastStaleSignature = '';
    let _youtubeStaleLogAt = 0;

    function scheduleYouTubePageSync(delay = 250) {
        if (!isYouTubeWatchPage()) return;
        clearTimeout(_youtubeSyncTimer);
        _youtubeSyncTimer = setTimeout(() => {
            syncYouTubePageData().catch(() => {});
        }, delay);
    }

    function emitYouTubeNavigationSeed(reason = '') {
        if (!isYouTubeWatchPage()) return false;
        const pageUrl = location.href;
        const videoId = extractYouTubeVideoId(pageUrl);
        const seed = getYouTubeNavigationSeed(videoId);
        if (!seed?.title || !seed?.thumbnail) return false;
        const signature = `${videoId}|${seed.title}|${seed.thumbnail}`;
        if (signature === _youtubeLastSeedSignature) return true;
        _youtubeLastSeedSignature = signature;
        medianabLog('info', 'youtube.navigation', 'YouTube navigation seed emitted', {
            href: pageUrl,
            videoId,
            title: seed.title,
            hasThumbnail: !!seed.thumbnail,
            reason,
        });
        emitDetected(pageUrl, 'youtube', null, seed.thumbnail, 'image', '', seed.title, pageUrl, 'youtube-navigation');
        return true;
    }

    async function syncYouTubePageData() {
        if (!isYouTubeWatchPage()) return;
        const playerResponse = getYouTubePlayerResponse();
        if (!playerResponse) {
            emitYouTubeNavigationSeed('no-player-response');
            if (Date.now() - _youtubeNoPlayerLogAt > 5000) {
                _youtubeNoPlayerLogAt = Date.now();
                medianabLog('warn', 'youtube.pageData', 'YouTube player response not found', { href: location.href, title: document.title });
            }
            return;
        }

        const pageUrl = location.href;
        const currentVideoId = extractYouTubeVideoId(pageUrl);
        const responseVideoId = String(
            playerResponse?.videoDetails?.videoId ||
            playerResponse?.microformat?.playerMicroformatRenderer?.externalVideoId ||
            ''
        );
        if (currentVideoId && responseVideoId && currentVideoId !== responseVideoId) {
            const staleSignature = `${currentVideoId}|${responseVideoId}`;
            const now = Date.now();
            if (staleSignature !== _youtubeLastStaleSignature || now - _youtubeStaleLogAt > 5000) {
                _youtubeLastStaleSignature = staleSignature;
                _youtubeStaleLogAt = now;
                medianabLog('info', 'youtube.pageData', 'Skipping stale YouTube player response', {
                    href: pageUrl,
                    currentVideoId,
                    responseVideoId,
                    responseTitle: playerResponse?.videoDetails?.title || '',
                });
            }
            emitYouTubeNavigationSeed('stale-player-response');
            scheduleYouTubePageSync(1500);
            return;
        }
        _youtubeLastStaleSignature = '';

        const streaming = playerResponse?.streamingData || {};
        const currentSeed = getYouTubeNavigationSeed(currentVideoId);
        const pageTitle = cleanPageTitleCandidate(playerResponse?.videoDetails?.title || '') ||
            getCurrentYouTubePageTitleInfo().title;
        if (!pageTitle) {
            emitYouTubeNavigationSeed('missing-player-title');
            scheduleYouTubePageSync(1200);
            return;
        }
        const thumbnail = getYouTubePageThumbnail(playerResponse) ||
            currentSeed?.thumbnail ||
            buildYouTubeThumbnailUrlForId(currentVideoId, pageUrl);
        const thumbnailKind = thumbnail ? 'image' : 'unknown';
        const isLive = !!(playerResponse?.videoDetails?.isLive || playerResponse?.microformat?.playerMicroformatRenderer?.isLiveContent);

        if (isLive && streaming?.hlsManifestUrl) {
            const liveManifestUrl = absolutizeUrl(streaming.hlsManifestUrl || '');
            if (!liveManifestUrl) return;
            let qualities = null;
            try {
                const response = await _fetch(liveManifestUrl);
                if (response.ok) {
                    const text = await response.text();
                    if (text.includes('#EXT-X-STREAM-INF')) {
                        qualities = parseMasterM3U8(text, liveManifestUrl);
                    }
                }
            } catch {}

            const signature = JSON.stringify({
                pageUrl,
                manifest: liveManifestUrl,
                title: pageTitle,
                thumb: thumbnail.slice(0, 96),
                qualityCount: qualities?.length || 0,
            });
            if (signature === _youtubeLastSignature && liveManifestUrl === _youtubeLastLiveManifest) return;
            _youtubeLastSignature = signature;
            _youtubeLastLiveManifest = liveManifestUrl;
            medianabLog('info', 'youtube.live.detect', 'YouTube live page data emitted', {
                href: pageUrl,
                title: pageTitle,
                manifest: liveManifestUrl,
                qualities: qualities?.length || 0,
                hasThumbnail: !!thumbnail,
            });
            emitDetected(liveManifestUrl, 'hls', qualities, thumbnail, thumbnailKind, '', pageTitle, pageUrl, 'youtube-metadata', null, { isLive: true });
            emitDetectedUpdate(liveManifestUrl, qualities, thumbnail, thumbnailKind, '', pageTitle, pageUrl, 'youtube-metadata', null, { isLive: true });
            return;
        }

        const qualities = buildYouTubeDirectQualities(playerResponse);
        const signature = JSON.stringify({
            pageUrl,
            title: pageTitle,
            thumb: thumbnail.slice(0, 96),
            qualityCount: qualities.length,
            labels: qualities.map(q => `${q.label}:${q.source}`).join('|'),
        });
        if (signature === _youtubeLastSignature) return;
        _youtubeLastSignature = signature;
        _youtubeLastLiveManifest = '';
        medianabLog('info', 'youtube.detect', 'YouTube page data emitted', {
            href: pageUrl,
            title: pageTitle,
            qualities: qualities.length,
            labels: qualities.map(q => q.label).slice(0, 12),
            hasThumbnail: !!thumbnail,
        });
        emitDetected(pageUrl, 'youtube', qualities, thumbnail, thumbnailKind, '', pageTitle, pageUrl, 'youtube-metadata');
        emitDetectedUpdate(pageUrl, qualities, thumbnail, thumbnailKind, '', pageTitle, pageUrl, 'youtube-metadata');
    }

    // DOM 변화 감시 (동적으로 추가되는 video 요소)
    const domObserver = new MutationObserver(() => {
        scanVideos();
        scheduleYouTubePageSync(300);
        scheduleExternalYouTubeLinkScan(450, 'dom');
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });

    // 페이지 og:image 메타태그에서 즉시 썸네일 전송 (재생 전에도 동작)
    function emitPageMeta() {
        let thumbnail = getPageThumbnail();
        const duration   = 0; // 재생 전에는 0
        const isYouTubePage = isYouTubeWatchPage();
        if (thumbnail && isYouTubeWatchPage()) {
            const currentVideoId = extractYouTubeVideoId(location.href);
            const thumbnailVideoId = extractYouTubeThumbnailVideoId(thumbnail);
            if (currentVideoId && thumbnailVideoId && currentVideoId !== thumbnailVideoId) {
                medianabLog('info', 'youtube.pageData', 'Skipping stale YouTube page thumbnail', {
                    href: location.href,
                    currentVideoId,
                    thumbnailVideoId,
                    thumbnail,
                });
                thumbnail = '';
            }
        }
        const pageTitleInfo = isYouTubePage
            ? getCurrentYouTubePageTitleInfo()
            : getBestPageTitleInfo();
        const pageTitle = pageTitleInfo.title;
        if (isYouTubePage && pageTitle) {
            const currentVideoId = extractYouTubeVideoId(location.href);
            const seed = getYouTubeNavigationSeed(currentVideoId);
            if (!thumbnail && seed?.thumbnail) thumbnail = seed.thumbnail;
            if (!thumbnail) thumbnail = buildYouTubeThumbnailUrlForId(currentVideoId, location.href);
            const thumbnailKind = thumbnail ? 'image' : 'unknown';
            emitDetected(location.href, 'youtube', null, thumbnail, thumbnailKind, '', pageTitle, location.href, pageTitleInfo.source);
            emitDetectedUpdate(location.href, null, thumbnail, thumbnailKind, '', pageTitle, location.href, pageTitleInfo.source);
            return;
        }
        if (isYouTubePage) return;
        if (thumbnail) {
            window.dispatchEvent(new CustomEvent('__medianab_video_meta__', {
                detail: {
                    thumbnail,
                    thumbnailKind: isYouTubePage ? 'image' : 'page-image',
                    duration,
                    sourceUrl: '',
                    sourceType: '',
                    pageTitle,
                    titleSource: pageTitleInfo.source,
                    tabUrl: location.href
                }
            }));
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            scanVideos();
            emitPageMeta();
            scheduleYouTubePageSync(120);
            scheduleExternalYouTubeLinkScan(180, 'dom-ready');
        });
    } else {
        scanVideos();
        emitPageMeta();
        scheduleYouTubePageSync(120);
        scheduleExternalYouTubeLinkScan(180, 'initial');
    }

    // 동적으로 메타태그가 추가되는 사이트 대비 (SPA 등)
    const metaObserver = new MutationObserver(() => {
        emitPageMeta();
        scheduleYouTubePageSync(220);
    });
    if (document.head) metaObserver.observe(document.head, { childList: true, subtree: true });
    let _medianabLastContextHref = location.href;
    function maybeEmitPageContextChanged(reason = '') {
        if (location.href === _medianabLastContextHref) return false;
        _medianabLastContextHref = location.href;
        window.dispatchEvent(new CustomEvent('__medianab_page_context_changed__', {
            detail: { tabUrl: location.href, reason }
        }));
        return true;
    }
    function handlePossiblePageContextChange(reason = '') {
        setTimeout(() => {
            if (!maybeEmitPageContextChanged(reason)) return;
            DETECTED.clear();
            _youtubeLastSeedSignature = '';
            _youtubeExternalLastSignature = '';
            emitYouTubeNavigationSeed(reason);
            emitPageMeta();
            scheduleYouTubePageSync(80);
            scheduleExternalYouTubeLinkScan(180, reason);
        }, 0);
    }
    try {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        history.pushState = function (...args) {
            const before = location.href;
            const result = originalPushState.apply(this, args);
            if (location.href !== before) handlePossiblePageContextChange('history-pushState');
            return result;
        };
        history.replaceState = function (...args) {
            const before = location.href;
            const result = originalReplaceState.apply(this, args);
            if (location.href !== before) handlePossiblePageContextChange('history-replaceState');
            return result;
        };
    } catch {}
    window.addEventListener('yt-navigate-finish', () => {
        _youtubeLastSignature = '';
        _youtubeLastLiveManifest = '';
        _youtubeLastStaleSignature = '';
        _youtubeLastSeedSignature = '';
        if (maybeEmitPageContextChanged('yt-navigate-finish')) DETECTED.clear();
        emitYouTubeNavigationSeed('yt-navigate-finish');
        emitPageMeta();
        scheduleYouTubePageSync(180);
        scheduleExternalYouTubeLinkScan(180, 'yt-navigate-finish');
    });
    window.addEventListener('popstate', () => {
        _youtubeLastSignature = '';
        _youtubeLastLiveManifest = '';
        _youtubeLastStaleSignature = '';
        _youtubeLastSeedSignature = '';
        _youtubeExternalLastSignature = '';
        if (maybeEmitPageContextChanged('popstate')) DETECTED.clear();
        emitYouTubeNavigationSeed('popstate');
        emitPageMeta();
        scheduleYouTubePageSync(180);
        scheduleExternalYouTubeLinkScan(180, 'popstate');
    });
    window.addEventListener('hashchange', () => {
        handlePossiblePageContextChange('hashchange');
    });
    setInterval(() => {
        if (maybeEmitPageContextChanged('location-watch')) {
            DETECTED.clear();
            _youtubeLastSeedSignature = '';
            _youtubeExternalLastSignature = '';
            emitYouTubeNavigationSeed('location-watch');
            emitPageMeta();
            scheduleYouTubePageSync(180);
            scheduleExternalYouTubeLinkScan(180, 'location-watch');
        }
    }, 450);

    // ── background 요청에 의한 m3u8 파싱 (XHR/fetch 무관하게 동작) ──
    // webRequest가 m3u8을 감지하면 background가 이 이벤트를 트리거
    // MAIN world에서 직접 fetch → 사이트 쿠키/헤더 포함 → CORS 우회
    const _METADATA_FETCHING = new Set();
    window.addEventListener('__medianab_fetch_metadata__', async (e) => {
        const { url, tabUrl: requestTabUrl = location.href } = e.detail;
        const requestPageTitleInfo = getBestPageTitleInfo();
        if (_METADATA_FETCHING.has(url)) return;
        _METADATA_FETCHING.add(url);
        try {
            const res = await _fetch(url);
            if (!res.ok) return;
            const text = await res.text();

            let qualities = null;
            let isLive = undefined; // undefined = 판별 안 함 (일반 HLS는 건드리지 않음)
            if (text.includes('#EXT-X-STREAM-INF')) {
                qualities = parseMasterM3U8(text, url);
                // YouTube 전용: 첫 sub-playlist fetch → isLive 판별
                if (url.includes('manifest.googlevideo.com') && qualities?.length) {
                    try {
                        const subRes = await _fetch(qualities[0].url);
                        const subText = await subRes.text();
                        isLive = !subText.includes('#EXT-X-ENDLIST');
                    } catch {}
                }
            }

            const isYouTubeManifest = /manifest\.googlevideo\.com\/api\/manifest\/hls_/i.test(String(url || ''));
            const pageTitle = isYouTubeManifest ? '' : requestPageTitleInfo.title;
            const titleSource = isYouTubeManifest ? '' : requestPageTitleInfo.source;
            const officialThumb = isYouTubeManifest ? '' : getOfficialHlsThumbnail();
            const officialKind = officialThumb ? 'page-image' : 'unknown';
            const tabUrl = requestTabUrl;
            if (qualities) {
                window.dispatchEvent(new CustomEvent('__medianab_update_qualities__', {
                    detail: {
                        url,
                        qualities,
                        thumbnail: officialThumb,
                        thumbnailKind: officialKind,
                        previewUrl: '',
                        pageTitle,
                        titleSource,
                        isLive,
                        tabUrl
                    }
                }));
                if (officialThumb) maybeInlineThumbnail(url, officialThumb, getOfficialThumbnailCandidates());
            }
        } catch (err) {
            const message = String(err?.message || err || '');
            if (/Failed to fetch/i.test(message)) {
                console.debug('[MediaNab] fetchMetadata 건너뜀:', message);
            } else {
                console.warn('[MediaNab] fetchMetadata 실패:', err);
            }
        } finally {
            // 재요청 허용 (같은 URL이라도 5초 후 다시 가능)
            setTimeout(() => _METADATA_FETCHING.delete(url), 5000);
        }
    });

    window.addEventListener(PREVIEW_EVENTS.fetchResource, async (e) => {
        const { requestId, url, responseType = 'text', byterange = null } = e.detail || {};
        const respond = (payload = {}) => {
            window.dispatchEvent(new CustomEvent(PREVIEW_EVENTS.fetchResourceResult, {
                detail: {
                    requestId,
                    ...payload
                }
            }));
        };

        if (!requestId || !url) {
            respond({ ok: false, status: 0, error: 'invalid-preview-fetch-request' });
            return;
        }

        try {
            const headers = {};
            if (byterange?.length) {
                const start = Number(byterange.offset || 0);
                const end = start + Number(byterange.length) - 1;
                headers.Range = `bytes=${start}-${end}`;
            }

            const response = await _fetch(url, Object.keys(headers).length ? { headers } : undefined);
            if (!response.ok && response.status !== 206) {
                respond({
                    ok: false,
                    status: Number(response.status || 0),
                    error: response.statusText || `HTTP ${response.status}`,
                    url: response.url || url
                });
                return;
            }

            if (responseType === 'arrayBuffer') {
                const fullBuf = await response.arrayBuffer();
                let finalBuf = fullBuf;
                if (byterange?.length && response.status === 200 && fullBuf.byteLength > byterange.length) {
                    const start = Number(byterange.offset || 0);
                    const end = start + Number(byterange.length || 0);
                    if (fullBuf.byteLength < end) {
                        respond({
                            ok: false,
                            status: Number(response.status || 0),
                            error: 'byterange-response-too-short',
                            url: response.url || url
                        });
                        return;
                    }
                    finalBuf = fullBuf.slice(start, end);
                }
                respond({
                    ok: true,
                    status: Number(response.status || 200),
                    url: response.url || url,
                    bytes: Array.from(new Uint8Array(finalBuf))
                });
                return;
            }

            respond({
                ok: true,
                status: Number(response.status || 200),
                url: response.url || url,
                text: await response.text()
            });
        } catch (error) {
            respond({
                ok: false,
                status: 0,
                error: error?.message || String(error || 'preview-fetch-failed'),
                url
            });
        }
    });

    // ── HLS 다운로드 실행 (background → content_bridge → 이 이벤트) ──
    window.addEventListener(DL_EVENTS.downloadControl, (e) => {
        const taskId = e.detail?.taskId;
        if (!taskId) return;
        HLS_DOWNLOAD_CONTROL.set(taskId, {
            status: e.detail.status || '',
            error: e.detail.error || '',
            updatedAt: Date.now(),
        });
    });

    window.addEventListener(LIVE_EVENTS.control, (e) => {
        const taskId = e.detail?.taskId;
        if (!taskId) return;
        LIVE_RECORD_CONTROL.set(taskId, {
            status: e.detail.status || '',
            error: e.detail.error || '',
            updatedAt: Date.now(),
        });
    });

    window.addEventListener(DL_EVENTS.download, async (e) => {
        const { taskId, m3u8Url, mediaUrl, fileName, kind, containerExt } = e.detail;
        HLS_DOWNLOAD_CONTROL.delete(taskId);
        if (kind === 'direct') {
            await downloadDirectMedia(taskId, mediaUrl || m3u8Url, fileName, containerExt || 'mp4');
        } else {
            await downloadHLS(taskId, m3u8Url, fileName);
        }
    });

    window.addEventListener(LIVE_EVENTS.start, async (e) => {
        const {
            taskId,
            m3u8Url,
            fileName,
            recordMode,
            qualityLabel,
            qualityResolution,
            qualityBandwidth,
        } = e.detail;
        LIVE_RECORD_CONTROL.delete(taskId);
        await recordHLSLive(taskId, m3u8Url, fileName, recordMode, {
            qualityLabel,
            qualityResolution,
            qualityBandwidth,
        });
    });

    async function downloadHLS(taskId, m3u8Url, fileName) {
        // 진행률 추적 변수
        const downloadStartTime = Date.now();
        let downloadedBytes = 0;

        try {
            // ── Step 1: 주어진 URL fetch ──
            let res = await _fetch(m3u8Url);
            if (!res.ok) throw new Error(`m3u8 fetch 실패: ${res.status}`);
            let text = await res.text();
            let mediaUrl = m3u8Url;

            // ── Step 2: 마스터 플레이리스트라면 최고화질 미디어 플레이리스트로 이동 ──
            if (text.includes('#EXT-X-STREAM-INF')) {
                console.log('[MediaNab] 마스터 플레이리스트 감지 → 최고화질 서브 플레이리스트 선택');
                const base = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
                const lines = text.split('\n').map(l => l.trim());
                const streams = [];
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                        const nextLine = lines[i + 1];
                        if (nextLine && !nextLine.startsWith('#') && nextLine.trim()) {
                            const fullUrl = nextLine.startsWith('http') ? nextLine : base + nextLine;
                            streams.push({ bw: bwMatch ? parseInt(bwMatch[1]) : 0, url: fullUrl });
                        }
                    }
                }
                if (!streams.length) throw new Error('마스터 플레이리스트에서 서브 스트림을 찾지 못함');

                // 최고 화질 (bandwidth 최대)
                streams.sort((a, b) => b.bw - a.bw);
                mediaUrl = streams[0].url;
                console.log(`[MediaNab] 선택된 스트림: ${mediaUrl}`);

                res = await _fetch(mediaUrl);
                if (!res.ok) throw new Error(`미디어 m3u8 fetch 실패: ${res.status}`);
                text = await res.text();
            }

            // ── Step 3: 미디어 플레이리스트인지 확인 (#EXTINF 필수) ──
            if (!text.includes('#EXTINF')) {
                throw new Error(`미디어 플레이리스트가 아님 - #EXTINF 없음 (받은 내용 앞 200자: ${text.substring(0, 200)})`);
            }

            // ── Step 4: TS 세그먼트 URL 추출 ──
            const playlist = parseMediaPlaylist(text, mediaUrl);
            const segments = playlist.entries || [];
            if (!segments.length) throw new Error('세그먼트 없음');
            console.log(`[MediaNab] 세그먼트 ${segments.length}개 다운로드 시작 (${playlist.containerExt || 'ts'})`);

            const total = segments.length;
            emitProgress(taskId, 0);

            for (let i = 0; i < total; i++) {
                const controlState = HLS_DOWNLOAD_CONTROL.get(taskId);
                if (controlState?.status === 'cancelled' || controlState?.status === 'cancelling') {
                    emitStatus(
                        taskId,
                        'cancelled',
                        controlState?.error || `Cancelled via downloadControl (${controlState?.status || 'unknown'})`
                    );
                    HLS_DOWNLOAD_CONTROL.delete(taskId);
                    return;
                }
                if (controlState?.status === 'error') {
                    HLS_DOWNLOAD_CONTROL.delete(taskId);
                    return;
                }

                let buf = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        const segment = segments[i];
                        const headers = {};
                        if (segment.byteRange) {
                            const rangeEnd = segment.byteRange.offset + segment.byteRange.length - 1;
                            headers.Range = `bytes=${segment.byteRange.offset}-${rangeEnd}`;
                        }
                        const r = await _fetch(segment.url, Object.keys(headers).length ? { headers } : undefined);
                        if (!r.ok) throw new Error(`HTTP ${r.status}`);
                        const fullBuf = await r.arrayBuffer();
                        if (segment.byteRange && r.status === 200 && fullBuf.byteLength > segment.byteRange.length) {
                            const start = segment.byteRange.offset;
                            const end = start + segment.byteRange.length;
                            if (fullBuf.byteLength < end) throw new Error('BYTERANGE 응답이 예상보다 짧음');
                            buf = fullBuf.slice(start, end);
                        } else {
                            buf = fullBuf;
                        }
                        if (buf.byteLength === 0) throw new Error('빈 응답');
                        break;
                    } catch (e) {
                        console.warn(`[MediaNab] 세그먼트 ${i} 시도 ${attempt + 1} 실패:`, e.message);
                        if (attempt < 2) await sleep(500 * (attempt + 1));
                    }
                }

                if (buf && buf.byteLength > 0) {
                    downloadedBytes += buf.byteLength;
                    window.dispatchEvent(new CustomEvent(DL_EVENTS.chunk, {
                        detail: { taskId, buf, index: i, total }
                    }));
                    await sleep(20); // bridge IPC 안정화
                } else {
                    console.warn(`[MediaNab] 세그먼트 ${i} 건너뜀 (null 또는 빈 응답)`);
                }

                if (i % 5 === 0 || i === total - 1) {
                    // 속도/ETA 계산
                    const elapsedSec = (Date.now() - downloadStartTime) / 1000;
                    let speedStr = '';
                    let etaStr = '';
                    if (elapsedSec > 0 && downloadedBytes > 0) {
                        const bytesPerSec = downloadedBytes / elapsedSec;
                        speedStr = formatSpeed(bytesPerSec);
                        // 전체 크기 추정 (현재까지 다운로드한 바이트 / 진행률)
                        const currentPercent = (i + 1) / total;
                        if (currentPercent > 0) {
                            const estimatedTotalBytes = downloadedBytes / currentPercent;
                            const remainingBytes = estimatedTotalBytes - downloadedBytes;
                            const etaSec = remainingBytes / bytesPerSec;
                            etaStr = formatTime(etaSec);
                        }
                    }
                    emitProgress(taskId, Math.floor(((i + 1) / total) * 100), speedStr, etaStr);
                }
            }

            window.dispatchEvent(new CustomEvent(DL_EVENTS.allChunksSent, {
                detail: { taskId, fileName, containerExt: playlist.containerExt || 'ts' }
            }));
            HLS_DOWNLOAD_CONTROL.delete(taskId);

        } catch (err) {
            console.error('[MediaNab] 다운로드 오류:', err);
            HLS_DOWNLOAD_CONTROL.delete(taskId);
            emitStatus(taskId, 'error', err.message);
        }
    }

    async function downloadDirectMedia(taskId, mediaUrl, fileName, containerExt = 'mp4') {
        const downloadStartTime = Date.now();
        let downloadedBytes = 0;
        let lastProgressAt = 0;
        const ext = normalizeDirectMediaExt(containerExt || mediaUrl || fileName);

        try {
            if (!mediaUrl) throw new Error('Direct media URL missing');
            emitProgress(taskId, 0);

            const res = await _fetch(mediaUrl, { credentials: 'include' });
            if (!res.ok) throw new Error(`direct media fetch 실패: ${res.status}`);

            const totalBytes = Number(res.headers.get('content-length') || 0);
            const reader = res.body?.getReader ? res.body.getReader() : null;
            let index = 0;

            const emitDirectProgress = (force = false) => {
                const now = Date.now();
                if (!force && now - lastProgressAt < 350) return;
                lastProgressAt = now;
                const elapsedSec = (now - downloadStartTime) / 1000;
                let speedStr = '';
                let etaStr = '';
                if (elapsedSec > 0 && downloadedBytes > 0) {
                    const bytesPerSec = downloadedBytes / elapsedSec;
                    speedStr = formatSpeed(bytesPerSec);
                    if (totalBytes > 0 && bytesPerSec > 0) {
                        etaStr = formatTime((totalBytes - downloadedBytes) / bytesPerSec);
                    }
                }
                const percent = totalBytes > 0
                    ? Math.max(0, Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100)))
                    : 0;
                emitProgress(taskId, percent, speedStr, etaStr);
            };

            const shouldStop = () => {
                const controlState = HLS_DOWNLOAD_CONTROL.get(taskId);
                if (controlState?.status === 'cancelled' || controlState?.status === 'cancelling') {
                    emitStatus(
                        taskId,
                        'cancelled',
                        controlState?.error || `Cancelled via downloadControl (${controlState?.status || 'unknown'})`
                    );
                    HLS_DOWNLOAD_CONTROL.delete(taskId);
                    return true;
                }
                if (controlState?.status === 'error') {
                    HLS_DOWNLOAD_CONTROL.delete(taskId);
                    return true;
                }
                return false;
            };

            if (reader) {
                while (true) {
                    if (shouldStop()) return;
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!value || !value.byteLength) continue;
                    const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
                    downloadedBytes += value.byteLength;
                    window.dispatchEvent(new CustomEvent(DL_EVENTS.chunk, {
                        detail: { taskId, buf, index, total: totalBytes || 0 }
                    }));
                    index += 1;
                    emitDirectProgress(false);
                    await sleep(10);
                }
            } else {
                if (shouldStop()) return;
                const buf = await res.arrayBuffer();
                downloadedBytes = buf.byteLength;
                if (!downloadedBytes) throw new Error('빈 응답');
                window.dispatchEvent(new CustomEvent(DL_EVENTS.chunk, {
                    detail: { taskId, buf, index: 0, total: downloadedBytes }
                }));
                emitDirectProgress(true);
            }

            emitProgress(taskId, 100);
            window.dispatchEvent(new CustomEvent(DL_EVENTS.allChunksSent, {
                detail: { taskId, fileName, containerExt: ext }
            }));
            HLS_DOWNLOAD_CONTROL.delete(taskId);
        } catch (err) {
            console.error('[MediaNab] direct media 다운로드 오류:', err);
            HLS_DOWNLOAD_CONTROL.delete(taskId);
            emitStatus(taskId, 'error', err.message);
        }
    }

    function normalizeDirectMediaExt(value = '') {
        const match = String(value || '').match(/\.?(mp4|m4v|webm|mkv|flv)(?:[?#]|$)/i);
        return match ? match[1].toLowerCase() : 'mp4';
    }

    function selectHighestBandwidthStream(masterText, baseUrl) {
        return selectPreferredHlsStream(masterText, baseUrl);
    }

    function clampValue(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function parseTargetDuration(text) {
        const match = String(text || '').match(/#EXT-X-TARGETDURATION:(\d+)/i);
        const duration = match ? parseInt(match[1], 10) : 0;
        return Number.isFinite(duration) && duration > 0 ? duration : 3;
    }

    function makeSegmentKey(entry) {
        const range = entry?.byteRange
            ? `${entry.byteRange.offset || 0}:${entry.byteRange.length || 0}`
            : 'full';
        return `${entry?.kind || 'segment'}@@${entry?.url || ''}@@${range}`;
    }

    async function fetchPlaylistEntryBuffer(entry, taskId = '') {
        let buf = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const headers = {};
                if (entry.byteRange) {
                    const rangeEnd = entry.byteRange.offset + entry.byteRange.length - 1;
                    headers.Range = `bytes=${entry.byteRange.offset}-${rangeEnd}`;
                }
                const segmentRes = await fetchYouTubeLiveResource(entry.url, Object.keys(headers).length ? { headers } : {});
                if (!segmentRes.ok) {
                    const err = new Error(`HTTP ${segmentRes.status}`);
                    err.status = segmentRes.status;
                    throw err;
                }
                const fullBuf = await segmentRes.arrayBuffer();
                if (entry.byteRange && segmentRes.status === 200 && fullBuf.byteLength > entry.byteRange.length) {
                    const start = entry.byteRange.offset;
                    const end = start + entry.byteRange.length;
                    if (fullBuf.byteLength < end) throw new Error('BYTERANGE 응답이 예상보다 짧음');
                    buf = fullBuf.slice(start, end);
                } else {
                    buf = fullBuf;
                }
                if (buf.byteLength === 0) throw new Error('빈 응답');
                return buf;
            } catch (segmentError) {
                if (attempt < 2) await sleep(500 * (attempt + 1));
                else {
                    medianabLog('error', 'live.record', 'Live segment fetch failed', {
                        taskId,
                        kind: entry.kind || 'segment',
                        status: segmentError?.status || '',
                        error: segmentError?.message || String(segmentError),
                        url: String(entry.url || '').slice(0, 220),
                        hasByteRange: !!entry.byteRange,
                    });
                    throw segmentError;
                }
            }
        }
        return buf;
    }

    async function recordHLSLive(taskId, m3u8Url, fileName, recordMode = 'now', qualityPreference = {}) {
        const recordStartTime = Date.now();
        let recordedBytes = 0;
        let writtenSegments = 0;
        const includeCurrentWindow = recordMode === 'window';
        const originalLiveUrl = m3u8Url;

        try {
            medianabLog('info', 'live.record', 'Live recorder starting', {
                taskId,
                originalUrl: originalLiveUrl,
                fileName,
                recordMode,
                qualityLabel: qualityPreference.qualityLabel || '',
                qualityResolution: qualityPreference.qualityResolution || '',
            });
            let mediaUrl = await resolveFreshYouTubeLiveMediaUrl(originalLiveUrl, qualityPreference) || m3u8Url;
            let res = await fetchYouTubeLiveResource(mediaUrl, { cache: 'no-store' });
            if (!res.ok && isYouTubeHlsManifestUrl(mediaUrl)) {
                const refreshedUrl = await resolveFreshYouTubeLiveMediaUrl(originalLiveUrl, qualityPreference);
                if (refreshedUrl) {
                    mediaUrl = refreshedUrl;
                    res = await fetchYouTubeLiveResource(mediaUrl, { cache: 'no-store' });
                }
            }
            if (!res.ok) {
                medianabLog('error', 'live.record', 'Initial live playlist fetch failed', {
                    taskId,
                    mediaUrl,
                    status: res.status,
                });
                throw new Error(`m3u8 fetch 실패: ${res.status}`);
            }
            let text = await res.text();
            if (text.includes('#EXT-X-STREAM-INF')) {
                const nextMediaUrl = selectPreferredHlsStream(text, mediaUrl, qualityPreference);
                if (!nextMediaUrl) throw new Error('마스터 플레이리스트에서 서브 스트림을 찾지 못함');
                mediaUrl = nextMediaUrl;
                medianabLog('info', 'live.record', 'Master playlist resolved for live recorder', {
                    taskId,
                    mediaUrl,
                });
            }

            const seenSegments = new Set();
            let containerExt = 'ts';
            let primedInitialWindow = false;
            let loggedInitialWindow = false;
            let loggedFirstWrite = false;
            let pendingInitEntries = [];

            while (true) {
                const controlState = LIVE_RECORD_CONTROL.get(taskId);
                if (controlState?.status === 'error') {
                    LIVE_RECORD_CONTROL.delete(taskId);
                    return;
                }

                let playlistRes = await fetchYouTubeLiveResource(mediaUrl, { cache: 'no-store' });
                if (!playlistRes.ok && isYouTubeHlsManifestUrl(mediaUrl)) {
                    const refreshedUrl = await resolveFreshYouTubeLiveMediaUrl(originalLiveUrl, qualityPreference);
                    if (refreshedUrl) {
                        mediaUrl = refreshedUrl;
                        playlistRes = await fetchYouTubeLiveResource(mediaUrl, { cache: 'no-store' });
                    }
                }
                if (!playlistRes.ok) {
                    medianabLog('error', 'live.record', 'Live media playlist fetch failed', {
                        taskId,
                        mediaUrl,
                        status: playlistRes.status,
                    });
                    throw new Error(`라이브 playlist fetch 실패: ${playlistRes.status}`);
                }
                text = await playlistRes.text();
                if (!text.includes('#EXTINF')) {
                    throw new Error('라이브 미디어 플레이리스트가 아님');
                }

                const playlist = parseMediaPlaylist(text, mediaUrl);
                const pollMs = clampValue(Math.round(parseTargetDuration(text) * 750), 1000, 5000);
                containerExt = playlist.containerExt || containerExt;
                if (!loggedInitialWindow) {
                    const initialSegments = (playlist.entries || []).filter(entry => entry.kind === 'segment').length;
                    medianabLog('info', 'live.record', 'Live playlist initial window inspected', {
                        taskId,
                        recordMode,
                        includeCurrentWindow,
                        mediaUrl,
                        entries: (playlist.entries || []).length,
                        segments: initialSegments,
                        willSkipInitialWindow: !includeCurrentWindow,
                    });
                    loggedInitialWindow = true;
                }
                if (!primedInitialWindow && !includeCurrentWindow) {
                    pendingInitEntries = (playlist.entries || []).filter(entry => entry.kind === 'init');
                    for (const entry of playlist.entries || []) {
                        if (entry.kind !== 'segment') continue;
                        seenSegments.add(makeSegmentKey(entry));
                    }
                    primedInitialWindow = true;
                    medianabLog('info', 'live.record', 'Live recorder primed current playlist window', {
                        taskId,
                        recordMode,
                        skippedSegments: seenSegments.size,
                        pendingInitEntries: pendingInitEntries.length,
                    });
                    await sleep(pollMs);
                    continue;
                }
                primedInitialWindow = true;
                const preLoopControl = LIVE_RECORD_CONTROL.get(taskId);
                if (preLoopControl?.status === 'stopping' || preLoopControl?.status === 'stop') {
                    if (recordedBytes === 0) {
                        emitLiveStatus(taskId, 'error', 'No live media captured');
                    } else {
                        window.dispatchEvent(new CustomEvent(LIVE_EVENTS.finish, {
                            detail: { taskId, fileName, containerExt }
                        }));
                    }
                    LIVE_RECORD_CONTROL.delete(taskId);
                    return;
                }

                for (const entry of playlist.entries || []) {
                    const key = makeSegmentKey(entry);
                    if (seenSegments.has(key)) continue;

                    const stopState = LIVE_RECORD_CONTROL.get(taskId);
                    if (stopState?.status === 'stopping' || stopState?.status === 'stop') {
                        if (recordedBytes === 0) {
                            emitLiveStatus(taskId, 'error', 'No live media captured');
                            LIVE_RECORD_CONTROL.delete(taskId);
                            return;
                        }
                        window.dispatchEvent(new CustomEvent(LIVE_EVENTS.finish, {
                            detail: { taskId, fileName, containerExt }
                        }));
                        LIVE_RECORD_CONTROL.delete(taskId);
                        return;
                    }
                    if (stopState?.status === 'error') {
                        LIVE_RECORD_CONTROL.delete(taskId);
                        return;
                    }

                    if (entry.kind === 'segment' && pendingInitEntries.length) {
                        for (const initEntry of pendingInitEntries) {
                            const initKey = makeSegmentKey(initEntry);
                            if (seenSegments.has(initKey)) continue;
                            const initBuf = await fetchPlaylistEntryBuffer(initEntry, taskId);
                            seenSegments.add(initKey);
                            if (!initBuf || initBuf.byteLength <= 0) continue;
                            recordedBytes += initBuf.byteLength;
                            writtenSegments += 1;
                            window.dispatchEvent(new CustomEvent(LIVE_EVENTS.chunk, {
                                detail: { taskId, buf: initBuf, index: writtenSegments - 1, total: 0 }
                            }));
                        }
                        pendingInitEntries = [];
                    }

                    const buf = await fetchPlaylistEntryBuffer(entry, taskId);
                    seenSegments.add(key);
                    if (!buf || buf.byteLength <= 0) continue;
                    if (!loggedFirstWrite && entry.kind === 'segment') {
                        medianabLog('info', 'live.record', 'Live recorder writing first media segment', {
                            taskId,
                            recordMode,
                            includeCurrentWindow,
                            url: String(entry.url || '').slice(0, 220),
                            hasByteRange: !!entry.byteRange,
                        });
                        loggedFirstWrite = true;
                    }

                    recordedBytes += buf.byteLength;
                    writtenSegments += 1;
                    window.dispatchEvent(new CustomEvent(LIVE_EVENTS.chunk, {
                        detail: { taskId, buf, index: writtenSegments - 1, total: 0 }
                    }));
                    emitLiveProgress(taskId, Math.floor((Date.now() - recordStartTime) / 1000), recordedBytes);
                    await sleep(20);
                }

                if (text.includes('#EXT-X-ENDLIST')) {
                    if (recordedBytes === 0) throw new Error('No live media captured');
                    window.dispatchEvent(new CustomEvent(LIVE_EVENTS.finish, {
                        detail: { taskId, fileName, containerExt }
                    }));
                    medianabLog('info', 'live.record', 'Live recorder finished on ENDLIST', {
                        taskId,
                        bytes: recordedBytes,
                        segments: writtenSegments,
                        containerExt,
                    });
                    LIVE_RECORD_CONTROL.delete(taskId);
                    return;
                }

                await sleep(pollMs);
            }
        } catch (err) {
            console.error('[MediaNab] 라이브 녹화 오류:', err);
            medianabLog('error', 'live.record', 'Live recorder error', {
                taskId,
                error: err?.message || String(err),
                bytes: recordedBytes,
                segments: writtenSegments,
            });
            LIVE_RECORD_CONTROL.delete(taskId);
            emitLiveStatus(taskId, 'error', err.message);
        }
    }

    function resolvePlaylistUrl(baseUrl, value) {
        try {
            return new URL(value, baseUrl).href;
        } catch {
            const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
            return value.startsWith('http') ? value : base + value;
        }
    }

    function parseByteRangeSpec(value, fallbackOffset = 0, preferFallback = false) {
        const match = String(value || '').match(/(\d+)(?:@(\d+))?/);
        if (!match) return null;
        const length = parseInt(match[1], 10);
        const offset = match[2] ? parseInt(match[2], 10) : (preferFallback ? fallbackOffset : null);
        if (!length || (offset !== null && !Number.isFinite(offset))) return null;
        return { length, offset };
    }

    // ── m3u8 미디어 플레이리스트 파싱 (TS / fMP4 + EXT-X-MAP + BYTERANGE 지원) ──
    function parseMediaPlaylist(text, baseUrl) {
        const entries = [];
        const byteRangeCursor = new Map();
        let pendingByteRange = null;
        let containerExt = 'ts';

        for (const rawLine of text.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;

            if (line.startsWith('#EXT-X-MAP')) {
                const uriMatch = line.match(/URI="([^"]+)"/i);
                if (uriMatch?.[1]) {
                    const initUrl = resolvePlaylistUrl(baseUrl, uriMatch[1]);
                    const byteRangeMatch = line.match(/BYTERANGE="([^"]+)"/i);
                    const initRange = byteRangeMatch?.[1] ? parseByteRangeSpec(byteRangeMatch[1], 0, true) : null;
                    entries.push({ url: initUrl, byteRange: initRange, kind: 'init' });
                    containerExt = 'mp4';
                }
                continue;
            }

            if (line.startsWith('#EXT-X-BYTERANGE')) {
                pendingByteRange = parseByteRangeSpec(line.split(':')[1] || '', 0, false);
                continue;
            }

            if (line.startsWith('#')) continue;

            const segmentUrl = resolvePlaylistUrl(baseUrl, line);
            if (/\.(m4s|mp4|m4f|cmfv|ismv)(\?|#|$)/i.test(segmentUrl)) {
                containerExt = 'mp4';
            }

            let byteRange = null;
            if (pendingByteRange) {
                const defaultOffset = byteRangeCursor.get(segmentUrl) || 0;
                byteRange = {
                    length: pendingByteRange.length,
                    offset: pendingByteRange.offset != null ? pendingByteRange.offset : defaultOffset,
                };
                byteRangeCursor.set(segmentUrl, byteRange.offset + byteRange.length);
                pendingByteRange = null;
            }

            entries.push({ url: segmentUrl, byteRange, kind: 'segment' });
        }

        return { entries, containerExt };
    }

    // ── 헬퍼 ──
    function emitProgress(taskId, percent, speed = '', eta = '') {
        window.dispatchEvent(new CustomEvent(DL_EVENTS.progress, { detail: { taskId, percent, speed, eta } }));
    }
    function emitStatus(taskId, status, error = '') {
        window.dispatchEvent(new CustomEvent(DL_EVENTS.status, { detail: { taskId, status, error } }));
    }
    function emitLiveProgress(taskId, elapsedSec = 0, filesize = 0) {
        const bytesPerSec = elapsedSec > 0 && filesize > 0 ? filesize / elapsedSec : 0;
        window.dispatchEvent(new CustomEvent(LIVE_EVENTS.progress, {
            detail: {
                taskId,
                status: 'recording',
                elapsedSec,
                filesize,
                speed: bytesPerSec > 0 ? formatSpeed(bytesPerSec) : '',
            }
        }));
    }
    function emitLiveStatus(taskId, status, error = '') {
        window.dispatchEvent(new CustomEvent(LIVE_EVENTS.status, { detail: { taskId, status, error } }));
    }
    function formatSpeed(bytesPerSec) {
        if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(1)} B/s`;
        if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
        if (bytesPerSec < 1024 * 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
        return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
    }
    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '--:--';
        if (seconds < 60) return `00:${Math.floor(seconds).toString().padStart(2, '0')}`;
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        if (mins < 60) return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        const hours = Math.floor(mins / 60);
        const remainMins = mins % 60;
        return `${hours}:${remainMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

})();
