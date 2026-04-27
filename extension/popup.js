// popup.js — CSP 준수: inline onclick 없음, 이벤트 위임으로 처리

const I18N = {
    en: {
        lblDetected:'Detected Videos', lblQueue:'Download Queue', btnDl:'Download', btnCancel:'Cancel', btnRemove:'Remove',
        btnRecStart:'Start Recording', btnRecStop:'Stop Recording',
        stWaiting:'Waiting', stMetadata:'Checking info', stDl:'Downloading', stRecording:'Recording', stStopping:'Stopping', stMerging:'Merging', stFinalizing:'Finalizing', stNormalizing:'Normalizing', stErr:'Error',
        noVids:'No videos detected on this page', clearList:'Clear list', refreshList:'Refresh', quality:'Quality',
        qualityBest:'Best',
        qualityLoading:'Checking qualities...',
        liveMode:'Mode', liveModeNow:'From now', liveModeWindow:'Include previous',
        companionRequired:'To download from this site, install MediaNab Companion.',
        liveRecordRequiresCompanion:'Live recording currently requires MediaNab Companion.',
        liveRecordHlsOnly:'Live recording currently supports HLS live streams.',
        blockedByChannelPolicy:'Due to Google Web Store policy, this build does not support YouTube downloads or recording. Use the Edge, Firefox, or direct build.',
        youtubeDetected:'Detected video',
        youtubeDownload:'Companion download',
        setupGuide:'Setup Guide', ytdlpDl:'Downloading via companion...', queuedAfterMetadata:'Queued. Download starts after info check.', directStreamDl:'Downloading in browser session...', stDone:'Saved', noDownloads:'No downloads',
        companionChecking:'Checking connection', companionBrowserMode:'Browser download mode',
        companionYtdlpMissing:'Companion connected · yt-dlp not installed',
        companionBrowserDownloadPath:'Browser default download folder',
        pathChangeFolder:'Change folder', pathOpenFolder:'Open folder',
        companionShowDetails:'Show Companion details', companionHideDetails:'Hide Companion details',
        btnPlay:'Play', tabDetected:'Detected', tabQueue:'Queue', clearDone:'Clear done',
        lblLogs:'Logs', btnLogsExpand:'Open', btnLogsCollapse:'Hide', btnLogsFull:'Full',
        btnClearLogs:'Clear logs', btnCopyLogs:'Copy', noLogs:'No logs yet',
        logsCopied:'Logs copied', logsCleared:'Logs cleared',
        cookieAuth:'Cookie auth', cookieAuthOff:'Off', cookieAuthChrome:'Chrome', cookieAuthEdge:'Edge',
        cookieAuthCookies:'cookies.txt', cookieAuthPick:'Pick', cookieAuthSaved:'Cookie auth saved',
        cookieAuthRequired:'Browser cookie authentication is required. Select Chrome, Edge, or cookies.txt in Cookie auth.'
    },
    ko: {
        lblDetected:'감지된 영상', lblQueue:'다운로드 큐', btnDl:'다운로드', btnCancel:'취소', btnRemove:'제거',
        btnRecStart:'녹화 시작', btnRecStop:'녹화 중지',
        stWaiting:'대기 중', stMetadata:'정보 확인 중', stDl:'다운로드 중', stRecording:'녹화 중', stStopping:'종료 중', stMerging:'병합 중', stFinalizing:'마무리 중', stNormalizing:'정규화 중', stErr:'오류',
        noVids:'이 페이지에서 감지된 영상이 없습니다', clearList:'목록 지우기', refreshList:'새로고침', quality:'화질',
        qualityBest:'Best',
        qualityLoading:'화질 확인 중...',
        liveMode:'모드', liveModeNow:'지금부터', liveModeWindow:'이전 구간 포함',
        companionRequired:'이 사이트의 다운로드에는 MediaNab Companion 설치가 필요합니다.',
        liveRecordRequiresCompanion:'라이브 녹화에는 MediaNab Companion 연결이 필요합니다.',
        liveRecordHlsOnly:'라이브 녹화는 현재 HLS 라이브 스트림만 지원합니다.',
        blockedByChannelPolicy:'Google Web Store 정책으로 인해 이 빌드에서는 YouTube 다운로드/녹화를 지원하지 않습니다. Edge, Firefox 또는 direct build를 사용하세요.',
        youtubeDetected:'감지된 영상',
        youtubeDownload:'Companion 다운로드',
        setupGuide:'설치 가이드', ytdlpDl:'Companion으로 다운로드 중...', queuedAfterMetadata:'큐에 등록했습니다. 정보 확인 후 다운로드를 시작합니다.', directStreamDl:'브라우저 세션으로 다운로드 중...', stDone:'저장됨', noDownloads:'다운로드 내역이 없습니다',
        companionChecking:'연결 확인 중', companionBrowserMode:'일반 다운로드 모드',
        companionYtdlpMissing:'Companion 연결됨 · yt-dlp 미설치',
        companionBrowserDownloadPath:'브라우저 기본 다운로드 폴더',
        pathChangeFolder:'저장 폴더 변경', pathOpenFolder:'저장 폴더 열기',
        companionShowDetails:'Companion 상세 정보 펼치기', companionHideDetails:'Companion 상세 정보 접기',
        btnPlay:'재생', tabDetected:'감지됨', tabQueue:'다운로드 큐', clearDone:'완료 항목 지우기',
        lblLogs:'로그', btnLogsExpand:'열기', btnLogsCollapse:'접기', btnLogsFull:'전체화면',
        btnClearLogs:'로그 지우기', btnCopyLogs:'복사', noLogs:'로그 없음',
        logsCopied:'로그 복사됨', logsCleared:'로그를 지웠습니다',
        cookieAuth:'쿠키 인증', cookieAuthOff:'끔', cookieAuthChrome:'Chrome', cookieAuthEdge:'Edge',
        cookieAuthCookies:'cookies.txt', cookieAuthPick:'선택', cookieAuthSaved:'쿠키 인증 설정 저장됨',
        cookieAuthRequired:'브라우저 쿠키 인증이 필요합니다. 쿠키 인증에서 Chrome/Edge 또는 cookies.txt를 선택하세요.'
    }
};
let lang = localStorage.getItem('mn_lang') || 'en';
let sortKey = 'time';
let sortKeyQ = 'time';
let currentTabId = null;
let currentTabUrl = '';
let _sortedVideos = [];
const YTDLP_HIGH_QUALITY_MIN = [2026, 3, 17];
const COOKIE_AUTH_SUPPRESS_MS = 10 * 60 * 1000;
const nativeFormatInflight = new Set();
const nativeFormatAuthBlocked = new Map();
const thumbnailDisplayUrls = new Map();
const thumbnailInflight = new Map();

// 화질 선택 상태 저장 (URL 단위, 재렌더링대원도 유지)
const qualityState = new Map(); // key: videoUrl → selectedIndex
const liveModeState = new Map(); // key: videoUrl → now | window
let _companionStatus = null; // null=미확인, {status:'ok',...} 또는 {status:'disconnected'}
let _companionStatusChecked = false;
let _companionDetailsExpanded = false;
let _lastTasks = {};
let _debugLogs = [];
let _debugPanelExpanded = localStorage.getItem('mn_debug_logs_expanded') === '1';
const VARIANT_CONFIG = globalThis.__MEDIANAB_VARIANT__ || {
    buildVariant: 'full',
    flags: {
        enableYouTubeDetection: true,
        enableYouTubeDownload: true,
        enableYouTubeLiveRecord: true,
    },
    policy: {
        blockedStatus: 'blocked_by_channel_policy',
    },
};

const t = k => I18N[lang][k] || k;

function getBlockedByChannelPolicyMessage() {
    return t('blockedByChannelPolicy');
}

function canDownloadYouTube(videoOrUrl) {
    if (!VARIANT_CONFIG.flags.enableYouTubeDownload) return false;
    return !!getYouTubePageUrl(videoOrUrl);
}

function canRecordYouTubeLive(videoOrUrl) {
    if (!VARIANT_CONFIG.flags.enableYouTubeLiveRecord) return false;
    return !!getYouTubePageUrl(videoOrUrl);
}

function canShowCookieAuthControls() {
    return !!(VARIANT_CONFIG.flags.enableYouTubeDownload || VARIANT_CONFIG.flags.enableYouTubeLiveRecord);
}

function getNativeFormatAuthKey(url = '') {
    return getYouTubePageKey(url) || String(url || '');
}

function markNativeFormatAuthBlocked(url = '') {
    const key = getNativeFormatAuthKey(url);
    if (key) nativeFormatAuthBlocked.set(key, Date.now() + COOKIE_AUTH_SUPPRESS_MS);
}

function clearNativeFormatAuthBlocked(url = '') {
    const key = getNativeFormatAuthKey(url);
    if (key) nativeFormatAuthBlocked.delete(key);
}

function isNativeFormatAuthBlocked(url = '') {
    const key = getNativeFormatAuthKey(url);
    if (!key) return false;
    const until = nativeFormatAuthBlocked.get(key) || 0;
    if (until > Date.now()) return true;
    nativeFormatAuthBlocked.delete(key);
    return false;
}

function isCookieAuthRequiredResponse(resp) {
    return resp?.status === 'cookie_auth_required' || resp?.error_code === 'cookie_auth_required';
}

function parseVersionTuple(versionText) {
    const match = String(versionText || '').match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
    return match ? [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])] : null;
}

function isVersionAtLeast(versionText, minimum = YTDLP_HIGH_QUALITY_MIN) {
    const current = parseVersionTuple(versionText);
    if (!current) return false;
    for (let i = 0; i < minimum.length; i++) {
        if ((current[i] || 0) > minimum[i]) return true;
        if ((current[i] || 0) < minimum[i]) return false;
    }
    return true;
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

function dedupeQualities(qualities) {
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
        if (shouldReplace) {
            bestByHeight.set(key, quality);
        }
    }

    return Array.from(bestByHeight.values()).sort((a, b) => qualityHeight(b) - qualityHeight(a));
}

function normalizeTaskMap(tasks) {
    return tasks && typeof tasks === 'object' ? tasks : {};
}

function isLiveRecordTask(task) {
    return !!task && (
        task.type === 'live-hls' ||
        task.mode === 'live-record' ||
        task.mode === 'live-native' ||
        task.mode === 'live-ytdlp'
    );
}

function getLiveRecordTaskForVideo(video) {
    if (!video) return null;
    const videoUrl = video.url || '';
    const videoPageUrl = video.tabUrl || video.pageUrl || '';
    const videoPageKey = getYouTubePageKey(videoPageUrl || videoUrl);
    return Object.values(_lastTasks || {}).find(task =>
        isLiveRecordTask(task) &&
        task.tabId === currentTabId &&
        (
            task.sourceUrl === videoUrl ||
            task.url === videoUrl ||
            (!!videoPageUrl && (task.pageUrl === videoPageUrl || task.tabUrl === videoPageUrl)) ||
            (!!videoPageKey && [task.pageUrl, task.tabUrl, task.url, task.sourceUrl].some(url => getYouTubePageKey(url || '') === videoPageKey))
        ) &&
        ['waiting_metadata', 'waiting', 'recording', 'stopping'].includes(task.status)
    ) || null;
}

function getLiveRecordableUrl(video, selectedIndex = 0) {
    return getLiveRecordQuality(video, selectedIndex)?.url || '';
}

function extractYouTubeItagFromUrl(url = '') {
    const match = String(url || '').match(/\/itag\/(\d+)(?:[/?#]|$)/i);
    return match ? match[1] : '';
}

function getLiveRecordQuality(video, selectedIndex = 0) {
    if (!video) return null;
    const qualities = Array.isArray(video.qualities) ? video.qualities : [];
    const selected = qualities[selectedIndex] || null;
    if (selected?.url && !isBestQualityPreset(selected)) return selected;
    if (isBestQualityPreset(selected)) {
        const bestVariant = qualities.find(q => q?.url && !isBestQualityPreset(q));
        if (bestVariant) return bestVariant;
    }
    if (video?.isLive && video?.type === 'hls' && isM3U8LikeUrl(video.url)) {
        return {
            label: selected?.label || 'Live HLS',
            url: video.url,
            bandwidth: 0,
            resolution: selected?.resolution || '',
            source: 'live-master'
        };
    }
    const livePageUrl = video?.isLive
        ? getYouTubePageUrl(video)
        : '';
    if (livePageUrl) {
        return {
            label: selected?.label || 'Best',
            id: isBestQualityPreset(selected) ? '' : (selected?.id || ''),
            url: livePageUrl,
            bandwidth: 0,
            resolution: selected?.resolution || '',
            height: selected?.height || 0,
            source: 'youtube-page-live'
        };
    }
    return null;
}

function isLiveRecordable(video, selectedIndex = 0) {
    if (!video?.isLive) return false;
    const recordUrl = getLiveRecordableUrl(video, selectedIndex);
    if (!recordUrl) return false;
    if (inferDetectedDownloadStrategy(video, recordUrl) === 'browser-hls') return true;
    return isYouTubePageUrl(recordUrl) && _companionStatus?.status === 'ok' && _companionStatus?.ytdlp_installed;
}

function formatBytesShort(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    const kb = value / 1024;
    const mb = kb / 1024;
    const gb = mb / 1024;
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    if (mb >= 1) return `${mb.toFixed(2)} MB`;
    if (kb >= 1) return `${kb.toFixed(1)} KB`;
    return `${Math.round(value)} B`;
}

function mapCompanionFormats(formats) {
    return dedupeQualities((formats || [])
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

function isCompanionLiveFormatResponse(resp) {
    const liveStatus = String(resp?.live_status || '').toLowerCase();
    const title = String(resp?.title || '');
    return !!resp?.is_live ||
        liveStatus === 'is_live' ||
        /^\s*\[LIVE\]/i.test(title);
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

function displayThumbnailUrl(url) {
    return isInvalidThumbnailUrl(url) ? '' : String(url);
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sendDebugLog(level, scope, message, data = {}) {
    try {
        chrome.runtime.sendMessage({
            action: 'debugLog',
            level,
            scope,
            message,
            data,
            tabId: currentTabId,
        }).catch(() => {});
    } catch {}
}

function formatLogTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${ms}`;
}

function formatLogData(data) {
    if (!data || typeof data !== 'object') return '';
    if (!Object.keys(data).length) return '';
    try {
        return JSON.stringify(data, null, 2);
    } catch {
        return String(data);
    }
}

function renderDebugRows(logs, limit = 160) {
    const rows = (logs || []).slice(-limit).reverse();
    if (!rows.length) {
        return `<div class="debug-empty">${escapeHtml(t('noLogs'))}</div>`;
    }
    return rows.map((log) => {
        const level = String(log.level || 'info').toLowerCase();
        const data = formatLogData(log.data);
        return `
            <div class="debug-row debug-${escapeHtml(level)}">
                <div class="debug-meta">
                    <span>${escapeHtml(formatLogTime(log.ts))}</span>
                    <span class="debug-level">${escapeHtml(level.toUpperCase())}</span>
                    <span class="debug-scope">${escapeHtml(log.scope || 'app')}</span>
                    ${log.tabId ? `<span class="debug-tab">tab ${escapeHtml(log.tabId)}</span>` : ''}
                </div>
                <div class="debug-message">${escapeHtml(log.message || '')}</div>
                ${data ? `<pre class="debug-data">${escapeHtml(data)}</pre>` : ''}
            </div>`;
    }).join('');
}

function renderDebugLogs() {
    const count = document.getElementById('debugLogCount');
    const list = document.getElementById('debugLogList');
    const overlayList = document.getElementById('debugLogOverlayList');
    const toggle = document.getElementById('debugToggle');
    const panel = document.getElementById('debugPanel');
    if (count) count.textContent = String(_debugLogs.length);
    if (panel) panel.classList.toggle('expanded', _debugPanelExpanded);
    if (toggle) toggle.textContent = _debugPanelExpanded ? t('btnLogsCollapse') : t('btnLogsExpand');
    if (list) list.innerHTML = _debugPanelExpanded ? renderDebugRows(_debugLogs, 80) : '';
    if (overlayList) overlayList.innerHTML = renderDebugRows(_debugLogs, 600);
}

async function loadDebugLogs() {
    try {
        const resp = await chrome.runtime.sendMessage({ action: 'getDebugLogs' });
        _debugLogs = Array.isArray(resp?.logs) ? resp.logs : [];
    } catch {
        _debugLogs = [];
    }
    renderDebugLogs();
}

async function clearDebugLogs() {
    await chrome.runtime.sendMessage({ action: 'clearDebugLogs' });
    _debugLogs = [];
    renderDebugLogs();
    showToast(t('logsCleared'));
}

async function copyDebugLogs() {
    const lines = (_debugLogs || []).map(log => JSON.stringify(log));
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast(t('logsCopied'));
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Failed to read thumbnail blob'));
        reader.readAsDataURL(blob);
    });
}

async function resolveThumbnailDisplayUrl(url) {
    const key = displayThumbnailUrl(url);
    if (!key) throw new Error('Invalid thumbnail url');
    if (key.startsWith('data:image/') || key.startsWith('blob:')) return key;
    if (thumbnailDisplayUrls.has(key)) return thumbnailDisplayUrls.get(key);
    if (thumbnailInflight.has(key)) return thumbnailInflight.get(key);

    const pending = (async () => {
        const resp = await fetch(key, {
            credentials: 'include',
            cache: 'force-cache',
        });
        if (!resp.ok) throw new Error(`Thumbnail fetch failed: ${resp.status}`);
        const type = resp.headers.get('content-type') || '';
        if (!type.startsWith('image/')) throw new Error(`Unexpected thumbnail type: ${type || 'unknown'}`);
        const blob = await resp.blob();
        const dataUrl = await blobToDataUrl(blob);
        thumbnailDisplayUrls.set(key, dataUrl);
        thumbnailInflight.delete(key);
        return dataUrl;
    })().catch((err) => {
        thumbnailInflight.delete(key);
        throw err;
    });

    thumbnailInflight.set(key, pending);
    return pending;
}

function parseQualityDimensions(quality = {}) {
    const width = Number(quality?.width || 0);
    const height = Number(quality?.height || 0);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return { width, height };
    }
    const raw = `${quality?.resolution || ''} ${quality?.label || ''}`;
    const match = raw.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i);
    if (!match) return null;
    return {
        width: Number(match[1] || 0),
        height: Number(match[2] || 0),
    };
}

function isVerticalVideoItem(video = {}, selectedIndex = 0) {
    if (isYouTubeShortsUrl(getYouTubePageUrl(video) || video.tabUrl || video.url || '')) return true;
    const qualities = Array.isArray(video.qualities) ? video.qualities : [];
    const boundedIndex = qualities.length
        ? Math.min(Math.max(Number(selectedIndex || 0), 0), qualities.length - 1)
        : 0;
    const dims = parseQualityDimensions(qualities[boundedIndex] || {}) || parseQualityDimensions(video);
    return !!(dims?.width > 0 && dims?.height > dims.width * 1.1);
}

function isLandscapeVideoItem(video = {}, selectedIndex = 0) {
    const qualities = Array.isArray(video.qualities) ? video.qualities : [];
    const boundedIndex = qualities.length
        ? Math.min(Math.max(Number(selectedIndex || 0), 0), qualities.length - 1)
        : 0;
    const dims = parseQualityDimensions(qualities[boundedIndex] || {}) || parseQualityDimensions(video);
    return !!(dims?.width > 0 && dims.width > dims.height * 1.1);
}

function updateThumbnailFit(wrap, image) {
    if (!wrap || !image || !image.naturalWidth || !image.naturalHeight) return;
    if (wrap.dataset.verticalVideo === '1' || wrap.classList.contains('is-shorts')) {
        wrap.classList.remove('fit-top-cover');
        wrap.classList.remove('fit-contain');
        return;
    }
    const imageRatio = image.naturalWidth / image.naturalHeight;
    if (imageRatio > 0 && imageRatio < 1.05) {
        if (wrap.dataset.landscapeVideo === '1') {
            wrap.classList.add('fit-top-cover');
            wrap.classList.remove('fit-contain');
        } else {
            wrap.classList.add('fit-contain');
            wrap.classList.remove('fit-top-cover');
        }
    } else {
        wrap.classList.remove('fit-top-cover');
        wrap.classList.remove('fit-contain');
    }
}

function hydrateRenderedThumbnails() {
    const wraps = document.querySelectorAll('.thumb-wrap');
    wraps.forEach((wrap) => {
        const url = displayThumbnailUrl(wrap.dataset.thumbUrl || '');
        const previewSrc = wrap.dataset.previewSrc || '';
        const image = wrap.querySelector('img.thumb-image');
        const media = wrap.querySelector('video.thumb-media');
        const placeholder = wrap.querySelector('.thumb-placeholder');
        const applyVideoOrientation = () => {
            if (!media?.videoWidth || !media?.videoHeight) return;
            if (media.videoHeight > media.videoWidth * 1.1) {
                wrap.dataset.verticalVideo = '1';
                wrap.dataset.landscapeVideo = '0';
                wrap.classList.remove('fit-top-cover');
                wrap.classList.add('fit-contain');
            } else if (media.videoWidth > media.videoHeight * 1.1) {
                wrap.dataset.landscapeVideo = '1';
                if (wrap.dataset.verticalVideo !== '1' && image) updateThumbnailFit(wrap, image);
            }
        };
        if (media) {
            if (media.readyState >= 1) applyVideoOrientation();
            else media.addEventListener('loadedmetadata', applyVideoOrientation, { once: true });
        }
        if (image) {
            if (image.complete && image.naturalWidth) updateThumbnailFit(wrap, image);
            if (url && image.dataset.loaded !== '1') {
                const showImage = (src) => {
                    if (!wrap.isConnected || !image.isConnected) return;
                    image.src = src;
                    image.style.display = 'block';
                    image.dataset.loaded = '1';
                    if (image.complete && image.naturalWidth) {
                        updateThumbnailFit(wrap, image);
                    } else {
                        image.addEventListener('load', () => updateThumbnailFit(wrap, image), { once: true });
                    }
                    if (placeholder) placeholder.style.display = 'none';
                };

                image.addEventListener('load', () => {
                    if (!wrap.isConnected || !image.isConnected) return;
                    image.style.display = 'block';
                    image.dataset.loaded = '1';
                    updateThumbnailFit(wrap, image);
                    if (placeholder) placeholder.style.display = 'none';
                }, { once: true });

                image.addEventListener('error', () => {
                    const fallbackUrl = displayThumbnailUrl(image.dataset.fallbackThumbUrl || '');
                    if (fallbackUrl && fallbackUrl !== url && image.dataset.usedFallback !== '1') {
                        image.dataset.usedFallback = '1';
                        image.src = fallbackUrl;
                        return;
                    }
                    image.style.display = 'none';
                    image.removeAttribute('src');
                    if (placeholder) placeholder.style.display = 'flex';
                    const itemUrl = wrap.dataset.url || '';
                    if (itemUrl && url) {
                        chrome.runtime.sendMessage({
                            action: 'thumbnailLoadFailed',
                            tabId: currentTabId,
                            url: itemUrl,
                            thumbnail: url,
                        }).catch(() => {});
                    }
                    resolveThumbnailDisplayUrl(url).then((displayUrl) => {
                        showImage(displayUrl);
                    }).catch(() => {
                        if (!previewSrc && placeholder) placeholder.style.display = 'flex';
                    });
                }, { once: true });

                image.referrerPolicy = 'no-referrer';
                image.src = url;
            }
            if (media && previewSrc) {
                primePreviewThumbnail(wrap);
            }
            return;
        }

        if (!media) return;

        if (!url) {
            primePreviewThumbnail(wrap);
            return;
        }

        if (media.dataset.loaded === '1') return;

        resolveThumbnailDisplayUrl(url).then((displayUrl) => {
            if (!wrap.isConnected || !media.isConnected) return;
            media.poster = displayUrl;
            media.style.display = 'block';
            media.dataset.loaded = '1';
            if (placeholder) placeholder.style.display = 'none';
        }).catch(() => {
            if (wrap.isConnected && media.isConnected && url) {
                media.poster = url;
                media.style.display = 'block';
                media.dataset.loaded = '1';
                if (placeholder) placeholder.style.display = 'none';
                return;
            }
            primePreviewThumbnail(wrap);
        });
    });
}

function isPreviewableDirectVideo(url) {
    const value = String(url || '');
    return value.startsWith('data:video/') || /\.(mp4|webm|m4v|mkv)(\?|#|$)/i.test(value);
}

function isM3U8LikeUrl(url) {
    const value = String(url || '');
    return /\.m3u8(\?|#|$)/i.test(value) ||
        /\/api\/manifest\/hls_/i.test(value) ||
        /\/(playlist|master|index)\.m3u8/i.test(value);
}

function isM3U8Url(url) {
    return isM3U8LikeUrl(url);
}

function isYouTubePageDirectQuality(quality) {
    const source = String(quality?.source || '');
    return source === 'youtube-page-direct' || source === 'youtube-page-merged';
}

function isBestQualityPreset(quality) {
    return String(quality?.preset || '') === 'best';
}

function shouldOfferBestQualityPreset(video) {
    return isYouTubeVideoItem(video);
}

function addBestQualityPreset(video, qualities = []) {
    const list = (qualities || []).filter(q => !isBestQualityPreset(q));
    if (!shouldOfferBestQualityPreset(video)) return list;
    return [
        {
            label: t('qualityBest'),
            preset: 'best',
            source: 'preset-best',
        },
        ...list,
    ];
}

function normalizePreviewAsset(video) {
    const asset = video?.previewAsset;
    if (asset?.kind && asset?.url) return asset;

    const youtubePageUrl = getYouTubePageUrl(video);
    const isYouTubeItem = !!youtubePageUrl || video?.type === 'youtube';
    const previewCandidateUrl = isPreviewableDirectVideo(video?.previewCandidateUrl || video?.previewUrl || '')
        ? String(video.previewCandidateUrl || video.previewUrl)
        : '';

    if (video?.type === 'hls') {
        if (previewCandidateUrl) {
            return { kind: 'video', url: previewCandidateUrl };
        }
        if (video?.thumbnailKind === 'frame' && video?.thumbnail) {
            return { kind: 'frame', url: video.thumbnail };
        }
        const imageUrl = displayThumbnailUrl(video?.thumbnail || '');
        if (imageUrl) {
            return { kind: 'image', url: imageUrl };
        }
        return null;
    }

    if (previewCandidateUrl) {
        return { kind: 'video', url: previewCandidateUrl };
    }
    if (!isYouTubeItem && isPreviewableDirectVideo(video?.url)) {
        return { kind: 'video', url: video.url };
    }
    if (video?.thumbnailKind === 'frame' && video?.thumbnail) {
        return { kind: 'frame', url: video.thumbnail };
    }
    const imageUrl = displayThumbnailUrl(video?.thumbnail || '') || (isYouTubeItem ? buildYouTubeThumbnailUrl(youtubePageUrl || video?.url || video?.tabUrl) : '');
    if (imageUrl) {
        return { kind: 'image', url: imageUrl };
    }
    return null;
}

function inferDetectedDownloadStrategy(video, downloadUrl) {
    if (video?.downloadStrategy) return video.downloadStrategy;
    const isYouTubeItem = !!getYouTubePageUrl(video) || isYouTubePageUrl(downloadUrl || '');
    if (video?.type === 'hls' || isM3U8Url(downloadUrl || video?.url)) return 'browser-hls';
    if (isYouTubeItem && _companionStatus?.deno_installed) return 'native-ytdlp';
    if (isYouTubeItem && Array.isArray(video?.qualities) && video.qualities.some(isYouTubePageDirectQuality)) {
        return 'direct-video';
    }
    if (isYouTubeItem) return 'native-ytdlp';
    if (isPreviewableDirectVideo(downloadUrl || video?.url)) return 'direct-video';
    return 'browser-hls';
}

function getRepresentativePreviewTime(media) {
    const duration = Number(media?.duration || 0);
    if (!Number.isFinite(duration) || duration <= 0) return 0.75;
    if (duration <= 1.5) return Math.max(0.15, Math.min(duration - 0.05, duration * 0.7));
    if (duration <= 6) return Math.max(0.45, Math.min(duration - 0.08, duration * 0.45));
    return Math.max(0.8, Math.min(duration - 0.2, Math.min(2.5, duration * 0.12)));
}

function revealPreviewStillFrame(wrap, media, placeholder, reveal = true) {
    if (!wrap?.isConnected || !media?.isConnected) return;
    try {
        media.pause();
    } catch {}
    media.dataset.loaded = '1';
    media.style.display = reveal ? 'block' : 'none';
    if (placeholder) placeholder.style.display = 'none';
}

function seekPreviewToRepresentativeFrame(wrap, media, placeholder, reveal = true) {
    const targetTime = getRepresentativePreviewTime(media);
    if (!(targetTime > 0.05)) {
        revealPreviewStillFrame(wrap, media, placeholder, reveal);
        return;
    }

    let settled = false;
    let settleTimer = null;
    const finish = () => {
        if (settled) return;
        settled = true;
        if (settleTimer) clearTimeout(settleTimer);
        media.onseeked = null;
        revealPreviewStillFrame(wrap, media, placeholder, reveal);
    };

    media.onseeked = finish;
    settleTimer = setTimeout(finish, 500);

    try {
        if (Math.abs((media.currentTime || 0) - targetTime) < 0.05) {
            finish();
            return;
        }
        media.currentTime = targetTime;
    } catch {
        finish();
    }
}

function primePreviewThumbnail(wrap) {
    const media = wrap?.querySelector('video.thumb-media[data-preview-src]');
    const image = wrap?.querySelector('img.thumb-image');
    const placeholder = wrap?.querySelector('.thumb-placeholder');
    if (!media || media.dataset.loaded === '1' || media.dataset.previewFailed === '1') return;

    const src = media.dataset.previewSrc || '';
    if (!src) return;

    const cleanup = () => {
        media.onloadeddata = null;
        media.onerror = null;
    };

    media.onloadeddata = () => {
        cleanup();
        if (!wrap.isConnected || !media.isConnected) return;
        seekPreviewToRepresentativeFrame(wrap, media, placeholder, !image);
    };

    media.onerror = () => {
        cleanup();
        media.dataset.previewFailed = '1';
        if (placeholder) placeholder.style.display = 'flex';
    };

    try {
        if (media.getAttribute('src') !== src) {
            media.src = src;
        }
        media.preload = 'auto';
        media.load();
    } catch {
        cleanup();
        media.dataset.previewFailed = '1';
    }
}

function bindThumbPreviewLoop(media) {
    if (!(media instanceof HTMLVideoElement) || media.dataset.previewLoopBound === '1') return;
    media.dataset.previewLoopBound = '1';
    media.addEventListener('ended', () => {
        if (media.dataset.previewing !== '1') return;
        try { media.currentTime = 0; } catch {}
        media.play().catch(() => {});
    });
}

function activateThumbPreview(wrap) {
    const media = wrap?.querySelector('video[data-preview-src]');
    const image = wrap?.querySelector('img.thumb-image');
    if (!media || media.dataset.previewing === '1') return;
    const src = media.dataset.previewSrc || '';
    const thumbUrl = wrap?.dataset?.thumbUrl || '';
    if (!src) return;
    bindThumbPreviewLoop(media);
    media.dataset.previewing = '1';
    if (media.getAttribute('src') !== src) {
        media.src = src;
    }
    media.defaultMuted = true;
    media.muted = true;
    media.playsInline = true;
    media.loop = true;
    media.style.display = 'block';
    if (image) image.style.display = 'none';
    try { media.currentTime = 0; } catch {}
    media.play().catch(() => {
        media.dataset.previewing = '0';
        if (image) image.style.display = 'block';
        media.style.display = image ? 'none' : 'block';
        if (!thumbUrl) {
            try { media.pause(); } catch {}
            return;
        }
    });
}

function deactivateThumbPreview(wrap) {
    const media = wrap?.querySelector('video[data-preview-src]');
    const image = wrap?.querySelector('img.thumb-image');
    const thumbUrl = wrap?.dataset?.thumbUrl || '';
    if (!media || media.dataset.previewing !== '1') return;
    media.dataset.previewing = '0';
    media.loop = false;
    try { media.pause(); } catch {}
    if (image && thumbUrl) {
        media.style.display = 'none';
        image.style.display = 'block';
        return;
    }
    if (!thumbUrl) {
        try {
            media.currentTime = getRepresentativePreviewTime(media);
        } catch {}
        return;
    }
}

function i18nPage() {
    document.getElementById('langToggle').textContent = lang.toUpperCase();
    const lbl = document.getElementById('lblDetected');
    if (lbl) lbl.textContent = t('lblDetected');
    const lblQ = document.getElementById('lblQueue');
    if (lblQ) lblQ.textContent = t('lblQueue');
    const refresh = document.getElementById('refreshDetected');
    if (refresh) refresh.textContent = t('refreshList');
    const clr = document.getElementById('clearDetected');
    if (clr) clr.textContent = t('clearList');
    const em = document.getElementById('emptyMsg');
    if (em) em.textContent = t('noVids');
    const clrDone = document.getElementById('clearDoneBtn');
    if (clrDone) clrDone.textContent = t('clearDone');
    const tbDet = document.getElementById('tabDetected');
    if (tbDet) tbDet.textContent = t('tabDetected');
    const tbQ = document.getElementById('tabQueue');
    if (tbQ) tbQ.textContent = t('tabQueue');
    const debugTitle = document.getElementById('debugTitle');
    if (debugTitle) debugTitle.textContent = t('lblLogs');
    const debugToggle = document.getElementById('debugToggle');
    if (debugToggle) debugToggle.textContent = _debugPanelExpanded ? t('btnLogsCollapse') : t('btnLogsExpand');
    const debugFullscreen = document.getElementById('debugFullscreen');
    if (debugFullscreen) debugFullscreen.textContent = t('btnLogsFull');
    const debugClear = document.getElementById('debugClear');
    if (debugClear) debugClear.textContent = t('btnClearLogs');
    const debugCopy = document.getElementById('debugCopy');
    if (debugCopy) debugCopy.textContent = t('btnCopyLogs');
    const overlayTitle = document.getElementById('debugOverlayTitle');
    if (overlayTitle) overlayTitle.textContent = t('lblLogs');
    const overlayClear = document.getElementById('debugOverlayClear');
    if (overlayClear) overlayClear.textContent = t('btnClearLogs');
    const overlayCopy = document.getElementById('debugOverlayCopy');
    if (overlayCopy) overlayCopy.textContent = t('btnCopyLogs');
    const authLabel = document.getElementById('cookieAuthLabel');
    if (authLabel) authLabel.textContent = t('cookieAuth');
    const authSelect = document.getElementById('cookieAuthSelect');
    if (authSelect) {
        const labels = {
            off: t('cookieAuthOff'),
            chrome: t('cookieAuthChrome'),
            edge: t('cookieAuthEdge'),
            file: t('cookieAuthCookies'),
        };
        Array.from(authSelect.options).forEach(option => {
            option.textContent = labels[option.value] || option.textContent;
        });
    }
    const authPick = document.getElementById('cookieAuthPickFile');
    if (authPick) authPick.textContent = t('cookieAuthPick');
    const pathChange = document.getElementById('companionChangePath');
    if (pathChange) pathChange.title = t('pathChangeFolder');
    const pathOpen = document.getElementById('companionOpenPath');
    if (pathOpen) pathOpen.title = t('pathOpenFolder');
    const companionSetup = document.getElementById('companionSetup');
    if (companionSetup) {
        companionSetup.title = t('setupGuide');
        companionSetup.setAttribute('aria-label', t('setupGuide'));
    }
    updateCompanionDetailsVisibility();
    updateCompanionBar();
    renderDebugLogs();
}

// ── 탭 전환 ──
document.getElementById('tabDetected').addEventListener('click', () => switchTab('detected'));
document.getElementById('tabQueue').addEventListener('click', () => switchTab('queue'));

function switchTab(tab) {
    document.getElementById('tabDetected').classList.toggle('active', tab === 'detected');
    document.getElementById('tabQueue').classList.toggle('active', tab === 'queue');
    document.getElementById('contentDetected').style.display = tab === 'detected' ? '' : 'none';
    document.getElementById('contentQueue').style.display = tab === 'queue' ? '' : 'none';
    if (tab === 'queue') renderQueue();
}

// ── 언어 ──
document.getElementById('langToggle').addEventListener('click', () => {
    lang = lang === 'en' ? 'ko' : 'en';
    localStorage.setItem('mn_lang', lang);
    i18nPage();
    if (window._lastVideos) renderVideos(window._lastVideos);
    renderQueue();
});

document.getElementById('debugToggle')?.addEventListener('click', () => {
    _debugPanelExpanded = !_debugPanelExpanded;
    localStorage.setItem('mn_debug_logs_expanded', _debugPanelExpanded ? '1' : '0');
    renderDebugLogs();
});

document.getElementById('debugFullscreen')?.addEventListener('click', () => {
    document.getElementById('debugLogOverlay')?.classList.add('show');
    renderDebugLogs();
});

document.getElementById('debugCloseOverlay')?.addEventListener('click', () => {
    document.getElementById('debugLogOverlay')?.classList.remove('show');
});

document.getElementById('debugClear')?.addEventListener('click', () => {
    clearDebugLogs().catch(() => {});
});

document.getElementById('debugOverlayClear')?.addEventListener('click', () => {
    clearDebugLogs().catch(() => {});
});

document.getElementById('debugCopy')?.addEventListener('click', () => {
    copyDebugLogs().catch(() => {});
});

document.getElementById('debugOverlayCopy')?.addEventListener('click', () => {
    copyDebugLogs().catch(() => {});
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        document.getElementById('debugLogOverlay')?.classList.remove('show');
    }
});

// ── 정렬 (감지) ──
document.querySelectorAll('[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
        sortKey = btn.dataset.sort;
        document.querySelectorAll('[data-sort]').forEach(b => b.classList.toggle('active', b === btn));
        if (window._lastVideos) renderVideos(window._lastVideos);
    });
});
// ── 정렬 (큐) ──
document.querySelectorAll('[data-sort-q]').forEach(btn => {
    btn.addEventListener('click', () => {
        sortKeyQ = btn.dataset.sortQ;
        document.querySelectorAll('[data-sort-q]').forEach(b => b.classList.toggle('active', b === btn));
        renderQueue();
    });
});

// ── 목록 초기화 ──
document.getElementById('clearDetected').addEventListener('click', async () => {
    if (!currentTabId) return;
    sendDebugLog('info', 'popup.list', 'Detected list cleared', { tabId: currentTabId });
    const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
    delete detectedVideos[currentTabId];
    await chrome.storage.local.set({ detectedVideos });
    chrome.action.setBadgeText({ text: '', tabId: currentTabId });
    renderVideos([]);
});
document.getElementById('refreshDetected').addEventListener('click', async () => {
    if (!currentTabId) return;
    sendDebugLog('info', 'popup.list', 'Detected list refresh requested', { tabId: currentTabId });
    const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
    delete detectedVideos[currentTabId];
    await chrome.storage.local.set({ detectedVideos });
    chrome.action.setBadgeText({ text: '', tabId: currentTabId });
    renderVideos([]);
    chrome.tabs.reload(currentTabId);
});
document.getElementById('clearDoneBtn').addEventListener('click', async () => {
    const { tasks = {} } = await chrome.storage.local.get('tasks');
    const keep = {};
    for (const [id, tk] of Object.entries(tasks)) {
        if (['downloading', 'waiting', 'waiting_metadata', 'recording', 'stopping'].includes(tk.status)) keep[id] = tk;
    }
    await chrome.storage.local.set({ tasks: keep });
    renderQueue();
});

// ── 이벤트 위임: 영상 목록 ──
document.getElementById('videoList').addEventListener('click', e => {
    const card = e.target.closest('.video-card');
    if (!card) return;
    const idx = parseInt(card.dataset.idx);

    if (e.target.closest('.btn-dl')) { startDownload(idx); return; }
    if (e.target.closest('.btn-live-start')) { startLiveRecord(idx); return; }
    if (e.target.closest('.btn-live-stop')) { stopLiveRecord(idx); return; }
    if (e.target.closest('.btn-rm')) { removeVideo(idx); return; }
    if (e.target.closest('.thumb-wrap')) { previewVideo(idx); return; }
});

document.getElementById('videoList').addEventListener('mouseover', e => {
    const wrap = e.target.closest('.thumb-wrap[data-preview-src]');
    if (!wrap) return;
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    activateThumbPreview(wrap);
});

document.getElementById('videoList').addEventListener('mouseout', e => {
    const wrap = e.target.closest('.thumb-wrap[data-preview-src]');
    if (!wrap) return;
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    deactivateThumbPreview(wrap);
});

// 화질 선택 변경 시 qualityState 업데이트 (재렌더링대원도 선택 유지)
document.getElementById('videoList').addEventListener('change', e => {
    const sel = e.target.closest('select.quality-select');
    if (sel) {
        const idx = parseInt(sel.dataset.idx);
        const v = _sortedVideos[idx];
        if (v) qualityState.set(v.url, parseInt(sel.value));
        return;
    }
    const modeSel = e.target.closest('select.live-mode-select');
    if (!modeSel) return;
    const idx = parseInt(modeSel.dataset.idx);
    const v = _sortedVideos[idx];
    if (v) liveModeState.set(v.url, modeSel.value === 'window' ? 'window' : 'now');
});

// ── 이벤트 위임: 큐 ──
document.getElementById('queueList').addEventListener('click', e => {
    const item = e.target.closest('.queue-item');
    if (!item) return;
    const taskId = item.dataset.taskId;
    if (e.target.closest('.btn-cancel')) { cancelDl(taskId); return; }
    if (e.target.closest('.btn-stop-record')) { stopRecording(taskId); return; }
    if (e.target.closest('.btn-rm')) { removeDl(taskId); return; }
    if (e.target.closest('.btn-open-folder')) {
        chrome.storage.local.get('tasks').then(({tasks}) => {
            const tk = tasks[taskId];
            if (tk && tk.filePath) {
                const sep = tk.filePath.includes('\\') ? '\\' : '/';
                const folder = tk.filePath.substring(0, tk.filePath.lastIndexOf(sep));
                chrome.runtime.sendMessage({ action: 'companionOpenFolder', path: folder });
            } else {
                chrome.runtime.sendMessage({ action: 'companionOpenFolder' });
            }
        });
        return;
    }
    if (e.target.closest('.btn-play')) {
        chrome.storage.local.get('tasks').then(({tasks}) => {
            if (tasks[taskId]?.filePath) {
                chrome.runtime.sendMessage({ action: 'nativePlay', filepath: tasks[taskId].filePath });
            }
        });
        return;
    }
});

// ── 재생시간 포맷 ──
function fmtDur(sec) {
    if (!sec || !isFinite(sec) || sec <= 0) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
}

// 마지막 렌더링 해시 (변경 없으면 DOM 재구성 생략 → 드롭다운 열린 상태 유지)
let _lastRenderedHash = '';

// ── 영상 목록 렌더링 ──
function renderVideos(videos) {
    window._lastVideos = videos;
    const list = document.getElementById('videoList');
    const visibleVideos = filterVisibleDetectedVideos(videos || []);
    if (!visibleVideos.length) {
        _lastRenderedHash = '';
        list.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><div>${t('noVids')}</div></div>`;
        return;
    }

    // 변경 감지: URL·제목·썸네일·화질수·재생시간이 같으면 DOM 재구성 생략
    const companionRenderState = [
        _companionStatus?.status || '',
        _companionStatus?.download_path || '',
        _companionStatus?.ytdlp_installed ? 'ytdlp' : '',
        _companionStatus?.deno_installed ? 'deno' : '',
    ].join('|');
    const newHash = JSON.stringify({
        companion: companionRenderState,
        videos: visibleVideos.map(v =>
            `${v.type||''}|${v.isLive ? 'live' : ''}|${v.url}|${v.mediaKey||''}|${v.mediaIndex??''}|${(v.sourceUrls||[]).join(',')}|${(v.aliasUrls||[]).join(',')}|${v.detectedOrigin||''}|${v.tabUrl||''}|${v.pageTitle||''}|${v.tabTitle||''}|${v.thumbnail||''}|${v.thumbnailSource||''}|${v.metadataHydrating ? 'hydrating' : ''}|${JSON.stringify(v.previewAsset||{})}|${v.previewCandidateUrl||v.previewUrl||''}|${(v.qualities||[]).map(q => `${q.id||q.url||''}:${q.label||''}`).join(',')}|${Math.floor(v.duration||0)}|${getLiveRecordTaskForVideo(v)?.status || ''}`
        )
    });
    if (newHash === _lastRenderedHash) {
        hydrateRenderedThumbnails();
        return; // 변경 없음 → skip
    }
    _lastRenderedHash = newHash;

    const sorted = [...visibleVideos].map(v => ({
        ...v,
        qualities: addBestQualityPreset(v, dedupeQualities(v.qualities || [])),
        previewAsset: normalizePreviewAsset(v),
    })).sort((a, b) =>
        sortKey === 'type' ? (a.type||'').localeCompare(b.type||'') : (b.addedAt||0) - (a.addedAt||0)
    );
    _sortedVideos = sorted;

    list.innerHTML = sorted.map((v, i) => {
        // 타입별 배지: LIVE(빨강) / HLS(파랑) / MP4(초록)
        const isLive = v.isLive || false;
        const youtubePageUrl = getYouTubePageUrl(v);
        const isYouTubeItem = !!youtubePageUrl || v.type === 'youtube';
        let typeClass = '';
        let typeLabel = '';
        if (isLive) {
            typeClass = 'live';
            typeLabel = 'LIVE';
        } else if (isYouTubeItem || v.type === 'youtube') {
            typeClass = '';
            typeLabel = 'YT';
        } else if (v.type === 'hls') {
            typeClass = '';
            typeLabel = 'HLS';
        } else {
            typeClass = 'mp4';
            typeLabel = (v.type || 'VIDEO').toUpperCase();
        }

        const dur = fmtDur(v.duration);
        const shortUrl = v.url.length > 46 ? v.url.substring(0, 46) + '…' : v.url;
        const displayTitle = getVisibleVideoTitle(v, sorted, shortUrl);
        const cardTooltip = v.pageTitle || v.tabUrl || v.url;
        const isShortsItem = isYouTubeShortsUrl(youtubePageUrl || v.url || v.tabUrl);
        const rawSavedQi = qualityState.get(v.url) || 0;
        const savedQi = Array.isArray(v.qualities) && v.qualities.length
            ? Math.min(rawSavedQi, v.qualities.length - 1)
            : 0;
        const isVerticalVideo = isVerticalVideoItem(v, savedQi);
        const isLandscapeVideo = isLandscapeVideoItem(v, savedQi);

        const previewAsset = v.previewAsset || null;
        const previewSrc = (previewAsset?.kind === 'video' && !isYouTubeItem && isPreviewableDirectVideo(previewAsset.url))
            ? previewAsset.url
            : '';
        const isDirectVideoItem = !isYouTubeItem && inferDetectedDownloadStrategy(v, v.url || previewSrc) === 'direct-video';
        const isGeneratedHlsThumbnail = v.type === 'hls' && /^(offscreen-preview|native-preview|hidden-video-preview|visible-video-preview|video-frame)$/i.test(String(v.thumbnailSource || ''));
        const thumbnailKind = String(v.thumbnailKind || '');
        const isImageThumbnailKind = /^(image|image-url|page-image|meta-image|og-image|twitter-image|poster-image|player-image)$/i.test(thumbnailKind);
        const staticThumbUrl = (() => {
            let rawThumb = displayThumbnailUrl(v.thumbnail || '');
            const youtubeThumbUrl = isYouTubeItem ? buildYouTubeThumbnailUrl(youtubePageUrl || v.url || v.tabUrl) : '';
            if (isYouTubeItem && rawThumb && isStaleYouTubeThumbnail(v, rawThumb)) {
                rawThumb = '';
            }
            if (isShortsItem && youtubeThumbUrl) {
                return youtubeThumbUrl;
            }
            if (isDirectVideoItem && previewSrc) {
                return '';
            }
            if (isGeneratedHlsThumbnail) {
                return '';
            }
            if (v.type === 'hls' && (thumbnailKind === 'frame' || thumbnailKind === 'capture')) {
                return '';
            }
            if (rawThumb && (isImageThumbnailKind || thumbnailKind === 'frame' || thumbnailKind === 'capture' || !previewSrc)) {
                return rawThumb;
            }
            if (previewAsset?.kind === 'image' || (previewAsset?.kind === 'frame' && v.type !== 'hls')) {
                return displayThumbnailUrl(previewAsset.url);
            }
            if (isLive && youtubeThumbUrl) {
                return youtubeThumbUrl;
            }
            return '';
        })();
        const thumbHtml = (() => {
            const fallbackThumbUrl = '';
            const fallbackAttr = fallbackThumbUrl && fallbackThumbUrl !== staticThumbUrl
                ? ` data-fallback-thumb-url="${fallbackThumbUrl}"`
                : '';
            const imageHtml = staticThumbUrl ? `<img class="thumb-image" src="${staticThumbUrl}" alt=""${fallbackAttr}>` : '';
            const mediaHtml = previewSrc
                ? `<video class="thumb-media" data-preview-src="${previewSrc}" muted playsinline preload="none" style="display:none"></video>`
                : '';
            if (imageHtml || mediaHtml) {
                return `${imageHtml}${mediaHtml}${!imageHtml && !mediaHtml ? '<div class="thumb-placeholder">🎬</div>' : '<div class="thumb-placeholder" style="display:none">🎬</div>'}`;
            }
            return `<div class="thumb-placeholder">🎬</div>`;
        })();
        const thumbClasses = [
            'thumb-wrap',
            isYouTubeItem ? 'is-youtube' : '',
            (isShortsItem || isVerticalVideo) ? 'is-shorts' : '',
            staticThumbUrl ? 'has-thumb' : '',
            previewSrc ? 'has-preview' : '',
        ].filter(Boolean).join(' ');

        // 저장된 선택 인덱스 복원 (재렌더링 후에도 유지)
        const savedLiveMode = liveModeState.get(v.url) || 'now';
        let qualityHtml = '';
        const hasSelectableQualities = Array.isArray(v.qualities) && v.qualities.length > 0;
        const hasBestQualityPreset = hasSelectableQualities && v.qualities.some(isBestQualityPreset);
        const hasHlsQualityUrls = v.type === 'hls' && hasSelectableQualities && v.qualities.some(q => !!q.url);
        const canUseNativeQualitySelect = hasSelectableQualities && (hasBestQualityPreset || hasHlsQualityUrls || !isYouTubeItem || v.qualities.some(q => !!q.id || isYouTubePageDirectQuality(q)));
        if (canUseNativeQualitySelect) {
            const opts = v.qualities.map((q, qi) =>
                `<option value="${qi}"${qi === savedQi ? ' selected' : ''}>${q.label}${q.resolution && q.resolution !== q.label ? ' · '+q.resolution : ''}</option>`
            ).join('');
            qualityHtml = `<div class="quality-row">
                <span class="quality-label">${t('quality')}:</span>
                <select class="quality-select" data-idx="${i}">${opts}</select>
            </div>`;
        } else if ((isYouTubeItem || isLive) && _companionStatus?.status === 'ok') {
            qualityHtml = `<div class="quality-row">
                <span class="quality-label">${t('quality')}:</span>
                <span style="font-size:12px;color:var(--text-muted);">${t('qualityLoading')}</span>
            </div>`;
        }
        const liveTask = isLive ? getLiveRecordTaskForVideo(v) : null;
        const canRecordLive = isLiveRecordable(v, savedQi);
        let liveModeHtml = '';
        if (isLive) {
            liveModeHtml = `<div class="quality-row">
                <span class="quality-label">${t('liveMode')}:</span>
                <select class="live-mode-select" data-idx="${i}"${liveTask ? ' disabled' : ''}>
                    <option value="now"${savedLiveMode === 'now' ? ' selected' : ''}>${t('liveModeNow')}</option>
                    <option value="window"${savedLiveMode === 'window' ? ' selected' : ''}>${t('liveModeWindow')}</option>
                </select>
            </div>`;
        }
        const dlBtnHtml = (() => {
            if (!isLive) return `<button class="btn btn-dl">${t('btnDl')}</button>`;
            if (liveTask) {
                const disabled = liveTask.status === 'stopping' ? ' disabled' : '';
                const label = liveTask.status === 'stopping' ? t('stStopping') : t('btnRecStop');
                return `<button class="btn btn-live-stop"${disabled}>${label}</button>`;
            }
            if (canRecordLive) {
                return `<button class="btn btn-live-start">${t('btnRecStart')}</button>`;
            }
            const title = _companionStatus?.status === 'ok'
                ? t('liveRecordHlsOnly')
                : t('liveRecordRequiresCompanion');
            return `<button class="btn btn-live-start btn-live-unavailable" disabled title="${escapeHtml(title)}">${t('btnRecStart')}</button>`;
        })();

        return `<div class="video-card" data-idx="${i}">
            <div class="card-top">
                <div class="${thumbClasses}" data-type="${v.type || ''}" data-vertical-video="${isVerticalVideo ? '1' : '0'}" data-landscape-video="${isLandscapeVideo ? '1' : '0'}" data-url="${escapeHtml(v.url || '')}"${staticThumbUrl ? ` data-thumb-url="${escapeHtml(staticThumbUrl)}"` : ''}${previewSrc ? ` data-preview-src="${escapeHtml(previewSrc)}"` : ''}>
                    ${thumbHtml}
                    ${dur ? `<span class="duration-badge">${dur}</span>` : ''}
                </div>
                <div class="card-info">
                    <div class="card-url" title="${escapeHtml(cardTooltip)}">${escapeHtml(displayTitle)}</div>
                    <span class="type-badge ${typeClass}">${typeLabel}</span>
                    ${qualityHtml}
                    ${liveModeHtml}
                </div>
            </div>
            <div class="card-actions">
                ${dlBtnHtml}
                <button class="btn btn-rm">${t('btnRemove')}</button>
            </div>
        </div>`;
    }).join('');

    hydrateRenderedThumbnails();
    hydrateYouTubeFormats(sorted).catch(() => {});
}


function previewVideo(idx) {
    const v = _sortedVideos[idx];
    if (v) chrome.tabs.create({ url: v.url, active: false });
}

function buildQueuedMetadata(video, baseName, downloadUrl, strategy) {
    return {
        initialBaseName: baseName || '',
        pageTitle: video?.pageTitle || video?.title || '',
        titleSource: video?.titleSource || video?.pageTitleSource || '',
        tabTitle: video?.tabTitle || '',
        tabUrl: video?.tabUrl || currentTabUrl || '',
        pageUrl: video?.tabUrl || currentTabUrl || '',
        itemUrl: video?.url || '',
        downloadUrl: downloadUrl || video?.url || '',
        mediaKey: video?.mediaKey || '',
        mediaIndex: video?.mediaIndex,
        type: video?.type || '',
        strategy: strategy || inferDetectedDownloadStrategy(video, downloadUrl || video?.url || ''),
    };
}

async function queueDownloadRequest(payload) {
    const response = await chrome.runtime.sendMessage({
        action: 'queueDownloadRequest',
        tabId: currentTabId,
        displayName: t('stMetadata'),
        ...payload,
    });
    if (response?.status === VARIANT_CONFIG.policy.blockedStatus) {
        showToast(response?.message || getBlockedByChannelPolicyMessage(), 'warning');
        return response;
    }
    if (response?.status === 'error' || response?.ok === false) {
        showToast(response?.message || response?.error || t('stErr'), 'warning');
        return response;
    }
    showToast(t('queuedAfterMetadata'));
    switchTab('queue');
    return response;
}

async function removeDetectedVideoEntry(target, reason = '') {
    if (!target || !currentTabId) return 0;
    const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
    if (!detectedVideos[currentTabId]) return 0;

    const before = detectedVideos[currentTabId].length;
    detectedVideos[currentTabId] = detectedVideos[currentTabId].filter(v => {
        if (target.mediaKey || v.mediaKey) return v.mediaKey !== target.mediaKey;
        if ((v.addedAt || 0) && (target.addedAt || 0)) {
            return !((v.url || '') === (target.url || '') && (v.addedAt || 0) === (target.addedAt || 0));
        }
        return v.url !== target.url;
    });
    const count = detectedVideos[currentTabId].length;
    if (count === before) return count;

    await chrome.storage.local.set({ detectedVideos });
    chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId: currentTabId });
    sendDebugLog('info', 'popup.list', 'Detected item removed', {
        reason,
        removed: before - count,
        remaining: count,
        url: target.url || '',
        tabUrl: target.tabUrl || currentTabUrl || '',
    });
    renderVideos(detectedVideos[currentTabId]);
    return count;
}

async function startDownload(idx) {
    const v = _sortedVideos[idx];
    if (!v) return;

    // 화질 선택 (select 요소에서 읽기)
    let downloadUrl = v.url;
    const sel = document.querySelector(`select.quality-select[data-idx="${idx}"]`);
    if (sel && v.qualities) {
        const qi = parseInt(sel.value);
        downloadUrl = v.qualities[qi]?.url || v.url;
    }

    let baseName = extractBestName(v, _sortedVideos);
    const directMediaExtMatch = downloadUrl.match(/\.(mp4|webm|flv|m4v|mkv)(\?|#|$)/i);
    const directMediaExt = (directMediaExtMatch?.[1] || 'mp4').toLowerCase();
    const isMP4Direct = !!directMediaExtMatch;
    const youtubePageUrl = getYouTubePageUrl(v);
    const isYT = !!youtubePageUrl || isYouTubePageUrl(downloadUrl);
    const selectedQuality = sel && v.qualities ? v.qualities[parseInt(sel.value)] : null;
    const selectedIsBest = isBestQualityPreset(selectedQuality);
    const selectedFormatId = selectedQuality?.id || '';
    const selectedDims = parseQualityDimensions(selectedQuality || {}) || {};
    const selectedQualityHeight = !selectedIsBest
        ? (Number(selectedQuality?.height || 0) || selectedDims.height || qualityHeight(selectedQuality || {}) || 0)
        : 0;
    const selectedQualityResolution = !selectedIsBest
        ? (selectedQuality?.resolution || (selectedDims.width && selectedDims.height ? `${selectedDims.width}x${selectedDims.height}` : ''))
        : '';
    const selectedQualityLabel = selectedQuality?.label || '';
    const isResolvedYouTubeQuality = isYT && isYouTubePageDirectQuality(selectedQuality) && !_companionStatus?.deno_installed;
    const downloadStrategy = inferDetectedDownloadStrategy(v, downloadUrl);

    sendDebugLog('info', 'popup.download', 'Download clicked', {
        title: baseName,
        type: v.type,
        isYouTube: isYT,
        strategy: downloadStrategy,
        selectedFormatId,
        selectedQualityLabel,
        selectedQualityResolution,
        selectedQualityHeight,
        companion: _companionStatus?.status || 'missing',
        ytdlp: !!_companionStatus?.ytdlp_installed,
        deno: !!_companionStatus?.deno_installed,
        url: downloadUrl,
        tabUrl: v.tabUrl || '',
    });

    if (isYT && !canDownloadYouTube(v)) {
        showToast(getBlockedByChannelPolicyMessage(), 'warning');
        return {
            ok: false,
            status: VARIANT_CONFIG.policy.blockedStatus,
            message: getBlockedByChannelPolicyMessage(),
        };
    }

    // ── 다운로드 분기 로직 ──
    // 1) YouTube 등 yt-dlp 전용 사이트 → yt-dlp 필수
    if (isResolvedYouTubeQuality) {
        if (!_companionStatus?.ytdlp_installed) {
            sendDebugLog('warn', 'popup.download', 'Resolved YouTube quality requires companion', { title: baseName });
            showToast(t('companionRequired'), 'warning');
            return;
        }
        const downloadId = `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await queueDownloadRequest({
            taskId: downloadId,
            requestKind: 'native',
            url: selectedQuality?.url || downloadUrl,
            downloadPath: _companionStatus.download_path || '',
            nativeMode: 'youtube-direct',
            referer: youtubePageUrl || v.tabUrl || '',
            formatId: selectedFormatId || '',
            requestedFormatId: selectedFormatId || '',
            qualityLabel: selectedQualityLabel,
            qualityResolution: selectedQualityResolution,
            qualityHeight: selectedQualityHeight,
            audioUrl: selectedQuality?.audioUrl || '',
            videoExt: selectedQuality?.ext || '',
            audioExt: selectedQuality?.audioExt || '',
            allowCookieAuth: true,
            containerExt: selectedQuality?.ext || 'mp4',
            titleResolveUrl: youtubePageUrl || downloadUrl,
            requestedItem: buildQueuedMetadata(v, baseName, downloadUrl, downloadStrategy),
        });
        return;
    }

    if (downloadStrategy === 'native-ytdlp' || isYT) {
        if (!_companionStatus?.ytdlp_installed) {
            sendDebugLog('warn', 'popup.download', 'Native yt-dlp download requires companion', { title: baseName, isYouTube: isYT });
            showToast(t('companionRequired'), 'warning');
            return;
        }
        const downloadId = `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await queueDownloadRequest({
            taskId: downloadId,
            requestKind: 'native',
            url: youtubePageUrl || downloadUrl,
            formatId: selectedFormatId || '',
            requestedFormatId: selectedFormatId || '',
            qualityLabel: selectedQualityLabel,
            qualityResolution: selectedQualityResolution,
            qualityHeight: selectedQualityHeight,
            downloadPath: _companionStatus.download_path || '',
            nativeMode: 'ytdlp',
            titleResolveUrl: youtubePageUrl || downloadUrl,
            allowCookieAuth: true,
            requestedItem: buildQueuedMetadata(v, baseName, downloadUrl, downloadStrategy),
        });
        return;
    }

    // 2) MP4 직접 링크
    if (downloadStrategy === 'direct-video' && isMP4Direct) {
        // Companion 연결 시 → 기존 yt-dlp 우선, 실패 시 페이지 세션 native stream fallback
        if (_companionStatus?.ytdlp_installed) {
            const downloadId = `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            sendDebugLog('info', 'popup.download', 'Direct media delegated to native downloader with page-session fallback', {
                downloadId,
                title: baseName,
                url: downloadUrl,
            });
            await queueDownloadRequest({
                taskId: downloadId,
                requestKind: 'native',
                url: downloadUrl,
                downloadPath: _companionStatus.download_path || '',
                nativeMode: 'ytdlp',
                referer: v.tabUrl || '',
                type: v.type || directMediaExt || 'mp4',
                containerExt: directMediaExt,
                directFallback: true,
                fallbackTabId: currentTabId,
                fallbackType: v.type || directMediaExt || 'mp4',
                requestedItem: buildQueuedMetadata(v, baseName, downloadUrl, downloadStrategy),
            });
            return;
        }
        // Companion 미연결 → chrome.downloads
        const taskId = `browser_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        sendDebugLog('info', 'popup.download', 'Direct media delegated to browser downloader', { taskId, title: baseName, url: downloadUrl });
        await queueDownloadRequest({
            taskId,
            requestKind: 'browser-direct',
            url: downloadUrl,
            tabId: currentTabId,
            type: v.type || 'mp4',
            containerExt: directMediaExt,
            requestedItem: buildQueuedMetadata(v, baseName, downloadUrl, downloadStrategy),
        });
        return;
    }

    // 3) HLS → Companion 연결 시 companion 폴더 저장, 실패 시 background에서 browser fallback
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const qualityLabel = (sel && v.qualities)
        ? (v.qualities[parseInt(sel.value)]?.label || '').replace(/[^a-zA-Z0-9\uAC00-\uD7A3]/g, '-')
        : '';
    const companionDownloadPath = (_companionStatus?.status === 'ok' && _companionStatus?.download_path)
        ? _companionStatus.download_path
        : '';

    sendDebugLog('info', 'popup.download', 'HLS download delegated to background', {
        taskId,
        title: baseName,
        companionDownloadPath: !!companionDownloadPath,
        url: downloadUrl,
    });
    await queueDownloadRequest({
        taskId,
        requestKind: 'hls',
        url: downloadUrl,
        type: v.type,
        tabId: currentTabId,
        downloadPath: companionDownloadPath,
        containerExt: 'ts',
        qualityLabel,
        requestedItem: buildQueuedMetadata(v, baseName, downloadUrl, downloadStrategy),
    });
}

function makeLiveRecordFileName(baseName) {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    return `${baseName}_${stamp}.ts`;
}

async function startLiveRecord(idx) {
    const v = _sortedVideos[idx];
    if (!v?.isLive) return;
    if (getYouTubePageUrl(v) && !canRecordYouTubeLive(v)) {
        showToast(getBlockedByChannelPolicyMessage(), 'warning');
        return {
            ok: false,
            status: VARIANT_CONFIG.policy.blockedStatus,
            message: getBlockedByChannelPolicyMessage(),
        };
    }
    if (!_companionStatus?.status || !_companionStatus?.download_path) {
        sendDebugLog('warn', 'popup.live', 'Live recording requires companion', {
            title: v?.pageTitle || v?.title || '',
            companion: _companionStatus?.status || 'missing',
        });
        showToast(t('liveRecordRequiresCompanion'), 'warning');
        return;
    }

    const sel = document.querySelector(`select.quality-select[data-idx="${idx}"]`);
    const selectedIndex = sel ? parseInt(sel.value, 10) : 0;
    const selectedQuality = Array.isArray(v.qualities) ? v.qualities[selectedIndex] : null;
    const recordQuality = getLiveRecordQuality(v, selectedIndex);
    const recordUrl = getLiveRecordableUrl(v, selectedIndex);
    const modeSel = document.querySelector(`select.live-mode-select[data-idx="${idx}"]`);
    const recordMode = modeSel?.value === 'window' ? 'window' : 'now';
    const selectedIsBest = isBestQualityPreset(selectedQuality);
    const isYouTubePageLiveFallback = recordQuality?.source === 'youtube-page-live';
    const recordDims = parseQualityDimensions(recordQuality || selectedQuality || {}) || {};
    const liveFormatId = (recordMode === 'window' || selectedIsBest || (isYouTubePageLiveFallback && recordMode === 'now'))
        ? ''
        : (recordQuality?.id || extractYouTubeItagFromUrl(recordQuality?.url || ''));
    const liveQualityHeight = (!selectedIsBest && recordDims.height > 0 && !(isYouTubePageLiveFallback && recordMode === 'now')) ? recordDims.height : 0;
    if (!isLiveRecordable(v, selectedIndex)) {
        sendDebugLog('warn', 'popup.live', 'Live recording rejected because selected source is not recordable', {
            title: v.pageTitle || v.title || '',
            selectedQuality: selectedQuality?.label || '',
            url: recordUrl,
        });
        showToast(t('liveRecordHlsOnly'), 'warning');
        return;
    }

    const taskId = `live_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const pageUrl = v.tabUrl || currentTabUrl || '';
    sendDebugLog('info', 'popup.live', 'Live recording clicked', {
        taskId,
        title: v.pageTitle || v.title || '',
        recordMode,
        selectedQuality: selectedQuality?.label || '',
        selectedResolution: recordQuality?.resolution || selectedQuality?.resolution || '',
        selectedFormatId: liveFormatId,
        selectedHeight: liveQualityHeight,
        url: recordUrl,
        sourceUrl: v.url,
        pageUrl,
    });
    const response = await queueDownloadRequest({
        requestKind: 'live',
        taskId,
        url: recordUrl,
        sourceUrl: v.url,
        pageUrl,
        formatId: liveFormatId,
        type: 'live-hls',
        tabId: currentTabId,
        downloadPath: _companionStatus.download_path || '',
        recordMode,
        qualityLabel: selectedQuality?.label || '',
        qualityResolution: recordQuality?.resolution || selectedQuality?.resolution || '',
        qualityHeight: liveQualityHeight,
        qualityBandwidth: recordQuality?.bandwidth || 0,
        isLive: true,
        allowCookieAuth: !!getYouTubePageUrl(v),
        containerExt: 'ts',
        requestedItem: buildQueuedMetadata(v, extractBestName(v, _sortedVideos), recordUrl, 'browser-hls'),
    });
}

async function stopLiveRecord(idx) {
    const liveTask = getLiveRecordTaskForVideo(_sortedVideos[idx]);
    if (!liveTask) return;
    await chrome.runtime.sendMessage({ action: 'stopLiveRecord', taskId: liveTask.taskId });
    renderQueue();
}

async function removeVideo(idx) {
    const target = _sortedVideos[idx];
    await removeDetectedVideoEntry(target, 'manual-remove');
}

// ── 큐 렌더링 ──
async function renderQueue() {
    const { tasks = {} } = await chrome.storage.local.get('tasks');
    _lastTasks = normalizeTaskMap(tasks);
    const list = document.getElementById('queueList');
    const all = Object.values(tasks);
    if (!all.length) {
        list.innerHTML = `<div class="empty"><div class="empty-icon">📋</div><div>${t('noDownloads')}</div></div>`;
        return;
    }
    all.sort((a, b) => sortKeyQ === 'status'
        ? (a.status||'').localeCompare(b.status||'')
        : (b.addedAt||0) - (a.addedAt||0)
    );
    const stLabel = {
        waiting: t('stWaiting'),
        waiting_metadata: t('stMetadata'),
        downloading: t('stDl'),
        recording: t('stRecording'),
        stopping: t('stStopping'),
        blocked_by_channel_policy: t('blockedByChannelPolicy'),
        error: t('stErr'),
        cancelling: t('btnCancel'),
        done: t('stDone'),
        partial: t('stDone')
    };
    list.innerHTML = all.map(tk => {
        const effectiveStatus = tk.status === 'partial' ? 'done' : tk.status;
        const pct = tk.percent || 0;
        const sc = `status-${effectiveStatus}`;
        const name = (tk.fileName || tk.taskId || '').substring(0, 40);
        const modeTag = tk.mode === 'ytdlp' ? '<span style="color:var(--error);font-size:9px;font-weight:700;margin-left:4px;">yt-dlp</span>' : '';
        const isLiveTask = isLiveRecordTask(tk);
        const isLiveWindowStopping = isLiveTask && tk.status === 'stopping' && tk.recordMode === 'window';
        const statusText = (() => {
            if (isLiveTask && tk.status === 'stopping') {
                if (tk.finalizeStage === 'normalizing') return t('stNormalizing');
                if (tk.finalizeStage === 'finalizing') return t('stFinalizing');
                return isLiveWindowStopping ? t('stMerging') : t('stStopping');
            }
            return stLabel[effectiveStatus] || effectiveStatus;
        })();
        const hasRuntimeInfo = tk.status === 'downloading' && (tk.speed || tk.eta || (pct > 0 && pct < 100));
        let speedInfo = hasRuntimeInfo
            ? `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">${tk.speed || '--'} • ETA ${tk.eta || '--'}</div>`
            : '';
        if (isLiveTask) {
            const infoParts = [];
            const fallbackElapsed = ['recording', 'stopping'].includes(tk.status)
                ? Math.max(0, Math.floor((Date.now() - (tk.recordingStartedAt || tk.addedAt || Date.now())) / 1000))
                : 0;
            const elapsedSec = Number(tk.elapsedSec || 0) || fallbackElapsed;
            if (elapsedSec > 0) infoParts.push(`${lang === 'ko' ? '녹화' : 'REC'} ${fmtDur(elapsedSec)}`);
            if (tk.filesize > 0) infoParts.push(formatBytesShort(tk.filesize));
            if (tk.speed) infoParts.push(tk.speed);
            speedInfo = infoParts.length
                ? `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">${infoParts.join(' • ')}</div>`
                : '';
        }
        
        let sizeInfo = '';
        if (effectiveStatus === 'done' && tk.filesize) {
            const kb = tk.filesize / 1024;
            const mb = kb / 1024;
            const gb = mb / 1024;
            let sz = gb >= 1 ? `${gb.toFixed(2)} GB` : mb >= 1 ? `${mb.toFixed(2)} MB` : `${kb.toFixed(2)} KB`;
            sizeInfo = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">${sz}</div>`;
        }
        const errorInfo = (tk.status === 'error' && tk.error)
            ? `<div style="font-size:10px;color:var(--error);margin-bottom:6px;line-height:1.35;">${String(tk.error).substring(0, 180)}</div>`
            : '';
        const warningText = tk.warning || '';
        const warningInfo = warningText && effectiveStatus !== 'done'
            ? `<div style="font-size:10px;color:var(--warning);margin-bottom:6px;line-height:1.35;">${String(warningText).substring(0, 180)}</div>`
            : '';

        let actionBtns = '';
        if (isLiveTask && (tk.status === 'recording' || tk.status === 'waiting')) {
            actionBtns = `<button class="btn btn-stop-record" style="background:var(--surface2);color:var(--warning);border:1px solid var(--border);padding:5px 10px;border-radius:5px;font-size:11px;cursor:pointer;">${t('btnRecStop')}</button>`;
        } else if (isLiveTask && tk.status === 'stopping') {
            actionBtns = `<button class="btn" disabled style="background:var(--surface2);color:var(--text-muted);border:1px solid var(--border);padding:5px 10px;border-radius:5px;font-size:11px;cursor:not-allowed;opacity:.7;">${statusText}</button>`;
        } else if (tk.status === 'downloading' || tk.status === 'waiting' || tk.status === 'waiting_metadata') {
            actionBtns = `<button class="btn btn-cancel" style="background:var(--surface2);color:var(--text-muted);border:1px solid var(--border);padding:5px 10px;border-radius:5px;font-size:11px;cursor:pointer;">${t('btnCancel')}</button>`;
        } else {
            const hasSavedOutput = (effectiveStatus === 'done' && tk.filePath);
            const openBtn = hasSavedOutput
                ? `<button class="btn btn-open-folder" style="background:var(--surface2);color:var(--accent);border:1px solid var(--border);padding:5px 8px;border-radius:5px;font-size:11px;cursor:pointer;margin-right:6px;display:flex;align-items:center;" title="${lang==='ko'?'폴더 열기':'Open folder'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>`
                : '';
            const playBtn = hasSavedOutput
                ? `<button class="btn btn-play" style="background:var(--surface2);color:#4CAF50;border:1px solid var(--border);padding:5px 10px;border-radius:5px;font-size:11px;cursor:pointer;margin-right:6px;display:flex;align-items:center;gap:4px;" title="${t('btnPlay')}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>${t('btnPlay')}</button>`
                : '';
            actionBtns = `${playBtn}${openBtn}<button class="btn btn-rm" style="background:var(--surface2);color:var(--text-muted);border:1px solid var(--border);padding:5px 10px;border-radius:5px;font-size:11px;cursor:pointer;">${t('btnRemove')}</button>`;
        }
        const progressBarClass = isLiveTask && (tk.status === 'recording' || tk.status === 'stopping')
            ? 'progress-bar indeterminate'
            : 'progress-bar';
        const progressWidth = isLiveTask
            ? (effectiveStatus === 'done' ? '100%' : '35%')
            : `${pct}%`;
        return `<div class="queue-item" data-task-id="${tk.taskId}">
            <div class="queue-header">
                <div class="queue-name" title="${tk.fileName||''}">${name}${modeTag}</div>
                <span class="status-badge ${sc}">${statusText}</span>
            </div>
            ${speedInfo}
            ${errorInfo}
            ${warningInfo}
            ${sizeInfo}
            <div class="${progressBarClass}"><div class="progress-fill" style="width:${progressWidth}"></div></div>
            <div class="queue-actions">${actionBtns}</div>
        </div>`;
    }).join('');
}

async function cancelDl(taskId) {
    await chrome.runtime.sendMessage({ action: 'cancelDownload', taskId });
    renderQueue();
}
async function stopRecording(taskId) {
    await chrome.runtime.sendMessage({ action: 'stopLiveRecord', taskId });
    renderQueue();
}
async function removeDl(taskId) {
    const { tasks = {} } = await chrome.storage.local.get('tasks');
    delete tasks[taskId];
    await chrome.storage.local.set({ tasks });
    renderQueue();
}

// ── 유틸 ──
function sanitizeName(n) { return (n||'video').replace(/[\\/:*?"<>|]/g,'_').substring(0,80).trim(); }

function normalizeNameText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim();
}

function hostLabelFromUrl(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./i, '');
        return host.split('.').slice(0, -1).join(' ') || host.split('.')[0] || '';
    } catch {
        return '';
    }
}

function splitTitleVariants(value) {
    const text = normalizeNameText(value);
    if (!text) return [];
    const variants = new Set([text]);
    const separators = [/\s+\|\s+/g, /\s+-\s+/g, /\s+::\s+/g, /\s+»\s+/g, /\s+\/\s+/g];
    for (const separator of separators) {
        const parts = text.split(separator).map(part => normalizeNameText(part)).filter(Boolean);
        if (parts.length > 1) {
            parts.forEach(part => variants.add(part));
        }
    }
    return Array.from(variants);
}

function isPollutedYouTubeUiTitle(title = '', url = '') {
    if (!isYouTubeUrl(url)) return false;
    const text = normalizeNameText(title);
    if (!text) return false;
    const compact = text.replace(/\s+/g, '');
    if (/^(검색|superthanks|구매)/i.test(compact)) return true;
    if (/(탭하여음소거해제|검색정보쇼핑|잠시후재생|재생목록포함|공유재생목록)/i.test(compact)) return true;
    if (/(Super\s*Thanks|구매\|?@|검색[_\s"“”']|탭하여 음소거 해제|잠시 후 재생)/i.test(text)) return true;
    const uiHits = (compact.match(/구독|댓글|공유|리믹스|좋아요|싫어요|조회수|정보|쇼핑|음소거/g) || []).length;
    return uiHits >= 2;
}

function cleanPageTitleCandidate(title, url = '') {
    const hostLabel = normalizeNameText(hostLabelFromUrl(url)).toLowerCase();
    const genericTitles = new Set([
        'youtube',
        'youtube shorts',
        'shorts',
        'facebook',
        'instagram',
        'tiktok',
        'twitter',
        'x'
    ]);
    let bestValue = '';
    let bestScore = -1000;
    for (const variant of splitTitleVariants(title)) {
        let value = variant
            .replace(/\s*[-|]\s*(YouTube|YouTube Shorts|TikTok|Instagram|Facebook|Twitter|X)$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        value = value
            .replace(/^(?:\s*[\[［【][^\]］】]{1,20}[\]］】]\s*)+/u, '')
            .replace(/^(?:\s*\((?:[^)]{1,12})\)\s*)+/u, '')
            .replace(/^[^\p{L}\p{N}]+/u, '')
            .trim();
        value = value
            .replace(/\s*(?:\d{4}[./_-]\d{1,2}[./_-]\d{1,2}(?:\s*(?:AM|PM|오전|오후))?(?:\s+\d{1,2}[:._]\d{2}(?::\d{2})?)?)\s*$/iu, '')
            .replace(/\s*\(\d{1,4}\)\s*$/u, '')
            .replace(/\s*(?:\d{4}[./_-]\d{1,2}[./_-]\d{1,2}(?:\s*(?:AM|PM|오전|오후))?(?:\s+\d{1,2}[:._]\d{2}(?::\d{2})?)?)\s*$/iu, '')
            .trim();
        if (!value || value.length < 3) continue;
        if (isPollutedYouTubeUiTitle(value, url)) continue;

        const lower = value.toLowerCase();
        if (genericTitles.has(lower)) continue;
        if (/^(시청 기록|기록|watch history|history)$/i.test(value)) continue;
        if (hostLabel && (lower === hostLabel || lower === `${hostLabel}.com`)) continue;
        if (/^category[_\s-]*\d+$/i.test(value)) continue;
        if (/(^|\s)(function\s+\w+\s*\(|window\.open\(|adsbygoogle|googlesyndication|return false|javascript:)/i.test(value)) continue;
        if (/(돌아가기|아래로|위로|목록|댓글|복사|추천|공유)(\s+(돌아가기|아래로|위로|목록|댓글|복사|추천|공유))+/.test(value)) continue;

        let score = Math.min(value.length, 80);
        if (/\s/.test(value)) score += 12;
        if (/[가-힣]/.test(value)) score += 10;
        if (/[[\]【】「」『』()]/.test(value)) score += 16;
        if (/(카테고리|게시판|커뮤니티|블로그|갤러리|forum|community|board|gallery|category)/i.test(value)) score -= 20;
        if (score > bestScore || (score === bestScore && value.length > bestValue.length)) {
            bestScore = score;
            bestValue = value;
        }
    }
    return bestValue;
}

function isMeaningfulSlug(value) {
    const text = normalizeNameText(value)
        .replace(/\.(m3u8|mp4|webm|flv|m4v|mkv|ts|m4s)(\?.*)?$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim();
    if (!text || text.length < 3) return false;
    if (/^(index|master|playlist|video|play|source|stream|download|file|media|clip)$/i.test(text)) return false;
    if (/^[0-9]+$/i.test(text)) return false;
    if (/^[0-9a-f-]{12,}$/i.test(text.replace(/\s+/g, ''))) return false;
    return true;
}

function extractMediaSlug(video) {
    const candidateUrls = [video?.url, video?.previewCandidateUrl, video?.previewUrl].filter(Boolean);
    for (const rawUrl of candidateUrls) {
        try {
            const u = parseLooseUrl(rawUrl);
            if (!u) continue;
            for (const key of ['filename', 'file', 'title', 'name', 'download']) {
                const value = u.searchParams.get(key) || '';
                if (isMeaningfulSlug(value)) return sanitizeName(decodeURIComponent(value));
            }
            const parts = u.pathname.split('/').filter(Boolean);
            for (let i = parts.length - 1; i >= 0; i -= 1) {
                const segment = decodeURIComponent(parts[i] || '');
                if (isMeaningfulSlug(segment)) {
                    return sanitizeName(segment.replace(/\.(m3u8|mp4|webm|flv|m4v|mkv|ts|m4s)(\?.*)?$/i, '').replace(/[_-]+/g, ' ').trim());
                }
            }
        } catch {}
    }
    return '';
}

function buildCandidateBaseName(video) {
    const titleCandidate = cleanPageTitleCandidate(video?.pageTitle, video?.tabUrl || video?.url || '');
    const tabTitleCandidate = cleanPageTitleCandidate(video?.tabTitle, video?.tabUrl || video?.url || '');
    const pageName = titleCandidate || tabTitleCandidate;
    const isDirectVideo = inferDetectedDownloadStrategy(video, video?.url || '') === 'direct-video' || /\.(mp4|webm|flv|m4v|mkv)(\?|#|$)/i.test(String(video?.url || ''));
    const mediaSlug = extractMediaSlug(video);

    const youtubePageUrl = getYouTubePageUrl(video);
    if (youtubePageUrl) {
        if (pageName) return sanitizeName(pageName);
        const ytId = extractYouTubeVideoId(youtubePageUrl);
        if (ytId) return sanitizeName(`youtube_${ytId}`);
    }

    if (isDirectVideo && mediaSlug) {
        if (pageName) return sanitizeName(pageName);
        return sanitizeName(mediaSlug);
    }

    if (pageName) return sanitizeName(pageName);

    if (video?.tabUrl) {
        try {
            const u = new URL(video.tabUrl);
            const parts = u.pathname.split('/').filter(Boolean);
            for (let i = parts.length - 1; i >= 0; i -= 1) {
                const segment = decodeURIComponent(parts[i] || '');
                if (isMeaningfulSlug(segment)) return sanitizeName(segment.replace(/[_-]+/g, ' ').trim());
            }
        } catch {}
    }

    if (mediaSlug) return sanitizeName(mediaSlug);
    return 'video';
}

function buildCandidateDisplayName(video) {
    const titleCandidate = cleanPageTitleCandidate(video?.pageTitle, video?.tabUrl || video?.url || '');
    const tabTitleCandidate = cleanPageTitleCandidate(video?.tabTitle, video?.tabUrl || video?.url || '');
    const pageName = titleCandidate || tabTitleCandidate;
    const isDirectVideo = inferDetectedDownloadStrategy(video, video?.url || '') === 'direct-video' || /\.(mp4|webm|flv|m4v|mkv)(\?|#|$)/i.test(String(video?.url || ''));
    const mediaSlug = extractMediaSlug(video);

    const youtubePageUrl = getYouTubePageUrl(video);
    if (youtubePageUrl) {
        if (pageName) return normalizeNameText(pageName);
        const ytId = extractYouTubeVideoId(youtubePageUrl);
        if (ytId) return `youtube_${ytId}`;
    }

    if (isDirectVideo && mediaSlug) {
        return normalizeNameText(pageName || mediaSlug);
    }

    if (pageName) return normalizeNameText(pageName);

    if (video?.tabUrl) {
        try {
            const u = new URL(video.tabUrl);
            const parts = u.pathname.split('/').filter(Boolean);
            for (let i = parts.length - 1; i >= 0; i -= 1) {
                const segment = decodeURIComponent(parts[i] || '');
                if (isMeaningfulSlug(segment)) return normalizeNameText(segment.replace(/[_-]+/g, ' ').trim());
            }
        } catch {}
    }

    if (mediaSlug) return normalizeNameText(mediaSlug);
    return 'video';
}

function isTemporaryYouTubeBaseName(video, baseName) {
    const ytId = extractYouTubeVideoId(getYouTubePageUrl(video) || video?.tabUrl || video?.url || '');
    return !!ytId && sanitizeName(`youtube_${ytId}`) === String(baseName || '');
}

function getVisibleVideoTitle(video, allVideos = [], fallback = '') {
    const safeName = extractBestName(video, allVideos);
    if (isTemporaryYouTubeBaseName(video, safeName)) {
        return isYouTubeShortsUrl(getYouTubePageUrl(video) || video?.tabUrl || video?.url || '') ? '' : t('youtubeDetected');
    }
    const displayBase = buildCandidateDisplayName(video);
    const safeBase = buildCandidateBaseName(video);
    const duplicates = (allVideos || [])
        .filter(item => buildCandidateBaseName(item) === safeBase)
        .sort((a, b) =>
            (a.addedAt || 0) - (b.addedAt || 0) ||
            String(a.url || '').localeCompare(String(b.url || ''))
        );
    if (duplicates.length <= 1) {
        return displayBase && displayBase !== 'video' ? displayBase : fallback;
    }

    let index = duplicates.findIndex(item =>
        (item.url || '') === (video?.url || '') &&
        (item.addedAt || 0) === (video?.addedAt || 0)
    );
    if (index < 0) index = duplicates.findIndex(item => (item.url || '') === (video?.url || ''));
    if (index < 0) index = 0;
    return displayBase && displayBase !== 'video' ? `${displayBase}_${index + 1}` : fallback;
}

function extractBestName(video, allVideos = []) {
    const baseName = buildCandidateBaseName(video);
    const duplicates = (allVideos || [])
        .filter(item => buildCandidateBaseName(item) === baseName)
        .sort((a, b) =>
            (a.addedAt || 0) - (b.addedAt || 0) ||
            String(a.url || '').localeCompare(String(b.url || ''))
        );
    if (duplicates.length <= 1) return baseName;

    let index = duplicates.findIndex(item =>
        (item.url || '') === (video?.url || '') &&
        (item.addedAt || 0) === (video?.addedAt || 0)
    );
    if (index < 0) index = duplicates.findIndex(item => (item.url || '') === (video?.url || ''));
    if (index < 0) index = 0;
    return sanitizeName(`${baseName}_${index + 1}`);
}

function extractName(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        return parts[parts.length-1]?.replace(/\.(m3u8|mp4|ts).*/,'') || 'video';
    } catch { return 'video'; }
}

// ── 유틸: YouTube URL 판별 ──
function parseLooseUrl(url) {
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

function isYouTubeUrl(url) {
    if (!url) return false;
    const parsed = parseLooseUrl(url);
    const h = parsed?.hostname || '';
    return h.includes('youtube.com') || h.includes('youtu.be') || h.includes('googlevideo.com');
}

function isYouTubePageUrl(url) {
    if (!url) return false;
    const parsed = parseLooseUrl(url);
    const h = parsed?.hostname || '';
    return h.includes('youtube.com') || h.includes('youtu.be');
}

function getYouTubePageUrl(videoOrUrl) {
    if (!videoOrUrl) return '';
    if (typeof videoOrUrl === 'string') {
        return isYouTubePageUrl(videoOrUrl) ? videoOrUrl : '';
    }
    if (isYouTubePageUrl(videoOrUrl.url || '')) return videoOrUrl.url;
    if (isYouTubePageUrl(videoOrUrl.tabUrl || '')) return videoOrUrl.tabUrl;
    return '';
}

function isYouTubeVideoItem(video) {
    return !!getYouTubePageUrl(video) || video?.type === 'youtube';
}

function isYouTubeShortsUrl(url) {
    if (!url) return false;
    const parsed = parseLooseUrl(url);
    const h = parsed?.hostname || '';
    return !!parsed && h.includes('youtube.com') && parsed.pathname.startsWith('/shorts/');
}

function extractYouTubeVideoId(url) {
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

function buildYouTubeThumbnailUrl(url) {
    const id = extractYouTubeVideoId(url);
    if (!id) return '';
    return isYouTubeShortsUrl(url)
        ? `https://i.ytimg.com/vi/${id}/oardefault.jpg`
        : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function buildYouTubeWideThumbnailUrl(url) {
    const id = extractYouTubeVideoId(url);
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}

function extractYouTubeThumbnailVideoId(url) {
    const parsed = parseLooseUrl(url);
    if (!parsed || !/ytimg\.com$/i.test(parsed.hostname)) return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(part => part === 'vi' || part === 'vi_webp');
    return idx >= 0 ? (parts[idx + 1] || '') : '';
}

function isStaleYouTubeThumbnail(video, thumbnailUrl) {
    const currentId = extractYouTubeVideoId(getYouTubePageUrl(video) || video?.tabUrl || video?.url || '');
    const thumbnailId = extractYouTubeThumbnailVideoId(thumbnailUrl);
    return !!currentId && !!thumbnailId && currentId !== thumbnailId;
}

function getYouTubePageKey(url) {
    const id = extractYouTubeVideoId(url);
    if (id) return `yt:${id}`;
    if (!isYouTubeUrl(url)) return '';
    const u = parseLooseUrl(url);
    return u ? `${u.origin}${u.pathname}` : '';
}

function isYouTubeLiveHlsCandidate(video) {
    return video?.type === 'hls' &&
        isYouTubePageUrl(video?.tabUrl || '') &&
        /manifest\.googlevideo\.com\/api\/manifest\/hls_/i.test(String(video?.url || '')) &&
        /yt_live_broadcast/i.test(String(video?.url || ''));
}

function filterVisibleDetectedVideos(videos = []) {
    const liveKeys = new Set((videos || [])
        .filter(v => (v?.isLive && v?.type === 'hls') || isYouTubeLiveHlsCandidate(v))
        .map(v => getYouTubePageKey(getYouTubePageUrl(v) || v?.tabUrl || v?.url || ''))
        .filter(Boolean));
    if (!liveKeys.size) return Array.isArray(videos) ? [...videos] : [];

    return (videos || []).filter(v => {
        if ((v?.isLive && v?.type === 'hls') || isYouTubeLiveHlsCandidate(v)) return true;
        if (v?.type !== 'youtube') return true;
        const pageKey = getYouTubePageKey(getYouTubePageUrl(v) || v?.tabUrl || v?.url || '');
        return !pageKey || !liveKeys.has(pageKey);
    });
}

// ── 토스트 메시지 (모달 대신 하단 슬라이드) ──
function showToast(msg, type = 'info') {
    // 기존 토스트 제거
    document.querySelectorAll('.toast-msg').forEach(el => el.remove());
    const toast = document.createElement('div');
    toast.className = `toast-msg toast-${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

async function hydrateYouTubeFormats(videos) {
    if (!currentTabId || !_companionStatus?.ytdlp_installed) return;

    const shouldRefreshSingleQuality = isVersionAtLeast(_companionStatus.ytdlp_version);
    const youtubeTargets = (videos || []).filter(v => {
        if (v?.type === 'hls') return false;
        if (v?.metadataHydrating) return false;
        const hydrateUrl = getYouTubePageUrl(v);
        if (!hydrateUrl) return false;
        if (isNativeFormatAuthBlocked(hydrateUrl)) return false;
        const qualities = Array.isArray(v.qualities) ? v.qualities : [];
        const hasNativeIds = qualities.some(q => !!q.id);
        const hasResolvedPageQualities = qualities.some(isYouTubePageDirectQuality);
        if (hasResolvedPageQualities && !_companionStatus?.deno_installed) return false;
        if (!hasNativeIds) return true;
        if (!shouldRefreshSingleQuality || qualities.length > 1) return false;
        return v.qualitiesVersion !== _companionStatus.ytdlp_version;
    });

    const pendingTargets = youtubeTargets.filter(video => {
        const fetchUrl = getYouTubePageUrl(video) || video.tabUrl || video.url;
        return !nativeFormatInflight.has(`${currentTabId}|${fetchUrl}`);
    });

    if (pendingTargets.length) {
        sendDebugLog('info', 'popup.youtube', 'YouTube format hydrate targets queued', {
            count: pendingTargets.length,
            ytdlpVersion: _companionStatus.ytdlp_version || '',
            deno: !!_companionStatus?.deno_installed,
            urls: pendingTargets.map(v => getYouTubePageUrl(v) || v.tabUrl || v.url),
        });
    }

    for (const video of pendingTargets) {
        const fetchUrl = getYouTubePageUrl(video) || video.tabUrl || video.url;
        if (!isYouTubePageUrl(fetchUrl)) continue;
        const key = `${currentTabId}|${fetchUrl}`;
        nativeFormatInflight.add(key);

        sendDebugLog('info', 'popup.youtube', 'Requesting YouTube formats from companion', {
            url: fetchUrl,
            existingQualities: Array.isArray(video.qualities) ? video.qualities.length : 0,
        });
        chrome.runtime.sendMessage({ action: 'companionGetFormats', url: fetchUrl }, async (resp) => {
            try {
                if (!resp || resp.status !== 'ok') {
                    if (isCookieAuthRequiredResponse(resp)) {
                        markNativeFormatAuthBlocked(fetchUrl);
                        showToast(t('cookieAuthRequired'), 'warning');
                    }
                    sendDebugLog(isCookieAuthRequiredResponse(resp) ? 'warn' : 'error', 'popup.youtube', 'YouTube format hydrate failed', {
                        url: fetchUrl,
                        status: resp?.status || '',
                        error: resp?.message || resp?.error || 'empty response',
                    });
                    return;
                }
                clearNativeFormatAuthBlocked(fetchUrl);
                let activeTabUrl = currentTabUrl || '';
                try {
                    const tab = await chrome.tabs.get(currentTabId);
                    activeTabUrl = tab?.url || activeTabUrl;
                } catch {}
                const activePageKey = getYouTubePageKey(activeTabUrl);
                const fetchPageKey = getYouTubePageKey(fetchUrl);
                if (activePageKey && fetchPageKey && activePageKey !== fetchPageKey) {
                    sendDebugLog('info', 'popup.youtube', 'Ignoring stale YouTube format response', {
                        url: fetchUrl,
                        activeUrl: activeTabUrl,
                    });
                    return;
                }
                const mapped = mapCompanionFormats(resp?.formats);
                sendDebugLog(mapped.length ? 'info' : 'warn', 'popup.youtube', 'YouTube formats mapped', {
                    url: fetchUrl,
                    received: Array.isArray(resp?.formats) ? resp.formats.length : 0,
                    mapped: mapped.length,
                    thumbnail: resp?.thumbnail || '',
                    title: resp?.title || '',
                });
                if (!mapped.length) return;

                const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
                const list = detectedVideos[currentTabId] || [];
                const item = list.find(v => {
                    const itemUrl = getYouTubePageUrl(v) || v.tabUrl || v.url || '';
                    return itemUrl === fetchUrl || (fetchPageKey && getYouTubePageKey(itemUrl) === fetchPageKey);
                });
                if (!item) {
                    sendDebugLog('warn', 'popup.youtube', 'Hydrated YouTube target disappeared before update', { url: fetchUrl });
                    return;
                }

                const existingCount = Array.isArray(item.qualities) ? item.qualities.length : 0;
                if (existingCount > mapped.length && !shouldRefreshSingleQuality) {
                    sendDebugLog('warn', 'popup.youtube', 'Ignoring smaller YouTube format list', {
                        url: fetchUrl,
                        existingCount,
                        mapped: mapped.length,
                    });
                    return;
                }

                item.qualities = mapped;
                item.qualitiesVersion = _companionStatus.ytdlp_version || '';
                if (isCompanionLiveFormatResponse(resp)) {
                    item.isLive = true;
                    item.liveSource = 'youtube-page-metadata';
                    item.downloadStrategy = 'native-ytdlp';
                    item.tabUrl = resp.webpage_url || item.tabUrl || fetchUrl;
                    item.url = item.tabUrl || item.url || fetchUrl;
                }
                const resolvedThumbnail = displayThumbnailUrl(resp.thumbnail) || buildYouTubeThumbnailUrl(fetchUrl);
                if (resolvedThumbnail) {
                    item.thumbnail = resolvedThumbnail;
                    item.thumbnailKind = 'image';
                }
                if (resp.title && cleanPageTitleCandidate(resp.title, fetchUrl)) {
                    item.pageTitle = resp.title;
                }
                if (resp.duration && !item.duration) item.duration = resp.duration;
                await chrome.storage.local.set({ detectedVideos });
                renderVideos(detectedVideos[currentTabId] || []);
            } finally {
                nativeFormatInflight.delete(key);
            }
        });
    }
}

function getCookieAuthSelectionFromStatus() {
    const mode = _companionStatus?.cookie_auth_mode || 'off';
    if (mode === 'browser') {
        return _companionStatus?.cookie_auth_browser === 'edge' ? 'edge' : 'chrome';
    }
    if (mode === 'file') return 'file';
    return 'off';
}

function updateCookieAuthRow() {
    const row = document.getElementById('cookieAuthRow');
    const select = document.getElementById('cookieAuthSelect');
    const fileText = document.getElementById('cookieAuthFile');
    const pickButton = document.getElementById('cookieAuthPickFile');
    if (!row || !select || !fileText || !pickButton) return;

    const visible = canShowCookieAuthControls() && _companionStatus?.status === 'ok' && _companionStatus?.ytdlp_installed;
    row.style.display = visible ? 'flex' : 'none';
    if (!visible) return;

    const selection = getCookieAuthSelectionFromStatus();
    if (select.value !== selection) select.value = selection;
    const cookiesFile = _companionStatus?.cookie_auth_file || '';
    const showFileControls = selection === 'file';
    fileText.style.display = showFileControls ? '' : 'none';
    pickButton.style.display = showFileControls ? '' : 'none';
    fileText.textContent = cookiesFile ? shortenPath(cookiesFile) : '';
    fileText.title = cookiesFile;
}

function updateCompanionDetailsVisibility() {
    const panel = document.getElementById('companionStatusPanel');
    const details = document.getElementById('companionDetails');
    const toggle = document.getElementById('companionDetailsToggle');
    if (panel) panel.classList.toggle('expanded', _companionDetailsExpanded);
    if (details) details.hidden = !_companionDetailsExpanded;
    if (toggle) {
        toggle.setAttribute('aria-expanded', _companionDetailsExpanded ? 'true' : 'false');
        toggle.title = _companionDetailsExpanded ? t('companionHideDetails') : t('companionShowDetails');
        toggle.setAttribute('aria-label', toggle.title);
    }
}

// ── Companion 상태 바 업데이트 ──
function updateCompanionBar() {
    const dot = document.getElementById('companionDot');
    const info = document.getElementById('companionInfo');
    const setup = document.getElementById('companionSetup');
    const pathRow = document.getElementById('companionPathRow');
    const pathText = document.getElementById('companionPath');
    const changePath = document.getElementById('companionChangePath');
    const openPath = document.getElementById('companionOpenPath');
    if (!dot || !info) return;

    // 설치 가이드 버튼은 항상 표시
    if (setup) setup.style.display = '';
    if (pathRow) pathRow.style.display = 'flex';

    const setPathFallback = () => {
        if (pathText) {
            pathText.textContent = t('companionBrowserDownloadPath');
            pathText.title = t('companionBrowserDownloadPath');
        }
        if (changePath) changePath.style.display = 'none';
        if (openPath) openPath.style.display = 'none';
    };

    if (!_companionStatusChecked) {
        dot.className = 'companion-dot disconnected';
        info.className = 'info';
        info.textContent = t('companionChecking');
        setPathFallback();
    } else if (_companionStatus?.ytdlp_installed) {
        dot.className = 'companion-dot connected';
        info.className = 'info connected';
        const companionVersion = _companionStatus.companion_version
            ? ` · Companion ${_companionStatus.companion_version}`
            : '';
        info.textContent = lang === 'ko'
            ? `yt-dlp ${_companionStatus.ytdlp_version || ''} 연결됨${companionVersion}`
            : `yt-dlp ${_companionStatus.ytdlp_version || ''} connected${companionVersion}`;
        // 경로 표시
        if (pathRow && pathText) {
            pathRow.style.display = 'flex';
            const dl = _companionStatus.download_path || '~/Downloads';
            pathText.textContent = shortenPath(dl);
            pathText.title = dl;
        }
        if (changePath) changePath.style.display = '';
        if (openPath) openPath.style.display = '';
    } else if (_companionStatus?.status === 'ok') {
        dot.className = 'companion-dot disconnected';
        info.className = 'info';
        info.textContent = t('companionYtdlpMissing');
        setPathFallback();
    } else {
        dot.className = 'companion-dot disconnected';
        info.className = 'info';
        info.textContent = t('companionBrowserMode');
        setPathFallback();
    }
    updateCookieAuthRow();
    updateCompanionDetailsVisibility();
}

function shortenPath(p) {
    if (!p) return '';
    // ~/Downloads/Videos → ~/Downloads/Videos
    const home = _companionStatus?.platform === 'Darwin' ? '/Users/' : 'C:\\Users\\';
    if (p.startsWith(home)) {
        const after = p.substring(home.length);
        const slash = after.indexOf('/') >= 0 ? after.indexOf('/') : after.indexOf('\\');
        if (slash >= 0) return '~' + after.substring(slash);
    }
    return p.length > 30 ? '...' + p.slice(-27) : p;
}

async function saveCookieAuthConfig(config) {
    const resp = await chrome.runtime.sendMessage({ action: 'companionSetConfig', config });
    if (resp?.status !== 'ok') {
        showToast(resp?.message || t('stErr'), 'warning');
        updateCookieAuthRow();
        return resp;
    }
    _companionStatus = {
        ...(_companionStatus || { status: 'ok' }),
        ...(resp.config || {}),
    };
    nativeFormatAuthBlocked.clear();
    updateCookieAuthRow();
    showToast(t('cookieAuthSaved'));
    return resp;
}

async function pickCookieAuthFile() {
    const picked = await chrome.runtime.sendMessage({
        action: 'companionPickCookiesFile',
        current_path: _companionStatus?.cookie_auth_file || '',
    });
    if (picked?.status !== 'ok' || !picked.path) {
        updateCookieAuthRow();
        if (picked?.status === 'error') showToast(picked.message || t('stErr'), 'warning');
        return picked;
    }
    return saveCookieAuthConfig({
        cookie_auth_mode: 'file',
        cookie_auth_file: picked.path,
    });
}

// Setup 가이드 클릭
document.getElementById('companionSetup')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('setup-guide.html') });
});

document.getElementById('companionDetailsToggle')?.addEventListener('click', () => {
    _companionDetailsExpanded = !_companionDetailsExpanded;
    updateCompanionDetailsVisibility();
});

document.getElementById('cookieAuthSelect')?.addEventListener('change', async (event) => {
    const value = event.target.value;
    try {
        if (value === 'off') {
            await saveCookieAuthConfig({ cookie_auth_mode: 'off' });
        } else if (value === 'chrome' || value === 'edge') {
            await saveCookieAuthConfig({
                cookie_auth_mode: 'browser',
                cookie_auth_browser: value,
            });
        } else if (value === 'file') {
            if (_companionStatus?.cookie_auth_file) {
                await saveCookieAuthConfig({ cookie_auth_mode: 'file' });
            } else {
                await pickCookieAuthFile();
            }
        }
    } catch (error) {
        showToast(error?.message || t('stErr'), 'warning');
        updateCookieAuthRow();
    }
});

document.getElementById('cookieAuthPickFile')?.addEventListener('click', () => {
    pickCookieAuthFile().catch(error => {
        showToast(error?.message || t('stErr'), 'warning');
        updateCookieAuthRow();
    });
});

// 폴더 변경 버튼
document.getElementById('companionChangePath')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({
        action: 'companionPickFolder',
        current_path: _companionStatus?.download_path || ''
    }, (resp) => {
        if (resp?.status === 'ok' && resp.path) {
            _companionStatus.download_path = resp.path;
            updateCompanionBar();
            showToast(lang === 'ko' ? `저장 경로: ${resp.path}` : `Download path: ${resp.path}`);
        }
    });
});

// 폴더 열기 버튼
document.getElementById('companionOpenPath')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({
        action: 'companionOpenFolder',
        path: _companionStatus?.download_path || ''
    });
});

// ── 초기화 ──
async function init() {
    i18nPage();
    await loadDebugLogs();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id;
    currentTabUrl = tab?.url || '';
    if (!currentTabId) return;

    // Companion 상태 확인 → UI 상태 바 업데이트
    chrome.runtime.sendMessage({ action: 'companionCheckStatus' }, (resp) => {
        _companionStatusChecked = true;
        _companionStatus = resp?.status === 'ok' ? resp : null;
        updateCompanionBar();
        if (window._lastVideos) renderVideos(window._lastVideos);
        if (_companionStatus?.ytdlp_installed && window._lastVideos?.length) {
            hydrateYouTubeFormats(window._lastVideos).catch(() => {});
        }
    });

    // 초기 렌더
    const { tasks = {} } = await chrome.storage.local.get('tasks');
    _lastTasks = normalizeTaskMap(tasks);
    const { detectedVideos = {} } = await chrome.storage.local.get('detectedVideos');
    renderVideos(detectedVideos[currentTabId] || []);

    // 1.5초마다 갱신 (화질 파싱 완료 대기)
    const interval = setInterval(async () => {
        const { detectedVideos: dv = {} } = await chrome.storage.local.get('detectedVideos');
        renderVideos(dv[currentTabId] || []);
        if (document.getElementById('contentQueue').style.display !== 'none') renderQueue();
    }, 1500);

    window.addEventListener('unload', () => {
        clearInterval(interval);
        thumbnailDisplayUrls.clear();
        thumbnailInflight.clear();
    });
}

// ── storage 변경 감지: 큐 자동 갱신 ──
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.detectedVideos && currentTabId) {
        const nextVideos = changes.detectedVideos.newValue?.[currentTabId] || [];
        renderVideos(nextVideos);
    }
    if (area === 'local' && changes.tasks) {
        _lastTasks = normalizeTaskMap(changes.tasks.newValue);
        if (window._lastVideos) renderVideos(window._lastVideos);
        if (document.getElementById('contentQueue')?.style.display !== 'none') {
            renderQueue();
        }
    }
    if (area === 'local' && changes.debugLogs) {
        _debugLogs = Array.isArray(changes.debugLogs.newValue) ? changes.debugLogs.newValue : [];
        renderDebugLogs();
    }
});

init();
