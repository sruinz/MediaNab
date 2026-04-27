// background.js — Service Worker
// 역할: 영상 감지/저장, m3u8 화질 파싱, 큐 관리, offscreen 중계, chrome.downloads

import './variant.js';

const MAX_CONCURRENT = 2;
const MAX_DEBUG_LOGS = 600;
const COOKIE_AUTH_SUPPRESS_MS = 10 * 60 * 1000;
let offscreenReady = false;
let creatingOffscreen = false;

// ── 직렬화 큐: storage read-modify-write 레이스 컨디션 방지 ──
let _storageQueue = Promise.resolve();
function serializedStorageOp(fn) {
    _storageQueue = _storageQueue.then(fn).catch(e => {
        console.warn('[MediaNab] storage op 오류:', e);
    });
    return _storageQueue;
}
// 마스터에서 파싱된 sub-playlist URL 블랙리스트 (동적)
const KNOWN_SUB_PLAYLISTS = new Set();
const _pendingNativePreviewRequests = new Map();
const _nativePreviewFailureAt = new Map();
const _pendingOffscreenPreviewRequests = new Map();
const _offscreenPreviewFailureAt = new Map();
const _pendingThumbnailRefreshTimers = new Map();
const _youtubeMetadataInflight = new Map();
const _cookieAuthRequiredUntil = new Map();
let _debugLogQueue = Promise.resolve();
const VARIANT_CONFIG = globalThis.__MEDIANAB_VARIANT__ || {
    buildVariant: 'full',
    flags: {
        enableYouTubeDetection: true,
        enableYouTubeDownload: true,
        enableYouTubeLiveRecord: true,
    },
    policy: {
        blockedStatus: 'blocked_by_channel_policy',
        blockedMessage: {
            ko: 'Google Web Store 정책으로 인해 이 빌드에서는 YouTube 다운로드/녹화를 지원하지 않습니다. Edge, Firefox 또는 direct build를 사용하세요.',
            en: 'Due to Google Web Store policy, this build does not support YouTube downloads or recording. Use the Edge, Firefox, or direct build.',
        },
    },
};

function getVariantPolicyMessage() {
    const lang = String(chrome.i18n?.getUILanguage?.() || 'en').toLowerCase();
    return /^ko\b/.test(lang)
        ? VARIANT_CONFIG.policy.blockedMessage.ko
        : VARIANT_CONFIG.policy.blockedMessage.en;
}

function isYouTubeBlockedForVariant(kind = 'download') {
    if (kind === 'live-record') return !VARIANT_CONFIG.flags.enableYouTubeLiveRecord;
    return !VARIANT_CONFIG.flags.enableYouTubeDownload;
}

function buildBlockedByChannelPolicyResponse(kind = 'download') {
    return {
        ok: false,
        status: VARIANT_CONFIG.policy.blockedStatus,
        policy: VARIANT_CONFIG.policy.blockedStatus,
        kind,
        message: getVariantPolicyMessage(),
    };
}

function resolveYouTubePolicyTarget(request = {}, kindHint = '') {
    const candidateKind = kindHint === 'live-record' || request.requestKind === 'live' || request.live_record || request.liveRecord
        ? 'live-record'
        : 'download';
    const urls = [
        request.url,
        request.sourceUrl,
        request.pageUrl,
        request.tabUrl,
        request.titleResolveUrl,
        request.itemUrl,
        request.downloadUrl,
        request.requestedItem?.tabUrl,
        request.requestedItem?.pageUrl,
        request.requestedItem?.url,
        request.requestedItem?.itemUrl,
        request.requestedItem?.downloadUrl,
        request.requestedDownload?.url,
        request.requestedDownload?.sourceUrl,
        request.requestedDownload?.pageUrl,
        request.requestedDownload?.tabUrl,
        request.requestedDownload?.titleResolveUrl,
        request.requestedDownload?.requestedItem?.tabUrl,
        request.requestedDownload?.requestedItem?.pageUrl,
        request.requestedDownload?.requestedItem?.url,
        request.requestedDownload?.requestedItem?.itemUrl,
        request.requestedDownload?.requestedItem?.downloadUrl,
    ];
    const isYouTube = urls.some(value => isYouTubeLikeUrl(value || ''));
    return { isYouTube, kind: candidateKind };
}

function assertYouTubeAllowedForVariant(request = {}, kindHint = '') {
    const target = resolveYouTubePolicyTarget(request, kindHint);
    if (!target.isYouTube) return;
    if (!isYouTubeBlockedForVariant(target.kind)) return;
    const error = new Error(getVariantPolicyMessage());
    error.code = VARIANT_CONFIG.policy.blockedStatus;
    error.kind = target.kind;
    throw error;
}

function summarizeDebugUrl(value) {
    const raw = String(value || '');
    if (!raw) return '';
    if (raw.startsWith('data:')) return raw.slice(0, 32) + '...';
    if (raw.startsWith('blob:')) return 'blob:...';
    if (/^\/?[A-Za-z]:[\\/]/.test(raw)) {
        return raw.length > 220 ? raw.slice(0, 217) + '...' : raw;
    }
    try {
        const u = new URL(raw);
        if (u.hostname.includes('youtube.com')) {
            const id = u.searchParams.get('v');
            return `${u.hostname}${u.pathname}${id ? `?v=${id}` : ''}`;
        }
        return `${u.hostname}${u.pathname}`.slice(0, 160);
    } catch {}
    return raw.length > 220 ? raw.slice(0, 217) + '...' : raw;
}

function sanitizeDebugData(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') return summarizeDebugUrl(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.slice(0, 12).map(v => sanitizeDebugData(v, depth + 1));
    }
    if (typeof value === 'object') {
        if (depth >= 2) return '[object]';
        const out = {};
        for (const [key, item] of Object.entries(value).slice(0, 24)) {
            out[key] = sanitizeDebugData(item, depth + 1);
        }
        return out;
    }
    return String(value);
}

function recordDebugLog(level, scope, message, data = {}, tabId = null) {
    const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        level: level || 'info',
        scope: scope || 'app',
        message: String(message || ''),
        tabId: Number.isFinite(Number(tabId)) ? Number(tabId) : null,
        data: sanitizeDebugData(data),
    };
    _debugLogQueue = _debugLogQueue.then(async () => {
        const { debugLogs = [] } = await chrome.storage.local.get('debugLogs');
        const logs = Array.isArray(debugLogs) ? debugLogs : [];
        logs.push(entry);
        await chrome.storage.local.set({ debugLogs: logs.slice(-MAX_DEBUG_LOGS) });
    }).catch((e) => {
        console.warn('[MediaNab] debug log 저장 실패:', e);
    });
    return _debugLogQueue;
}

function isHlsTask(task) {
    return !!task && (task.type === 'hls' || task.mode === 'hls' || task.mode === 'hls-native');
}

function isPageStreamDownloadTask(task) {
    return isHlsTask(task) || task?.mode === 'direct-native-stream';
}

function isLiveRecordTask(task) {
    return !!task && (
        task.type === 'live-hls' ||
        task.mode === 'live-record' ||
        task.mode === 'live-native' ||
        task.mode === 'live-ytdlp'
    );
}

function notifyHlsDownloadControl(task, status, error = '') {
    if (!isPageStreamDownloadTask(task) || !task?.tabId) return;
    chrome.tabs.sendMessage(task.tabId, {
        action: 'downloadControl',
        taskId: task.taskId,
        status,
        error: error || '',
    }).catch(() => {});
}

function notifyLiveRecordControl(task, status, error = '') {
    if (!isLiveRecordTask(task) || !task?.tabId) return;
    chrome.tabs.sendMessage(task.tabId, {
        action: 'liveRecordControl',
        taskId: task.taskId,
        status,
        error: error || '',
    }).catch(() => {});
}

// ── URL 분류 헬퍼 ──
function isTsSegment(url) {
    return /\.(ts|aac|fmp4|m4s)(\?|#|$)/i.test(url) || /\/seg[-_]\d+/i.test(url);
}
function isM3U8(url) {
    return /\.m3u8(\?|#|$)/i.test(url) || /\/(playlist|master|index)\.m3u8/i.test(url);
}
function isDirectVideoUrl(url) {
    return /\.(mp4|webm|flv|m4v|mkv)(\?|#|$)/i.test(String(url || ''));
}
function isLikelyPreviewDirectUrl(url) {
    return /\b(preview|trailer|sample|teaser|promo|snippet|thumb_?vid|preroll|midroll|postroll)\b/i.test(String(url || '')) ||
        /\/(ads?|advert|banner|commercials?|sponsor)\//i.test(String(url || ''));
}
function isPreviewVideoUrl(url) {
    const value = String(url || '');
    return value.startsWith('data:video/') || isDirectVideoUrl(value);
}
function parseLooseUrl(url = '') {
    if (!url) return null;
    try {
        return new URL(url);
    } catch {
        try {
            return new URL(`https://${url}`);
        } catch {
            return null;
        }
    }
}
function isYouTubeLikeUrl(url) {
    return /(^https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(String(url || ''));
}

function extractYouTubeVideoId(url = '') {
    if (!url) return '';
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

function extractYouTubeThumbnailVideoId(url = '') {
    const u = parseLooseUrl(url);
    if (!u || !/ytimg\.com$/i.test(u.hostname)) return '';
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(part => part === 'vi' || part === 'vi_webp');
    return idx >= 0 ? (parts[idx + 1] || '') : '';
}

function isYouTubeThumbnailForPage(thumbnail = '', pageUrl = '') {
    const pageId = extractYouTubeVideoId(pageUrl);
    const thumbnailId = extractYouTubeThumbnailVideoId(thumbnail);
    return !!pageId && !!thumbnailId && pageId === thumbnailId;
}

function buildYouTubeThumbnailUrl(url = '') {
    const id = extractYouTubeVideoId(url);
    if (!id) return '';
    return isYouTubeShortsUrl(url)
        ? `https://i.ytimg.com/vi/${id}/oardefault.jpg`
        : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function getTrustedYouTubeThumbnail(pageUrl = '', candidate = '') {
    const thumb = isInvalidThumbnailUrl(candidate) ? '' : String(candidate || '').trim();
    if (thumb && isYouTubeThumbnailForPage(thumb, pageUrl)) return thumb;
    return buildYouTubeThumbnailUrl(pageUrl);
}

function extractYouTubeItagFromUrl(url = '') {
    const match = String(url || '').match(/\/itag\/(\d+)(?:[/?#]|$)/i);
    return match ? match[1] : '';
}

function cleanYouTubeFormatId(value = '') {
    const text = String(value || '').trim();
    return text && text !== '0' ? text : '';
}

function buildYouTubeLiveWindowFormatSelector(task = {}) {
    const height = qualityHeight({
        height: Number(task.qualityHeight || 0),
        resolution: task.qualityResolution || '',
        label: task.qualityLabel || '',
    });
    return height > 0
        ? `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}][ext=mp4]/best[height<=${height}]`
        : '';
}

function extractYouTubeManifestVideoId(url = '') {
    const match = String(url || '').match(/\/id\/([^/?#]+)/i);
    const id = match?.[1] || '';
    return id.replace(/[.~].*$/u, '');
}

function buildYouTubeWatchUrlFromManifest(url = '') {
    const id = extractYouTubeManifestVideoId(url);
    return id ? `https://www.youtube.com/watch?v=${id}` : '';
}

function isYouTubeLiveManifestUrl(url = '') {
    const text = String(url || '');
    return /manifest\.googlevideo\.com\/api\/manifest\/hls_/i.test(text) && /yt_live_broadcast/i.test(text);
}

function isYouTubeLiveVariantManifestUrl(url = '') {
    return isYouTubeLiveManifestUrl(url) && /\/hls_variant(?:\/|$)/i.test(String(url || ''));
}

function normalizeYouTubeLiveTabUrl(manifestUrl = '', tabUrl = '') {
    if (!isYouTubeLiveManifestUrl(manifestUrl)) return tabUrl || '';
    const manifestId = extractYouTubeManifestVideoId(manifestUrl);
    if (!manifestId) return tabUrl || '';
    const tabVideoId = extractYouTubeVideoId(tabUrl);
    if (!tabVideoId || tabVideoId !== manifestId) {
        return buildYouTubeWatchUrlFromManifest(manifestUrl);
    }
    return tabUrl || buildYouTubeWatchUrlFromManifest(manifestUrl);
}

function getYouTubePageKey(url = '') {
    const id = extractYouTubeVideoId(url);
    if (id) return `yt:${id}`;
    if (!isYouTubeLikeUrl(url)) return '';
    return normalizeUrl(url);
}

function getCookieAuthRequiredMessage() {
    const lang = String(chrome.i18n?.getUILanguage?.() || 'en').toLowerCase();
    return lang.startsWith('ko')
        ? '브라우저 쿠키 인증이 필요합니다. MediaNab의 쿠키 인증에서 Chrome/Edge 또는 cookies.txt를 선택하세요.'
        : 'Browser cookie authentication is required. Select Chrome, Edge, or cookies.txt in MediaNab Cookie auth.';
}

function getCookieAuthCacheKey(url = '') {
    return getYouTubePageKey(url) || normalizeUrl(url || '');
}

function markCookieAuthRequired(url = '') {
    const key = getCookieAuthCacheKey(url);
    if (key) _cookieAuthRequiredUntil.set(key, Date.now() + COOKIE_AUTH_SUPPRESS_MS);
}

function clearCookieAuthRequired(url = '') {
    const key = getCookieAuthCacheKey(url);
    if (key) _cookieAuthRequiredUntil.delete(key);
}

function isCookieAuthSuppressed(url = '') {
    const key = getCookieAuthCacheKey(url);
    if (!key) return false;
    const until = _cookieAuthRequiredUntil.get(key) || 0;
    if (until > Date.now()) return true;
    _cookieAuthRequiredUntil.delete(key);
    return false;
}

function isCookieAuthRequiredResponse(response = {}) {
    return response?.status === 'cookie_auth_required' || response?.error_code === 'cookie_auth_required';
}

function isYouTubeShortsUrl(url = '') {
    if (!url) return false;
    const u = parseLooseUrl(url);
    return !!(u?.hostname.includes('youtube.com') && u.pathname.startsWith('/shorts/'));
}

function isYouTubeShortsEntryUrl(url = '', tabUrl = '') {
    return isYouTubeShortsUrl(tabUrl || '') || isYouTubeShortsUrl(url || '');
}

const _tabPaths = new Map();

function getPageContextKey(url = '') {
    const youTubeKey = getYouTubePageKey(url);
    if (youTubeKey) return youTubeKey;
    const parsed = parseLooseUrl(url);
    if (!parsed) return normalizeUrl(url || '');
    if (!/^https?:$/i.test(parsed.protocol)) return normalizeUrl(url || '');
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}${parsed.search || ''}`;
}

async function getCurrentTabContextKey(tabId) {
    if (!tabId || tabId < 0) return '';
    try {
        const tab = await chrome.tabs.get(tabId);
        return tab?.url ? getPageContextKey(tab.url) : '';
    } catch {
        return '';
    }
}

async function isTabContextCurrent(tabId, contextUrl = '') {
    if (!contextUrl) return true;
    const incomingKey = getPageContextKey(contextUrl);
    if (!incomingKey) return true;
    const currentKey = await getCurrentTabContextKey(tabId);
    return !currentKey || incomingKey === currentKey;
}

async function resetDetectedVideosForTabContext(tabId, contextUrl = '', reason = '') {
    if (!tabId || tabId < 0 || !contextUrl) return false;
    const nextKey = getPageContextKey(contextUrl);
    if (!nextKey) return false;
    const prevKey = _tabPaths.get(tabId);
    _tabPaths.set(tabId, nextKey);
    const explicitContextChange = !!prevKey && prevKey !== nextKey;

    const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
    const currentItems = detectedVideos[tabId] || [];
    const hasStaleStoredItems = currentItems.some(item => {
        const itemContextUrl = item?.tabUrl || item?.pageUrl || '';
        if (!itemContextUrl) return false;
        const itemKey = getPageContextKey(itemContextUrl);
        return itemKey && itemKey !== nextKey;
    });
    if (!explicitContextChange && !hasStaleStoredItems) return false;

    const removed = detectedVideos[tabId]?.length || 0;
    if (removed) {
        delete detectedVideos[tabId];
        await chrome.storage.local.set({ detectedVideos });
        chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    }
    recordDebugLog('info', 'detect.context', 'Page context changed; cleared detected items', {
        from: prevKey || '',
        to: nextKey,
        reason,
        removed,
    }, tabId);
    return removed > 0;
}

async function prepareDetectedContext(tabId, contextUrl = '', reason = '') {
    if (!contextUrl) return true;
    const incomingKey = getPageContextKey(contextUrl);
    if (!incomingKey) return true;
    const currentKey = await getCurrentTabContextKey(tabId);
    if (currentKey && incomingKey !== currentKey) {
        recordDebugLog('info', 'detect.context', 'Ignoring stale detected message', {
            incoming: incomingKey,
            current: currentKey,
            reason,
        }, tabId);
        return false;
    }
    await resetDetectedVideosForTabContext(tabId, contextUrl, reason);
    return true;
}

function isPollutedYouTubeUiTitle(title = '', url = '') {
    if (!isYouTubeLikeUrl(url)) return false;
    const text = normalizePageTitle(title);
    if (!text) return false;
    const compact = text.replace(/\s+/g, '');
    if (/^(검색|superthanks|구매)/i.test(compact)) return true;
    if (/(탭하여음소거해제|검색정보쇼핑|잠시후재생|재생목록포함|공유재생목록)/i.test(compact)) return true;
    if (/(Super\s*Thanks|구매\|?@|검색[_\s"“”']|탭하여 음소거 해제|잠시 후 재생)/i.test(text)) return true;
    const uiHits = (compact.match(/구독|댓글|공유|리믹스|좋아요|싫어요|조회수|정보|쇼핑|음소거/g) || []).length;
    return uiHits >= 2;
}

function shouldSkipRedundantYouTubeEntry(entries = [], url = '', tabUrl = '') {
    const pageKey = getYouTubePageKey(tabUrl || url);
    if (!pageKey) return false;
    return (entries || []).some(item =>
        shouldTreatAsYouTubeLiveHls(item) &&
        getYouTubePageKey(item?.tabUrl || item?.url || '') === pageKey
    );
}

function findYouTubeWatchEntryIndexForLive(entries = [], liveUrl = '', tabUrl = '') {
    if (!Array.isArray(entries) || !liveUrl) return -1;
    const livePageKey = getYouTubePageKey(tabUrl || buildYouTubeWatchUrlFromManifest(liveUrl) || liveUrl);
    if (!livePageKey) return -1;
    return entries.findIndex(item => {
        if (!item || item.type !== 'youtube') return false;
        if (isYouTubeShortsEntryUrl(item.url || '', item.tabUrl || '')) return false;
        return getYouTubePageKey(item.tabUrl || item.url || '') === livePageKey;
    });
}

function isYouTubeLiveHlsCandidate(item = null) {
    return item?.type === 'hls' &&
        isYouTubeLikeUrl(item?.tabUrl || '') &&
        /manifest\.googlevideo\.com\/api\/manifest\/hls_/i.test(String(item?.url || '')) &&
        /yt_live_broadcast/i.test(String(item?.url || ''));
}

function shouldTreatAsYouTubeLiveHls(item = null) {
    return item?.type === 'hls' && (item?.isLive || isYouTubeLiveHlsCandidate(item));
}

function promoteYouTubeWatchEntryToLiveHls(item = null, liveUrl = '', tabUrl = '') {
    if (!item || !liveUrl) return false;
    let changed = false;
    const nextTabUrl = normalizeYouTubeLiveTabUrl(liveUrl, tabUrl || item.tabUrl || item.url || '');
    if (item.type !== 'hls') { item.type = 'hls'; changed = true; }
    if (item.url !== liveUrl) { item.url = liveUrl; changed = true; }
    if (nextTabUrl && item.tabUrl !== nextTabUrl) { item.tabUrl = nextTabUrl; changed = true; }
    if (!item.isLive) { item.isLive = true; changed = true; }
    return changed;
}

async function promoteExistingYouTubeLiveManifest(tabId, manifestUrl = '', tabUrl = '') {
    if (!tabId || tabId < 0 || !isYouTubeLiveVariantManifestUrl(manifestUrl)) return false;
    const liveTabUrl = normalizeYouTubeLiveTabUrl(manifestUrl, tabUrl || buildYouTubeWatchUrlFromManifest(manifestUrl));
    if (!liveTabUrl || !(await isTabContextCurrent(tabId, liveTabUrl))) return false;
    const manifestQualities = await fetchQualities(manifestUrl).catch(() => null);
    let promoted = false;
    await serializedStorageOp(async () => {
        if (!(await prepareDetectedContext(tabId, liveTabUrl, 'live-manifest'))) return;
        const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
        const list = detectedVideos[tabId] || [];
        const seedIdx = findYouTubeWatchEntryIndexForLive(list, manifestUrl, liveTabUrl);
        if (seedIdx < 0) return;
        const item = list[seedIdx];
        let changed = promoteYouTubeWatchEntryToLiveHls(item, manifestUrl, liveTabUrl);
        const beforeDownloadStrategy = item.downloadStrategy || '';
        const beforePreviewStrategy = item.previewStrategy || '';
        applyEntryStrategies(item);
        if (item.downloadStrategy !== beforeDownloadStrategy || item.previewStrategy !== beforePreviewStrategy) {
            changed = true;
        }
        if (shouldApplyQualities(item, manifestQualities)) {
            item.qualities = manifestQualities;
            item.qualitiesSource = 'hls-manifest';
            changed = true;
        }
        const prunedRedundantYouTube = pruneRedundantYouTubeEntriesForLive(list, item);
        const prunedYouTubeWatch = prunePreviousYouTubeWatchEntries(list, item);
        if (changed || prunedRedundantYouTube || prunedYouTubeWatch) {
            await chrome.storage.local.set({ detectedVideos });
            chrome.action.setBadgeText({ text: list.length > 0 ? String(list.length) : '', tabId }).catch(() => {});
            recordDebugLog('info', 'detect.storage', 'YouTube live card promoted from manifest', {
                url: item.url,
                tabUrl: item.tabUrl || '',
                title: item.pageTitle || '',
                strategy: item.downloadStrategy || '',
                isLive: !!item.isLive,
                qualities: Array.isArray(item.qualities) ? item.qualities.length : 0,
                qualitiesSource: item.qualitiesSource || '',
            }, tabId);
            promoted = true;
        }
    });
    return promoted;
}

function pruneRedundantYouTubeEntriesForLive(entries = [], liveItem = null) {
    if (!Array.isArray(entries) || !shouldTreatAsYouTubeLiveHls(liveItem)) return false;
    const livePageKey = getYouTubePageKey(liveItem.tabUrl || liveItem.url || '');
    if (!livePageKey) return false;
    const liveTabKey = normalizeUrl(liveItem.tabUrl || liveItem.url || '');
    const before = entries.length;
    const filtered = entries.filter(entry => {
        if (entry === liveItem) return true;
        if (entry?.type !== 'youtube') return true;
        const entryPageKey = getYouTubePageKey(entry.tabUrl || entry.url || '');
        const entryTabKey = normalizeUrl(entry.tabUrl || entry.url || '');
        return !(entryPageKey === livePageKey || entryTabKey === liveTabKey);
    });
    if (filtered.length === before) return false;
    entries.splice(0, entries.length, ...filtered);
    return true;
}

function prunePreviousShortsEntries(entries = [], currentItem = null) {
    if (!Array.isArray(entries) || !currentItem) return false;
    if (!isYouTubeShortsEntryUrl(currentItem.url || '', currentItem.tabUrl || '')) return false;
    const before = entries.length;
    const filtered = entries.filter(entry =>
        entry === currentItem ||
        !isYouTubeShortsEntryUrl(entry?.url || '', entry?.tabUrl || '')
    );
    if (filtered.length === before) return false;
    entries.splice(0, entries.length, ...filtered);
    return true;
}

function prunePreviousYouTubeWatchEntries(entries = [], currentItem = null) {
    if (!Array.isArray(entries) || !currentItem) return false;
    const currentUrl = currentItem.tabUrl || currentItem.url || '';
    if (!isYouTubeLikeUrl(currentUrl) || isYouTubeShortsEntryUrl(currentItem.url || '', currentItem.tabUrl || '')) return false;
    const currentPageKey = getYouTubePageKey(currentUrl);
    if (!currentPageKey) return false;
    const before = entries.length;
    const filtered = entries.filter(entry => {
        if (entry === currentItem) return true;
        const entryUrl = entry?.tabUrl || entry?.url || '';
        if (!isYouTubeLikeUrl(entryUrl) && !isYouTubeLiveManifestUrl(entry?.url || '')) return true;
        if (isYouTubeShortsEntryUrl(entry?.url || '', entry?.tabUrl || '')) return true;
        const entryPageKey = getYouTubePageKey(entryUrl);
        return !entryPageKey || entryPageKey === currentPageKey;
    });
    if (filtered.length === before) return false;
    entries.splice(0, entries.length, ...filtered);
    return true;
}
// 화질별 서브 플레이리스트 제외: 정적 + 동적 블랙리스트
function isSubPlaylist(url) {
    const nKey = normalizeUrl(url);
    if (KNOWN_SUB_PLAYLISTS.has(nKey)) return true; // 동적 블랙리스트
    return /\/\d{3,4}p\//i.test(url);
}

function normalizeGoogleVideoManifestKey(url = '') {
    try {
        const raw = String(url || '');
        const parsed = parseLooseUrl(raw);
        if (!parsed || parsed.hostname !== 'manifest.googlevideo.com') return '';
        const typeMatch = raw.match(/\/hls_(variant|playlist)(?:\/|$)/i) || parsed.pathname.match(/\/hls_(variant|playlist)(?:\/|$)/i);
        const idMatch = raw.match(/\/id\/([^/?#]+)/i) || parsed.pathname.match(/\/id\/([^/?#]+)/i);
        const itagMatch = raw.match(/\/itag\/([^/?#]+)/i) || parsed.pathname.match(/\/itag\/([^/?#]+)/i);
        const type = typeMatch ? `hls_${typeMatch[1].toLowerCase()}` : 'hls';
        const videoId = idMatch?.[1] || parsed.searchParams.get('id') || '';
        const itag = itagMatch?.[1] || parsed.searchParams.get('itag') || '';
        return `${parsed.origin}/api/manifest/${type}${videoId ? `/id/${videoId}` : ''}${itag ? `/itag/${itag}` : ''}`;
    } catch {
        return '';
    }
}

function normalizeUrl(url) {
    try {
        const googleVideoKey = normalizeGoogleVideoManifestKey(url);
        if (googleVideoKey) return googleVideoKey;
        const u = new URL(url);
        // watch 페이지는 v 파라미터까지 포함해 구분
        if (u.hostname.includes('youtube.com')) {
            if (u.pathname === '/watch') {
                return u.origin + u.pathname + '?v=' + u.searchParams.get('v');
            }
            if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/')) {
                return u.origin + u.pathname;
            }
        }
        return u.origin + u.pathname; // 일반 URL: 쿼리 제거
    }
    catch { return url; }
}

function uniqueStrings(values = []) {
    return Array.from(new Set((values || []).map(value => String(value || '').trim()).filter(Boolean)));
}

function normalizeMediaUrlList(values = []) {
    return uniqueStrings(values.map(value => {
        const parsed = parseLooseUrl(value || '');
        return parsed ? parsed.href : String(value || '').trim();
    }));
}

function directMediaFingerprint(url = '') {
    const parsed = parseLooseUrl(url);
    if (!parsed || !isDirectVideoUrl(parsed.href)) return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    const fileName = decodeURIComponent(parts[parts.length - 1] || '').toLowerCase();
    if (fileName && fileName.length >= 8) return `file:${fileName}`;
    const tail = parts.slice(-3).map(part => decodeURIComponent(part || '').toLowerCase()).join('/');
    return tail ? `path:${tail}` : '';
}

function detectedItemUrls(item = {}) {
    return normalizeMediaUrlList([
        item.url || '',
        ...(Array.isArray(item.sourceUrls) ? item.sourceUrls : []),
        ...(Array.isArray(item.aliasUrls) ? item.aliasUrls : [])
    ]);
}

function detectedItemFingerprints(item = {}) {
    return new Set(detectedItemUrls(item).map(directMediaFingerprint).filter(Boolean));
}

function samePageContext(a = '', b = '') {
    if (!a || !b) return true;
    return getPageContextKey(a) === getPageContextKey(b);
}

function isDirectDetectedItem(item = {}) {
    return item?.type === 'mp4' || item?.downloadStrategy === 'direct-video' || isDirectVideoUrl(item?.url || '');
}

function normalizeIncomingMediaInfo(url = '', type = '', tabUrl = '', mediaInfo = {}) {
    const sourceUrls = normalizeMediaUrlList([
        ...(Array.isArray(mediaInfo?.sourceUrls) ? mediaInfo.sourceUrls : []),
        ...(isDirectVideoUrl(url) ? [url] : [])
    ]);
    const detectedOrigin = String(mediaInfo?.detectedOrigin || (mediaInfo?.mediaKey ? 'dom' : (type === 'mp4' ? 'content' : '')) || '');
    return {
        url,
        type,
        tabUrl: tabUrl || '',
        mediaKey: mediaInfo?.mediaKey ? String(mediaInfo.mediaKey) : '',
        mediaIndex: Number.isFinite(Number(mediaInfo?.mediaIndex)) ? Number(mediaInfo.mediaIndex) : undefined,
        sourceUrls,
        detectedOrigin
    };
}

function directIncomingFingerprints(incoming = {}) {
    return new Set(normalizeMediaUrlList([incoming.url || '', ...(incoming.sourceUrls || [])])
        .map(directMediaFingerprint)
        .filter(Boolean));
}

function entryUrlMatches(item = {}, url = '') {
    if (!url) return false;
    const target = normalizeUrl(url);
    return detectedItemUrls(item).some(itemUrl => normalizeUrl(itemUrl) === target);
}

function directMediaMatchesEntry(item = {}, incoming = {}) {
    if (!isDirectDetectedItem(item) || incoming.type !== 'mp4') return false;
    if (item.mediaKey && incoming.mediaKey) return item.mediaKey === incoming.mediaKey;
    if (incoming.mediaKey && item.mediaKey === incoming.mediaKey) return true;
    if (entryUrlMatches(item, incoming.url)) return true;

    if (!samePageContext(item.tabUrl || '', incoming.tabUrl || '')) return false;
    const itemFingerprints = detectedItemFingerprints(item);
    const incomingFingerprints = directIncomingFingerprints(incoming);
    const hasSharedFingerprint = [...incomingFingerprints].some(fp => itemFingerprints.has(fp));
    if (!hasSharedFingerprint) return false;

    const itemDomConfirmed = item.detectedOrigin === 'dom' || !!item.mediaKey;
    const incomingDomConfirmed = incoming.detectedOrigin === 'dom' || !!incoming.mediaKey;
    return !(itemDomConfirmed && incomingDomConfirmed);
}

function findDetectedVideoIndex(list = [], incoming = {}) {
    if (!Array.isArray(list) || !incoming?.url) return -1;
    if (incoming.type === 'mp4' || isDirectVideoUrl(incoming.url)) {
        return list.findIndex(item => directMediaMatchesEntry(item, { ...incoming, type: 'mp4' }));
    }
    const key = normalizeUrl(incoming.url);
    return list.findIndex(item => normalizeUrl(item.url) === key);
}

function findDetectedVideo(list = [], incoming = {}) {
    const idx = findDetectedVideoIndex(list, incoming);
    return idx >= 0 ? list[idx] : null;
}

function mergeDirectMediaFields(item = {}, incoming = {}) {
    if (!isDirectDetectedItem(item) || incoming.type !== 'mp4') return false;
    let changed = false;
    const sourceUrls = normalizeMediaUrlList([...(item.sourceUrls || []), ...(incoming.sourceUrls || [])]);
    const aliasUrls = normalizeMediaUrlList(item.aliasUrls || []);
    const previousUrl = item.url || '';

    if (incoming.detectedOrigin === 'dom' && incoming.url && item.url !== incoming.url) {
        if (previousUrl) aliasUrls.push(previousUrl);
        item.url = incoming.url;
        changed = true;
    } else if (incoming.url && item.url !== incoming.url) {
        aliasUrls.push(incoming.url);
    }

    if (incoming.url && incoming.detectedOrigin === 'dom' && !sourceUrls.includes(incoming.url)) {
        sourceUrls.push(incoming.url);
    }
    const nextSourceUrls = normalizeMediaUrlList(sourceUrls);
    const nextAliasUrls = normalizeMediaUrlList(aliasUrls).filter(alias => normalizeUrl(alias) !== normalizeUrl(item.url || ''));

    if (JSON.stringify(item.sourceUrls || []) !== JSON.stringify(nextSourceUrls)) {
        item.sourceUrls = nextSourceUrls;
        changed = true;
    }
    if (JSON.stringify(item.aliasUrls || []) !== JSON.stringify(nextAliasUrls)) {
        item.aliasUrls = nextAliasUrls;
        changed = true;
    }
    if (incoming.mediaKey && item.mediaKey !== incoming.mediaKey) {
        item.mediaKey = incoming.mediaKey;
        changed = true;
    }
    if (Number.isFinite(Number(incoming.mediaIndex)) && item.mediaIndex !== incoming.mediaIndex) {
        item.mediaIndex = incoming.mediaIndex;
        changed = true;
    }
    const nextOrigin = incoming.detectedOrigin === 'dom' ? 'dom' : (item.detectedOrigin || incoming.detectedOrigin || '');
    if (nextOrigin && item.detectedOrigin !== nextOrigin) {
        item.detectedOrigin = nextOrigin;
        changed = true;
    }
    return changed;
}

function incomingMediaInfoFromItem(item = {}) {
    return normalizeIncomingMediaInfo(item.url || '', 'mp4', item.tabUrl || '', {
        mediaKey: item.mediaKey || '',
        mediaIndex: item.mediaIndex,
        sourceUrls: Array.isArray(item.sourceUrls) ? item.sourceUrls : [],
        detectedOrigin: item.detectedOrigin || (item.mediaKey ? 'dom' : '')
    });
}

function absorbDirectMediaMetadata(target = {}, source = {}) {
    let changed = mergeDirectMediaFields(target, incomingMediaInfoFromItem(source));
    if (!target.thumbnail && source.thumbnail) {
        target.thumbnail = source.thumbnail;
        target.thumbnailKind = source.thumbnailKind || target.thumbnailKind || 'unknown';
        changed = true;
    }
    if (!target.previewUrl && source.previewUrl) {
        target.previewUrl = source.previewUrl;
        changed = true;
    }
    if (!target.previewCandidateUrl && source.previewCandidateUrl) {
        target.previewCandidateUrl = source.previewCandidateUrl;
        changed = true;
    }
    if (!coercePreviewAsset(target.previewAsset) && coercePreviewAsset(source.previewAsset)) {
        target.previewAsset = source.previewAsset;
        changed = true;
    }
    if (shouldApplyQualities(target, source.qualities)) {
        target.qualities = source.qualities;
        changed = true;
    }
    if (!target.duration && source.duration) {
        target.duration = source.duration;
        changed = true;
    }
    const nextTitleSource = source.pageTitle ? normalizeTitleSource(source.titleSource || 'unknown') : '';
    if (shouldApplyPageTitle(target.pageTitle, source.pageTitle, target.tabUrl || source.tabUrl || target.url, target.titleSource || '', nextTitleSource)) {
        target.pageTitle = source.pageTitle;
        target.titleSource = nextTitleSource;
        changed = true;
    }
    if (source.tabUrl && !target.tabUrl) {
        target.tabUrl = source.tabUrl;
        changed = true;
    }
    if (changed) applyEntryStrategies(target);
    return changed;
}

function pruneDirectMediaDuplicateEntries(entries = []) {
    if (!Array.isArray(entries) || entries.length < 2) return { entries: Array.isArray(entries) ? entries : [], changed: false };
    const next = [...entries];
    let changed = false;

    for (let i = 0; i < next.length; i += 1) {
        const current = next[i];
        if (!isDirectDetectedItem(current)) continue;
        for (let j = i + 1; j < next.length; j += 1) {
            const candidate = next[j];
            if (!isDirectDetectedItem(candidate)) continue;
            const currentInfo = incomingMediaInfoFromItem(current);
            const candidateInfo = incomingMediaInfoFromItem(candidate);
            const bothDomConfirmed = !!currentInfo.mediaKey && !!candidateInfo.mediaKey;
            if (bothDomConfirmed && currentInfo.mediaKey !== candidateInfo.mediaKey) continue;
            if (!directMediaMatchesEntry(current, candidateInfo) && !directMediaMatchesEntry(candidate, currentInfo)) continue;

            const candidateDom = candidate.detectedOrigin === 'dom' || !!candidate.mediaKey;
            const currentDom = current.detectedOrigin === 'dom' || !!current.mediaKey;
            const targetIndex = candidateDom && !currentDom ? j : i;
            const sourceIndex = targetIndex === i ? j : i;
            const target = next[targetIndex];
            const source = next[sourceIndex];
            absorbDirectMediaMetadata(target, source);
            next.splice(sourceIndex, 1);
            changed = true;
            if (sourceIndex === i) {
                i -= 1;
                break;
            }
            j -= 1;
        }
    }

    return { entries: next, changed };
}

function scheduleDirectVideoSnapshotRefresh(tabId, url) {
    if (!tabId || tabId < 0 || !url) return;
    [350, 1200, 2800].forEach((delay) => {
        setTimeout(() => {
            requestDetectedThumbnail(tabId, url, 'mp4');
        }, delay);
    });
}

// ── webRequest로 m3u8만 감지 (content.js fetch 인터셉션과 중복 방지) ──
// content.js의 fetch 인터셉션에서 mp4/webm 등 직접 링크 처리
// webRequest는 m3u8 URI만 빠르게 잡는 역할만 담당
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        const url = details.url;
        const tabId = details.tabId;
        if (tabId < 0) return;
        if (isTsSegment(url)) return;
        const requestPageUrl = details.documentUrl || '';

        if (isDirectVideoUrl(url) && !isLikelyPreviewDirectUrl(url)) {
            recordDebugLog('info', 'detect.webRequest', 'Direct video detected', { url }, tabId);
            const mediaInfo = { detectedOrigin: 'webRequest', sourceUrls: [url] };
            if (requestPageUrl) {
                saveDetectedVideo(tabId, url, 'mp4', '', requestPageUrl, '', 'unknown', null, false, '', '', mediaInfo);
            } else {
                chrome.tabs.get(tabId)
                    .then(tab => saveDetectedVideo(tabId, url, 'mp4', '', tab?.url || '', '', 'unknown', null, false, '', '', mediaInfo))
                    .catch(() => saveDetectedVideo(tabId, url, 'mp4', '', '', '', 'unknown', null, false, '', '', mediaInfo));
            }
            scheduleDirectVideoSnapshotRefresh(tabId, url);
            return;
        }

        // 마스터 m3u8만 처리 (화질별 서브 플레이리스트 제외)
        if (isM3U8(url) && !isSubPlaylist(url)) {
            recordDebugLog('info', 'detect.webRequest', 'HLS manifest detected', { url }, tabId);
            const liveManifestPromotion = isYouTubeLiveVariantManifestUrl(url)
                ? promoteExistingYouTubeLiveManifest(tabId, url, requestPageUrl)
                : Promise.resolve(false);
            if (requestPageUrl) {
                saveDetectedVideo(tabId, url, 'hls', '', requestPageUrl);
            } else {
                chrome.tabs.get(tabId)
                    .then(tab => saveDetectedVideo(tabId, url, 'hls', '', tab?.url || ''))
                    .catch(() => saveDetectedVideo(tabId, url, 'hls'));
            }
            liveManifestPromotion.catch(() => {});
            // ★ content script에 파싱 요청: MAIN world에서 m3u8 fetch → qualities + thumbnail 반환
            // (XHR/fetch 상관없이 사이트 쿠키 포함하여 직접 요청)
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { action: 'fetchMetadata', url })
                    .catch(() => {});
            }, 400);
        }
    },
    { urls: ['<all_urls>'] }
);

// ── 메시지 처리 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.action === 'debugLog') {
        recordDebugLog(msg.level || 'info', msg.scope || 'external', msg.message || '', msg.data || {}, msg.tabId ?? sender.tab?.id)
            .then(() => sendResponse({ ok: true }))
            .catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === 'getDebugLogs') {
        chrome.storage.local.get('debugLogs').then(({ debugLogs = [] }) => {
            sendResponse({ ok: true, logs: Array.isArray(debugLogs) ? debugLogs : [] });
        });
        return true;
    }

    if (msg.action === 'clearDebugLogs') {
        chrome.storage.local.set({ debugLogs: [] }).then(() => sendResponse({ ok: true }));
        return true;
    }

    if (msg.action === 'pageContextChanged') {
        const tabId = sender.tab?.id;
        prepareDetectedContext(tabId, msg.tabUrl || sender.tab?.url || '', msg.reason || 'content')
            .then(ok => sendResponse({ ok }))
            .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
    }

    if (msg.action === 'videoDetected') {
        recordDebugLog('info', 'detect.content', 'Video detected', {
            type: msg.type,
            url: msg.url,
            tabUrl: msg.tabUrl,
            title: msg.pageTitle,
            qualities: Array.isArray(msg.qualities) ? msg.qualities.length : 0,
            thumbnailKind: msg.thumbnailKind || 'unknown',
            isLive: !!msg.isLive,
            mediaKey: msg.mediaKey || '',
            detectedOrigin: msg.detectedOrigin || '',
        }, sender.tab?.id);
        saveDetectedVideo(sender.tab?.id, msg.url, msg.type, msg.pageTitle, msg.tabUrl, msg.thumbnail || '', msg.thumbnailKind || 'unknown', msg.qualities || null, msg.isLive || false, msg.previewUrl || '', msg.titleSource || msg.pageTitleSource || '', {
            mediaKey: msg.mediaKey || '',
            mediaIndex: msg.mediaIndex,
            sourceUrls: Array.isArray(msg.sourceUrls) ? msg.sourceUrls : [],
            detectedOrigin: msg.detectedOrigin || (msg.mediaKey ? 'dom' : '')
        });
        sendResponse({ ok: true });
        return false;
    }

    // 화질 목록 업데이트 (content.js 파싱 완료 후)
    if (msg.action === 'updateQualities') {
        recordDebugLog('info', 'detect.qualities', 'Qualities update received', {
            url: msg.url,
            count: Array.isArray(msg.qualities) ? msg.qualities.length : 0,
            thumbnailKind: msg.thumbnailKind || 'unknown',
            title: msg.pageTitle || '',
            isLive: msg.isLive,
            mediaKey: msg.mediaKey || '',
        }, sender.tab?.id);
        updateVideoQualities(
            sender.tab?.id,
            msg.url,
            msg.qualities,
            msg.thumbnail || '',
            msg.thumbnailKind || 'unknown',
            msg.pageTitle || '',
            msg.isLive,
            msg.previewUrl || '',
            msg.tabUrl || sender.tab?.url || '',
            msg.titleSource || msg.pageTitleSource || '',
            {
                mediaKey: msg.mediaKey || '',
                mediaIndex: msg.mediaIndex,
                sourceUrls: Array.isArray(msg.sourceUrls) ? msg.sourceUrls : [],
                detectedOrigin: msg.detectedOrigin || (msg.mediaKey ? 'dom' : '')
            }
        );
        sendResponse({ ok: true });
        return false;
    }

    // 비디오 메타 (썸네일, 재생시간) → 가장 최근 감지된 영상에 매핑
    if (msg.action === 'videoMeta') {
        updateLatestVideoMeta(
            sender.tab?.id,
            msg.thumbnail,
            msg.thumbnailKind || 'unknown',
            msg.duration,
            msg.sourceUrl || '',
            msg.sourceType || '',
            msg.previewUrl || '',
            msg.previewKind || '',
            msg.pageTitle || '',
            msg.tabUrl || sender.tab?.url || '',
            msg.titleSource || msg.pageTitleSource || '',
            {
                mediaKey: msg.mediaKey || '',
                mediaIndex: msg.mediaIndex,
                sourceUrls: Array.isArray(msg.sourceUrls) ? msg.sourceUrls : [],
                detectedOrigin: msg.detectedOrigin || (msg.mediaKey ? 'dom' : '')
            }
        );
        sendResponse({ ok: true });
        return false;
    }

    if (msg.action === 'thumbnailLoadFailed') {
        const tabId = Number(msg.tabId || sender.tab?.id || 0);
        const failedUrl = String(msg.thumbnail || '');
        const itemUrl = String(msg.url || '');
        serializedStorageOp(async () => {
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
            const item = findDetectedVideo(detectedVideos[tabId] || [], {
                url: itemUrl,
                type: isDirectVideoUrl(itemUrl) ? 'mp4' : '',
                tabUrl: '',
                detectedOrigin: 'lookup'
            });
            if (!item || !failedUrl) return;
            if (item.thumbnail === failedUrl) {
                item.thumbnail = '';
                item.thumbnailKind = 'unknown';
                item.thumbnailSource = '';
            }
            if (item.previewAsset?.url === failedUrl) {
                item.previewAsset = null;
            }
            applyEntryStrategies(item);
            await chrome.storage.local.set({ detectedVideos });
            recordDebugLog('warn', 'popup.thumbnail', 'Thumbnail image failed to load; requesting refresh', {
                url: item.url,
                thumbnail: failedUrl,
                type: item.type || '',
            }, tabId);
            if (item.type === 'hls') {
                scheduleHlsFollowupRefresh(tabId, item, {
                    force: true,
                    delays: [80, 1000, 2600]
                });
            } else {
                requestDetectedThumbnail(tabId, item.url, item.type || '');
            }
        }).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === 'getDetectedVideos') {
        getDetectedVideos(msg.tabId).then(v => sendResponse(v));
        return true;
    }

    if (msg.action === 'fetchPreviewResource') {
        const tabId = Number(msg.tabId || 0);
        if (!tabId) {
            sendResponse({ ok: false, status: 0, error: 'missing-tab-id' });
            return false;
        }
        chrome.tabs.sendMessage(tabId, {
            action: 'fetchPreviewResourceInPage',
            url: msg.url || '',
            responseType: msg.responseType || 'text',
            byterange: msg.byterange || null
        }).then((response) => {
            sendResponse(response || { ok: false, status: 0, error: 'empty-preview-response' });
        }).catch((error) => {
            sendResponse({
                ok: false,
                status: 0,
                error: error?.message || String(error || 'preview-page-fetch-failed')
            });
        });
        return true;
    }

    if (msg.action === 'offscreen-previewProgress') {
        serializedStorageOp(async () => {
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
            const found = detectedVideos[msg.tabId]?.find(v => normalizeUrl(v.url) === normalizeUrl(msg.itemUrl));
            if (!found) return;
            if (!markPreviewDebug(found, 'offscreenPreview', msg.debug || '')) return;
            await chrome.storage.local.set({ detectedVideos });
        });
        sendResponse({ ok: true });
        return false;
    }

    if (msg.action === 'getQualities') {
        fetchQualities(msg.url).then(q => sendResponse(q));
        return true;
    }

    if (msg.action === 'queueDownloadRequest') {
        try {
            assertYouTubeAllowedForVariant(msg, msg.requestKind === 'live' ? 'live-record' : 'download');
        } catch (error) {
            sendResponse(buildBlockedByChannelPolicyResponse(error.kind || 'download'));
            return false;
        }
        const taskId = msg.taskId || msg.downloadId || `queued_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        recordDebugLog('info', 'queue.metadata', 'Download request queued for metadata validation', {
            taskId,
            requestKind: msg.requestKind || '',
            url: msg.url,
            tabUrl: msg.requestedItem?.tabUrl || msg.tabUrl || '',
            title: msg.requestedItem?.pageTitle || '',
            titleSource: msg.requestedItem?.titleSource || '',
        }, msg.tabId || sender.tab?.id);
        queueMetadataDownloadTask(taskId, msg, sender)
            .then(() => sendResponse({ ok: true, status: 'queued', taskId }))
            .catch(e => sendResponse({ ok: false, status: 'error', taskId, message: e.message }));
        return true;
    }

    if (msg.action === 'startDownload') {
        const taskId = msg.taskId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        recordDebugLog('info', 'queue.browserHls', 'Browser HLS download queued', {
            taskId,
            type: msg.type,
            url: msg.url,
            fileName: msg.fileName,
        }, msg.tabId || sender.tab?.id);
        queueTask(taskId, msg)
            .then(() => sendResponse({ ok: true, taskId }))
            .catch((e) => sendResponse({ ok: false, status: 'error', taskId, message: e.message }));
        return true;
    }

    if (msg.action === 'startLiveRecord') {
        try {
            assertYouTubeAllowedForVariant(msg, 'live-record');
        } catch (error) {
            sendResponse(buildBlockedByChannelPolicyResponse('live-record'));
            return false;
        }
        const taskId = msg.taskId || `live_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        recordDebugLog('info', 'queue.live', 'Live record queued', {
            taskId,
            url: msg.url,
            sourceUrl: msg.sourceUrl,
            fileName: msg.fileName,
            recordMode: msg.recordMode,
            qualityLabel: msg.qualityLabel,
            qualityResolution: msg.qualityResolution,
            qualityHeight: msg.qualityHeight || 0,
        }, msg.tabId || sender.tab?.id);
        queueLiveRecordTask(taskId, msg)
            .then(() => sendResponse({ ok: true, taskId }))
            .catch((e) => {
                if (e?.code === VARIANT_CONFIG.policy.blockedStatus) {
                    sendResponse(buildBlockedByChannelPolicyResponse('live-record'));
                    return;
                }
                sendResponse({ ok: false, status: 'error', taskId, message: e.message });
            });
        return true;
    }

    if (msg.action === 'stopLiveRecord') {
        stopLiveRecordTask(msg.taskId).then(() => sendResponse({ ok: true }));
        return true;
    }

    if (msg.action === 'cancelDownload') {
        cancelTask(msg.taskId).then(() => sendResponse({ ok: true }));
        return true;
    }

    if (msg.action === 'checkCancelled') {
        getTasks().then(tasks => {
            const t = tasks[msg.taskId];
            sendResponse({
                cancelled: t?.status === 'cancelling',
                errored: t?.status === 'error',
                missing: !t,
                status: t?.status || '',
            });
        });
        return true;
    }

    if (msg.action === 'downloadProgress') {
        const updates = { percent: msg.percent };
        if (msg.speed) updates.speed = msg.speed;
        if (msg.eta) updates.eta = msg.eta;
        updateTask(msg.taskId, updates).then(() => updateBadge());
        sendResponse({ ok: true });
        return false;
    }

    if (msg.action === 'liveRecordProgress') {
        getTasks().then((tasks) => {
            const task = tasks[msg.taskId];
            if (!task) {
                sendResponse({ ok: true });
                return;
            }
            const updates = {
                status: task.status === 'stopping' ? 'stopping' : (msg.status || 'recording'),
                elapsedSec: msg.elapsedSec || 0,
            };
            if (msg.speed) updates.speed = msg.speed;
            if (msg.filesize) updates.filesize = msg.filesize;
            updateTask(msg.taskId, updates).then(() => updateBadge());
            sendResponse({ ok: true });
        });
        return true;
    }

    if (msg.action === 'downloadStatus') {
        if (msg.status === 'error') {
            recordDebugLog('error', 'download.hls', 'Browser HLS download failed', {
                taskId: msg.taskId,
                error: msg.error || '',
            }, sender.tab?.id);
            getTasks().then(async (tasks) => {
                const task = tasks[msg.taskId];
                cleanupHlsRoute(msg.taskId);
                if (task?.storageBackend === 'companion') {
                    try { await cancelNativeHlsStream(msg.taskId); } catch {}
                }
                await updateTask(msg.taskId, {
                    status: 'error',
                    percent: 0,
                    error: msg.error || task?.error || 'Download failed',
                });
                notifyHlsDownloadControl(task, 'error', msg.error || task?.error || 'Download failed');
                updateBadge();
                processQueue();
            });
        } else if (msg.status === 'cancelled') {
            getTasks().then(async (tasks) => {
                const task = tasks[msg.taskId];
                cleanupHlsRoute(msg.taskId);
                if (task?.storageBackend === 'companion') {
                    try { await cancelNativeHlsStream(msg.taskId); } catch {}
                }
                if (!task) {
                    updateBadge();
                    processQueue();
                    return;
                }
                if (task.status === 'cancelling') {
                    await removeTask(msg.taskId);
                } else {
                    const cancelReason = msg.error
                        || `Unexpected HLS cancel path (taskStatus=${task.status || 'unknown'})`;
                    await updateTask(msg.taskId, {
                        status: 'error',
                        percent: task.percent || 0,
                        error: cancelReason,
                    });
                    notifyHlsDownloadControl(task, 'error', cancelReason);
                }
                updateBadge();
                processQueue();
            });
        }
        sendResponse({ ok: true });
        return false;
    }

    if (msg.action === 'liveRecordStatus') {
        if (msg.status === 'error') {
            recordDebugLog('error', 'live.record', 'Live record failed in page', {
                taskId: msg.taskId,
                error: msg.error || '',
            }, sender.tab?.id);
        }
        (async () => {
            const tasks = await getTasks();
            const task = tasks[msg.taskId];
            if (!task) {
                sendResponse({ ok: true });
                return;
            }
            cleanupHlsRoute(msg.taskId);
            if (task.storageBackend === 'companion') {
                try { await cancelNativeHlsStream(msg.taskId); } catch {}
            }
            await updateTask(msg.taskId, {
                status: 'error',
                percent: 0,
                error: msg.error || 'Live recording failed',
            });
            updateBadge();
            processQueue();
            sendResponse({ ok: true });
        })();
        return true;
    }

    // ── Companion (Native Messaging) 관련 핸들러 ──

    if (msg.action === 'companionCheckStatus') {
        recordDebugLog('info', 'companion.status', 'Companion status check requested', {}, sender.tab?.id);
        companionRequest({ action: 'checkStatus' })
            .then(r => {
                recordDebugLog(r?.status === 'ok' ? 'info' : 'warn', 'companion.status', 'Companion status response', {
                    status: r?.status,
                    version: r?.companion_version,
                    platform: r?.platform,
                    ytdlp: r?.ytdlp_version || '',
                    ytdlpInstalled: !!r?.ytdlp_installed,
                    denoInstalled: !!r?.deno_installed,
                    denoVersion: r?.deno_version || '',
                    ffmpegInstalled: !!r?.ffmpeg_installed,
                    cookieAuthMode: r?.cookie_auth_mode || 'off',
                    cookieAuthFileConfigured: !!r?.cookie_auth_file_configured,
                }, sender.tab?.id);
                sendResponse(r);
            })
            .catch(e => {
                recordDebugLog('error', 'companion.status', 'Companion status failed', { error: e.message }, sender.tab?.id);
                sendResponse({ status: 'disconnected', message: e.message });
            });
        return true;
    }

    if (msg.action === 'companionGetFormats') {
        if (isCookieAuthSuppressed(msg.url)) {
            sendResponse({ status: 'cookie_auth_required', message: getCookieAuthRequiredMessage() });
            return true;
        }
        recordDebugLog('info', 'youtube.formats', 'yt-dlp formats requested', { url: msg.url }, sender.tab?.id);
        companionRequest({ action: 'getFormats', url: msg.url })
            .then(r => {
                if (isCookieAuthRequiredResponse(r)) markCookieAuthRequired(msg.url);
                else if (r?.status === 'ok') clearCookieAuthRequired(msg.url);
                recordDebugLog(r?.status === 'ok' ? 'info' : (isCookieAuthRequiredResponse(r) ? 'warn' : 'error'), 'youtube.formats', 'yt-dlp formats response', {
                    url: msg.url,
                    status: r?.status,
                    title: r?.title || '',
                    count: Array.isArray(r?.formats) ? r.formats.length : 0,
                    message: r?.message || '',
                }, sender.tab?.id);
                sendResponse(isCookieAuthRequiredResponse(r) ? { ...r, message: r?.message || getCookieAuthRequiredMessage() } : r);
            })
            .catch(e => {
                recordDebugLog('error', 'youtube.formats', 'yt-dlp formats failed', { url: msg.url, error: e.message }, sender.tab?.id);
                sendResponse({ status: 'error', message: e.message });
            });
        return true;
    }

    if (msg.action === 'nativeDownload') {
        try {
            assertYouTubeAllowedForVariant(msg, msg.live_record ? 'live-record' : 'download');
        } catch (error) {
            sendResponse(buildBlockedByChannelPolicyResponse(error.kind || 'download'));
            return false;
        }
        const downloadId = msg.downloadId || `dl_${Date.now()}`;
        recordDebugLog('info', 'download.native', 'Native download requested', {
            downloadId,
            mode: msg.mode || 'ytdlp',
            url: msg.url,
            formatId: msg.format_id || '',
            requestedFormatId: msg.requested_format_id || msg.format_id || '',
            qualityLabel: msg.quality_label || '',
            qualityResolution: msg.quality_resolution || '',
            qualityHeight: msg.quality_height || 0,
            hasAudioUrl: !!msg.audio_url,
            fileName: msg.fileName,
            displayName: msg.displayName || '',
        }, sender.tab?.id);
        if (msg.queueBeforeStart) {
            queueNativeDownloadTask(downloadId, {
                url: msg.url,
                formatId: msg.format_id || '',
                requestedFormatId: msg.requested_format_id || msg.format_id || '',
                qualityLabel: msg.quality_label || '',
                qualityResolution: msg.quality_resolution || '',
                qualityHeight: Number(msg.quality_height || 0) || 0,
                downloadPath: msg.download_path || '',
                fileName: msg.fileName || '',
                displayName: msg.displayName || '',
                mode: msg.mode || 'ytdlp',
                referer: msg.referer || '',
                tabId: sender.tab?.id || msg.tabId || 0,
                audioUrl: msg.audio_url || '',
                videoExt: msg.video_ext || '',
                audioExt: msg.audio_ext || '',
                allowCookieAuth: !!msg.allow_cookie_auth,
                resolveTitleBeforeStart: !!msg.resolveTitleBeforeStart,
                titleResolveUrl: msg.titleResolveUrl || msg.url || '',
                type: isYouTubeLikeUrl(msg.titleResolveUrl || msg.url || '') ? 'youtube' : 'video',
            })
                .then(() => sendResponse({ status: 'queued', downloadId }))
                .catch(e => sendResponse({ status: 'error', message: e.message }));
            return true;
        }
        startNativeDownload(
            downloadId,
            msg.url,
            msg.format_id,
            msg.download_path,
            msg.fileName,
            msg.mode || 'ytdlp',
            msg.referer || '',
            {
                audioUrl: msg.audio_url || '',
                videoExt: msg.video_ext || '',
                audioExt: msg.audio_ext || '',
                displayName: msg.displayName || '',
                requestedFormatId: msg.requested_format_id || msg.format_id || '',
                qualityLabel: msg.quality_label || '',
                qualityResolution: msg.quality_resolution || '',
                qualityHeight: Number(msg.quality_height || 0) || 0,
                tabId: msg.tabId || sender.tab?.id || 0,
                allowCookieAuth: !!msg.allow_cookie_auth,
                directFallback: !!msg.directFallback,
                fallbackTabId: msg.fallbackTabId || msg.tabId || sender.tab?.id || 0,
                fallbackFileName: msg.fallbackFileName || '',
                fallbackType: msg.type || '',
                fallbackContainerExt: msg.containerExt || '',
                fallbackDownloadPath: msg.download_path || '',
                fallbackReferer: msg.referer || '',
            }
        )
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ status: 'error', message: e.message }));
        return true;
    }

    if (msg.action === 'directNativeStreamDownload') {
        const taskId = msg.taskId || `direct_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        recordDebugLog('info', 'download.direct', 'Direct native stream requested', {
            taskId,
            url: msg.url,
            fileName: msg.fileName || '',
            tabId: msg.tabId || sender.tab?.id || 0,
        }, msg.tabId || sender.tab?.id);
        startDirectNativeStreamDownload(taskId, msg, sender)
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ ok: false, status: 'error', taskId, error: e.message }));
        return true;
    }

    if (msg.action === 'nativeCancel') {
        companionRequest({ action: 'cancel', download_id: msg.downloadId })
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ status: 'error', message: e.message }));
        return true;
    }

    if (msg.action === 'companionSetConfig') {
        companionRequest({ action: 'setConfig', ...msg.config })
            .then(r => {
                if (r?.status === 'ok' && Object.keys(msg.config || {}).some(key => key.startsWith('cookie_auth_'))) {
                    _cookieAuthRequiredUntil.clear();
                }
                sendResponse(r);
            })
            .catch(e => sendResponse({ status: 'error', message: e.message }));
        return true;
    }

    if (msg.action === 'nativePlay') {
        companionRequest({ action: 'play', path: msg.filepath })
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ status: 'error', message: e.message }));
        return true;
    }

    if (msg.action === 'companionUpdateYtdlp') {
        companionRequest({ action: 'updateYtdlp' })
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ status: 'error', message: e.message }));
        return true;
    }

    if (msg.action === 'companionPickFolder') {
        companionRequest({ action: 'pickFolder', current_path: msg.current_path || '' })
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ status: 'error', message: e.message }));
        return true;
    }

    if (msg.action === 'companionPickCookiesFile') {
        companionRequest({ action: 'pickCookiesFile', current_path: msg.current_path || '' })
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ status: 'error', message: e.message }));
        return true;
    }

    if (msg.action === 'companionOpenFolder') {
        companionRequest({ action: 'openFolder', path: msg.path || '' })
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ status: 'error', message: e.message }));
        return true;
    }

    // ── MP4/직접 파일 다운로드 (chrome.downloads API) ──
    if (msg.action === 'directDownload') {
        startBrowserDirectDownload({
            taskId: msg.taskId || `browser_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            url: msg.url,
            fileName: msg.fileName || 'download',
            tabId: msg.tabId || sender.tab?.id || null,
            type: msg.type || 'mp4',
        }).then(r => sendResponse(r));
        return true;
    }

    if (msg.action === 'relayChunk') {
        (async () => {
            const route = _activeHlsStorage.get(msg.taskId) || (await getTasks())[msg.taskId]?.storageBackend || 'browser';
            if (route === 'companion') {
                try {
                    await writeNativeHlsChunk(msg.taskId, msg.bytes || []);
                    sendResponse({ ok: true });
                } catch (e) {
                    console.error('[BG] native HLS 청크 오류:', e.message);
                    cleanupHlsRoute(msg.taskId);
                    try { await cancelNativeHlsStream(msg.taskId); } catch {}
                    const tasks = await getTasks();
                    const task = tasks[msg.taskId];
                    await updateTask(msg.taskId, { status: 'error', percent: 0, error: e.message || 'Native HLS write failed' });
                    if (isLiveRecordTask(task)) notifyLiveRecordControl(task, 'error', e.message || 'Native HLS write failed');
                    else notifyHlsDownloadControl(task, 'error', e.message || 'Native HLS write failed');
                    updateBadge();
                    processQueue();
                    sendResponse({ ok: false, error: e.message });
                }
                return;
            }

            try {
                await ensureOffscreen();
                await chrome.runtime.sendMessage({
                    action: 'offscreen-chunk',
                    taskId: msg.taskId,
                    bytes: msg.bytes,
                    index: msg.index,
                    total: msg.total
                });
                sendResponse({ ok: true });
            } catch (e) {
                console.warn('[BG] offscreen 청크 오류:', e.message);
                const tasks = await getTasks();
                const task = tasks[msg.taskId];
                await updateTask(msg.taskId, { status: 'error', percent: 0, error: e.message || 'Offscreen write failed' });
                if (isLiveRecordTask(task)) notifyLiveRecordControl(task, 'error', e.message || 'Offscreen write failed');
                else notifyHlsDownloadControl(task, 'error', e.message || 'Offscreen write failed');
                updateBadge();
                processQueue();
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }

    if (msg.action === 'allChunksSent') {
        (async () => {
            const route = _activeHlsStorage.get(msg.taskId) || (await getTasks())[msg.taskId]?.storageBackend || 'browser';
            if (route === 'companion') {
                try {
                    const response = await finalizeNativeHlsStream(msg.taskId, msg.containerExt || 'ts', msg.fileName || '');
                    cleanupHlsRoute(msg.taskId);
                    const filePath = response.filepath || '';
                    const fileName = basenameFromPath(filePath) || msg.fileName || '';
                    const tasks = await getTasks();
                    const task = tasks[msg.taskId];
                    const updates = {
                        status: 'done',
                        percent: 100,
                        filePath,
                        fileName,
                    };
                    if (task?.mode === 'direct-native-stream') updates.mode = 'direct-native-stream';
                    else if (!isLiveRecordTask(task)) updates.mode = 'hls-native';
                    if (response.filesize) updates.filesize = response.filesize;
                    await updateTask(msg.taskId, updates);
                    updateBadge();
                    processQueue();
                    sendResponse({ ok: true, filepath: filePath });
                } catch (e) {
                    console.error('[BG] native HLS finalize 실패:', e.message);
                    cleanupHlsRoute(msg.taskId);
                    const tasks = await getTasks();
                    const task = tasks[msg.taskId];
                    await updateTask(msg.taskId, { status: 'error', percent: 0, error: e.message || 'Native HLS finalize failed' });
                    if (isLiveRecordTask(task)) notifyLiveRecordControl(task, 'error', e.message || 'Native HLS finalize failed');
                    else notifyHlsDownloadControl(task, 'error', e.message || 'Native HLS finalize failed');
                    updateBadge();
                    processQueue();
                    sendResponse({ ok: false, error: e.message });
                }
                return;
            }

            const finalFileName = replaceExtension(msg.fileName || 'video.ts', msg.containerExt || 'ts');
            chrome.runtime.sendMessage({
                action: 'offscreen-buildBlob',
                taskId: msg.taskId,
                fileName: finalFileName,
                containerExt: msg.containerExt || 'ts',
            }).catch(e => console.error('[BG] buildBlob 실패:', e));
            sendResponse({ ok: true });
        })();
        return true;
    }

    if (msg.action === 'offscreen-blobReady') {
        const { taskId, blobUrl, fileName } = msg;
        chrome.downloads.download({
            url: blobUrl,
            filename: sanitizeFilename(fileName),
            conflictAction: 'uniquify',
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error('[BG] 다운로드 실패:', chrome.runtime.lastError.message);
                updateTask(taskId, { status: 'error', percent: 0 });
            } else {
                // 완료 상태로 유지 (삭제하지 않음)
                updateTask(taskId, {
                    status: 'done',
                    percent: 100,
                    downloadId: downloadId,
                    fileName: sanitizeFilename(fileName)
                });
            }
            cleanupHlsRoute(taskId);
            updateBadge();
            processQueue();
        });
        sendResponse({ ok: true });
        return false;
    }

    if (msg.action === 'offscreen-error') {
        (async () => {
            const tasks = await getTasks();
            const task = tasks[msg.taskId];
            await updateTask(msg.taskId, { status: 'error', percent: 0, error: msg.error || 'Offscreen write failed' });
            if (isLiveRecordTask(task)) notifyLiveRecordControl(task, 'error', msg.error || 'Offscreen write failed');
            else notifyHlsDownloadControl(task, 'error', msg.error || 'Offscreen write failed');
            updateBadge();
            processQueue();
            sendResponse({ ok: true });
        })();
        return false;
    }

    return false;
});

// ── m3u8 마스터 플레이리스트 화질 목록 fetch ──
async function fetchQualities(m3u8Url) {
    try {
        const requestUrl = String(m3u8Url || '').startsWith('//')
            ? `https:${m3u8Url}`
            : (/^https?:\/\//i.test(String(m3u8Url || '')) ? String(m3u8Url || '') : `https://${m3u8Url}`);
        const res = await fetch(requestUrl);
        if (!res.ok) return null;
        const text = await res.text();
        if (!text.includes('#EXT-X-STREAM-INF')) {
            // 미디어 플레이리스트 (화질 하나뿐)
            return [{ label: 'Default', url: requestUrl, bandwidth: 0 }];
        }
        // 마스터 플레이리스트 파싱
        const base = requestUrl.substring(0, requestUrl.lastIndexOf('/') + 1);
        const lines = text.split('\n').map(l => l.trim());
        const qualities = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                const nameMatch = lines[i].match(/NAME="([^"]+)"/);
                const nextUrl = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : null;
                if (nextUrl) {
                    const fullUrl = nextUrl.startsWith('http') ? nextUrl : base + nextUrl;
                    const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                    const res = resMatch ? resMatch[1] : '';
                    const name = nameMatch ? nameMatch[1] : (res || `${Math.round(bw / 1000)}k`);
                    qualities.push({ label: name, url: fullUrl, bandwidth: bw, resolution: res });
                }
            }
        }
        // 화질 높은 순 정렬
        qualities.sort((a, b) => b.bandwidth - a.bandwidth);
        return qualities.length ? qualities : null;
    } catch (e) {
        console.error('[BG] 화질 파싱 오류:', e);
        return null;
    }
}

function inferDownloadStrategy({ url = '', type = '', tabUrl = '' } = {}) {
    if (type === 'hls' || isM3U8(url)) return 'browser-hls';
    if (isYouTubeLikeUrl(url) || isYouTubeLikeUrl(tabUrl)) return 'native-ytdlp';
    if (isDirectVideoUrl(url)) return 'direct-video';
    return 'browser-hls';
}

function makePreviewAsset(kind, url, source = '') {
    const assetUrl = String(url || '');
    if (!assetUrl) return null;
    if (kind === 'video' && !isPreviewVideoUrl(assetUrl)) return null;
    if ((kind === 'image' || kind === 'frame') && isInvalidThumbnailUrl(assetUrl)) return null;
    return {
        kind,
        url: assetUrl,
        source: source || '',
        updatedAt: Date.now(),
    };
}

function coercePreviewAsset(asset) {
    if (!asset || typeof asset !== 'object') return null;
    return makePreviewAsset(asset.kind, asset.url, asset.source || '');
}

function previewAssetRank(asset, type = '') {
    if (!asset?.url) return 0;
    if (asset.kind === 'video') {
        if (type !== 'hls') return 5;
        const source = String(asset.source || '');
        if (source === 'offscreen-preview') return 8;
        if (source === 'native-preview') return 7.25;
        if (source === 'hidden-video-preview') return 7;
        if (source === 'trusted-preview') return 6;
        if (source === 'preview-candidate') return 5;
        if (source === 'visible-video-preview') return 4;
        return 4;
    }
    if (asset.kind === 'frame') return 4;
    if (asset.kind === 'image') return isInlineThumbnail(asset.url) ? 3 : 2;
    return 0;
}

function shouldPromotePreviewAsset(currentAsset, nextAsset, type = '') {
    const current = coercePreviewAsset(currentAsset);
    const next = coercePreviewAsset(nextAsset);
    if (!next) return false;
    if (!current) return true;

    const currentRank = previewAssetRank(current, type);
    const nextRank = previewAssetRank(next, type);
    if (nextRank > currentRank) return true;
    if (nextRank < currentRank) return false;
    if (current.kind !== next.kind) return true;
    if (current.url === next.url) return false;

    if (next.kind === 'frame') return true;
    if (next.kind === 'image' && isInlineThumbnail(next.url) && !isInlineThumbnail(current.url)) return true;
    if (next.kind === 'video') {
        if (next.source && next.source !== current.source) return true;
        if (next.url !== current.url) return true;
    }
    return false;
}

function derivePreviewAsset(item) {
    if (!item) return null;
    const previewCandidateUrl = isPreviewVideoUrl(item.previewCandidateUrl || item.previewUrl)
        ? String(item.previewCandidateUrl || item.previewUrl)
        : '';
    const isYouTubeItem = isYouTubeLikeUrl(item.url) || isYouTubeLikeUrl(item.tabUrl);

    if (item.type === 'hls') {
        if (previewCandidateUrl) {
            return makePreviewAsset('video', previewCandidateUrl, 'trusted-preview');
        }
        if (item.thumbnailKind === 'frame' && item.thumbnail) {
            return makePreviewAsset('frame', item.thumbnail, 'video-frame');
        }
        if (item.thumbnail) {
            return makePreviewAsset('image', item.thumbnail, item.thumbnailSource || 'thumbnail');
        }
        return null;
    }

    if (previewCandidateUrl) {
        return makePreviewAsset('video', previewCandidateUrl, 'preview-candidate');
    }
    if (!isYouTubeItem && isDirectVideoUrl(item.url)) {
        return makePreviewAsset('video', item.url, 'direct-video');
    }
    if (item.thumbnailKind === 'frame' && item.thumbnail) {
        return makePreviewAsset('frame', item.thumbnail, 'video-frame');
    }
    if (item.thumbnail) {
        return makePreviewAsset('image', item.thumbnail, 'thumbnail');
    }
    return null;
}

function maybePromotePreviewAsset(item, nextAsset) {
    const next = coercePreviewAsset(nextAsset);
    if (!next) return false;
    if (!shouldPromotePreviewAsset(item.previewAsset, next, item.type)) return false;
    item.previewAsset = next;
    return true;
}

function inferPreviewStrategy({ url = '', type = '', tabUrl = '', previewAsset = null } = {}) {
    const asset = coercePreviewAsset(previewAsset);
    if (asset?.kind === 'video') return 'video';
    if (asset?.kind === 'frame') return 'frame';
    if (asset?.kind === 'image') return 'image';
    if (isYouTubeLikeUrl(url) || isYouTubeLikeUrl(tabUrl)) return 'image';
    if (type === 'hls') return 'image';
    if (isDirectVideoUrl(url)) return 'video';
    return 'image';
}

function applyEntryStrategies(item) {
    if (!item) return item;
    if (!item.previewCandidateUrl && isPreviewVideoUrl(item.previewUrl || '')) {
        item.previewCandidateUrl = item.previewUrl;
    }
    if (
        item.type === 'hls' &&
        item.previewAsset?.kind === 'video' &&
        !['native-preview', 'offscreen-preview', 'trusted-preview', 'hidden-video-preview', 'visible-video-preview'].includes(item.previewAsset?.source || '')
    ) {
        item.previewAsset = null;
    }
    const derivedPreviewAsset = derivePreviewAsset(item);
    if (derivedPreviewAsset) {
        maybePromotePreviewAsset(item, derivedPreviewAsset);
    }
    item.downloadStrategy = inferDownloadStrategy(item);
    item.previewStrategy = inferPreviewStrategy(item);
    return item;
}

function isInvalidThumbnailUrl(url) {
    const value = String(url || '').trim();
    if (!value || value === ';' || /^[;:,\s]+$/.test(value)) return true;
    if (/^(none|null|undefined|about:blank|javascript:)/i.test(value)) return true;
    if (value.startsWith('data:image/') || value.startsWith('blob:')) return false;
    const parsed = parseLooseUrl(value);
    if (!parsed || !/^https?:$/i.test(parsed.protocol)) return true;
    return /\.(mp4|webm|flv|m4v|mkv|m3u8)(\?|#|$)/i.test(value);
}

function isInlineThumbnail(url) {
    return typeof url === 'string' && url.startsWith('data:image/');
}

const HLS_REJECTED_THUMBNAIL_TTL_MS = 2 * 60 * 1000;
const _rejectedHlsOfficialThumbnails = new Map();

function isPlainChromeRuntime() {
    const ua = (globalThis.navigator?.userAgent || '');
    return /Chrome\//i.test(ua) && !/(Edg|OPR|Opera|Brave)\//i.test(ua);
}

function isSensitiveThumbnailPageUrl(url = '') {
    try {
        const host = parseLooseUrl(url)?.hostname || '';
        return /(^|\.)pornhub\.com$/i.test(host);
    } catch {
        return /pornhub\.com/i.test(String(url || ''));
    }
}

function isProbablyHtmlPageUrl(url = '') {
    const parsed = parseLooseUrl(url);
    if (!parsed || !/^https?:$/i.test(parsed.protocol)) return false;
    const path = (parsed.pathname || '').toLowerCase();
    if (!path || path === '/' || /\/$/.test(path)) return true;
    if (/\.(?:html?|php|aspx?|jsp)(?:$|[?#])/i.test(path)) return true;
    if (/\/(?:watch|view|view_video|video|post|article|humor|board)(?:[/.]|$)/i.test(path)) return true;
    return false;
}

function isLikelyRemoteImageCandidate(url = '') {
    if (!url || isInvalidThumbnailUrl(url)) return false;
    if (isInlineThumbnail(url) || String(url).startsWith('blob:')) return true;
    const parsed = parseLooseUrl(url);
    if (!parsed || !/^https?:$/i.test(parsed.protocol)) return false;
    const haystack = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    if (/\.(?:png|jpe?g|gif|webp|bmp|avif)(?:$|[?#/])/i.test(haystack)) return true;
    if (/(?:cover|poster|thumb|thumbnail|preview|image|original|plain|rs:fit)/i.test(haystack)) return true;
    return false;
}

function isSensitiveThumbnailHostUrl(url = '') {
    try {
        const host = parseLooseUrl(url)?.hostname || '';
        if (/(^|\.)phncdn\.com$/i.test(host)) return true;
        return /(^|\.)pornhub\.com$/i.test(host) && isLikelyRemoteImageCandidate(url) && !isProbablyHtmlPageUrl(url);
    } catch {
        return /phncdn/i.test(String(url || ''));
    }
}

function shouldVerifyHlsOfficialThumbnail(item, thumbnail = '') {
    if (!item || item.type !== 'hls' || !thumbnail || isInlineThumbnail(thumbnail)) return false;
    if (isPlainChromeRuntime()) return true;
    if (isSensitiveThumbnailHostUrl(thumbnail)) return true;
    if (isPlainChromeRuntime() && isSensitiveThumbnailPageUrl(item.tabUrl || item.url)) return true;
    return false;
}

function hlsRejectedThumbnailKey(tabId, item, thumbnail = '') {
    return `${tabId || 0}:${normalizeUrl(item?.url || '')}:${normalizeUrl(thumbnail || '')}`;
}

function rememberRejectedHlsThumbnail(tabId, item, thumbnail = '') {
    const key = hlsRejectedThumbnailKey(tabId, item, thumbnail);
    if (!key.endsWith(':')) _rejectedHlsOfficialThumbnails.set(key, Date.now());
}

function wasRejectedHlsThumbnail(tabId, item, thumbnail = '') {
    const key = hlsRejectedThumbnailKey(tabId, item, thumbnail);
    const rejectedAt = _rejectedHlsOfficialThumbnails.get(key) || 0;
    if (!rejectedAt) return false;
    if (Date.now() - rejectedAt > HLS_REJECTED_THUMBNAIL_TTL_MS) {
        _rejectedHlsOfficialThumbnails.delete(key);
        return false;
    }
    return true;
}

function isInlinePreviewVideo(url) {
    return typeof url === 'string' && url.startsWith('data:video/');
}

function isUsableHlsPreviewVideoUrl(url = '') {
    const value = String(url || '');
    if (!isPreviewVideoUrl(value)) return false;
    if (!value.startsWith('data:video/')) return true;
    return value.length > 4096;
}

function hasUsableHlsPreviewAsset(item) {
    return item?.type === 'hls' &&
        item.previewAsset?.kind === 'video' &&
        ['offscreen-preview', 'native-preview', 'trusted-preview', 'hidden-video-preview', 'visible-video-preview'].includes(item.previewAsset?.source || '') &&
        isUsableHlsPreviewVideoUrl(item.previewAsset?.url || '');
}

function isUntrustedChromeHlsPrimaryThumbnail(item) {
    if (!item || item.type !== 'hls' || !isPlainChromeRuntime()) return false;
    if (!item.thumbnail || isInlineThumbnail(item.thumbnail) || String(item.thumbnail).startsWith('blob:')) return false;
    if (!isHlsPrimaryThumbnailSource(item.thumbnailSource || '')) return false;
    if (isHlsPreviewThumbnailSource(item.thumbnailSource || '')) return false;
    return shouldVerifyHlsOfficialThumbnail(item, item.thumbnail);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

async function blobToDataUrl(blob) {
    const buffer = await blob.arrayBuffer();
    return `data:${blob.type || 'image/jpeg'};base64,${arrayBufferToBase64(buffer)}`;
}

function isLowInformationThumbnail(ctx, width, height) {
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

        if (!count) return true;
        const mean = sum / count;
        const variance = (sumSq / count) - (mean * mean);
        const range = max - min;

        return variance < 40 && range < 24;
    } catch {
        return false;
    }
}

async function captureTabRectAsThumbnail(tabId, rect, options = {}) {
    if (!tabId || !rect?.width || !rect?.height) return '';
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.windowId) return '';
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        if (!dataUrl) return '';
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);

        const dpr = rect.dpr || 1;
        const sx = clamp(Math.round(rect.left * dpr), 0, bitmap.width - 1);
        const sy = clamp(Math.round(rect.top * dpr), 0, bitmap.height - 1);
        const sw = clamp(Math.round(rect.width * dpr), 1, bitmap.width - sx);
        const sh = clamp(Math.round(rect.height * dpr), 1, bitmap.height - sy);
        if (sw <= 0 || sh <= 0) return '';

        const preserveAspect = !!options.preserveAspect;
        const sourceRatio = sw / Math.max(1, sh);
        const maxSide = preserveAspect ? 160 : 0;
        const outputWidth = preserveAspect
            ? clamp(Math.round(sourceRatio >= 1 ? maxSide : maxSide * sourceRatio), 48, maxSide)
            : 160;
        const outputHeight = preserveAspect
            ? clamp(Math.round(sourceRatio >= 1 ? maxSide / sourceRatio : maxSide), 48, maxSide)
            : 90;
        const canvas = new OffscreenCanvas(outputWidth, outputHeight);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return '';
        ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight);
        if (isLowInformationThumbnail(ctx, outputWidth, outputHeight)) return '';
        const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
        return await blobToDataUrl(thumbBlob);
    } catch (e) {
        console.warn('[MediaNab] HLS tab capture thumbnail 실패:', e);
        return '';
    }
}

async function fetchRemoteThumbnailAsDataUrl(url = '') {
    if (!url || isInvalidThumbnailUrl(url)) return '';
    if (isInlineThumbnail(url) || String(url).startsWith('blob:')) return String(url);
    try {
        const resp = await fetch(url, {
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
        });
        if (!resp.ok) return '';
        const type = resp.headers.get('content-type') || '';
        if (!type.startsWith('image/')) return '';
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        const sourceWidth = Math.max(1, bitmap.width || 1);
        const sourceHeight = Math.max(1, bitmap.height || 1);
        const maxSide = 360;
        const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
        const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
        const outputHeight = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = new OffscreenCanvas(outputWidth, outputHeight);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return '';
        ctx.drawImage(bitmap, 0, 0, outputWidth, outputHeight);
        if (isLowInformationThumbnail(ctx, outputWidth, outputHeight)) return '';
        const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
        return await blobToDataUrl(thumbBlob);
    } catch {
        return '';
    }
}

async function resolveHlsOfficialThumbnailForStorage(tabId, item, thumbnail = '', kind = 'unknown', rect = null) {
    if (!shouldVerifyHlsOfficialThumbnail(item, thumbnail)) {
        return normalizeHlsThumbnailForStorage(thumbnail, kind, {
            allowImage: !!(item?.isLive || !isYouTubeLikeUrl(item?.tabUrl || item?.url))
        });
    }

    const previouslyRejected = wasRejectedHlsThumbnail(tabId, item, thumbnail);
    if (previouslyRejected && !(rect?.width && rect?.height)) {
        return { thumbnail: '', kind: 'unknown' };
    }

    recordDebugLog('info', 'thumbnail.official', 'Official thumbnail candidate', {
        url: item.url || '',
        page: item.tabUrl || '',
        candidate: normalizeUrl(thumbnail),
        kind,
        chrome: isPlainChromeRuntime(),
    }, tabId);

    const invalidImageCandidate = !previouslyRejected && (!isLikelyRemoteImageCandidate(thumbnail) || isProbablyHtmlPageUrl(thumbnail));
    if (invalidImageCandidate) {
        rememberRejectedHlsThumbnail(tabId, item, thumbnail);
        recordDebugLog('warn', 'thumbnail.official', 'Official thumbnail rejected-non-image', {
            url: item.url || '',
            page: item.tabUrl || '',
            candidate: normalizeUrl(thumbnail),
        }, tabId);
        if (!(rect?.width && rect?.height)) {
            return { thumbnail: '', kind: 'unknown' };
        }
    }

    if (!previouslyRejected && !invalidImageCandidate) {
        const inlined = await fetchRemoteThumbnailAsDataUrl(thumbnail);
        if (inlined) {
            recordDebugLog('info', 'thumbnail.official', 'Official thumbnail validated', {
                url: item.url || '',
                page: item.tabUrl || '',
                candidate: normalizeUrl(thumbnail),
            }, tabId);
            return { thumbnail: inlined, kind: 'image', sourceHint: 'page-thumbnail' };
        }

        rememberRejectedHlsThumbnail(tabId, item, thumbnail);
        recordDebugLog('warn', 'thumbnail.official', 'Official thumbnail rejected-black', {
            url: item.url || '',
            page: item.tabUrl || '',
            candidate: normalizeUrl(thumbnail),
        }, tabId);
    }

    if (rect?.width && rect?.height) {
        recordDebugLog('info', 'thumbnail.official', 'Official thumbnail capture-fallback', {
            url: item.url || '',
            page: item.tabUrl || '',
            rect: {
                width: Math.round(Number(rect.width || 0)),
                height: Math.round(Number(rect.height || 0)),
            },
        }, tabId);
        const captured = await captureTabRectAsThumbnail(tabId, rect, { preserveAspect: true });
        if (captured) {
            recordDebugLog('info', 'thumbnail.official', 'Official thumbnail capture-ok', {
                url: item.url || '',
                page: item.tabUrl || '',
            }, tabId);
            return { thumbnail: captured, kind: 'image', sourceHint: 'page-thumbnail' };
        }
        recordDebugLog('warn', 'thumbnail.official', 'Official thumbnail capture-failed', {
            url: item.url || '',
            page: item.tabUrl || '',
        }, tabId);
    }

    return { thumbnail: '', kind: 'unknown' };
}

function getNativePreviewKey(tabId, item) {
    return `${tabId || 0}:${normalizeUrl(item?.url || '')}`;
}

function chooseHlsPreviewSource(item) {
    if (!item) return '';
    if (Array.isArray(item.qualities)) {
        const qualityUrl = item.qualities.find(q => q?.url)?.url;
        if (qualityUrl) return qualityUrl;
    }
    return item.url || '';
}

async function maybeRequestNativeHlsPreview(tabId, item, force = false) {
    if (!tabId || !item || item.type !== 'hls' || item.isLive) return;
    const sourceUrl = chooseHlsPreviewSource(item);
    if (!sourceUrl) return;
    if (!force) {
        const offscreenStatus = item.previewDebug?.offscreenPreview?.status || '';
        if (
            offscreenStatus === 'ok' &&
            item.previewAsset?.source === 'offscreen-preview' &&
            item.previewAsset?.kind === 'video' &&
            isUsableHlsPreviewVideoUrl(item.previewAsset?.url || '')
        ) return;
    }

    const key = getNativePreviewKey(tabId, item);
    if (_pendingNativePreviewRequests.has(key)) return _pendingNativePreviewRequests.get(key);
    if (!force) {
        const failedAt = _nativePreviewFailureAt.get(key) || 0;
        if (failedAt && (Date.now() - failedAt) < 60_000) return;
        if (
            item.previewAsset?.source === 'native-preview' &&
            item.previewAsset?.kind === 'video' &&
            isInlinePreviewVideo(item.previewAsset?.url || '') &&
            item.thumbnailKind === 'frame' &&
            isInlineThumbnail(item.thumbnail || '')
        ) {
            return;
        }
    }

    recordDebugLog('info', 'preview.hls', 'Native HLS thumbnail requested', {
        url: item.url,
        sourceUrl,
        force: !!force,
        qualities: Array.isArray(item.qualities) ? item.qualities.length : 0,
        duration: Math.floor(Number(item.duration || 0)),
    }, tabId);

    const offscreenPreviewDebug = item.previewDebug?.offscreenPreview || {};
    const offscreenStatus = String(offscreenPreviewDebug.status || '');
    const offscreenStage = String(offscreenPreviewDebug.stage || offscreenPreviewDebug.failedStage || '');
    const needsFullNativePreview = ['empty', 'error', 'still-only', 'invalid-preview'].includes(offscreenStatus) ||
        /^(clip-empty|compact-build-error)$/i.test(offscreenStage);

    const request = companionRequest({
        action: 'generatePreview',
        url: sourceUrl,
        referer: item.tabUrl || '',
        duration: item.duration || 0,
        thumbnail_only: !needsFullNativePreview,
    }).then(async (response) => {
        if (response?.status !== 'ok') {
            throw new Error(response?.message || 'preview generation failed');
        }

        const nextThumbnail = String(response.thumbnail || '');
        const nextThumbnailKind = response.thumbnail_kind || 'unknown';
        const nextPreviewUrl = isInlinePreviewVideo(response.preview_url || '') ? String(response.preview_url) : '';

        await serializedStorageOp(async () => {
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
            const found = detectedVideos[tabId]?.find(v => normalizeUrl(v.url) === normalizeUrl(item.url));
            if (!found) return;

            let changed = false;
            const offscreenStatus = found.previewDebug?.offscreenPreview?.status || '';
            const preserveOffscreenResult = offscreenStatus === 'ok' &&
                found.previewAsset?.source === 'offscreen-preview' &&
                found.previewAsset?.kind === 'video' &&
                isUsableHlsPreviewVideoUrl(found.previewAsset?.url || '');
            changed = markPreviewDebug(found, 'nativePreview', {
                status: (nextThumbnail || nextPreviewUrl) ? 'ok' : 'empty',
                source: 'native-preview',
                thumbnail: !!nextThumbnail,
                preview: !!nextPreviewUrl,
                thumbnailKind: nextThumbnailKind || ''
            }) || changed;
            if (!preserveOffscreenResult && nextThumbnail && shouldApplyStoredThumbnail(found, nextThumbnail, nextThumbnailKind, 'native-preview')) {
                found.thumbnail = nextThumbnail;
                found.thumbnailKind = nextThumbnailKind;
                found.thumbnailSource = 'native-preview';
                changed = true;
            }
            if (!preserveOffscreenResult && isUsableHlsPreviewVideoUrl(nextPreviewUrl)) {
                changed = maybePromotePreviewAsset(found, makePreviewAsset('video', nextPreviewUrl, 'native-preview')) || changed;
            } else if (!preserveOffscreenResult && nextThumbnail) {
                changed = maybePromotePreviewAsset(found, makePreviewAsset('frame', nextThumbnail, 'native-preview')) || changed;
            }
            applyEntryStrategies(found);
            if (changed) {
                await chrome.storage.local.set({ detectedVideos });
            }
        });

        _nativePreviewFailureAt.delete(key);
        recordDebugLog('info', 'preview.hls', 'Native HLS thumbnail generated', {
            url: item.url,
            sourceUrl,
            thumbnail: !!nextThumbnail,
            thumbnailKind: nextThumbnailKind || '',
        }, tabId);
    }).catch((e) => {
        _nativePreviewFailureAt.set(key, Date.now());
        serializedStorageOp(async () => {
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
            const found = detectedVideos[tabId]?.find(v => normalizeUrl(v.url) === normalizeUrl(item.url));
            if (!found) return;
            markPreviewDebug(found, 'nativePreview', {
                status: 'error',
                source: 'native-preview',
                error: e?.message || String(e || 'native preview failed')
            });
            await chrome.storage.local.set({ detectedVideos });
        });
        recordDebugLog('warn', 'preview.hls', 'Native HLS thumbnail failed', {
            url: item.url,
            sourceUrl,
            error: e?.message || String(e || 'native preview failed'),
        }, tabId);
        console.debug('[MediaNab] native HLS preview skipped:', e?.message || e);
    }).finally(() => {
        _pendingNativePreviewRequests.delete(key);
    });

    _pendingNativePreviewRequests.set(key, request);
    return request;
}

function getOffscreenPreviewKey(tabId, item) {
    return `${tabId || 0}:${normalizeUrl(chooseHlsPreviewSource(item))}:${Math.floor(Number(item?.duration || 0))}`;
}

async function maybeRequestOffscreenHlsPreview(tabId, item, force = false) {
    if (!tabId || !item || item.type !== 'hls' || item.isLive) return;
    const sourceUrl = chooseHlsPreviewSource(item);
    if (!sourceUrl) return;

    const key = getOffscreenPreviewKey(tabId, item);
    if (_pendingOffscreenPreviewRequests.has(key)) return _pendingOffscreenPreviewRequests.get(key);
    if (!force) {
        const failedAt = _offscreenPreviewFailureAt.get(key) || 0;
        if (failedAt && (Date.now() - failedAt) < 60_000) return;
        if (
            item.previewAsset?.source === 'offscreen-preview' &&
            item.previewAsset?.kind === 'video' &&
            isPreviewVideoUrl(item.previewAsset?.url || '') &&
            item.thumbnailKind === 'frame' &&
            !!item.thumbnail
        ) {
            return;
        }
    }

    const request = (async () => {
        await ensureOffscreen();
        await serializedStorageOp(async () => {
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
            const found = detectedVideos[tabId]?.find(v => normalizeUrl(v.url) === normalizeUrl(item.url));
            if (!found) return;
            if (markPreviewDebug(found, 'offscreenPreview', {
                status: 'requesting',
                source: 'offscreen-preview'
            })) {
                await chrome.storage.local.set({ detectedVideos });
            }
        });
        recordDebugLog('info', 'preview.hls', 'Offscreen HLS preview requested', {
            url: item.url,
            sourceUrl,
            force: !!force,
            qualities: Array.isArray(item.qualities) ? item.qualities.length : 0,
            duration: Math.floor(Number(item.duration || 0)),
        }, tabId);

        const response = await chrome.runtime.sendMessage({
            action: 'offscreen-generatePreview',
            type: 'hls',
            url: sourceUrl,
            duration: item.duration || 0,
            referer: item.tabUrl || '',
            tabId,
            itemUrl: item.url || sourceUrl,
        });
        if (!response?.ok) {
            const error = new Error(response?.error || 'offscreen preview generation failed');
            error.previewDebug = response?.debug || null;
            throw error;
        }

        const nextThumbnail = String(response.thumbnail || '');
        const nextPreviewUrl = isPreviewVideoUrl(response.previewUrl || '') ? String(response.previewUrl) : '';

        await serializedStorageOp(async () => {
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
            const found = detectedVideos[tabId]?.find(v => normalizeUrl(v.url) === normalizeUrl(item.url));
            if (!found) return;

            let changed = false;
            const offscreenDebug = response?.debug || {
                status: (nextThumbnail || nextPreviewUrl) ? 'ok' : 'empty',
                source: 'offscreen-preview',
                output: {
                    thumbnail: !!nextThumbnail,
                    preview: !!nextPreviewUrl
                }
            };
            if (nextThumbnail && !nextPreviewUrl && offscreenDebug && typeof offscreenDebug === 'object') {
                offscreenDebug.status = 'still-only';
            }
            changed = markPreviewDebug(found, 'offscreenPreview', offscreenDebug) || changed;
            if (nextThumbnail && shouldApplyStoredThumbnail(found, nextThumbnail, 'frame', 'offscreen-preview')) {
                found.thumbnail = nextThumbnail;
                found.thumbnailKind = 'frame';
                found.thumbnailSource = 'offscreen-preview';
                changed = true;
            }
            if (isUsableHlsPreviewVideoUrl(nextPreviewUrl)) {
                changed = maybePromotePreviewAsset(found, makePreviewAsset('video', nextPreviewUrl, 'offscreen-preview')) || changed;
            } else if (nextThumbnail) {
                changed = maybePromotePreviewAsset(found, makePreviewAsset('frame', nextThumbnail, 'offscreen-preview')) || changed;
            }
            applyEntryStrategies(found);
            if (changed) await chrome.storage.local.set({ detectedVideos });
        });

        _offscreenPreviewFailureAt.delete(key);
        recordDebugLog('info', 'preview.hls', 'Offscreen HLS preview generated', {
            url: item.url,
            sourceUrl,
            thumbnail: !!nextThumbnail,
            preview: !!nextPreviewUrl,
            status: response?.debug?.status || '',
            stage: response?.debug?.stage || '',
        }, tabId);
    })().catch((e) => {
        _offscreenPreviewFailureAt.set(key, Date.now());
        serializedStorageOp(async () => {
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
            const found = detectedVideos[tabId]?.find(v => normalizeUrl(v.url) === normalizeUrl(item.url));
            if (!found) return;
            markPreviewDebug(found, 'offscreenPreview', e?.previewDebug || {
                status: 'error',
                source: 'offscreen-preview',
                error: e?.message || String(e || 'offscreen preview failed')
            });
            await chrome.storage.local.set({ detectedVideos });
        });
        recordDebugLog('warn', 'preview.hls', 'Offscreen HLS preview failed', {
            url: item.url,
            sourceUrl,
            error: e?.message || String(e || 'offscreen preview failed'),
            status: e?.previewDebug?.status || '',
            stage: e?.previewDebug?.stage || '',
            failedStage: e?.previewDebug?.failedStage || '',
            detail: e?.previewDebug?.errorDetail || e?.previewDebug?.detail || '',
        }, tabId);
        console.debug('[MediaNab] offscreen HLS preview skipped:', e?.message || e);
    }).finally(() => {
        _pendingOffscreenPreviewRequests.delete(key);
    });

    _pendingOffscreenPreviewRequests.set(key, request);
    return request;
}

async function normalizeHlsThumbnailForStorage(thumbnail = '', kind = 'unknown', options = {}) {
    const allowImage = !!options.allowImage;
    const rawKind = String(kind || 'unknown').toLowerCase();
    if (!thumbnail || isInvalidThumbnailUrl(thumbnail)) return { thumbnail: '', kind: 'unknown' };
    if (rawKind === 'frame') return { thumbnail, kind: 'frame' };
    if (!allowImage) return { thumbnail: '', kind: 'unknown' };
    if (rawKind === 'capture') return { thumbnail, kind: 'capture' };
    if (/^(page|meta|og|twitter)-image$/.test(rawKind)) return { thumbnail, kind: 'image', sourceHint: 'page-thumbnail' };
    if (/^(poster|player)-image$/.test(rawKind)) return { thumbnail, kind: 'image', sourceHint: 'poster-thumbnail' };
    if (rawKind === 'image' || rawKind === 'image-url') return { thumbnail, kind: 'image' };
    if (String(thumbnail).startsWith('data:image/')) return { thumbnail, kind: 'image' };
    if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(String(thumbnail))) return { thumbnail, kind: 'image' };
    return { thumbnail: '', kind: 'unknown' };
}

function hlsThumbnailSourceForNormalized(next = {}) {
    if (next?.sourceHint) return next.sourceHint;
    if (next?.kind === 'frame') return 'video-frame';
    if (next?.kind === 'capture') return 'poster-capture';
    return next?.thumbnail ? 'thumbnail' : '';
}

function thumbnailRank(url, kind = 'unknown', type = '') {
    if (!url || isInvalidThumbnailUrl(url)) return 0;
    if (type === 'hls') {
        if (kind === 'frame') return 1;
        if (kind === 'image' || /^(page|meta|og|twitter|poster|player)-image$/.test(String(kind))) return isInlineThumbnail(url) ? 4 : 3;
        if (kind === 'image-url') return 2;
        if (kind === 'capture') return 1;
        return isInlineThumbnail(url) ? 3 : 1;
    }
    if (kind === 'frame') return 1;
    if (kind === 'capture') return 2;
    if (kind === 'image' || kind === 'image-url') return isInlineThumbnail(url) ? 4 : 3;
    return isInlineThumbnail(url) ? 2 : 1;
}

function hlsThumbnailSourceRank(source = '') {
    const value = String(source || '');
    if (value === 'offscreen-preview') return 9;
    if (value === 'native-preview') return 7.5;
    if (value === 'hidden-video-preview') return 7;
    if (value === 'visible-video-preview') return 6;
    if (value === 'video-frame') return 5;
    if (value === 'page-thumbnail') return 4;
    if (value === 'thumbnail') return 3;
    if (value === 'poster-thumbnail') return 2.5;
    if (value === 'poster-capture') return 2;
    return 1;
}

function isHlsPreviewThumbnailSource(source = '') {
    return /^(offscreen-preview|native-preview|hidden-video-preview|visible-video-preview|video-frame)$/i.test(String(source || ''));
}

function isHlsPrimaryThumbnailSource(source = '') {
    const value = String(source || '');
    return !value || value === 'thumbnail' || value === 'page-thumbnail' || value === 'poster-thumbnail' || value === 'poster-capture';
}

function shouldApplyThumbnail(currentThumbnail, currentKind, nextThumbnail, nextKind = 'unknown', type = '') {
    if (!nextThumbnail) return false;
    if (!currentThumbnail) return true;
    const currentRank = thumbnailRank(currentThumbnail, currentKind, type);
    const nextRank = thumbnailRank(nextThumbnail, nextKind, type);
    if (nextRank > currentRank) return true;
    if (nextRank < currentRank) return false;
    if ((nextKind === 'image' || nextKind === 'image-url') && currentKind !== nextKind && nextThumbnail !== currentThumbnail) {
        return true;
    }
    if (type === 'hls' && nextKind === 'frame') return false;
    return !isInlineThumbnail(currentThumbnail) && isInlineThumbnail(nextThumbnail) && (nextKind === 'image' || nextKind === 'frame');
}

function shouldApplyStoredThumbnail(item, nextThumbnail, nextKind = 'unknown', nextSource = '') {
    if (!item) return false;
    if (!nextThumbnail) return false;
    const currentThumbnail = item.thumbnail || '';
    const currentKind = item.thumbnailKind || 'unknown';
    const type = item.type || '';
    if (type === 'hls' && isHlsPreviewThumbnailSource(nextSource)) {
        return false;
    }
    if (!currentThumbnail) return true;
    if (type !== 'hls') {
        return shouldApplyThumbnail(currentThumbnail, currentKind, nextThumbnail, nextKind, type);
    }
    if (
        isHlsPreviewThumbnailSource(item.thumbnailSource || '') &&
        isHlsPrimaryThumbnailSource(nextSource) &&
        (nextKind === 'image' || nextKind === 'image-url')
    ) {
        return true;
    }

    const currentRank = thumbnailRank(currentThumbnail, currentKind, type);
    const nextRank = thumbnailRank(nextThumbnail, nextKind, type);
    if (nextRank > currentRank) return true;
    if (nextRank < currentRank) return false;

    const currentSourceRank = hlsThumbnailSourceRank(item.thumbnailSource || '');
    const nextSourceRank = hlsThumbnailSourceRank(nextSource);
    if (nextKind === 'frame' && currentKind === 'frame' && nextThumbnail !== currentThumbnail && nextSourceRank > currentSourceRank) {
        return true;
    }
    if ((nextKind === 'image' || nextKind === 'image-url') && currentKind === nextKind && nextThumbnail !== currentThumbnail && nextSourceRank > currentSourceRank) {
        return true;
    }
    if ((nextKind === 'image' || nextKind === 'image-url') && currentKind !== nextKind && nextThumbnail !== currentThumbnail) {
        return true;
    }
    if (type === 'hls' && nextKind === 'frame') return false;
    if (nextKind === 'frame' && currentKind !== 'frame') return true;
    return !isInlineThumbnail(currentThumbnail) && isInlineThumbnail(nextThumbnail) && (nextKind === 'image' || nextKind === 'frame');
}

function normalizePageTitle(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim();
}

function isWeakYouTubeLiveTitle(title = '') {
    const text = normalizePageTitle(title).replace(/\s*-\s*YouTube$/i, '').trim();
    return /^(youtube|live chat|실시간\s*채팅)$/i.test(text);
}

function normalizeTitleSource(source = '') {
    const value = String(source || '').trim();
    return ['media-scoped', 'metadata', 'document', 'youtube-navigation', 'youtube-metadata', 'unknown'].includes(value)
        ? value
        : 'unknown';
}

function titleSourceRank(source = '') {
    switch (normalizeTitleSource(source)) {
        case 'youtube-metadata': return 100;
        case 'youtube-navigation': return 95;
        case 'media-scoped': return 90;
        case 'metadata': return 70;
        case 'document': return 55;
        case 'unknown': return 10;
        default: return 0;
    }
}

function hostLabelFromAnyUrl(url = '') {
    try {
        const host = new URL(url).hostname.replace(/^www\./i, '');
        return host.split('.').slice(0, -1).join(' ') || host.split('.')[0] || '';
    } catch {
        return '';
    }
}

function pageTitleScore(title = '', url = '') {
    const text = normalizePageTitle(title)
        .replace(/^(?:\s*[\[［【][^\]］】]{1,20}[\]］】]\s*)+/u, '')
        .replace(/^(?:\s*\((?:[^)]{1,12})\)\s*)+/u, '')
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/\s*(?:\d{4}[./_-]\d{1,2}[./_-]\d{1,2}(?:\s*(?:AM|PM|오전|오후))?(?:\s+\d{1,2}[:._]\d{2}(?::\d{2})?)?)\s*$/iu, '')
        .replace(/\s*\(\d{1,4}\)\s*$/u, '')
        .replace(/\s*(?:\d{4}[./_-]\d{1,2}[./_-]\d{1,2}(?:\s*(?:AM|PM|오전|오후))?(?:\s+\d{1,2}[:._]\d{2}(?::\d{2})?)?)\s*$/iu, '')
        .trim();
    if (!text || text.length < 3) return -1000;
    if (isPollutedYouTubeUiTitle(text, url)) return -970;
    const lower = text.toLowerCase();
    const hostLabel = normalizePageTitle(hostLabelFromAnyUrl(url)).toLowerCase();
    if (hostLabel && (lower === hostLabel || lower === `${hostLabel}.com`)) return -1000;
    if (/^(youtube|youtube shorts|shorts|facebook|instagram|tiktok|twitter|x)$/i.test(text)) return -1000;
    if (/^(시청 기록|기록|watch history|history)$/i.test(text)) return -980;
    if (/^category[_\s-]*\d+$/i.test(text)) return -900;
    if (/^(category|video|mp4|file|download)$/i.test(text)) return -850;
    if (/(^|\s)(function\s+\w+\s*\(|window\.open\(|adsbygoogle|googlesyndication|return false|javascript:)/i.test(text)) return -950;
    if (/(돌아가기|아래로|위로|목록|댓글|복사|추천|공유)(\s+(돌아가기|아래로|위로|목록|댓글|복사|추천|공유))+/.test(text)) return -920;

    let score = Math.min(text.length, 80);
    if (/\s/.test(text)) score += 12;
    if (/[가-힣]/.test(text)) score += 10;
    if (/[0-9]/.test(text)) score += 4;
    if (/[[\]【】「」『』()]/.test(text)) score += 16;
    if (/(카테고리|게시판|커뮤니티|블로그|갤러리|forum|community|board|gallery|category)/i.test(text)) score -= 20;
    return score;
}

function shouldApplyPageTitle(currentTitle = '', nextTitle = '', url = '', currentSource = '', nextSource = 'unknown') {
    const nextScore = pageTitleScore(nextTitle, url);
    if (nextScore < 0) return false;
    const currentScore = pageTitleScore(currentTitle, url);
    if (currentScore < 0) return true;
    const currentRank = titleSourceRank(currentSource || (currentTitle ? 'unknown' : ''));
    const nextRank = titleSourceRank(nextSource || 'unknown');
    if (nextRank > currentRank) return true;
    if (nextRank < currentRank) return false;
    const currentText = normalizePageTitle(currentTitle);
    const nextText = normalizePageTitle(nextTitle);
    if (!currentText) return true;
    if (currentText === nextText) return false;
    if (nextRank <= titleSourceRank('unknown')) return false;
    if (nextScore > currentScore + 8) return true;
    return nextRank >= titleSourceRank('metadata') &&
        nextScore === currentScore &&
        nextText.length > currentText.length + 8;
}

function qualityCodecScore(q) {
    const codec = String(q?.vcodec || '').toLowerCase();
    if (codec.startsWith('avc1') || codec.startsWith('h264')) return 4;
    if (codec.startsWith('hev1') || codec.startsWith('hvc1')) return 3;
    if (codec.startsWith('vp9')) return 2;
    if (codec.startsWith('av01')) return 1;
    return 0;
}

function qualityHeight(q) {
    if (Number.isFinite(q?.height) && q.height > 0) return q.height;
    const raw = `${q?.resolution || ''} ${q?.label || ''}`;
    const match = raw.match(/(\d{3,4})p?/i);
    return match ? parseInt(match[1]) : 0;
}

function dedupeNativeQualities(qualities) {
    const bestByHeight = new Map();
    for (const quality of qualities || []) {
        if (!quality) continue;
        const height = qualityHeight(quality);
        const key = height > 0 ? String(height) : `${quality.label || ''}|${quality.id || quality.url || ''}`;
        const current = bestByHeight.get(key);
        if (!current) {
            bestByHeight.set(key, quality);
            continue;
        }
        const candidateScore = [
            qualityCodecScore(quality),
            quality.ext === 'mp4' ? 1 : 0,
            quality.filesize || 0,
        ];
        const currentScore = [
            qualityCodecScore(current),
            current.ext === 'mp4' ? 1 : 0,
            current.filesize || 0,
        ];
        const shouldReplace =
            candidateScore[0] > currentScore[0] ||
            (candidateScore[0] === currentScore[0] && candidateScore[1] > currentScore[1]) ||
            (candidateScore[0] === currentScore[0] && candidateScore[1] === currentScore[1] && candidateScore[2] > currentScore[2]);
        if (shouldReplace) bestByHeight.set(key, quality);
    }
    return Array.from(bestByHeight.values()).sort((a, b) => qualityHeight(b) - qualityHeight(a));
}

function mapCompanionFormats(formats) {
    return dedupeNativeQualities((formats || [])
        .filter(f => f && f.id)
        .map(f => ({
            id: f.id,
            label: f.label || (f.height ? `${f.height}p` : 'Default'),
            height: f.height || 0,
            width: f.width || 0,
            resolution: f.resolution || (f.height ? `${f.height}p` : ''),
            formatNote: f.format_note || '',
            ext: f.ext || 'mp4',
            filesize: f.filesize || 0,
            vcodec: f.vcodec || '',
            acodec: f.acodec || '',
        })));
}

function hasNativeFormatQualities(qualities) {
    return Array.isArray(qualities) && qualities.some(q => !!q?.id);
}

async function fetchYouTubeOEmbedMetadata(pageUrl = '') {
    const videoId = extractYouTubeVideoId(pageUrl);
    if (!videoId) return null;
    const canonicalUrl = isYouTubeShortsUrl(pageUrl)
        ? `https://www.youtube.com/shorts/${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`;
    try {
        const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonicalUrl)}`;
        const response = await fetch(endpoint, {
            cache: 'no-store',
            credentials: 'omit',
        });
        if (!response.ok) return null;
        const data = await response.json();
        const title = cleanNativeTitleCandidate(data?.title || '', pageUrl);
        const thumbnail = getTrustedYouTubeThumbnail(pageUrl, data?.thumbnail_url || '');
        if (!title) return null;
        return { title, thumbnail, metadataHydrating: true };
    } catch {
        return null;
    }
}

async function shouldAcceptYouTubeMetadataForTab(tabId, pageUrl = '') {
    if (!tabId || tabId < 0) return false;
    try {
        const tab = await chrome.tabs.get(tabId);
        const currentUrl = tab?.url || '';
        if (!currentUrl) return true;
        return getPageContextKey(currentUrl) === getPageContextKey(pageUrl);
    } catch {
        return false;
    }
}

async function applyTrustedYouTubeMetadata(tabId, pageUrl, metadata = {}) {
    if (!tabId || tabId < 0 || !isYouTubeLikeUrl(pageUrl)) return;
    const pageKey = getYouTubePageKey(pageUrl);
    if (!pageKey) return;
    const title = cleanNativeTitleCandidate(metadata.title || '', pageUrl);
    const qualities = mapCompanionFormats(metadata.formats || []);
    const thumbnail = getTrustedYouTubeThumbnail(pageUrl, metadata.thumbnail || '');
    const duration = Number(metadata.duration || 0) || 0;
    if (!title && !qualities.length && !thumbnail) return;

    await serializedStorageOp(async () => {
        if (!(await shouldAcceptYouTubeMetadataForTab(tabId, pageUrl))) {
            recordDebugLog('info', 'youtube.metadata', 'Ignoring stale YouTube metadata response', {
                url: pageUrl,
                pageKey,
            }, tabId);
            return;
        }

        const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
        if (!detectedVideos[tabId]) detectedVideos[tabId] = [];
        let item = detectedVideos[tabId].find(v =>
            shouldTreatAsYouTubeLiveHls(v) &&
            getYouTubePageKey(v.tabUrl || v.url || '') === pageKey
        );
        if (!item) {
            item = detectedVideos[tabId].find(v =>
                v?.type === 'youtube' &&
                (normalizeUrl(v.url || '') === normalizeUrl(pageUrl) || getYouTubePageKey(v.tabUrl || v.url || '') === pageKey)
            );
        }
        const action = item ? 'updated' : 'inserted';

        if (!item) {
            item = {
                url: pageUrl,
                type: 'youtube',
                pageTitle: '',
                tabUrl: pageUrl,
                addedAt: metadata.discoveredAt || Date.now(),
                thumbnail: '',
                thumbnailKind: 'unknown',
                thumbnailSource: '',
                duration: 0,
                qualities: null,
                isLive: false,
                previewUrl: '',
                previewCandidateUrl: '',
                previewAsset: null,
            };
            detectedVideos[tabId].push(item);
        }

        const isLiveHlsItem = shouldTreatAsYouTubeLiveHls(item);
        if (!isLiveHlsItem) {
            item.url = pageUrl;
            item.tabUrl = pageUrl;
        } else if (pageUrl && item.tabUrl !== pageUrl) {
            item.tabUrl = pageUrl;
        }
        if (title) {
            item.pageTitle = title;
            item.titleSource = 'youtube-metadata';
        }
        if (qualities.length && !isLiveHlsItem) {
            item.qualities = qualities;
            item.qualitiesSource = 'youtube-metadata';
            item.qualitiesVersion = metadata.ytdlp_version || '';
        }
        if (thumbnail) {
            item.thumbnail = thumbnail;
            item.thumbnailKind = 'image';
            item.thumbnailSource = 'youtube-metadata';
            if (!coercePreviewAsset(item.previewAsset)) {
                maybePromotePreviewAsset(item, makePreviewAsset('image', thumbnail, 'youtube-metadata'));
            }
        }
        if (duration && !item.duration) item.duration = duration;
        if (Object.prototype.hasOwnProperty.call(metadata, 'metadataHydrating')) {
            item.metadataHydrating = !!metadata.metadataHydrating;
        } else if (qualities.length) {
            item.metadataHydrating = false;
        }
        item.metadataResolved = true;

        applyEntryStrategies(item);
        prunePreviousShortsEntries(detectedVideos[tabId], item);
        prunePreviousYouTubeWatchEntries(detectedVideos[tabId], item);
        await chrome.storage.local.set({ detectedVideos });
        chrome.action.setBadgeText({ text: String(detectedVideos[tabId].length), tabId }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: '#1a73e8', tabId }).catch(() => {});
        recordDebugLog('info', 'youtube.metadata', `Trusted YouTube metadata ${action}`, {
            url: pageUrl,
            title: item.pageTitle || '',
            qualities: Array.isArray(item.qualities) ? item.qualities.length : 0,
            thumbnailKind: item.thumbnailKind || 'unknown',
        }, tabId);
    });
}

async function markYouTubeMetadataHydrateComplete(tabId, pageUrl = '') {
    const pageKey = getYouTubePageKey(pageUrl);
    if (!tabId || !pageKey) return;
    await serializedStorageOp(async () => {
        const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
        const item = detectedVideos[tabId]?.find(v =>
            (v?.type === 'youtube' || shouldTreatAsYouTubeLiveHls(v)) &&
            (normalizeUrl(v.url || '') === normalizeUrl(pageUrl) || getYouTubePageKey(v.tabUrl || v.url || '') === pageKey)
        );
        if (!item || item.metadataHydrating === false) return;
        item.metadataHydrating = false;
        await chrome.storage.local.set({ detectedVideos });
    });
}

function scheduleYouTubeMetadataHydrate(tabId, pageUrl = '', reason = '') {
    if (!tabId || tabId < 0 || !isYouTubeLikeUrl(pageUrl)) return;
    const pageKey = getYouTubePageKey(pageUrl);
    if (!pageKey) return;
    if (isCookieAuthSuppressed(pageUrl)) {
        recordDebugLog('info', 'youtube.metadata', 'Skipping trusted YouTube metadata while auth is required', {
            url: pageUrl,
            pageKey,
            reason,
        }, tabId);
        markYouTubeMetadataHydrateComplete(tabId, pageUrl).catch(() => {});
        return;
    }
    const key = `${tabId}|${pageKey}`;
    if (_youtubeMetadataInflight.has(key)) return;

    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const discoveredAt = Date.now();
    _youtubeMetadataInflight.set(key, { token, discoveredAt });
    recordDebugLog('info', 'youtube.metadata', 'Requesting trusted YouTube metadata', {
        url: pageUrl,
        pageKey,
        reason,
    }, tabId);

    fetchYouTubeOEmbedMetadata(pageUrl)
        .then(async (quickMetadata) => {
            if (_youtubeMetadataInflight.get(key)?.token !== token) return;
            if (!quickMetadata) return;
            recordDebugLog('info', 'youtube.metadata', 'Trusted YouTube quick metadata response', {
                url: pageUrl,
                title: quickMetadata.title || '',
                hasThumbnail: !!quickMetadata.thumbnail,
            }, tabId);
            await applyTrustedYouTubeMetadata(tabId, pageUrl, { ...quickMetadata, discoveredAt });
        })
        .catch(() => {});

    companionRequest({ action: 'getFormats', url: pageUrl })
        .then(async (response) => {
            if (_youtubeMetadataInflight.get(key)?.token !== token) return;
            if (isCookieAuthRequiredResponse(response)) markCookieAuthRequired(pageUrl);
            else if (response?.status === 'ok') clearCookieAuthRequired(pageUrl);
            recordDebugLog(response?.status === 'ok' ? 'info' : 'warn', 'youtube.metadata', 'Trusted YouTube metadata response', {
                url: pageUrl,
                status: response?.status || '',
                title: response?.title || '',
                count: Array.isArray(response?.formats) ? response.formats.length : 0,
                message: response?.message || '',
            }, tabId);
            if (response?.status !== 'ok') {
                await markYouTubeMetadataHydrateComplete(tabId, pageUrl);
                return;
            }
            await applyTrustedYouTubeMetadata(tabId, pageUrl, { ...response, metadataHydrating: false, discoveredAt });
        })
        .catch((error) => {
            recordDebugLog('warn', 'youtube.metadata', 'Trusted YouTube metadata failed', {
                url: pageUrl,
                error: error?.message || String(error),
            }, tabId);
            markYouTubeMetadataHydrateComplete(tabId, pageUrl).catch(() => {});
        })
        .finally(() => {
            if (_youtubeMetadataInflight.get(key)?.token === token) {
                _youtubeMetadataInflight.delete(key);
            }
        });
}

function clonePreviewDebugValue(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

function serializePreviewDebugValue(value) {
    if (value === undefined || value === null || value === '') return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function markPreviewDebug(item, key, value) {
    if (!item) return false;
    if (!item.previewDebug || typeof item.previewDebug !== 'object') item.previewDebug = {};
    const nextValue = clonePreviewDebugValue(value);
    const currentSerialized = serializePreviewDebugValue(item.previewDebug[key]);
    const nextSerialized = serializePreviewDebugValue(nextValue);
    if (currentSerialized === nextSerialized) return false;
    item.previewDebug[key] = nextValue;
    return true;
}

function shouldReplaceQualities(currentQualities, nextQualities) {
    if (!Array.isArray(nextQualities) || !nextQualities.length) return false;
    if (!Array.isArray(currentQualities) || !currentQualities.length) return true;
    if (nextQualities.length > currentQualities.length) return true;
    const currentWithResolution = currentQualities.filter(q => q?.resolution || q?.label).length;
    const nextWithResolution = nextQualities.filter(q => q?.resolution || q?.label).length;
    return nextWithResolution > currentWithResolution;
}

function hasUrlBackedQualities(qualities) {
    return Array.isArray(qualities) && qualities.some(q => !!q?.url);
}

function shouldApplyQualities(item = {}, nextQualities = null) {
    if (!Array.isArray(nextQualities) || !nextQualities.length) return false;
    const isLiveHls = shouldTreatAsYouTubeLiveHls(item);
    if (isLiveHls) {
        if (hasUrlBackedQualities(nextQualities) && !hasUrlBackedQualities(item.qualities)) return true;
        if (!hasUrlBackedQualities(nextQualities) && hasUrlBackedQualities(item.qualities)) return false;
    }
    return shouldReplaceQualities(item.qualities, nextQualities);
}

// ── 화질/썸네일/제목 업데이트 + sub-playlist 정리 ──
async function updateVideoQualities(tabId, url, qualities, thumbnail = '', thumbnailKind = 'unknown', pageTitle = '', isLive, previewUrl = '', tabUrl = '', titleSource = '', mediaInfo = {}) {
    if (!tabId) return;
    const incomingTabUrl = tabUrl || '';
    const normalizedLiveTabUrl = normalizeYouTubeLiveTabUrl(url, incomingTabUrl);
    const correctedDifferentYouTubeTab = !!incomingTabUrl &&
        !!normalizedLiveTabUrl &&
        normalizedLiveTabUrl !== incomingTabUrl &&
        !!extractYouTubeVideoId(incomingTabUrl);
    if (normalizedLiveTabUrl) tabUrl = normalizedLiveTabUrl;
    if (correctedDifferentYouTubeTab) {
        pageTitle = '';
        titleSource = '';
        thumbnail = '';
        thumbnailKind = 'unknown';
    }
    const contextReady = tabUrl
        ? prepareDetectedContext(tabId, tabUrl, 'qualities').catch(() => true)
        : Promise.resolve(true);
    try {
        await serializedStorageOp(async () => {
            if (!(await contextReady)) return;
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');

            // ★ sub-playlist URL 등록 및 storage에서 제거 (중복 항목 제거)
            if (qualities?.length) {
                let removed = false;
                for (const q of qualities) {
                    const nSubKey = normalizeUrl(q.url);
                    KNOWN_SUB_PLAYLISTS.add(nSubKey); // 동적 블랙리스트 등록
                    // 모든 탭에서 sub-playlist로 잘못 저장된 항목 삭제
                    for (const tid of Object.keys(detectedVideos)) {
                        const before = detectedVideos[tid]?.length || 0;
                        if (detectedVideos[tid]) {
                            detectedVideos[tid] = detectedVideos[tid].filter(v => normalizeUrl(v.url) !== nSubKey);
                            if (detectedVideos[tid].length < before) {
                                removed = true;
                                // 배지 업데이트
                                const cnt = detectedVideos[tid].length;
                                chrome.action.setBadgeText({ text: cnt > 0 ? cnt.toString() : '', tabId: parseInt(tid) })
                                    .catch(() => {});
                            }
                        }
                    }
                }
                if (removed) await chrome.storage.local.set({ detectedVideos });
            }

            const incomingMedia = normalizeIncomingMediaInfo(url, isDirectVideoUrl(url) ? 'mp4' : 'hls', tabUrl, mediaInfo);
            const list = detectedVideos[tabId] || [];
            let item = findDetectedVideo(list, incomingMedia);
            let changed = false;
            if (!item && isYouTubeLiveHlsCandidate({ type: 'hls', url, tabUrl, isLive: true })) {
                const seedIdx = findYouTubeWatchEntryIndexForLive(list, url, tabUrl);
                if (seedIdx >= 0) item = list[seedIdx];
            }
            if (!item) return;
            if (isYouTubeLiveHlsCandidate({ type: 'hls', url, tabUrl, isLive: true })) {
                changed = promoteYouTubeWatchEntryToLiveHls(item, url, tabUrl) || changed;
            }
            changed = mergeDirectMediaFields(item, incomingMedia) || changed;
            const liveCandidate = shouldTreatAsYouTubeLiveHls(item) || isYouTubeLiveHlsCandidate({
                type: item.type || 'hls',
                url,
                tabUrl: tabUrl || item.tabUrl || '',
                isLive: !!isLive
            });
            let nextPageTitle = liveCandidate && isWeakYouTubeLiveTitle(pageTitle) ? '' : pageTitle;
            if (item.type === 'youtube' && isYouTubeShortsEntryUrl(item.url, tabUrl || item.tabUrl)) {
                // Shorts titles are owned by the videoId-based metadata resolver.
                // DOM/page-data updates are too often stale during Shorts SPA scrolls.
                nextPageTitle = '';
            }
            const nextTitleSource = nextPageTitle ? normalizeTitleSource(titleSource || 'unknown') : '';
            if (tabUrl && item.tabUrl !== tabUrl) { item.tabUrl = tabUrl; changed = true; }
            if (shouldApplyQualities(item, qualities)) { item.qualities = qualities; changed = true; }
            if (previewUrl && !item.previewUrl) { item.previewUrl = previewUrl; changed = true; }
            if (previewUrl && !item.previewCandidateUrl) {
                item.previewCandidateUrl = previewUrl;
                changed = true;
                if (item.type === 'hls') {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('video', previewUrl, 'trusted-preview')) || changed;
                } else {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('video', previewUrl, 'preview-candidate')) || changed;
                }
            }
            if (item.type === 'hls') {
                const next = await resolveHlsOfficialThumbnailForStorage(tabId, item, thumbnail, thumbnailKind, null);
                const nextSource = hlsThumbnailSourceForNormalized(next);
                if (next.thumbnail && shouldApplyStoredThumbnail(item, next.thumbnail, next.kind, nextSource)) {
                    item.thumbnail = next.thumbnail;
                    item.thumbnailKind = next.kind;
                    item.thumbnailSource = nextSource;
                    changed = true;
                }
                if (next.kind === 'frame') {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('frame', next.thumbnail, 'video-frame')) || changed;
                } else if (!coercePreviewAsset(item.previewAsset) && next.thumbnail) {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('image', next.thumbnail, nextSource || 'thumbnail')) || changed;
                }
            } else if (
                !(item.type === 'youtube' && isYouTubeShortsEntryUrl(item.url, item.tabUrl || tabUrl) && (
                    thumbnailKind === 'frame' ||
                    thumbnailKind === 'capture' ||
                    (thumbnail && !isYouTubeThumbnailForPage(thumbnail, item.tabUrl || tabUrl || url))
                )) &&
                shouldApplyThumbnail(item.thumbnail, item.thumbnailKind, thumbnail, thumbnailKind, item.type)
            ) {
                item.thumbnail = thumbnail;
                item.thumbnailKind = thumbnailKind;
                changed = true;
                if (thumbnailKind === 'frame') {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('frame', thumbnail, 'video-frame')) || changed;
                } else if (!coercePreviewAsset(item.previewAsset) && thumbnail) {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('image', thumbnail, 'thumbnail')) || changed;
                }
            }
            if (shouldApplyPageTitle(item.pageTitle, nextPageTitle, item.tabUrl || url, item.titleSource || '', nextTitleSource)) {
                item.pageTitle = nextPageTitle;
                item.titleSource = nextTitleSource;
                changed = true;
            }
            if (typeof isLive === 'boolean') { item.isLive = isLive; changed = true; }
            let prunedRedundantYouTube = false;
            let prunedYouTubeWatch = false;
            if (item.isLive && pruneRedundantYouTubeEntriesForLive(detectedVideos[tabId], item)) {
                changed = true;
                prunedRedundantYouTube = true;
            }
            if (prunePreviousYouTubeWatchEntries(detectedVideos[tabId], item)) {
                changed = true;
                prunedYouTubeWatch = true;
            }
            const beforeDownloadStrategy = item.downloadStrategy;
            const beforePreviewStrategy = item.previewStrategy;
            applyEntryStrategies(item);
            if (item.downloadStrategy !== beforeDownloadStrategy || item.previewStrategy !== beforePreviewStrategy) changed = true;
            if (changed) {
                const prunedDirectMedia = pruneDirectMediaDuplicateEntries(detectedVideos[tabId] || []);
                if (prunedDirectMedia.changed) detectedVideos[tabId] = prunedDirectMedia.entries;
                await chrome.storage.local.set({ detectedVideos });
                if (prunedDirectMedia.changed || prunedRedundantYouTube || prunedYouTubeWatch) {
                    const count = detectedVideos[tabId].length;
                    chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId }).catch(() => {});
                }
            }
            if (item.type === 'hls') {
                scheduleHlsFollowupRefresh(tabId, item, {
                    force: true,
                    delays: [0, 300, 900, 1800, 2400]
                });
            }
        });
    } catch {}
}

async function requestPageSnapshot(tabId, url, type = '') {
    if (!tabId) return {};
    try {
        return await chrome.tabs.sendMessage(tabId, {
            action: 'requestPageSnapshot',
            type,
            sourceUrl: url
        });
    } catch {
        return {};
    }
}

function requestDetectedThumbnail(tabId, url, type = '') {
    chrome.tabs.sendMessage(tabId, { action: 'requestThumbnail', type, sourceUrl: url })
        .then((response) => {
            serializedStorageOp(async () => {
                let nextThumbnail = response?.thumbnail || '';
                let nextKind = response?.thumbnailKind || 'image';
                let nextRect = response?.rect || null;
                const responseTitle = response?.pageTitle || '';
                const responseTitleSource = responseTitle ? normalizeTitleSource(response?.pageTitleSource || response?.titleSource || 'unknown') : '';
                if (!nextThumbnail && nextRect?.width && nextRect?.height && !(type === 'youtube' && isYouTubeShortsUrl(url))) {
                    const captured = await captureTabRectAsThumbnail(tabId, nextRect, {
                        preserveAspect: type === 'youtube' && isYouTubeShortsUrl(url),
                    });
                    if (captured) {
                        nextThumbnail = captured;
                        nextKind = 'capture';
                    }
                }
                if (!nextThumbnail && !responseTitle) return;
                const { detectedVideos: dv2 = {} } = await chrome.storage.local.get('detectedVideos');
                const found = findDetectedVideo(dv2[tabId] || [], {
                    url,
                    type: isDirectVideoUrl(url) ? 'mp4' : (type || ''),
                    tabUrl: '',
                    detectedOrigin: 'lookup'
                });
                if (!found) return;
                let changed = false;
                if (found.type === 'hls') {
                    const next = await resolveHlsOfficialThumbnailForStorage(tabId, found, nextThumbnail, nextKind, nextRect);
                    if (next.kind === 'frame') return;
                    const nextSource = hlsThumbnailSourceForNormalized(next);
                    if (next.thumbnail && shouldApplyStoredThumbnail(found, next.thumbnail, next.kind, nextSource)) {
                        found.thumbnail = next.thumbnail;
                        found.thumbnailKind = next.kind;
                        found.thumbnailSource = nextSource;
                        if (next.kind === 'frame') {
                            maybePromotePreviewAsset(found, makePreviewAsset('frame', next.thumbnail, 'video-frame'));
                        }
                        changed = true;
                    }
                    if (shouldApplyPageTitle(found.pageTitle, responseTitle, found.tabUrl || found.url, found.titleSource || '', responseTitleSource)) {
                        found.pageTitle = responseTitle;
                        found.titleSource = responseTitleSource;
                        changed = true;
                    }
                    if (changed) {
                        applyEntryStrategies(found);
                        await chrome.storage.local.set({ detectedVideos: dv2 });
                    }
                    return;
                }
                const isShortsFound = found.type === 'youtube' && isYouTubeShortsEntryUrl(found.url, found.tabUrl);
                const shortsPageUrl = found.tabUrl || found.url || url;
                const isGeneratedShortsThumb = isShortsFound && (nextKind === 'frame' || nextKind === 'capture');
                const isMismatchedShortsThumb = isShortsFound && nextThumbnail && !isYouTubeThumbnailForPage(nextThumbnail, shortsPageUrl);
                if (!isGeneratedShortsThumb && !isMismatchedShortsThumb && shouldApplyThumbnail(found.thumbnail, found.thumbnailKind, nextThumbnail, nextKind, found.type)) {
                    found.thumbnail = nextThumbnail;
                    found.thumbnailKind = nextKind;
                    if (nextKind === 'frame') {
                        maybePromotePreviewAsset(found, makePreviewAsset('frame', nextThumbnail, 'video-frame'));
                    } else if (!coercePreviewAsset(found.previewAsset)) {
                        maybePromotePreviewAsset(found, makePreviewAsset('image', nextThumbnail, 'thumbnail'));
                    }
                    changed = true;
                }
                if (!isShortsFound && shouldApplyPageTitle(found.pageTitle, responseTitle, found.tabUrl || found.url, found.titleSource || '', responseTitleSource)) {
                    found.pageTitle = responseTitle;
                    found.titleSource = responseTitleSource;
                    changed = true;
                }
                if (changed) {
                    applyEntryStrategies(found);
                    await chrome.storage.local.set({ detectedVideos: dv2 });
                }
            });
        }).catch(() => {});
}

function clearScheduledThumbnailRefresh(key) {
    const timers = _pendingThumbnailRefreshTimers.get(key) || [];
    timers.forEach(timer => clearTimeout(timer));
    _pendingThumbnailRefreshTimers.delete(key);
}

function shouldRefreshDetectedThumbnail(item, type = '') {
    if (!item) return false;
    const itemType = item.type || type || '';
    if (itemType !== 'hls') return !item.thumbnail;

    const previewSource = String(item.previewAsset?.source || '');
    const thumbSourceRank = hlsThumbnailSourceRank(item.thumbnailSource || '');
    const hasPrimaryThumbnail = !!item.thumbnail &&
        isHlsPrimaryThumbnailSource(item.thumbnailSource || '') &&
        !isHlsPreviewThumbnailSource(item.thumbnailSource || '') &&
        !isUntrustedChromeHlsPrimaryThumbnail(item);
    if (hasPrimaryThumbnail) {
        return false;
    }
    if (
        item.previewAsset?.kind === 'video' &&
        ['offscreen-preview', 'native-preview', 'hidden-video-preview', 'visible-video-preview'].includes(previewSource)
    ) {
        return !hasPrimaryThumbnail;
    }
    if (thumbSourceRank >= hlsThumbnailSourceRank('visible-video-preview') && !!item.thumbnail) {
        return true;
    }
    return true;
}

function scheduleDetectedThumbnailRefresh(tabId, url, type = '') {
    if (!tabId || !url) return;
    const nKey = normalizeUrl(url);
    const key = `${tabId}:${nKey}:${type || ''}`;
    clearScheduledThumbnailRefresh(key);

    const delays = [140, 300, 420, 900, 1100, 1800, 2200, 4800, 9000];
    const timers = delays.map(delay => setTimeout(async () => {
        try {
            const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
            const item = findDetectedVideo(detectedVideos[tabId] || [], {
                url,
                type: isDirectVideoUrl(url) ? 'mp4' : type,
                tabUrl: '',
                detectedOrigin: 'lookup'
            });
            if (!shouldRefreshDetectedThumbnail(item, type)) {
                clearScheduledThumbnailRefresh(key);
                return;
            }
            requestDetectedThumbnail(tabId, item.url, type);
        } catch {}
    }, delay));
    timers.push(setTimeout(() => {
        _pendingThumbnailRefreshTimers.delete(key);
    }, delays[delays.length - 1] + 300));
    _pendingThumbnailRefreshTimers.set(key, timers);
}

function shouldRefreshHlsPreview(item) {
    return !!item && item.type === 'hls' && !item.isLive && !hasUsableHlsPreviewAsset(item);
}

function scheduleHlsPreviewRefresh(tabId, itemOrUrl, options = {}) {
    const initialUrl = typeof itemOrUrl === 'string' ? itemOrUrl : (itemOrUrl?.url || '');
    const nKey = normalizeUrl(initialUrl);
    if (!tabId || !nKey) return;

    const delays = Array.isArray(options.delays) && options.delays.length
        ? options.delays
        : [80, 800, 2200];
    const force = !!options.force;

    for (const rawDelay of delays) {
        const delay = Math.max(0, Number(rawDelay || 0));
        setTimeout(async () => {
            try {
                const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
                const item = detectedVideos[tabId]?.find(v => normalizeUrl(v.url) === nKey);
                if (!item || item.type !== 'hls' || item.isLive) return;
                if (!shouldRefreshHlsPreview(item) && !shouldRefreshDetectedThumbnail(item, item.type)) return;

                // HLS manifests often surface before the playable variant is ready.
                // Later attempts intentionally bypass the short failure cooldown.
                const forceAttempt = force || delay > 0;
                maybeRequestOffscreenHlsPreview(tabId, item, forceAttempt);
                maybeRequestNativeHlsPreview(tabId, item, forceAttempt);
            } catch {}
        }, delay);
    }
}

function scheduleHlsFollowupRefresh(tabId, item, options = {}) {
    if (!tabId || !item || item.type !== 'hls' || item.isLive) return;
    const needsThumbnail = shouldRefreshDetectedThumbnail(item, item.type);
    const needsPreview = shouldRefreshHlsPreview(item);
    if (!needsThumbnail && !needsPreview) return;
    if (needsThumbnail) {
        scheduleDetectedThumbnailRefresh(tabId, item.url, item.type);
    }
    if (needsPreview || options.force) {
        maybeRequestNativeHlsPreview(tabId, item, !!options.force);
        maybeRequestOffscreenHlsPreview(tabId, item, !!options.force);
        scheduleHlsPreviewRefresh(tabId, item, {
            force: !!options.force,
            delays: options.delays
        });
    }
}

// ── 영상 감지 저장 (직렬화 큐로 레이스 컨디션 방지) ──
function saveDetectedVideo(tabId, url, type = 'hls', pageTitle = '', tabUrl = '', thumbnail = '', thumbnailKind = 'unknown', qualities = null, isLive = false, previewUrl = '', titleSource = '', mediaInfo = {}) {
    if (!tabId || tabId < 0) return;
    if (isSubPlaylist(url)) return;
    if (type === 'youtube' && isYouTubeShortsEntryUrl(url, tabUrl) && !hasNativeFormatQualities(qualities)) {
        scheduleYouTubeMetadataHydrate(tabId, tabUrl || url, 'shorts-detected');
        return;
    }
    const incomingTabUrl = tabUrl || '';
    const normalizedLiveTabUrl = normalizeYouTubeLiveTabUrl(url, incomingTabUrl);
    const correctedDifferentYouTubeTab = !!incomingTabUrl &&
        !!normalizedLiveTabUrl &&
        normalizedLiveTabUrl !== incomingTabUrl &&
        !!extractYouTubeVideoId(incomingTabUrl);
    if (normalizedLiveTabUrl) tabUrl = normalizedLiveTabUrl;
    const liveCandidateForTitle = type === 'hls' && (isLive || isYouTubeLiveHlsCandidate({ type, url, tabUrl, isLive }));
    let incomingTitleSource = pageTitle ? normalizeTitleSource(titleSource || 'unknown') : '';
    if (correctedDifferentYouTubeTab || (liveCandidateForTitle && isWeakYouTubeLiveTitle(pageTitle))) {
        pageTitle = '';
        incomingTitleSource = '';
    }
    if (correctedDifferentYouTubeTab) {
        thumbnail = '';
        thumbnailKind = 'unknown';
    }
    if (
        type === 'hls' &&
        isYouTubeLiveManifestUrl(url) &&
        isYouTubeLikeUrl(tabUrl || '') &&
        !pageTitle &&
        !thumbnail &&
        !(Array.isArray(qualities) && qualities.length)
    ) {
        return;
    }
    const contextReady = tabUrl
        ? prepareDetectedContext(tabId, tabUrl, 'save-detected').catch(() => true)
        : Promise.resolve(true);

    serializedStorageOp(async () => {
        if (!(await contextReady)) return;
        const isYouTubeDetectedEntry = type === 'youtube' || isYouTubeLiveManifestUrl(url) || isYouTubeLikeUrl(tabUrl || url);
        if (!isYouTubeDetectedEntry && pageTitleScore(pageTitle, tabUrl || url) < 45) {
            try {
                const tab = await chrome.tabs.get(tabId);
                const tabTitle = correctedDifferentYouTubeTab || (liveCandidateForTitle && isWeakYouTubeLiveTitle(tab.title))
                    ? ''
                    : (tab.title || '');
                if (shouldApplyPageTitle(pageTitle, tabTitle, tabUrl || url, incomingTitleSource, 'document')) {
                    pageTitle = tabTitle;
                    incomingTitleSource = pageTitle ? 'document' : '';
                }
            } catch {}
        }

        const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
        if (!detectedVideos[tabId]) detectedVideos[tabId] = [];
        if (type === 'youtube' && shouldSkipRedundantYouTubeEntry(detectedVideos[tabId], url, tabUrl)) {
            return;
        }

        const incomingMedia = normalizeIncomingMediaInfo(url, type, tabUrl, mediaInfo);
        let existingIdx = findDetectedVideoIndex(detectedVideos[tabId], incomingMedia);
        const isIncomingYouTubeLiveHls = isYouTubeLiveHlsCandidate({ type, url, tabUrl, isLive: true });
        if (existingIdx === -1 && isIncomingYouTubeLiveHls) {
            existingIdx = findYouTubeWatchEntryIndexForLive(detectedVideos[tabId], url, tabUrl);
        }
        const hlsThumbContext = { type, url, tabUrl, isLive };
        const normalizedHlsThumb = type === 'hls'
            ? await resolveHlsOfficialThumbnailForStorage(tabId, hlsThumbContext, thumbnail, thumbnailKind, null)
            : null;
        const normalizedHlsThumbSource = type === 'hls' ? hlsThumbnailSourceForNormalized(normalizedHlsThumb) : '';
        const shouldStoreInitialHlsThumb = type === 'hls' &&
            !!normalizedHlsThumb?.thumbnail &&
            !isHlsPreviewThumbnailSource(normalizedHlsThumbSource);

        if (existingIdx !== -1) {
            const item = detectedVideos[tabId][existingIdx];
            if (isIncomingYouTubeLiveHls) {
                promoteYouTubeWatchEntryToLiveHls(item, url, tabUrl);
            }
            mergeDirectMediaFields(item, incomingMedia);
            if (shouldApplyQualities(item, qualities)) item.qualities = qualities;
            if (previewUrl && !item.previewUrl) item.previewUrl = previewUrl;
            if (previewUrl && !item.previewCandidateUrl) {
                item.previewCandidateUrl = previewUrl;
                if (item.type === 'hls') {
                    maybePromotePreviewAsset(item, makePreviewAsset('video', previewUrl, 'trusted-preview'));
                } else {
                    maybePromotePreviewAsset(item, makePreviewAsset('video', previewUrl, 'preview-candidate'));
                }
            }
            if (item.type === 'hls') {
                const nextThumb = normalizedHlsThumb?.thumbnail || '';
                const nextKind = normalizedHlsThumb?.kind || 'unknown';
                const nextSource = hlsThumbnailSourceForNormalized(normalizedHlsThumb);
                if (nextThumb && shouldApplyStoredThumbnail(item, nextThumb, nextKind, nextSource)) {
                    item.thumbnail = nextThumb;
                    item.thumbnailKind = nextKind;
                    item.thumbnailSource = nextSource;
                }
                if (nextKind === 'frame') {
                    maybePromotePreviewAsset(item, makePreviewAsset('frame', nextThumb, 'video-frame'));
                } else if (!coercePreviewAsset(item.previewAsset) && nextThumb) {
                    maybePromotePreviewAsset(item, makePreviewAsset('image', nextThumb, nextSource || 'thumbnail'));
                }
            } else if (
                !(item.type === 'youtube' && isYouTubeShortsEntryUrl(item.url, item.tabUrl || tabUrl) && (
                    thumbnailKind === 'frame' ||
                    thumbnailKind === 'capture' ||
                    (thumbnail && !isYouTubeThumbnailForPage(thumbnail, item.tabUrl || tabUrl || url))
                )) &&
                shouldApplyThumbnail(item.thumbnail, item.thumbnailKind, thumbnail, thumbnailKind, item.type)
            ) {
                item.thumbnail = thumbnail;
                item.thumbnailKind = thumbnailKind;
                if (thumbnailKind === 'frame') {
                    maybePromotePreviewAsset(item, makePreviewAsset('frame', thumbnail, 'video-frame'));
                } else if (!coercePreviewAsset(item.previewAsset) && thumbnail) {
                    maybePromotePreviewAsset(item, makePreviewAsset('image', thumbnail, 'thumbnail'));
                }
            }
            const blockUntrustedShortsTitle = item.type === 'youtube' &&
                isYouTubeShortsEntryUrl(item.url, item.tabUrl || tabUrl) &&
                item.titleSource === 'youtube-metadata';
            if (!blockUntrustedShortsTitle && shouldApplyPageTitle(item.pageTitle, pageTitle, item.tabUrl || tabUrl || url, item.titleSource || '', incomingTitleSource)) {
                item.pageTitle = pageTitle;
                item.titleSource = incomingTitleSource;
            }
            // isLive는 항상 최신 값으로 업데이트 (YouTube에서 나중에 판별되므로)
            if (isLive) item.isLive = true;
            const removedRedundantYouTube = pruneRedundantYouTubeEntriesForLive(detectedVideos[tabId], item);
            const removedPreviousShorts = prunePreviousShortsEntries(detectedVideos[tabId], item);
            const removedPreviousYouTubeWatch = prunePreviousYouTubeWatchEntries(detectedVideos[tabId], item);
            applyEntryStrategies(item);
            const prunedDirectMedia = pruneDirectMediaDuplicateEntries(detectedVideos[tabId] || []);
            if (prunedDirectMedia.changed) detectedVideos[tabId] = prunedDirectMedia.entries;
            await chrome.storage.local.set({ detectedVideos });
            recordDebugLog('info', 'detect.storage', 'Detected item updated', {
                type: item.type,
                url: item.url,
                title: item.pageTitle,
                qualities: Array.isArray(item.qualities) ? item.qualities.length : 0,
                thumbnailKind: item.thumbnailKind || 'unknown',
                thumbnailSource: item.thumbnailSource || '',
                hasThumbnail: !!item.thumbnail,
                strategy: item.downloadStrategy || '',
                previewStrategy: item.previewStrategy || '',
            }, tabId);
            if (item.type === 'hls') {
                scheduleHlsFollowupRefresh(tabId, item, {
                    force: true,
                    delays: [0, 300, 900, 1800, 2400]
                });
            }
            if (removedRedundantYouTube || removedPreviousShorts || removedPreviousYouTubeWatch || prunedDirectMedia.changed) {
                const count = detectedVideos[tabId].length;
                chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId }).catch(() => {});
            }
            return;
        }

        const isRejectedInitialShortsThumbnail = type === 'youtube' &&
            isYouTubeShortsEntryUrl(url, tabUrl) &&
            !!thumbnail &&
            (
                thumbnailKind === 'frame' ||
                thumbnailKind === 'capture' ||
                !isYouTubeThumbnailForPage(thumbnail, tabUrl || url)
            );

            const entry = applyEntryStrategies({
                url, type,
                pageTitle: pageTitle || '',
                titleSource: pageTitle ? incomingTitleSource : '',
                tabUrl: tabUrl || '',
                addedAt: Date.now(),
                thumbnail: type === 'hls'
                    ? (shouldStoreInitialHlsThumb ? (normalizedHlsThumb?.thumbnail || '') : '')
                    : (isRejectedInitialShortsThumbnail || isInvalidThumbnailUrl(thumbnail) ? '' : (thumbnail || '')),
                thumbnailKind: type === 'hls'
                    ? (shouldStoreInitialHlsThumb ? (normalizedHlsThumb?.kind || 'unknown') : 'unknown')
                    : ((!thumbnail || isRejectedInitialShortsThumbnail || isInvalidThumbnailUrl(thumbnail)) ? 'unknown' : thumbnailKind),
                thumbnailSource: type === 'hls'
                    ? (shouldStoreInitialHlsThumb ? normalizedHlsThumbSource : '')
                    : '',
            duration: 0,
            qualities: qualities || null,
            isLive: isLive || false,
            previewUrl: previewUrl || '',
            previewCandidateUrl: previewUrl || '',
            previewAsset: type === 'hls'
                ? makePreviewAsset('video', previewUrl || '', 'trusted-preview')
                : null,
            ...(type === 'mp4' ? {
                mediaKey: incomingMedia.mediaKey || '',
                mediaIndex: incomingMedia.mediaIndex,
                sourceUrls: incomingMedia.sourceUrls || [],
                aliasUrls: [],
                detectedOrigin: incomingMedia.detectedOrigin || ''
            } : {})
        });
        detectedVideos[tabId].push(entry);
        const removedRedundantYouTube = pruneRedundantYouTubeEntriesForLive(detectedVideos[tabId], entry);
        const removedPreviousShorts = prunePreviousShortsEntries(detectedVideos[tabId], entry);
        const removedPreviousYouTubeWatch = prunePreviousYouTubeWatchEntries(detectedVideos[tabId], entry);
        const prunedDirectMedia = pruneDirectMediaDuplicateEntries(detectedVideos[tabId] || []);
        if (prunedDirectMedia.changed) detectedVideos[tabId] = prunedDirectMedia.entries;
        await chrome.storage.local.set({ detectedVideos });
        recordDebugLog('info', 'detect.storage', 'Detected item inserted', {
            type: entry.type,
            url: entry.url,
            title: entry.pageTitle,
            qualities: Array.isArray(entry.qualities) ? entry.qualities.length : 0,
            thumbnailKind: entry.thumbnailKind || 'unknown',
            thumbnailSource: entry.thumbnailSource || '',
            hasThumbnail: !!entry.thumbnail,
            strategy: entry.downloadStrategy || '',
            isLive: !!entry.isLive,
        }, tabId);

        const count = detectedVideos[tabId].length;
        chrome.action.setBadgeText({ text: count.toString(), tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#1a73e8', tabId });

        const inserted = findDetectedVideo(detectedVideos[tabId] || [], incomingMedia);
        if (inserted) {
            requestDetectedThumbnail(tabId, inserted.url, type);
            scheduleHlsFollowupRefresh(tabId, inserted, {
                force: true,
                delays: [0, 300, 900, 1800, 2200]
            });
        }
        if (removedRedundantYouTube || removedPreviousShorts || removedPreviousYouTubeWatch || prunedDirectMedia.changed) {
            const updatedCount = detectedVideos[tabId].length;
            chrome.action.setBadgeText({ text: updatedCount > 0 ? updatedCount.toString() : '', tabId }).catch(() => {});
        }
    });
}

function updateLatestVideoMeta(tabId, thumbnail, thumbnailKind, duration, sourceUrl = '', sourceType = '', previewUrl = '', previewKind = '', pageTitle = '', tabUrl = '', titleSource = '', mediaInfo = {}) {
    if (!tabId || tabId < 0) return;
    const contextReady = tabUrl
        ? prepareDetectedContext(tabId, tabUrl, 'video-meta').catch(() => true)
        : Promise.resolve(true);
    serializedStorageOp(async () => {
        if (!(await contextReady)) return;
        const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
        const list = detectedVideos[tabId];
        if (!list || !list.length) return;

        const matchLatest = (predicate) => [...list]
            .filter(predicate)
            .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
            .slice(0, 1);

        let targets = [];
        const lookupUrl = sourceUrl || (Array.isArray(mediaInfo?.sourceUrls) ? mediaInfo.sourceUrls[0] : '') || '';
        const incomingMedia = normalizeIncomingMediaInfo(lookupUrl, sourceType || (isDirectVideoUrl(lookupUrl) ? 'mp4' : ''), tabUrl, mediaInfo);
        const sourceKey = lookupUrl ? normalizeUrl(lookupUrl) : '';
        if (sourceKey) {
            targets = matchLatest(item => {
                if (incomingMedia.type === 'mp4') return directMediaMatchesEntry(item, incomingMedia);
                return normalizeUrl(item.url) === sourceKey;
            });
        } else if (sourceType === 'hls') {
            targets = matchLatest(item => item.type === 'hls' || item.downloadStrategy === 'browser-hls');
        } else if (sourceType) {
            targets = matchLatest(item => item.type === sourceType);
        } else if (thumbnail || pageTitle) {
            targets = matchLatest(item => item.type === 'hls' || isYouTubeLikeUrl(item.tabUrl || item.url));
        }
        if (!targets.length) {
            if (!sourceKey && !sourceType) return;
            targets = matchLatest(() => true);
        }

        let changed = false;
        for (const item of targets) {
            changed = mergeDirectMediaFields(item, incomingMedia) || changed;
            const incomingTabKey = getYouTubePageKey(tabUrl || '');
            const currentItemTabKey = getYouTubePageKey(item.tabUrl || item.url || '');
            const shouldFreezeShortsItem =
                item?.type === 'youtube' &&
                isYouTubeShortsUrl(tabUrl || '') &&
                incomingTabKey &&
                currentItemTabKey &&
                incomingTabKey !== currentItemTabKey;
            if (shouldFreezeShortsItem) {
                continue;
            }
            const isHiddenHlsPreview = sourceType === 'hls' && previewKind === 'hidden-video';
            if (isHiddenHlsPreview) {
                if (duration && !item.duration) { item.duration = duration; changed = true; }
                continue;
            }
            if ((previewKind === 'video' || isHiddenHlsPreview) && isPreviewVideoUrl(previewUrl)) {
                if (!item.previewUrl || isHiddenHlsPreview) {
                    item.previewUrl = previewUrl;
                    changed = true;
                }
                if (!item.previewCandidateUrl || isHiddenHlsPreview) {
                    item.previewCandidateUrl = previewUrl;
                    changed = true;
                }
                changed = maybePromotePreviewAsset(
                    item,
                    makePreviewAsset(
                        'video',
                        previewUrl,
                        sourceType === 'hls'
                            ? (isHiddenHlsPreview ? 'hidden-video-preview' : 'visible-video-preview')
                            : 'video-preview'
                    )
                ) || changed;
            }
            if (item.type === 'hls') {
                const next = await resolveHlsOfficialThumbnailForStorage(tabId, item, thumbnail, thumbnailKind, null);
                const nextSource = sourceType === 'hls'
                    ? (previewKind === 'hidden-video' ? 'hidden-video-preview' : (next.kind === 'frame' ? 'visible-video-preview' : hlsThumbnailSourceForNormalized(next)))
                    : hlsThumbnailSourceForNormalized(next);
                if (next.thumbnail && shouldApplyStoredThumbnail(item, next.thumbnail, next.kind, nextSource)) {
                    item.thumbnail = next.thumbnail;
                    item.thumbnailKind = next.kind;
                    item.thumbnailSource = nextSource;
                    changed = true;
                }
                if (next.kind === 'frame') {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('frame', next.thumbnail, 'video-frame')) || changed;
                } else if (!coercePreviewAsset(item.previewAsset) && next.thumbnail) {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('image', next.thumbnail, nextSource || 'thumbnail')) || changed;
                }
            } else if (
                !(item.type === 'youtube' && isYouTubeShortsEntryUrl(item.url, item.tabUrl || tabUrl) && (
                    thumbnailKind === 'frame' ||
                    thumbnailKind === 'capture' ||
                    (thumbnail && !isYouTubeThumbnailForPage(thumbnail, item.tabUrl || tabUrl || item.url))
                )) &&
                shouldApplyThumbnail(item.thumbnail, item.thumbnailKind, thumbnail, thumbnailKind, item.type)
            ) {
                item.thumbnail = thumbnail;
                item.thumbnailKind = thumbnailKind;
                changed = true;
                if (thumbnailKind === 'frame') {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('frame', thumbnail, 'video-frame')) || changed;
                } else if (!coercePreviewAsset(item.previewAsset) && thumbnail) {
                    changed = maybePromotePreviewAsset(item, makePreviewAsset('image', thumbnail, 'thumbnail')) || changed;
                }
            }
            if (duration && !item.duration) { item.duration = duration; changed = true; }
            if (tabUrl && item.tabUrl !== tabUrl) { item.tabUrl = tabUrl; changed = true; }
            const nextMetaTitle = item.type === 'youtube' && isYouTubeShortsEntryUrl(item.url, item.tabUrl || tabUrl)
                ? ''
                : pageTitle;
            const nextMetaTitleSource = nextMetaTitle ? normalizeTitleSource(titleSource || 'unknown') : '';
            if (shouldApplyPageTitle(item.pageTitle, nextMetaTitle, item.tabUrl || item.url, item.titleSource || '', nextMetaTitleSource)) {
                item.pageTitle = nextMetaTitle;
                item.titleSource = nextMetaTitleSource;
                changed = true;
            }
            if (item.isLive && pruneRedundantYouTubeEntriesForLive(detectedVideos[tabId], item)) {
                changed = true;
            }
            if (prunePreviousShortsEntries(detectedVideos[tabId], item)) {
                changed = true;
            }
            applyEntryStrategies(item);
            if (item.type === 'hls' && item.duration > 0) {
                scheduleHlsFollowupRefresh(tabId, item, {
                    force: true,
                    delays: [0, 300, 900, 1800]
                });
            }
        }
        if (changed) {
            const prunedDirectMedia = pruneDirectMediaDuplicateEntries(detectedVideos[tabId] || []);
            if (prunedDirectMedia.changed) detectedVideos[tabId] = prunedDirectMedia.entries;
            await chrome.storage.local.set({ detectedVideos });
            if (prunedDirectMedia.changed) {
                const count = detectedVideos[tabId].length;
                chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId }).catch(() => {});
            }
        }
    });
}

async function getDetectedVideos(tabId) {
    const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
    const pruned = pruneDirectMediaDuplicateEntries((detectedVideos[tabId] || []).map(item => ({ ...item })));
    return pruned.entries.map(item => applyEntryStrategies({ ...item }));
}

// ── 다운로드 큐 ──
async function queueTask(taskId, data) {
    await mutateTasks((tasks) => {
        const existing = tasks[taskId] || {};
        const downloadPath = data.downloadPath || '';
        tasks[taskId] = {
            ...existing,
            taskId,
            url: data.url,
            fileName: data.fileName,
            downloadPath,
            tabId: data.tabId,
            type: data.type || 'hls',
            mode: 'hls',
            storageBackend: downloadPath ? 'companion' : 'browser',
            percent: 0,
            status: 'waiting',
            addedAt: existing.addedAt || Date.now()
        };
    });
    processQueue();
}

async function queueLiveRecordTask(taskId, data) {
    assertYouTubeAllowedForVariant(data, 'live-record');
    await mutateTasks((tasks) => {
        const existing = tasks[taskId] || {};
        const downloadPath = data.downloadPath || '';
        tasks[taskId] = {
            ...existing,
            taskId,
            url: data.url,
            sourceUrl: data.sourceUrl || data.url,
            pageUrl: data.pageUrl || '',
            tabUrl: data.tabUrl || data.pageUrl || '',
            formatId: data.formatId || '',
            fileName: data.fileName,
            downloadPath,
            tabId: data.tabId,
            type: data.type || 'live-hls',
            mode: 'live-record',
            storageBackend: downloadPath ? 'companion' : 'browser',
            percent: 0,
            elapsedSec: 0,
            filesize: 0,
            isLive: true,
            recordMode: data.recordMode === 'window' ? 'window' : 'now',
            qualityLabel: data.qualityLabel || '',
            qualityResolution: data.qualityResolution || '',
            qualityHeight: Number(data.qualityHeight || 0),
            qualityBandwidth: Number(data.qualityBandwidth || 0),
            allowCookieAuth: !!data.allowCookieAuth,
            status: 'waiting',
            addedAt: existing.addedAt || Date.now(),
        };
    });
    processQueue();
}

async function queueNativeDownloadTask(taskId, data) {
    assertYouTubeAllowedForVariant(data, data.liveRecord || data.live_record ? 'live-record' : 'download');
    await mutateTasks((tasks) => {
        const existing = tasks[taskId] || {};
        const downloadPath = data.downloadPath || '';
        const displayName = data.displayName || data.fileName || 'Video download';
        tasks[taskId] = {
            ...existing,
            taskId,
            url: data.url,
            formatId: data.formatId || '',
            requestedFormatId: data.requestedFormatId || data.formatId || '',
            qualityLabel: data.qualityLabel || '',
            qualityResolution: data.qualityResolution || '',
            qualityHeight: Number(data.qualityHeight || 0) || 0,
            fileName: displayName,
            fileNameForDownload: data.fileName || '',
            downloadPath,
            tabId: data.tabId || 0,
            type: data.type || 'youtube',
            mode: data.mode || 'ytdlp',
            storageBackend: 'companion',
            percent: 0,
            status: 'waiting',
            addedAt: existing.addedAt || Date.now(),
            referer: data.referer || '',
            audioUrl: data.audioUrl || '',
            videoExt: data.videoExt || '',
            audioExt: data.audioExt || '',
            allowCookieAuth: !!data.allowCookieAuth,
            resolveTitleBeforeStart: !!data.resolveTitleBeforeStart,
            titleResolveUrl: data.titleResolveUrl || data.url || '',
            directFallback: !!data.directFallback,
            fallbackTabId: data.fallbackTabId || data.tabId || 0,
            fallbackFileName: data.fallbackFileName || '',
            fallbackType: data.fallbackType || data.type || '',
            fallbackContainerExt: data.fallbackContainerExt || data.containerExt || '',
            fallbackDownloadPath: data.fallbackDownloadPath || data.downloadPath || '',
            fallbackReferer: data.fallbackReferer || data.referer || '',
            containerExt: data.containerExt || '',
        };
    });
    processQueue();
}

async function queueBrowserDirectDownloadTask(taskId, data) {
    await mutateTasks((tasks) => {
        const existing = tasks[taskId] || {};
        tasks[taskId] = {
            ...existing,
            taskId,
            url: data.url,
            fileName: data.fileName || 'download.mp4',
            tabId: data.tabId || 0,
            type: data.type || 'mp4',
            mode: 'browser-direct-queued',
            storageBackend: 'browser',
            percent: 0,
            status: 'waiting',
            addedAt: existing.addedAt || Date.now(),
        };
    });
    processQueue();
}

function metadataDisplayName(requestKind = '') {
    return requestKind === 'live' ? 'Live recording' : 'Checking media info';
}

async function queueMetadataDownloadTask(taskId, msg, sender) {
    const requestedItem = {
        ...(msg.requestedItem && typeof msg.requestedItem === 'object' ? msg.requestedItem : {}),
        url: msg.url || msg.requestedItem?.downloadUrl || msg.requestedItem?.url || '',
        tabUrl: msg.requestedItem?.tabUrl || msg.tabUrl || msg.pageUrl || '',
        titleResolveUrl: msg.titleResolveUrl || msg.requestedItem?.tabUrl || msg.pageUrl || msg.url || '',
    };
    const tabId = Number(msg.tabId || sender.tab?.id || requestedItem.tabId || 0);
    const requestKind = String(msg.requestKind || '').trim() || 'hls';
    const displayName = msg.displayName || metadataDisplayName(requestKind);
    await mutateTasks((tasks) => {
        const existing = tasks[taskId] || {};
        tasks[taskId] = {
            ...existing,
            taskId,
            url: msg.url,
            tabId,
            type: msg.type || requestedItem.type || (requestKind === 'live' ? 'live-hls' : ''),
            mode: 'metadata-gate',
            requestKind,
            requestedItem,
            requestedDownload: {
                ...msg,
                requestedItem,
                tabId,
            },
            displayName,
            fileName: displayName,
            finalFileName: '',
            status: 'waiting_metadata',
            percent: 0,
            addedAt: existing.addedAt || Date.now(),
        };
    });
    updateBadge();
    resolveMetadataDownloadTask(taskId).catch(async (e) => {
        recordDebugLog('error', 'queue.metadata', 'Metadata-gated download failed', {
            taskId,
            error: e.message,
        }, tabId);
        await updateTask(taskId, { status: 'error', percent: 0, error: e.message || 'Metadata validation failed' });
        updateBadge();
        processQueue();
    });
}

function withTimeout(promise, ms, label = 'timeout') {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))
    ]);
}

function isQueuedDirectMediaItem(requestedItem = {}, url = '') {
    return requestedItem.strategy === 'direct-video' ||
        requestedItem.type === 'mp4' ||
        isDirectVideoUrl(requestedItem.downloadUrl || '') ||
        isDirectVideoUrl(requestedItem.itemUrl || '') ||
        isDirectVideoUrl(requestedItem.url || url);
}

function trustedQueuedInitialBaseName(requestedItem = {}, url = '') {
    const isYouTube =
        isYouTubeLikeUrl(requestedItem.url || '') ||
        isYouTubeLikeUrl(requestedItem.itemUrl || '') ||
        isYouTubeLikeUrl(requestedItem.downloadUrl || '') ||
        isYouTubeLikeUrl(url) ||
        isYouTubeLikeUrl(requestedItem.tabUrl || '');
    if (isYouTube || !isQueuedDirectMediaItem(requestedItem, url)) return '';
    const title = normalizePageTitle(requestedItem.initialBaseName || '');
    const scoreUrl = requestedItem.tabUrl || requestedItem.pageUrl || url;
    if (!title || pageTitleScore(title, scoreUrl) < 0) return '';
    return title;
}

function trustedQueuedTitle(requestedItem = {}, url = '') {
    const source = normalizeTitleSource(requestedItem.titleSource || requestedItem.pageTitleSource || '');
    const title = normalizePageTitle(requestedItem.pageTitle || requestedItem.title || '');
    const isYouTube =
        isYouTubeLikeUrl(requestedItem.url || '') ||
        isYouTubeLikeUrl(requestedItem.itemUrl || '') ||
        isYouTubeLikeUrl(requestedItem.downloadUrl || '') ||
        isYouTubeLikeUrl(url) ||
        isYouTubeLikeUrl(requestedItem.tabUrl || '');
    const initialBaseName = trustedQueuedInitialBaseName(requestedItem, url);
    if (initialBaseName) return initialBaseName;
    if (title && pageTitleScore(title, url) >= 0) {
        if (isYouTube) {
            if (source === 'youtube-metadata') return cleanNativeTitleCandidate(title, url);
            return '';
        }
        if (source === 'media-scoped' || source === 'metadata') {
            return title;
        }
        if (source === 'document' && requestedItem.strategy !== 'direct-video' && requestedItem.type !== 'mp4') return title;
    }
    return '';
}

function safeFallbackBaseName(requestedItem = {}, url = '') {
    const candidateUrl = requestedItem.tabUrl || requestedItem.pageUrl || url || requestedItem.url || '';
    const videoId = extractYouTubeVideoId(candidateUrl);
    if (videoId) return `youtube_${videoId}`;
    const urls = [url, requestedItem.downloadUrl, requestedItem.itemUrl, requestedItem.url, requestedItem.tabUrl].filter(Boolean);
    for (const raw of urls) {
        const parsed = parseLooseUrl(raw);
        if (!parsed) continue;
        const parts = parsed.pathname.split('/').filter(Boolean);
        for (let i = parts.length - 1; i >= 0; i -= 1) {
            const segment = decodeURIComponent(parts[i] || '')
                .replace(/\.(m3u8|mp4|webm|flv|m4v|mkv|ts|m4s)(?:[?#].*)?$/i, '')
                .replace(/[_-]+/g, ' ')
                .trim();
            if (!segment || segment.length < 3) continue;
            if (/^(index|master|playlist|video|play|source|stream|download|file|media|clip)$/i.test(segment)) continue;
            if (/^[0-9a-f-]{12,}$/i.test(segment.replace(/\s+/g, ''))) continue;
            return segment;
        }
    }
    const host = parseLooseUrl(candidateUrl)?.hostname?.replace(/^www\./i, '').split('.')[0] || '';
    return host ? `${host}_video` : 'video';
}

async function resolveQueuedDownloadBaseName(task) {
    const request = task.requestedDownload || {};
    const requestedItem = request.requestedItem || task.requestedItem || {};
    const url = request.titleResolveUrl || requestedItem.titleResolveUrl || requestedItem.tabUrl || request.pageUrl || request.url || task.url || '';
    const tabId = Number(task.tabId || request.tabId || 0);
    const contextUrl = requestedItem.tabUrl || request.pageUrl || request.tabUrl || '';
    if (contextUrl && !(await isTabContextCurrent(tabId, contextUrl))) {
        throw new Error('Page changed before download metadata was confirmed');
    }

    let title = trustedQueuedTitle(requestedItem, url);
    if (!title && isYouTubeLikeUrl(url)) {
        try {
            const response = await withTimeout(companionRequest({ action: 'getFormats', url }), 12000, 'YouTube metadata resolve timeout');
            title = cleanNativeTitleCandidate(response?.title || '', url);
            recordDebugLog(title ? 'info' : 'warn', 'queue.metadata', 'YouTube metadata resolved for queued download', {
                taskId: task.taskId,
                url,
                title,
                status: response?.status || '',
            }, tabId);
        } catch (e) {
            recordDebugLog('warn', 'queue.metadata', 'YouTube metadata resolve failed for queued download', {
                taskId: task.taskId,
                url,
                error: e.message,
            }, tabId);
        }
    }

    if (!title && tabId) {
        const snapshotType = isYouTubeLikeUrl(url) ? 'youtube' : (request.type === 'mp4' || isDirectVideoUrl(request.url) ? 'mp4' : (request.type || 'hls'));
        const snapshot = await withTimeout(requestPageSnapshot(tabId, request.url || url, snapshotType), 1800, 'Page snapshot timeout').catch(() => ({}));
        const snapshotSource = normalizeTitleSource(snapshot?.pageTitleSource || snapshot?.titleSource || '');
        title = trustedQueuedTitle({
            ...requestedItem,
            pageTitle: snapshot?.pageTitle || '',
            titleSource: snapshotSource,
            tabUrl: requestedItem.tabUrl || request.pageUrl || '',
            url: request.url || url,
        }, url);
    }

    if (!title) title = safeFallbackBaseName(requestedItem, request.url || url);
    return sanitizeFilename(title || 'video') || 'video';
}

function queuedDownloadFileName(request = {}, baseName = '') {
    const safeBase = sanitizeFilename(baseName || 'video') || 'video';
    const kind = request.requestKind || '';
    if (kind === 'live') {
        const stamp = new Date(request.queuedAt || Date.now());
        const pad = n => String(n).padStart(2, '0');
        const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
        const qualitySuffix = selectedQualityFileSuffix(request);
        const liveExt = isYouTubeLiveWindowRequest(request) ? 'mp4' : 'ts';
        return `${safeBase}${qualitySuffix ? `_${qualitySuffix}` : ''}_${date}.${liveExt}`;
    }
    if (kind === 'hls') {
        const quality = String(request.qualityLabel || '').replace(/[^a-zA-Z0-9\uAC00-\uD7A3]/g, '-');
        return quality ? `${safeBase}_${quality}.ts` : `${safeBase}.ts`;
    }
    if (kind === 'browser-direct') {
        return replaceExtension(safeBase, request.containerExt || inferDirectMediaExt(request.url, 'mp4'));
    }
    const youtubeQualitySuffix = youtubeNativeQualityFileSuffix(request);
    if (youtubeQualitySuffix) {
        return `${safeBase}_${youtubeQualitySuffix}`;
    }
    return safeBase;
}

function youtubeNativeQualityFileSuffix(request = {}) {
    if ((request.requestKind || '') !== 'native') return '';
    const requestedItem = request.requestedItem || {};
    const candidateUrl = request.titleResolveUrl || requestedItem.tabUrl || request.tabUrl || request.pageUrl || request.url || '';
    if (!isYouTubeLikeUrl(candidateUrl)) return '';
    return selectedQualityFileSuffix(request);
}

function selectedQualityFileSuffix(request = {}) {
    const label = String(request.qualityLabel || '').trim();
    if (!label || /^best$/i.test(label)) return '';

    const height = Number(request.qualityHeight || 0) || 0;
    if (height > 0) return `${height}p`;

    const resolution = String(request.qualityResolution || '').trim();
    const resolutionHeight = resolution.match(/x\s*(\d{3,4})\b/i);
    if (resolutionHeight) return `${resolutionHeight[1]}p`;

    const labelHeight = label.match(/(\d{3,4})\s*p\b/i);
    if (labelHeight) return `${labelHeight[1]}p`;

    return '';
}

function isYouTubeLiveWindowRequest(request = {}) {
    if ((request.requestKind || '') !== 'live' || request.recordMode !== 'window') return false;
    const requestedItem = request.requestedItem || {};
    const candidateUrl = request.pageUrl || request.tabUrl || requestedItem.tabUrl || requestedItem.pageUrl || request.titleResolveUrl || '';
    return isYouTubeLikeUrl(candidateUrl);
}

async function resolveMetadataDownloadTask(taskId) {
    const tasks = await getTasks();
    const task = tasks[taskId];
    if (!task || task.status !== 'waiting_metadata') return;
    const request = {
        ...(task.requestedDownload || {}),
        queuedAt: task.addedAt || Date.now(),
    };
    const baseName = await resolveQueuedDownloadBaseName(task);
    const current = (await getTasks())[taskId];
    if (!current || current.status !== 'waiting_metadata') return;
    const finalFileName = queuedDownloadFileName(request, baseName);
    recordDebugLog('info', 'queue.metadata', 'Queued download metadata confirmed', {
        taskId,
        requestKind: request.requestKind || '',
        baseName,
        finalFileName,
        url: request.url || '',
    }, request.tabId || task.tabId);
    await updateTask(taskId, {
        finalFileName,
        fileName: finalFileName,
        displayName: finalFileName,
        status: 'waiting',
    });
    await enqueueResolvedDownloadRequest(taskId, request, baseName, finalFileName);
}

async function enqueueResolvedDownloadRequest(taskId, request = {}, baseName = '', finalFileName = '') {
    const kind = request.requestKind || '';
    if (kind === 'native') {
        const fallbackExt = normalizeDownloadContainerExt(request.containerExt || inferDirectMediaExt(request.url, 'mp4'));
        await queueNativeDownloadTask(taskId, {
            url: request.url,
            formatId: request.formatId || '',
            requestedFormatId: request.requestedFormatId || request.formatId || '',
            qualityLabel: request.qualityLabel || '',
            qualityResolution: request.qualityResolution || '',
            qualityHeight: Number(request.qualityHeight || 0) || 0,
            downloadPath: request.downloadPath || request.download_path || '',
            fileName: finalFileName || baseName,
            displayName: finalFileName || baseName,
            mode: request.nativeMode || request.mode || 'ytdlp',
            referer: request.referer || '',
            tabId: request.tabId || 0,
            audioUrl: request.audioUrl || request.audio_url || '',
            videoExt: request.videoExt || request.video_ext || '',
            audioExt: request.audioExt || request.audio_ext || '',
            titleResolveUrl: request.titleResolveUrl || request.url || '',
            type: request.type || 'video',
            containerExt: fallbackExt,
            directFallback: !!request.directFallback,
            fallbackTabId: request.fallbackTabId || request.tabId || 0,
            fallbackFileName: request.directFallback ? replaceExtension(finalFileName || baseName, fallbackExt) : '',
            fallbackType: request.fallbackType || request.type || fallbackExt,
            fallbackContainerExt: fallbackExt,
            fallbackDownloadPath: request.downloadPath || request.download_path || '',
            fallbackReferer: request.fallbackReferer || request.referer || '',
            allowCookieAuth: !!request.allowCookieAuth,
        });
        return;
    }
    if (kind === 'browser-direct') {
        await queueBrowserDirectDownloadTask(taskId, {
            url: request.url,
            fileName: finalFileName,
            tabId: request.tabId || 0,
            type: request.type || 'mp4',
        });
        return;
    }
    if (kind === 'live') {
        await queueLiveRecordTask(taskId, {
            ...request,
            fileName: finalFileName,
            downloadPath: request.downloadPath || request.download_path || '',
            allowCookieAuth: !!request.allowCookieAuth,
        });
        return;
    }
    await queueTask(taskId, {
        ...request,
        fileName: finalFileName,
        downloadPath: request.downloadPath || request.download_path || '',
    });
}

async function stopLiveRecordTask(taskId) {
    const task = (await getTasks())[taskId];
    if (!task || !isLiveRecordTask(task)) return;
    if (task.status === 'waiting' || task.status === 'waiting_metadata') {
        await removeTask(taskId);
        updateBadge();
        return;
    }
    await updateTask(taskId, { status: 'stopping' });
    notifyLiveRecordControl(task, 'stopping');
    if (task.mode === 'live-ytdlp') {
        const sent = cancelNativeDownloadViaActivePort(taskId);
        if (!sent) {
            companionRequest({ action: 'cancel', download_id: taskId }).catch(() => {});
        }
    }
    updateBadge();
}

function isQueuedNativeDownloadTask(task) {
    return task?.storageBackend === 'companion' && (task.mode === 'ytdlp' || task.mode === 'youtube-direct');
}

function isQueuedBrowserDirectDownloadTask(task) {
    return task?.storageBackend === 'browser' && task.mode === 'browser-direct-queued';
}

function cleanNativeTitleCandidate(title = '', url = '') {
    const text = String(title || '')
        .replace(/\s+-\s+YouTube$/i, '')
        .trim();
    if (!text || /^youtube$/i.test(text)) return '';
    if (isPollutedYouTubeUiTitle(text, url)) return '';
    const videoId = extractYouTubeVideoId(url);
    if (videoId && sanitizeFilename(text) === sanitizeFilename(`youtube_${videoId}`)) return '';
    return text;
}

async function resolveQueuedNativeFileName(task) {
    if (!task.resolveTitleBeforeStart) return task.fileNameForDownload || task.fileName || '';
    const url = task.titleResolveUrl || task.url || '';
    if (!isYouTubeLikeUrl(url)) return task.fileNameForDownload || task.fileName || '';

    try {
        recordDebugLog('info', 'download.native', 'Resolving queued YouTube title before native start', {
            taskId: task.taskId,
            url,
        }, task.tabId);
        const response = await companionRequest({ action: 'getFormats', url });
        recordDebugLog(response?.status === 'ok' ? 'info' : 'warn', 'download.native', 'Queued YouTube title resolve response', {
            taskId: task.taskId,
            url,
            status: response?.status || '',
            title: response?.title || '',
            count: Array.isArray(response?.formats) ? response.formats.length : 0,
            message: response?.message || '',
        }, task.tabId);
        const resolvedTitle = cleanNativeTitleCandidate(response?.title || '', url);
        if (resolvedTitle) {
            const resolvedName = sanitizeFilename(resolvedTitle);
            await updateTask(task.taskId, { fileName: resolvedName });
            return resolvedName;
        }
    } catch (e) {
        recordDebugLog('warn', 'download.native', 'Queued YouTube title resolve failed', {
            taskId: task.taskId,
            url,
            error: e.message,
        }, task.tabId);
    }

    return task.fileNameForDownload || '';
}

async function startQueuedNativeDownloadTask(task) {
    const initialDisplayName = task.fileName || task.fileNameForDownload || 'yt-dlp download';
    await updateTask(task.taskId, { status: 'downloading', percent: 0, fileName: initialDisplayName });
    updateBadge();

    let fileName = await resolveQueuedNativeFileName(task);
    let displayName = fileName || initialDisplayName;

    const latest = (await getTasks())[task.taskId];
    if (!latest || latest.status === 'cancelling') {
        if (latest?.status === 'cancelling') await removeTask(task.taskId);
        updateBadge();
        processQueue();
        return;
    }
    if (latest.fileName && latest.fileName !== initialDisplayName) {
        displayName = latest.fileName;
    }

    try {
        await startNativeDownload(
            task.taskId,
            task.url,
            task.formatId || '',
            task.downloadPath || '',
            fileName,
            task.mode || 'ytdlp',
            task.referer || '',
            {
                audioUrl: task.audioUrl || '',
                videoExt: task.videoExt || '',
                audioExt: task.audioExt || '',
                displayName,
                requestedFormatId: task.requestedFormatId || task.formatId || '',
                qualityLabel: task.qualityLabel || '',
                qualityResolution: task.qualityResolution || '',
                qualityHeight: task.qualityHeight || 0,
                tabId: task.tabId,
                allowCookieAuth: !!task.allowCookieAuth,
                directFallback: !!task.directFallback,
                fallbackTabId: task.fallbackTabId || task.tabId || 0,
                fallbackFileName: task.fallbackFileName || '',
                fallbackType: task.fallbackType || task.type || '',
                fallbackContainerExt: task.fallbackContainerExt || task.containerExt || '',
                fallbackDownloadPath: task.fallbackDownloadPath || task.downloadPath || '',
                fallbackReferer: task.fallbackReferer || task.referer || '',
            }
        );
    } catch (e) {
        recordDebugLog('error', 'download.native', 'Queued native download start failed', {
            taskId: task.taskId,
            error: e.message,
        }, task.tabId);
        await updateTask(task.taskId, { status: 'error', percent: 0, error: e.message || 'Native download failed' });
        updateBadge();
        processQueue();
    }
}

async function startQueuedBrowserDirectDownloadTask(task) {
    const latest = (await getTasks())[task.taskId];
    if (!latest || latest.status === 'cancelling') {
        if (latest?.status === 'cancelling') await removeTask(task.taskId);
        updateBadge();
        processQueue();
        return;
    }
    await startBrowserDirectDownload({
        taskId: task.taskId,
        url: task.url,
        fileName: task.fileName || 'download.mp4',
        tabId: task.tabId || 0,
        type: task.type || 'mp4',
    });
}

async function processQueue() {
    const tasks = await getTasks();
    const active = Object.values(tasks).filter(t => ['downloading', 'recording', 'stopping'].includes(t.status));
    if (active.length >= MAX_CONCURRENT) return;

    const waiting = Object.values(tasks)
        .filter(t => t.status === 'waiting')
        .sort((a, b) => a.addedAt - b.addedAt);
    if (!waiting.length) return;

    const task = waiting[0];
    const isLiveTask = isLiveRecordTask(task);
    recordDebugLog('info', 'queue.process', 'Task starting', {
        taskId: task.taskId,
        mode: task.mode,
        type: task.type,
        storageBackend: task.storageBackend,
        url: task.url,
        sourceUrl: task.sourceUrl || '',
        pageUrl: task.pageUrl || '',
        tabUrl: task.tabUrl || '',
        formatId: task.formatId || '',
        requestedFormatId: task.requestedFormatId || '',
        qualityLabel: task.qualityLabel || '',
        qualityResolution: task.qualityResolution || '',
        qualityHeight: task.qualityHeight || 0,
        fileName: task.fileName,
        recordMode: isLiveTask ? (task.recordMode || 'now') : undefined,
    }, task.tabId);

    if (isQueuedNativeDownloadTask(task)) {
        await startQueuedNativeDownloadTask(task);
        return;
    }

    if (isQueuedBrowserDirectDownloadTask(task)) {
        await startQueuedBrowserDirectDownloadTask(task);
        return;
    }

    await updateTask(task.taskId, { status: isLiveTask ? 'recording' : 'downloading', percent: 0 });

    // tab이 유효한지 확인
    let taskTab = null;
    try {
        taskTab = await chrome.tabs.get(task.tabId);
        if (!taskTab || taskTab.url.startsWith('chrome://')) {
            await updateTask(task.taskId, { status: 'error', percent: 0, error: 'Invalid tab' });
            if (isLiveTask) notifyLiveRecordControl(task, 'error', 'Invalid tab');
            else notifyHlsDownloadControl(task, 'error', 'Invalid tab');
            processQueue();
            return;
        }
    } catch (e) {
        await updateTask(task.taskId, { status: 'error', percent: 0, error: 'Tab not found' });
        if (isLiveTask) notifyLiveRecordControl(task, 'error', 'Tab not found');
        else notifyHlsDownloadControl(task, 'error', 'Tab not found');
        processQueue();
        return;
    }

    let storageBackend = task.storageBackend || (task.downloadPath ? 'companion' : 'browser');
    if (storageBackend === 'companion' && task.downloadPath) {
        const candidatePageUrl = task.pageUrl || task.tabUrl || taskTab?.url || '';
        const youtubeLivePageUrl = isLiveTask && isYouTubeLikeUrl(candidatePageUrl) ? candidatePageUrl : '';
        if (youtubeLivePageUrl) {
            const isWindowMode = task.recordMode === 'window';
            const nativeLiveName = String(task.fileName || 'youtube-live');
            const requestedFormatId = cleanYouTubeFormatId(task.formatId);
            const nativeFormatId = isWindowMode
                ? (requestedFormatId || buildYouTubeLiveWindowFormatSelector(task))
                : (
                    requestedFormatId ||
                    cleanYouTubeFormatId(extractYouTubeItagFromUrl(task.url)) ||
                    cleanYouTubeFormatId(extractYouTubeItagFromUrl(task.sourceUrl)) ||
                    ''
                );
            recordDebugLog('info', 'live.native', 'Starting YouTube live via yt-dlp', {
                taskId: task.taskId,
                pageUrl: youtubeLivePageUrl,
                hlsUrl: task.url,
                requestedFormatId,
                formatId: nativeFormatId,
                recordMode: task.recordMode || 'now',
                qualityLabel: task.qualityLabel || '',
                qualityResolution: task.qualityResolution || '',
                qualityHeight: task.qualityHeight || 0,
            }, task.tabId);
            try {
                await startNativeDownload(
                    task.taskId,
                    youtubeLivePageUrl,
                    nativeFormatId,
                    task.downloadPath,
                    nativeLiveName,
                    'live-ytdlp',
                    '',
                    {
                        isLive: true,
                        keepPartial: true,
                        liveRecordMode: task.recordMode || 'now',
                        requestedFormatId,
                        qualityLabel: task.qualityLabel || '',
                        qualityResolution: task.qualityResolution || '',
                        qualityHeight: task.qualityHeight || 0,
                        tabId: task.tabId,
                        allowCookieAuth: !!task.allowCookieAuth,
                    }
                );
            } catch (e) {
                recordDebugLog('error', 'live.native', 'YouTube live yt-dlp start failed', {
                    taskId: task.taskId,
                    error: e.message,
                }, task.tabId);
                await updateTask(task.taskId, { status: 'error', percent: 0, error: e.message || 'Native live start failed' });
                notifyLiveRecordControl(task, 'error', e.message || 'Native live start failed');
                updateBadge();
                processQueue();
            }
            return;
        }

        try {
            recordDebugLog('info', 'hls.native', 'Opening companion HLS stream', {
                taskId: task.taskId,
                fileName: task.fileName,
                isLive: isLiveTask,
                pageUrl: candidatePageUrl,
                formatId: task.formatId || '',
            }, task.tabId);
            const streamStart = await openNativeHlsStream(task.taskId, task.fileName, task.downloadPath);
            _activeHlsStorage.set(task.taskId, 'companion');
            const updates = {
                mode: isLiveTask ? 'live-native' : 'hls-native',
                storageBackend: 'companion'
            };
            if (streamStart?.filepath) {
                updates.filePath = streamStart.filepath;
                updates.fileName = basenameFromPath(streamStart.filepath);
            }
            await updateTask(task.taskId, updates);
        } catch (e) {
            console.warn('[BG] companion HLS 시작 실패, browser fallback:', e.message);
            recordDebugLog('warn', 'hls.native', 'Companion HLS stream failed, fallback to browser', {
                taskId: task.taskId,
                error: e.message,
            }, task.tabId);
            storageBackend = 'browser';
            await updateTask(task.taskId, {
                mode: isLiveTask ? 'live-record' : 'hls',
                storageBackend: 'browser',
                downloadPath: '',
                filePath: '',
            });
        }
    }

    if (storageBackend !== 'companion') {
        _activeHlsStorage.set(task.taskId, 'browser');
        await ensureOffscreen();
    }

    try {
        recordDebugLog('info', isLiveTask ? 'live.page' : 'download.page', 'Sending task to content script', {
            taskId: task.taskId,
            action: isLiveTask ? 'startLiveRecordInPage' : 'startDownloadInPage',
            url: task.url,
            qualityLabel: task.qualityLabel || '',
            qualityResolution: task.qualityResolution || '',
            qualityHeight: isLiveTask ? Number(task.qualityHeight || 0) : undefined,
        }, task.tabId);
        await chrome.tabs.sendMessage(task.tabId, {
            action: isLiveTask ? 'startLiveRecordInPage' : 'startDownloadInPage',
            taskId: task.taskId,
            url: task.url,
            fileName: task.fileName,
            recordMode: isLiveTask ? (task.recordMode || 'now') : undefined,
            qualityLabel: isLiveTask ? (task.qualityLabel || '') : undefined,
            qualityResolution: isLiveTask ? (task.qualityResolution || '') : undefined,
            qualityBandwidth: isLiveTask ? Number(task.qualityBandwidth || 0) : undefined
        });
    } catch (e) {
        console.error('[BG] content script 메시지 실패:', e.message);
        recordDebugLog('error', isLiveTask ? 'live.page' : 'download.page', 'Content script message failed', {
            taskId: task.taskId,
            error: e.message,
        }, task.tabId);
        if (storageBackend === 'companion') {
            cleanupHlsRoute(task.taskId);
            try { await cancelNativeHlsStream(task.taskId); } catch {}
        }
        await updateTask(task.taskId, { status: 'error', percent: 0, error: 'Content script not responding' });
        if (isLiveTask) notifyLiveRecordControl(task, 'error', 'Content script not responding');
        else notifyHlsDownloadControl(task, 'error', 'Content script not responding');
        processQueue();
    }
    updateBadge();
}

// ── Offscreen Document ──
async function ensureOffscreen() {
    if (offscreenReady) return;
    if (creatingOffscreen) { while (creatingOffscreen) await sleep(100); return; }
    creatingOffscreen = true;
    try {
        if (typeof chrome.runtime.getContexts === 'function') {
            const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
            if (ctx.length > 0) { offscreenReady = true; return; }
        }
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['BLOBS'],
            justification: 'OPFS 기반 대용량 영상 스트리밍 저장'
        });
        await sleep(300);
        offscreenReady = true;
    } catch (e) {
        if (e.message?.includes('already exists') || e.message?.includes('single offscreen')) offscreenReady = true;
        else console.error('[BG] Offscreen 생성 실패:', e);
    } finally {
        creatingOffscreen = false;
    }
}

// ── 유틸리티 ──
let _taskStorageQueue = Promise.resolve();
async function getTasks() {
    await _taskStorageQueue.catch(() => {});
    const { tasks = {} } = await chrome.storage.local.get('tasks');
    return tasks;
}
function mutateTasks(mutator) {
    const run = async () => {
        const { tasks = {} } = await chrome.storage.local.get('tasks');
        const result = await mutator(tasks);
        await chrome.storage.local.set({ tasks });
        return result;
    };
    const next = _taskStorageQueue.then(run, run);
    _taskStorageQueue = next.catch((e) => {
        console.warn('[MediaNab] task storage op 오류:', e);
    });
    return next;
}
async function saveTasks(tasks) {
    return mutateTasks((current) => {
        for (const key of Object.keys(current)) delete current[key];
        Object.assign(current, tasks || {});
    });
}
async function updateTask(taskId, updates) {
    return mutateTasks((tasks) => {
        if (tasks[taskId]) Object.assign(tasks[taskId], updates);
    });
}
async function removeTask(taskId) {
    return mutateTasks((tasks) => {
        delete tasks[taskId];
    });
}
function isBrowserDownloadCancelled(errorText = '') {
    return /USER_CANCELED|USER_CANCELLED/i.test(String(errorText || ''));
}

async function findBrowserTask(downloadId) {
    const tasks = await getTasks();
    const task = Object.values(tasks).find(t => t.downloadId === downloadId && t.mode === 'browser-direct');
    return task || null;
}

function syncBrowserDownloadTask(downloadId) {
    findBrowserTask(downloadId).then((task) => {
        if (!task) return;
        chrome.downloads.search({ id: downloadId }, async (results) => {
            const item = results?.[0];
            if (!item) {
                if (task.status === 'cancelling') {
                    await removeTask(task.taskId);
                    updateBadge();
                }
                return;
            }

            const totalBytes = item.totalBytes > 0 ? item.totalBytes : (task.totalBytes || 0);
            const receivedBytes = item.bytesReceived || 0;
            const percent = totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100))) : (task.percent || 0);

            if (item.state === 'complete') {
                await updateTask(task.taskId, {
                    status: 'done',
                    percent: 100,
                    fileName: basenameFromPath(item.filename) || task.fileName,
                    filesize: item.fileSize || item.totalBytes || item.bytesReceived || 0,
                    totalBytes: totalBytes || undefined,
                });
                updateBadge();
                processQueue();
                return;
            }

            if (item.state === 'interrupted') {
                if (task.status === 'cancelling' || isBrowserDownloadCancelled(item.error)) {
                    await removeTask(task.taskId);
                } else {
                    await updateTask(task.taskId, {
                        status: 'error',
                        percent,
                        totalBytes: totalBytes || undefined,
                        error: item.error || 'Browser download failed',
                    });
                }
                updateBadge();
                processQueue();
                return;
            }

            await updateTask(task.taskId, {
                status: task.status === 'cancelling' ? 'cancelling' : 'downloading',
                percent,
                totalBytes: totalBytes || undefined,
                filesize: receivedBytes || task.filesize || 0,
            });
            updateBadge();
        });
    }).catch((e) => {
        console.warn('[MediaNab] browser download sync 오류:', e);
    });
}

async function startBrowserDirectDownload({ taskId, url, fileName, tabId, type, fallbackError = '' }) {
    if (fallbackError) {
        recordDebugLog('warn', 'download.direct', 'Falling back to browser direct download', {
            taskId,
            url,
            fileName,
            error: fallbackError,
        }, tabId);
    }
    await mutateTasks((tasks) => {
        tasks[taskId] = {
            taskId,
            url,
            fileName: fileName || 'download',
            tabId: tabId || null,
            type: type || 'mp4',
            mode: 'browser-direct',
            storageBackend: 'browser',
            percent: 0,
            status: 'downloading',
            addedAt: tasks[taskId]?.addedAt || Date.now(),
            fallbackError: fallbackError || '',
        };
    });
    updateBadge();

    return new Promise((resolve) => {
        chrome.downloads.download({
            url,
            filename: fileName || undefined,
            conflictAction: 'uniquify',
            saveAs: false,
        }, async (downloadId) => {
            if (chrome.runtime.lastError || typeof downloadId !== 'number') {
                const error = chrome.runtime.lastError?.message || 'Browser download failed';
                await updateTask(taskId, {
                    status: 'error',
                    percent: 0,
                    error,
                });
                updateBadge();
                resolve({ ok: false, taskId, error });
                return;
            }

            const latestTasks = await getTasks();
            const currentStatus = latestTasks[taskId]?.status || 'downloading';
            await updateTask(taskId, { downloadId, status: currentStatus });
            syncBrowserDownloadTask(downloadId);
            updateBadge();

            if (currentStatus === 'cancelling') {
                chrome.downloads.cancel(downloadId, () => {});
            }

            resolve({ ok: true, taskId, downloadId });
        });
    });
}

async function startDirectNativeStreamDownload(taskId, msg, sender) {
    const tabId = Number(msg.tabId || sender.tab?.id || 0);
    const containerExt = normalizeDownloadContainerExt(msg.containerExt || inferDirectMediaExt(msg.url, 'mp4'));
    const fileName = replaceExtension(msg.fileName || 'video', containerExt);
    const downloadPath = msg.download_path || '';
    let streamOpened = false;

    await mutateTasks((tasks) => {
        tasks[taskId] = {
            taskId,
            url: msg.url,
            fileName,
            downloadPath,
            tabId,
            type: msg.type || containerExt || 'mp4',
            mode: 'direct-native-stream',
            storageBackend: 'companion',
            percent: 0,
            status: 'downloading',
            addedAt: Date.now(),
            referer: msg.referer || '',
        };
    });
    updateBadge();

    try {
        const streamStart = await openNativeHlsStream(taskId, fileName, downloadPath, containerExt);
        streamOpened = true;
        _activeHlsStorage.set(taskId, 'companion');
        if (streamStart?.filepath) {
            await updateTask(taskId, {
                filePath: streamStart.filepath,
                fileName: basenameFromPath(streamStart.filepath) || fileName,
            });
        }

        const response = await chrome.tabs.sendMessage(tabId, {
            action: 'startDirectDownloadInPage',
            taskId,
            url: msg.url,
            fileName,
            containerExt,
        });
        if (response?.status !== 'started') {
            throw new Error(response?.message || 'Content script did not start direct media stream');
        }
        return { ok: true, status: 'started', taskId };
    } catch (e) {
        cleanupHlsRoute(taskId);
        if (streamOpened) {
            try { await cancelNativeHlsStream(taskId); } catch {}
        }
        return startBrowserDirectDownload({
            taskId,
            url: msg.url,
            fileName,
            tabId,
            type: msg.type || containerExt || 'mp4',
            fallbackError: e.message || 'Direct native stream failed before page fetch started',
        });
    }
}

function cancelNativeDownloadViaActivePort(downloadId) {
    const port = _activeNativePorts.get(downloadId);
    if (!port) return false;
    try {
        port.postMessage({ action: 'cancel', download_id: downloadId });
        return true;
    } catch {
        return false;
    }
}
async function cancelTask(taskId) {
    const task = (await getTasks())[taskId];
    if (!task) return;
    if (isLiveRecordTask(task)) {
        await stopLiveRecordTask(taskId);
        return;
    }
    await mutateTasks((tasks) => {
        if (!tasks[taskId]) return;
        if (['waiting', 'waiting_metadata', 'error'].includes(tasks[taskId].status)) delete tasks[taskId];
        else tasks[taskId].status = 'cancelling';
    });
    notifyHlsDownloadControl(task, 'cancelled');
    chrome.runtime.sendMessage({ action: 'offscreen-cancel', taskId }).catch(() => {});

    // yt-dlp(native) 작업도 함께 취소
    if (task.mode === 'ytdlp' || task.mode === 'youtube-direct') {
        const sent = cancelNativeDownloadViaActivePort(taskId);
        if (!sent) {
            companionRequest({ action: 'cancel', download_id: taskId }).catch(() => {});
        }
    } else if (task.mode === 'hls-native' || task.mode === 'direct-native-stream') {
        try { await cancelNativeHlsStream(taskId); } catch {}
    } else if (task.mode === 'browser-direct' && task.downloadId) {
        chrome.downloads.cancel(task.downloadId, () => {});
    }
}
async function updateBadge() {
    const tasks = await getTasks();
    const active = Object.values(tasks).filter(t => ['downloading', 'recording', 'stopping'].includes(t.status));
    if (active.length === 1) {
        const task = active[0];
        if (isLiveRecordTask(task)) {
            chrome.action.setBadgeText({ text: task.status === 'stopping' ? 'END' : 'REC' });
        } else {
            chrome.action.setBadgeText({ text: `${task.percent || 0}%` });
        }
    } else if (active.length > 1) chrome.action.setBadgeText({ text: `${active.length}↓` });
    else chrome.action.setBadgeText({ text: '' });
}
function sanitizeFilename(name) { return name.replace(/[\\/:*?"<>|]/g, '_').substring(0, 200); }
function normalizeDownloadContainerExt(ext = 'ts') {
    const value = String(ext || '').replace(/^\./, '').toLowerCase();
    return ['ts', 'mp4', 'm4v', 'webm', 'mkv', 'flv'].includes(value) ? value : 'ts';
}
function inferDirectMediaExt(url = '', fallback = 'mp4') {
    const match = String(url || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    const ext = match ? normalizeDownloadContainerExt(match[1]) : normalizeDownloadContainerExt(fallback);
    return ext === 'ts' ? normalizeDownloadContainerExt(fallback) || 'mp4' : ext;
}
function replaceExtension(fileName, ext = 'ts') {
    const safeExt = normalizeDownloadContainerExt(ext);
    const base = String(fileName || 'video.ts').replace(/\.[^.\\/]+$/, '');
    return `${base}.${safeExt}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function registerYouTubePageDetected(tabId, currentUrl) {
    if (!(await prepareDetectedContext(tabId, currentUrl, 'youtube-page'))) return;
    if (isYouTubeShortsUrl(currentUrl)) {
        scheduleYouTubeMetadataHydrate(tabId, currentUrl, 'youtube-page');
        return;
    }
    const snapshot = await requestPageSnapshot(tabId, currentUrl, 'youtube');
    if (!(await isTabContextCurrent(tabId, currentUrl))) return;
    const pageTitle = cleanNativeTitleCandidate(snapshot?.pageTitle || '', currentUrl);
    if (!pageTitle) {
        scheduleYouTubeMetadataHydrate(tabId, currentUrl, 'youtube-page-missing-title');
        return;
    }
    const thumbnail = snapshot?.thumbnail || buildYouTubeThumbnailUrl(currentUrl);
    const thumbnailKind = thumbnail ? (snapshot?.thumbnailKind || 'image') : 'unknown';
    saveDetectedVideo(
        tabId,
        currentUrl,
        'youtube',
        pageTitle,
        currentUrl,
        thumbnail,
        thumbnailKind,
        null,
        false,
        '',
        snapshot?.pageTitleSource || 'youtube-metadata'
    );
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
    _tabPaths.delete(tabId);
    const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
    delete detectedVideos[tabId];
    await chrome.storage.local.set({ detectedVideos });
});

chrome.downloads.onChanged.addListener((delta) => {
    if (!delta?.id) return;
    if (!delta.state && !delta.bytesReceived && !delta.totalBytes && !delta.error && !delta.filename) return;
    syncBrowserDownloadTask(delta.id);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const currentUrl = changeInfo.url || tab.url;
    if (!currentUrl) return;

    try {
        const u = new URL(currentUrl);
        await resetDetectedVideosForTabContext(tabId, currentUrl, changeInfo.url ? 'tab-url' : 'tab-update');

        const isYouTubeVideo = u.hostname.includes('youtube.com') && 
            ((u.pathname === '/watch' && u.searchParams.has('v')) || 
             u.pathname.startsWith('/shorts/') || 
             u.pathname.startsWith('/live/'));

        // watch/shorts/live 페이지 감지 및 자동 등록
        if (isYouTubeVideo) {
            if (changeInfo.status === 'complete' || changeInfo.url) {
                const delay = changeInfo.status === 'complete' ? 80 : 320;
                setTimeout(() => {
                    registerYouTubePageDetected(tabId, currentUrl).catch(() => {
                        scheduleYouTubeMetadataHydrate(tabId, currentUrl, 'youtube-page-error');
                    });
                }, delay);
            }
        }
    } catch {}
});

console.log('[MediaNab] Service Worker 시작 v1.2.4.06');

// ── SW 시작 시 초기화: 현재 열린 탭 URL 등록 + 닫힌 탭 데이터 정리 ──
(async () => {
    try {
        const tabs = await chrome.tabs.query({});
        const openTabIds = new Set();
        for (const tab of tabs) {
            if (tab.id && tab.url) {
                openTabIds.add(tab.id);
                _tabPaths.set(tab.id, getPageContextKey(tab.url));
            }
        }
        // 닫힌 탭의 detectedVideos 정리
        const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
        let cleaned = false;
        for (const tid of Object.keys(detectedVideos)) {
            if (!openTabIds.has(parseInt(tid))) {
                delete detectedVideos[tid];
                cleaned = true;
            }
        }
        if (cleaned) await chrome.storage.local.set({ detectedVideos });
    } catch {}
})();

// ── Companion (Native Messaging) 통신 ──

const NATIVE_HOST = 'com.medianab.host';

/**
 * Companion에 1회성 요청 후 응답 반환
 * 연결 실패 시 reject → 호출부에서 fallback 처리
 */
function companionRequest(msg) {
    return new Promise((resolve, reject) => {
        try {
            const port = chrome.runtime.connectNative(NATIVE_HOST);
            let responded = false;
            const timeoutMs = msg?.action === 'generatePreview' ? 120000 : 30000;

            port.onMessage.addListener((response) => {
                responded = true;
                resolve(response);
                port.disconnect();
            });

            port.onDisconnect.addListener(() => {
                if (!responded) {
                    const err = chrome.runtime.lastError?.message || 'Companion disconnected';
                    reject(new Error(err));
                }
            });

            port.postMessage(msg);

            setTimeout(() => {
                if (!responded) {
                    reject(new Error('Companion timeout'));
                    try { port.disconnect(); } catch {}
                }
            }, timeoutMs);
        } catch (e) {
            reject(new Error(`Native connect failed: ${e.message}`));
        }
    });
}

/**
 * Native companion 다운로드 시작 (장기 연결 + 진행률 스트리밍)
 */
const _activeNativePorts = new Map();
const _activeNativeStreamPorts = new Map();
const _activeHlsStorage = new Map();

function basenameFromPath(filepath) {
    return filepath ? filepath.split('/').pop().split('\\').pop() : '';
}

function buildNativeLiveCompletionUpdates(response = {}, fallbackPath = '') {
    const fp = response.filepath || fallbackPath || '';
    const resultStatus = response.result_status || (fp ? 'done' : 'failed');
    const fname = basenameFromPath(fp);
    const failed = resultStatus === 'failed' || !fp;
    const updates = {
        status: failed ? 'error' : 'done',
        percent: failed ? 0 : 100,
        filePath: fp,
        finalizeStage: '',
        finalizeMessage: '',
        repairStatus: '',
    };
    if (fname) updates.fileName = fname;
    if (response.filesize) updates.filesize = response.filesize;
    if (response.original_filepath) updates.originalFilePath = response.original_filepath;
    if (failed) updates.error = response.error || 'Recording stopped, but no usable output file was preserved';
    return updates;
}

function cleanupHlsRoute(taskId) {
    _activeHlsStorage.delete(taskId);
}

function createNativeStreamSession(taskId) {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    const session = {
        taskId,
        port,
        pending: [],
        closing: false,
    };

    port.onMessage.addListener((response) => {
        const pending = session.pending.shift();
        if (pending) pending.resolve(response);
        else console.warn('[BG] 예상치 못한 native stream 응답:', response);
    });

    port.onDisconnect.addListener(async () => {
        const err = new Error(chrome.runtime.lastError?.message || 'Companion disconnected');
        const pendings = session.pending.splice(0);
        pendings.forEach(p => p.reject(err));
        const known = _activeNativeStreamPorts.get(taskId);
        if (known === session) _activeNativeStreamPorts.delete(taskId);
        if (session.closing) return;

        const tasks = await getTasks();
        const task = tasks[taskId];
        if (
            task &&
            ['downloading', 'recording', 'stopping'].includes(task.status) &&
            (task.mode === 'hls-native' || task.mode === 'live-native')
        ) {
            cleanupHlsRoute(taskId);
            await updateTask(taskId, { status: 'error', percent: 0, error: 'Companion disconnected' });
            updateBadge();
            processQueue();
        }
    });

    _activeNativeStreamPorts.set(taskId, session);
    return session;
}

function closeNativeStreamSession(taskId) {
    const session = _activeNativeStreamPorts.get(taskId);
    if (!session) return;
    session.closing = true;
    _activeNativeStreamPorts.delete(taskId);
    try { session.port.disconnect(); } catch {}
}

function sendNativeStreamRequest(taskId, payload) {
    const session = _activeNativeStreamPorts.get(taskId);
    if (!session) return Promise.reject(new Error('Native HLS stream not active'));

    return new Promise((resolve, reject) => {
        session.pending.push({ resolve, reject });
        try {
            session.port.postMessage(payload);
        } catch (e) {
            session.pending.pop();
            reject(e);
        }
    });
}

async function openNativeHlsStream(taskId, fileName, downloadPath, containerExt = 'ts') {
    let session = _activeNativeStreamPorts.get(taskId);
    if (!session) session = createNativeStreamSession(taskId);

    try {
        const response = await sendNativeStreamRequest(taskId, {
            action: 'streamStart',
            download_id: taskId,
            file_name: fileName || '',
            download_path: downloadPath || '',
            container_ext: normalizeDownloadContainerExt(containerExt),
        });
        if (response?.status !== 'started') {
            throw new Error(response?.message || 'Native HLS stream start failed');
        }
        return response;
    } catch (e) {
        closeNativeStreamSession(taskId);
        throw e;
    }
}

async function writeNativeHlsChunk(taskId, bytes) {
    // Native messaging payload is JSON-encoded, so keep binary slices conservative.
    const MAX_CHUNK = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK) {
        const response = await sendNativeStreamRequest(taskId, {
            action: 'streamWrite',
            download_id: taskId,
            bytes: bytes.slice(offset, offset + MAX_CHUNK),
        });
        if (response?.status !== 'ok') {
            throw new Error(response?.message || 'Native HLS stream write failed');
        }
    }
}

async function finalizeNativeHlsStream(taskId, containerExt = 'ts', fileName = '') {
    try {
        const response = await sendNativeStreamRequest(taskId, {
            action: 'streamFinish',
            download_id: taskId,
            container_ext: containerExt,
            file_name: replaceExtension(fileName || 'video.ts', containerExt),
        });
        if (response?.status !== 'complete') {
            throw new Error(response?.message || 'Native HLS stream finalize failed');
        }
        return response;
    } finally {
        closeNativeStreamSession(taskId);
    }
}

async function cancelNativeHlsStream(taskId) {
    const session = _activeNativeStreamPorts.get(taskId);
    if (!session) return { status: 'cancelled' };
    try {
        return await sendNativeStreamRequest(taskId, {
            action: 'streamCancel',
            download_id: taskId,
        });
    } finally {
        closeNativeStreamSession(taskId);
    }
}

async function startNativeDownload(downloadId, url, formatId, downloadPath, fileName, mode = 'ytdlp', referer = '', options = {}) {
    const taskId = downloadId;
    const isLiveNative = !!options.isLive;
    assertYouTubeAllowedForVariant({
        url,
        pageUrl: options.pageUrl || '',
        tabUrl: options.tabUrl || '',
        titleResolveUrl: options.titleResolveUrl || '',
        sourceUrl: options.sourceUrl || '',
        liveRecord: isLiveNative,
        live_record: isLiveNative,
    }, isLiveNative ? 'live-record' : 'download');
    const liveRecordMode = options.liveRecordMode === 'window' ? 'window' : 'now';
    const displayName = options.displayName || fileName || 'yt-dlp download';
    recordDebugLog('info', 'download.native', 'Native download starting', {
        taskId,
        mode,
        url,
        formatId: formatId || '',
        requestedFormatId: options.requestedFormatId || formatId || '',
        qualityLabel: options.qualityLabel || '',
        qualityResolution: options.qualityResolution || '',
        qualityHeight: Number(options.qualityHeight || 0) || 0,
        fileName,
        displayName,
        hasAudioUrl: !!options.audioUrl,
        referer,
        isLive: isLiveNative,
        liveRecordMode: isLiveNative ? liveRecordMode : '',
    }, options.tabId || null);
    await mutateTasks((tasks) => {
        const existing = tasks[taskId] || {};
        tasks[taskId] = {
            ...existing,
            taskId,
            status: isLiveNative ? 'recording' : 'downloading',
            percent: existing.percent || 0,
            url,
            fileName: displayName,
            mode,
            type: isLiveNative ? (existing.type || 'live-hls') : existing.type,
            downloadPath: downloadPath || existing.downloadPath || '',
            recordingStartedAt: isLiveNative ? (existing.recordingStartedAt || Date.now()) : existing.recordingStartedAt,
            elapsedSec: isLiveNative ? (existing.elapsedSec || 0) : existing.elapsedSec,
            filesize: isLiveNative ? (existing.filesize || 0) : existing.filesize,
            addedAt: existing.addedAt || Date.now(),
        };
    });
    updateBadge();

    return new Promise((resolve, reject) => {
        try {
            const port = chrome.runtime.connectNative(NATIVE_HOST);
            let nativePortClosedIntentionally = false;

            port.onMessage.addListener(async (response) => {
                if (response.type === 'debug') {
                    recordDebugLog(response.level || 'info', response.scope || 'companion.download', response.message || 'Companion debug', {
                        ...(response.data || {}),
                        downloadId: response.download_id || downloadId,
                    }, options.tabId || null);
                } else if (response.type === 'warning') {
                    const warningMessage = response.message || 'Selected quality unavailable; recording Best instead.';
                    recordDebugLog('warn', response.scope || 'companion.download', warningMessage, {
                        ...(response.data || {}),
                        downloadId: response.download_id || downloadId,
                        warningCode: response.warning_code || '',
                    }, options.tabId || null);
                    await updateTask(taskId, { warning: warningMessage });
                    updateBadge();
                } else if (response.status === 'started') {
                    recordDebugLog('info', 'download.native', 'Native host accepted download', {
                        taskId,
                        downloadId: response.download_id || downloadId,
                    }, options.tabId || null);
                } else if (response.status === 'error' || response.status === 'cookie_auth_required') {
                    const authRequired = isCookieAuthRequiredResponse(response);
                    if (authRequired) markCookieAuthRequired(url);
                    const message = authRequired
                        ? getCookieAuthRequiredMessage()
                        : (response.message || 'Download failed');
                    recordDebugLog('error', 'download.native', 'Native download start error', {
                        taskId,
                        message,
                        status: response.status || '',
                        errorCode: response.error_code || '',
                    }, options.tabId || null);
                    await updateTask(taskId, { status: 'error', percent: 0, error: message });
                    if (isLiveNative) notifyLiveRecordControl({ taskId, tabId: options.tabId, type: 'live-hls' }, 'error', message);
                    updateBadge(); processQueue();
                    _activeNativePorts.delete(downloadId);
                    nativePortClosedIntentionally = true;
                    try { port.disconnect(); } catch {}
                } else if (response.type === 'progress') {
                    const ts = await getTasks();
                    if (ts[taskId]?.status === 'cancelling') return;
                    const updates = {
                        percent: isLiveNative ? (ts[taskId]?.percent || 0) : (response.percent || 0),
                        speed: response.speed || '',
                        eta: response.eta || '',
                    };
                    if (isLiveNative) {
                        if (response.elapsedSec) updates.elapsedSec = response.elapsedSec;
                        if (response.filesize) updates.filesize = response.filesize;
                        if (response.stage) updates.finalizeStage = response.stage;
                        if (response.message) updates.finalizeMessage = response.message;
                    }
                    await updateTask(taskId, updates);
                    updateBadge();
                } else if (response.type === 'complete') {
                    recordDebugLog('info', 'download.native', 'Native download complete', {
                        taskId,
                        filepath: response.filepath || '',
                        filesize: response.filesize || 0,
                        resultStatus: response.result_status || '',
                    }, options.tabId || null);
                    const ts = await getTasks();
                    if (!isLiveNative && ts[taskId]?.status === 'cancelling') {
                        await removeTask(taskId);
                        updateBadge(); processQueue();
                        _activeNativePorts.delete(downloadId);
                        try { port.disconnect(); } catch {}
                        return;
                    }
                    const fp = response.filepath || '';
                    if (!fp && options.directFallback) {
                        const fallbackExt = normalizeDownloadContainerExt(options.fallbackContainerExt || inferDirectMediaExt(url, 'mp4'));
                        const fallbackFileName = replaceExtension(options.fallbackFileName || fileName || displayName || 'video', fallbackExt);
                        recordDebugLog('warn', 'download.direct', 'Native direct download completed without output path, falling back to page-session stream', {
                            taskId,
                            url,
                            fileName: fallbackFileName,
                        }, options.fallbackTabId || options.tabId || null);
                        _activeNativePorts.delete(downloadId);
                        nativePortClosedIntentionally = true;
                        try { port.disconnect(); } catch {}
                        try {
                            await startDirectNativeStreamDownload(taskId, {
                                url,
                                tabId: options.fallbackTabId || options.tabId || 0,
                                fileName: fallbackFileName,
                                download_path: options.fallbackDownloadPath || downloadPath || '',
                                type: options.fallbackType || fallbackExt || 'mp4',
                                containerExt: fallbackExt,
                                referer: options.fallbackReferer || referer || '',
                            }, { tab: { id: options.fallbackTabId || options.tabId || 0 } });
                        } catch (fallbackError) {
                            await updateTask(taskId, {
                                status: 'error',
                                percent: 0,
                                error: fallbackError.message || 'Direct media completed without output path',
                            });
                            updateBadge();
                            processQueue();
                        }
                        updateBadge();
                        return;
                    }
                    const updates = isLiveNative
                        ? buildNativeLiveCompletionUpdates(response, fp)
                        : { status: 'done', percent: 100, filePath: fp };
                    if (!isLiveNative) {
                        const fname = fp ? fp.split('/').pop().split('\\').pop() : '';
                        if (response.filesize) updates.filesize = response.filesize;
                        if (fname) updates.fileName = fname;
                    }

                    await updateTask(taskId, updates);
                    if (isLiveNative) {
                        const controlStatus = updates.status === 'error' ? 'error' : 'done';
                        notifyLiveRecordControl(ts[taskId] || { taskId, tabId: options.tabId, type: 'live-hls' }, controlStatus, updates.error || '');
                    }
                    updateBadge(); processQueue();
                    _activeNativePorts.delete(downloadId);
                    nativePortClosedIntentionally = true;
                    port.disconnect();
                } else if (response.type === 'error') {
                    const authRequired = isCookieAuthRequiredResponse(response);
                    if (authRequired) markCookieAuthRequired(url);
                    const errorMessage = authRequired
                        ? getCookieAuthRequiredMessage()
                        : (response.message || 'Download failed');
                    recordDebugLog('error', 'download.native', 'Native download error', {
                        taskId,
                        message: errorMessage,
                        errorCode: response.error_code || '',
                    }, options.tabId || null);
                    const ts = await getTasks();
                    if (!isLiveNative && ts[taskId]?.status === 'cancelling') {
                        await removeTask(taskId);
                        updateBadge(); processQueue();
                        _activeNativePorts.delete(downloadId);
                        try { port.disconnect(); } catch {}
                        return;
                    }
                    if (authRequired) {
                        await updateTask(taskId, {
                            status: 'error', percent: 0,
                            error: errorMessage,
                        });
                        if (isLiveNative) notifyLiveRecordControl(ts[taskId] || { taskId, tabId: options.tabId, type: 'live-hls' }, 'error', errorMessage);
                        updateBadge(); processQueue();
                        _activeNativePorts.delete(downloadId);
                        nativePortClosedIntentionally = true;
                        port.disconnect();
                        return;
                    }
                    if (options.directFallback) {
                        const fallbackExt = normalizeDownloadContainerExt(options.fallbackContainerExt || inferDirectMediaExt(url, 'mp4'));
                        const fallbackFileName = replaceExtension(options.fallbackFileName || fileName || displayName || 'video', fallbackExt);
                        recordDebugLog('warn', 'download.direct', 'Native direct download failed, falling back to page-session stream', {
                            taskId,
                            url,
                            fileName: fallbackFileName,
                            error: response.message || 'Download failed',
                        }, options.fallbackTabId || options.tabId || null);
                        _activeNativePorts.delete(downloadId);
                        nativePortClosedIntentionally = true;
                        try { port.disconnect(); } catch {}
                        try {
                            await startDirectNativeStreamDownload(taskId, {
                                url,
                                tabId: options.fallbackTabId || options.tabId || 0,
                                fileName: fallbackFileName,
                                download_path: options.fallbackDownloadPath || downloadPath || '',
                                type: options.fallbackType || fallbackExt || 'mp4',
                                containerExt: fallbackExt,
                                referer: options.fallbackReferer || referer || '',
                            }, { tab: { id: options.fallbackTabId || options.tabId || 0 } });
                        } catch (fallbackError) {
                            await updateTask(taskId, {
                                status: 'error',
                                percent: 0,
                                error: fallbackError.message || response.message || 'Direct media fallback failed',
                            });
                            updateBadge();
                            processQueue();
                        }
                        updateBadge();
                        return;
                    }
                    await updateTask(taskId, {
                        status: 'error', percent: 0,
                        error: errorMessage,
                    });
                    if (isLiveNative) notifyLiveRecordControl(ts[taskId] || { taskId, tabId: options.tabId, type: 'live-hls' }, 'error', errorMessage);
                    updateBadge(); processQueue();
                    _activeNativePorts.delete(downloadId);
                    nativePortClosedIntentionally = true;
                    port.disconnect();
                } else if (response?.status === 'cancelled') {
                    if (isLiveNative) {
                        const ts = await getTasks();
                        const current = ts[taskId] || { taskId, tabId: options.tabId, type: 'live-hls' };
                        const fp = response.filepath || current.filePath || '';
                        if (fp) {
                            const updates = buildNativeLiveCompletionUpdates(response, fp);
                            await updateTask(taskId, updates);
                            const controlStatus = updates.status === 'error' ? 'error' : 'done';
                            notifyLiveRecordControl(current, controlStatus, updates.error || '');
                        } else {
                            const message = response.error || 'Recording stopped, but the output path was not reported';
                            recordDebugLog('warn', 'download.native', 'Live recording stopped before output path was detected', {
                                taskId,
                                kept: !!response.kept,
                            }, options.tabId || null);
                            await updateTask(taskId, { status: 'error', percent: 0, error: message });
                            notifyLiveRecordControl(current, 'error', message);
                        }
                    } else {
                        await removeTask(taskId);
                    }
                    updateBadge(); processQueue();
                    _activeNativePorts.delete(downloadId);
                    nativePortClosedIntentionally = true;
                    try { port.disconnect(); } catch {}
                }
            });

            port.onDisconnect.addListener(async () => {
                _activeNativePorts.delete(downloadId);
                if (nativePortClosedIntentionally) return;
                const ts = await getTasks();
                if (['downloading', 'recording'].includes(ts[taskId]?.status)) {
                    recordDebugLog('error', 'download.native', 'Native port disconnected during download', {
                        taskId,
                        error: chrome.runtime.lastError?.message || 'Companion disconnected',
                    }, options.tabId || null);
                    await updateTask(taskId, { status: 'error', error: 'Companion disconnected' });
                    if (isLiveNative) notifyLiveRecordControl(ts[taskId] || { taskId, tabId: options.tabId, type: 'live-hls' }, 'error', 'Companion disconnected');
                    updateBadge();
                }
            });

            port.postMessage({
                action: 'download',
                url,
                format_id: formatId || '',
                requested_format_id: options.requestedFormatId || formatId || '',
                quality_label: options.qualityLabel || '',
                quality_resolution: options.qualityResolution || '',
                quality_height: Number(options.qualityHeight || 0) || 0,
                audio_url: options.audioUrl || '',
                video_ext: options.videoExt || '',
                audio_ext: options.audioExt || '',
                download_path: downloadPath || '',
                download_id: downloadId,
                file_name: fileName || '',
                referer: referer || '',
                allow_cookie_auth: !!options.allowCookieAuth,
                keep_partial: !!options.keepPartial,
                live_record: isLiveNative,
                live_record_mode: isLiveNative ? liveRecordMode : '',
            });

            _activeNativePorts.set(downloadId, port);
            resolve({ status: 'started', downloadId });
        } catch (e) {
            reject(new Error(`Native download failed: ${e.message}`));
        }
    });
}
