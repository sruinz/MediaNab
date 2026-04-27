// offscreen.js — Extension offscreen document
// 역할: OPFS(Origin Private File System)에 HLS 청크를 스트리밍 저장
// 컨테이너(ts/mp4)에 따라 finalize 시 MIME/파일명을 결정한다.

const writers = {}; // taskId → FileSystemWritableFileStream
const previewJobs = new Map();

function withPreviewTimeout(promise, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = 0;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn(value);
        };
        timer = setTimeout(() => {
            finish(reject, makePreviewStageError('preview-timeout', 'preview-timeout'));
        }, timeoutMs);
        promise.then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error)
        );
    });
}

function roundPreviewNumber(value, digits = 3) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Number(number.toFixed(digits));
}

function sanitizePreviewDebugDetails(details = {}) {
    const out = {};
    for (const [key, value] of Object.entries(details || {})) {
        if (value === undefined) continue;
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            out[key] = value;
            continue;
        }
        try {
            out[key] = JSON.parse(JSON.stringify(value));
        } catch {
            out[key] = String(value);
        }
    }
    return out;
}

function snapshotPreviewDebug(debug) {
    if (!debug || typeof debug !== 'object') return null;
    const payload = sanitizePreviewDebugDetails(debug);
    delete payload.progressTarget;
    return payload;
}

function reportPreviewDebugProgress(debug) {
    const target = debug?.progressTarget;
    if (!target?.tabId || !target?.itemUrl) return;
    const payload = snapshotPreviewDebug(debug);
    if (!payload) return;
    chrome.runtime.sendMessage({
        action: 'offscreen-previewProgress',
        tabId: target.tabId,
        itemUrl: target.itemUrl,
        debug: payload
    }).catch(() => {});
}

function createPreviewDebug(kind = 'hls', input = {}) {
    return {
        kind,
        source: 'offscreen-preview',
        status: 'running',
        stage: 'job-start',
        progressTarget: input.tabId && input.itemUrl
            ? { tabId: Number(input.tabId), itemUrl: String(input.itemUrl) }
            : null,
        input: sanitizePreviewDebugDetails({
            url: String(input.url || ''),
            durationHint: roundPreviewNumber(input.duration || 0),
            hasBundledHls: typeof Hls === 'function',
            mediaRecorderAvailable: typeof MediaRecorder !== 'undefined'
        }),
        stages: []
    };
}

function pushPreviewDebugStage(debug, stage, details = {}) {
    if (!debug || typeof debug !== 'object') return;
    const entry = { stage, ...sanitizePreviewDebugDetails(details) };
    debug.stage = stage;
    debug.stages = Array.isArray(debug.stages) ? debug.stages : [];
    debug.stages.push(entry);
    reportPreviewDebugProgress(debug);
}

function finalizePreviewDebug(debug, status, details = {}) {
    if (!debug || typeof debug !== 'object') {
        return {
            source: 'offscreen-preview',
            status: status || 'unknown',
            ...sanitizePreviewDebugDetails(details)
        };
    }
    debug.status = status || debug.status || 'unknown';
    Object.assign(debug, sanitizePreviewDebugDetails(details));
    reportPreviewDebugProgress(debug);
    return snapshotPreviewDebug(debug);
}

function makePreviewStageError(message, stage, details = {}) {
    const error = new Error(String(message || stage || 'preview failed'));
    error.previewStage = stage || 'preview-error';
    error.previewDetails = sanitizePreviewDebugDetails(details);
    return error;
}

function getVideoSnapshot(video) {
    if (!(video instanceof HTMLVideoElement)) {
        return { readyState: 0, width: 0, height: 0, duration: 0, currentTime: 0 };
    }
    return {
        readyState: Number(video.readyState || 0),
        width: Number(video.videoWidth || 0),
        height: Number(video.videoHeight || 0),
        duration: roundPreviewNumber(video.duration || 0),
        currentTime: roundPreviewNumber(video.currentTime || 0)
    };
}

function absolutizePlaylistUrl(uri, baseUrl) {
    try {
        if (!uri) return '';
        const absolute = new URL(uri, baseUrl);
        const base = new URL(baseUrl);
        if (!absolute.search && base.search) absolute.search = base.search;
        return absolute.href;
    } catch {
        return '';
    }
}

function parseAttributeList(input = '') {
    const out = {};
    const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
    let match;
    while ((match = regex.exec(input))) {
        const [, key, raw] = match;
        out[key] = raw?.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    }
    return out;
}

function stringifyAttributeList(attrs = {}) {
    return Object.entries(attrs)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => {
            const text = String(value);
            return /^[A-Z0-9.-]+$/i.test(text) ? `${key}=${text}` : `${key}="${text}"`;
        })
        .join(',');
}

function parseByterangeSpec(input = '') {
    const text = String(input || '').trim();
    if (!text) return null;
    const [lengthPart, offsetPart] = text.split('@');
    const length = Number.parseInt(lengthPart, 10);
    if (!Number.isFinite(length) || length <= 0) return null;
    const offset = offsetPart == null ? null : Number.parseInt(offsetPart, 10);
    return {
        length,
        offset: Number.isFinite(offset) && offset >= 0 ? offset : null,
        raw: text
    };
}

function parseHlsMasterManifest(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/);
    const variants = [];
    let pendingAttrs = null;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            pendingAttrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
            continue;
        }
        if (!line.startsWith('#') && pendingAttrs) {
            const url = absolutizePlaylistUrl(line, baseUrl);
            if (url) {
                const bandwidth = Number.parseInt(pendingAttrs.BANDWIDTH || '0', 10) || 0;
                const average = Number.parseInt(pendingAttrs['AVERAGE-BANDWIDTH'] || '0', 10) || 0;
                variants.push({
                    url,
                    bandwidth: average || bandwidth,
                    resolution: pendingAttrs.RESOLUTION || ''
                });
            }
            pendingAttrs = null;
        }
    }
    return variants;
}

function parseHlsMediaManifest(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/);
    let version = 6;
    let targetDuration = 6;
    let mediaSequence = 0;
    let hasEndList = false;
    let currentKey = null;
    let currentMap = null;
    let pendingDuration = null;
    let pendingByterange = null;
    let pendingDiscontinuity = false;
    const segments = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-VERSION:')) {
            version = Number.parseInt(line.split(':')[1], 10) || version;
            continue;
        }
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = Number.parseFloat(line.split(':')[1]) || targetDuration;
            continue;
        }
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            mediaSequence = Number.parseInt(line.split(':')[1], 10) || mediaSequence;
            continue;
        }
        if (line === '#EXT-X-ENDLIST') {
            hasEndList = true;
            continue;
        }
        if (line.startsWith('#EXT-X-KEY:')) {
            const attrs = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
            currentKey = {
                attrs,
                uri: attrs.URI ? absolutizePlaylistUrl(attrs.URI, baseUrl) : ''
            };
            continue;
        }
        if (line.startsWith('#EXT-X-MAP:')) {
            const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
            currentMap = {
                attrs,
                uri: attrs.URI ? absolutizePlaylistUrl(attrs.URI, baseUrl) : '',
                byterange: parseByterangeSpec(attrs.BYTERANGE || '')
            };
            continue;
        }
        if (line.startsWith('#EXTINF:')) {
            pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
            continue;
        }
        if (line.startsWith('#EXT-X-BYTERANGE:')) {
            pendingByterange = parseByterangeSpec(line.slice('#EXT-X-BYTERANGE:'.length));
            continue;
        }
        if (line === '#EXT-X-DISCONTINUITY') {
            pendingDiscontinuity = true;
            continue;
        }
        if (line.startsWith('#')) continue;

        const url = absolutizePlaylistUrl(line, baseUrl);
        if (!url) continue;
        const sequence = mediaSequence + segments.length;
        segments.push({
            url,
            sequence,
            duration: pendingDuration || 0,
            byterange: pendingByterange,
            discontinuity: pendingDiscontinuity,
            key: currentKey ? {
                attrs: { ...currentKey.attrs },
                uri: currentKey.uri
            } : null,
            map: currentMap ? {
                attrs: { ...currentMap.attrs },
                uri: currentMap.uri,
                byterange: currentMap.byterange ? { ...currentMap.byterange } : null
            } : null
        });
        pendingDuration = null;
        pendingByterange = null;
        pendingDiscontinuity = false;
    }

    return {
        version,
        targetDuration,
        mediaSequence,
        isLive: !hasEndList,
        segments
    };
}

function chooseHlsPreviewWindow(parsed) {
    const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
    if (!segments.length) return null;

    const isLive = !!parsed.isLive;
    const targetIndex = isLive ? Math.max(segments.length - 1, 0) : Math.floor(segments.length / 2);
    const desiredDuration = 12;
    let start = targetIndex;
    let end = targetIndex;
    let total = Number(segments[targetIndex]?.duration || 0);
    let toggle = false;

    while (total < desiredDuration && (start > 0 || end < segments.length - 1)) {
        if (isLive) {
            if (start > 0) {
                start -= 1;
                total += Number(segments[start]?.duration || 0);
                continue;
            }
            if (end < segments.length - 1) {
                end += 1;
                total += Number(segments[end]?.duration || 0);
            }
            continue;
        }
        if ((!toggle && start > 0) || end >= segments.length - 1) {
            start -= 1;
            total += Number(segments[start]?.duration || 0);
        } else if (end < segments.length - 1) {
            end += 1;
            total += Number(segments[end]?.duration || 0);
        }
        toggle = !toggle;
    }

    const windowSegments = segments.slice(start, end + 1);
    const durationBeforeTarget = windowSegments
        .slice(0, Math.max(0, targetIndex - start))
        .reduce((sum, segment) => sum + Number(segment?.duration || 0), 0);
    const targetSegment = segments[targetIndex];
    const targetDuration = Math.max(Number(targetSegment?.duration || 0), 0.8);
    const targetWithinSegment = isLive
        ? Math.min(Math.max(targetDuration * 0.35, 0.2), Math.max(targetDuration - 0.15, 0.2))
        : Math.min(Math.max(targetDuration * 0.55, 0.4), Math.max(targetDuration - 0.2, 0.4));

    return {
        isLive,
        startIndex: start,
        targetIndex,
        mediaSequence: windowSegments[0]?.sequence ?? parsed.mediaSequence,
        targetTime: durationBeforeTarget + targetWithinSegment,
        segments: windowSegments
    };
}

function createPreviewFetchOptions(referer = '', extra = {}) {
    const init = {
        cache: 'no-store',
        credentials: 'include',
        ...extra
    };
    if (referer) {
        init.referrer = referer;
        init.referrerPolicy = 'unsafe-url';
    }
    return init;
}

async function fetchPreviewResource(url, {
    referer = '',
    responseType = 'text',
    byterange = null,
    tabId = 0
} = {}) {
    const absoluteUrl = String(url || '');
    if (!absoluteUrl) {
        throw new Error('fetch-resource-missing-url');
    }

    if (tabId > 0) {
        const response = await chrome.runtime.sendMessage({
            action: 'fetchPreviewResource',
            tabId,
            url: absoluteUrl,
            responseType,
            byterange
        });
        if (!response?.ok) {
            const status = Number(response?.status || 0);
            const error = new Error(`fetch-resource-${status || 'page-failed'}`);
            error.fetchStatus = status;
            error.fetchUrl = response?.url || absoluteUrl;
            error.fetchDetail = response?.error || '';
            throw error;
        }
        return {
            status: Number(response.status || 200),
            url: response.url || absoluteUrl,
            data: responseType === 'arrayBuffer'
                ? new Uint8Array(response.bytes || []).buffer
                : String(response.text || '')
        };
    }

    const headers = new Headers();
    if (byterange?.length) {
        const start = Number(byterange.offset || 0);
        const end = start + Number(byterange.length) - 1;
        headers.set('Range', `bytes=${start}-${end}`);
    }
    const response = await fetch(absoluteUrl, createPreviewFetchOptions(referer, {
        method: 'GET',
        headers
    }));
    if (!response.ok && response.status !== 206) {
        const error = new Error(`fetch-resource-${response.status}`);
        error.fetchStatus = Number(response.status || 0);
        error.fetchUrl = response.url || absoluteUrl;
        error.fetchDetail = response.statusText || '';
        throw error;
    }
    return {
        status: Number(response.status || 200),
        url: response.url || absoluteUrl,
        data: responseType === 'arrayBuffer'
            ? await response.arrayBuffer()
            : await response.text()
    };
}

async function fetchResourceArrayBuffer(url, referer = '', byterange = null, tabId = 0) {
    const result = await fetchPreviewResource(url, {
        referer,
        responseType: 'arrayBuffer',
        byterange,
        tabId
    });
    return result.data;
}

async function fetchResourceText(url, referer = '', tabId = 0) {
    const result = await fetchPreviewResource(url, {
        referer,
        responseType: 'text',
        tabId
    });
    return {
        text: String(result.data || ''),
        status: Number(result.status || 0),
        url: result.url || String(url || '')
    };
}

async function stagePreviewResource(url, referer = '', byterange = null, type = '', tabId = 0) {
    const buffer = await fetchResourceArrayBuffer(url, referer, byterange, tabId);
    const blob = type ? new Blob([buffer], { type }) : new Blob([buffer]);
    return URL.createObjectURL(blob);
}

async function buildCompactPreviewPlaylist(sourceUrl, referer = '', debug = null, tabId = 0) {
    let sourceText = '';
    try {
        const sourceResponse = await fetchResourceText(sourceUrl, referer, tabId);
        sourceText = sourceResponse.text;
    } catch (error) {
        throw makePreviewStageError(error?.message || 'fetch-manifest-failed', 'manifest-fetch-error', {
            sourceUrl,
            status: Number(error?.fetchStatus || 0),
            finalUrl: error?.fetchUrl || sourceUrl,
            detail: error?.fetchDetail || ''
        });
    }
    pushPreviewDebugStage(debug, 'manifest-fetch-ok', {
        sourceUrl,
        textLength: sourceText.length
    });

    const variantUrls = parseHlsMasterManifest(sourceText, sourceUrl);
    pushPreviewDebugStage(debug, 'master-parse-ok', {
        variantCount: variantUrls.length
    });
    const mediaUrl = variantUrls.length
        ? variantUrls.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]?.url || sourceUrl
        : sourceUrl;

    let mediaText = sourceText;
    if (mediaUrl !== sourceUrl) {
        try {
            const mediaResponse = await fetchResourceText(mediaUrl, referer, tabId);
            mediaText = mediaResponse.text;
        } catch (error) {
            throw makePreviewStageError(error?.message || 'fetch-media-failed', 'media-fetch-error', {
                mediaUrl,
                status: Number(error?.fetchStatus || 0),
                finalUrl: error?.fetchUrl || mediaUrl,
                detail: error?.fetchDetail || ''
            });
        }
    }
    pushPreviewDebugStage(debug, 'media-fetch-ok', {
        mediaUrl,
        reusedSourceManifest: mediaUrl === sourceUrl,
        textLength: mediaText.length
    });

    const parsed = parseHlsMediaManifest(mediaText, mediaUrl);
    pushPreviewDebugStage(debug, 'media-parse-ok', {
        mediaUrl,
        segmentCount: Array.isArray(parsed?.segments) ? parsed.segments.length : 0,
        isLive: !!parsed?.isLive,
        targetDuration: roundPreviewNumber(parsed?.targetDuration || 0)
    });
    const selection = chooseHlsPreviewWindow(parsed);
    if (!selection || !selection.segments.length) {
        throw makePreviewStageError('preview-window-empty', 'compact-build-error', {
            mediaUrl,
            segmentCount: Array.isArray(parsed?.segments) ? parsed.segments.length : 0
        });
    }

    const cleanup = new Set();
    const resourceCache = new Map();

    async function localize(url, byterange = null, type = '') {
        const key = `${url}|${byterange?.raw || ''}|${type}`;
        if (resourceCache.has(key)) return resourceCache.get(key);
        try {
            const blobUrl = await stagePreviewResource(url, referer, byterange, type, tabId);
            cleanup.add(blobUrl);
            resourceCache.set(key, blobUrl);
            return blobUrl;
        } catch (error) {
            throw makePreviewStageError(
                error?.message || 'resource-stage-failed',
                'resource-stage-error',
                {
                    url,
                    type,
                    byterange: byterange?.raw || '',
                    cause: error?.message || '',
                    status: Number(error?.fetchStatus || 0),
                    finalUrl: error?.fetchUrl || url,
                    detail: error?.fetchDetail || ''
                }
            );
        }
    }

    const lines = [
        '#EXTM3U',
        `#EXT-X-VERSION:${Math.max(parsed.version || 6, 3)}`,
        `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(parsed.targetDuration || 6))}`,
        `#EXT-X-MEDIA-SEQUENCE:${selection.mediaSequence}`
    ];

    let lastKeyLine = '';
    let lastMapLine = '';
    for (const segment of selection.segments) {
        if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
        if (segment.key?.uri) {
            const keyUrl = await localize(segment.key.uri);
            const keyLine = makeKeyLine(segment.key, keyUrl);
            if (keyLine && keyLine !== lastKeyLine) {
                lines.push(keyLine);
                lastKeyLine = keyLine;
            }
        }
        if (segment.map?.uri) {
            const mapUrl = await localize(segment.map.uri, segment.map.byterange, 'video/mp4');
            const mapLine = makeMapLine(segment.map, mapUrl);
            if (mapLine && mapLine !== lastMapLine) {
                lines.push(mapLine);
                lastMapLine = mapLine;
            }
        }
        const segmentUrl = await localize(segment.url, segment.byterange);
        lines.push(`#EXTINF:${Number(segment.duration || parsed.targetDuration || 1).toFixed(3)},`);
        lines.push(segmentUrl);
    }
    lines.push('#EXT-X-ENDLIST');

    const playlistBlob = new Blob([lines.join('\n')], { type: 'application/vnd.apple.mpegurl' });
    const playlistUrl = URL.createObjectURL(playlistBlob);
    cleanup.add(playlistUrl);

    return {
        manifestUrl: playlistUrl,
        cleanupUrls: Array.from(cleanup),
        targetTime: Math.max(0, selection.targetTime || 0),
        totalDuration: selection.segments.reduce((sum, segment) => sum + Number(segment?.duration || 0), 0),
        selectedSegments: selection.segments.length,
        variantCount: variantUrls.length,
        mediaUrl
    };
}

function makeKeyLine(key, uri) {
    if (!key?.attrs) return '';
    return `#EXT-X-KEY:${stringifyAttributeList({ ...key.attrs, URI: uri })}`;
}

function makeMapLine(map, uri) {
    if (!map?.attrs) return '';
    const attrs = { ...map.attrs, URI: uri };
    delete attrs.BYTERANGE;
    return `#EXT-X-MAP:${stringifyAttributeList(attrs)}`;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    // ── 청크 수신 → OPFS에 직접 쓰기 ──
    if (msg.action === 'offscreen-chunk') {
        const { taskId, bytes } = msg;
        if (!bytes?.length) { sendResponse({ ok: true }); return false; }
        const buf = new Uint8Array(bytes).buffer;
        handleChunk(taskId, buf)
            .then(() => sendResponse({ ok: true }))
            .catch(e => {
                console.error('[Offscreen] 청크 쓰기 오류:', e);
                sendResponse({ ok: false, error: e.message });
            });
        return true;
    }

    // ── 모든 청크 완료 → 파일 닫기 → Blob URL 생성 ──
    if (msg.action === 'offscreen-buildBlob') {
        const { taskId, fileName, containerExt } = msg;
        finalize(taskId, fileName, containerExt).catch(e => {
            console.error('[Offscreen] 완료 처리 오류:', e);
            chrome.runtime.sendMessage({ action: 'offscreen-error', taskId, error: e.message });
        });
        sendResponse({ ok: true });
        return false;
    }

    // ── 취소 ──
    if (msg.action === 'offscreen-cancel') {
        cancelTask(msg.taskId);
        sendResponse({ ok: true });
        return false;
    }

    if (msg.action === 'offscreen-generatePreview') {
        const key = `${msg.type || 'hls'}|${msg.url || ''}|${Math.floor(Number(msg.duration || 0))}`;
        const existing = previewJobs.get(key);
        const job = existing || withPreviewTimeout(generatePreviewAsset(msg)).finally(() => previewJobs.delete(key));
        previewJobs.set(key, job);
        job.then(
            (result) => sendResponse({ ok: true, ...result }),
            (error) => sendResponse({
                ok: false,
                error: error?.message || String(error || 'preview failed'),
                debug: error?.previewDebug || null
            })
        );
        return true;
    }

    return false;
});

async function handleChunk(taskId, buf) {
    if (!writers[taskId]) {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(`${taskId}.media`, { create: true });
        writers[taskId] = await fh.createWritable({ keepExistingData: false });
        console.log(`[Offscreen] OPFS 열림: ${taskId}.media`);
    }
    await writers[taskId].write(buf);
}

function normalizeContainerExt(ext) {
    return String(ext || '').replace(/^\./, '').toLowerCase() === 'mp4' ? 'mp4' : 'ts';
}

function replaceExtension(fileName, ext = 'ts') {
    const safeExt = normalizeContainerExt(ext);
    const base = String(fileName || 'video.ts').replace(/\.[^.\\/]+$/, '');
    return `${base}.${safeExt}`;
}

async function finalize(taskId, fileName, containerExt = 'ts') {
    const writable = writers[taskId];
    if (!writable) throw new Error(`태스크 없음: ${taskId}`);

    await writable.close();
    delete writers[taskId];

    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(`${taskId}.media`);
    const file = await fh.getFile();

    if (file.size === 0) throw new Error('파일이 비어있음');
    const normalizedExt = normalizeContainerExt(containerExt);
    const finalFileName = replaceExtension(fileName, normalizedExt);
    console.log(`[Offscreen] 완성: ${(file.size / 1024 / 1024).toFixed(2)} MB — ${finalFileName}`);

    const mime = normalizedExt === 'mp4' ? 'video/mp4' : 'video/mp2t';
    const blobUrl = URL.createObjectURL(file.slice(0, file.size, mime));

    chrome.runtime.sendMessage({ action: 'offscreen-blobReady', taskId, blobUrl, fileName: finalFileName });

    setTimeout(async () => {
        try {
            URL.revokeObjectURL(blobUrl);
            const r = await navigator.storage.getDirectory();
            await r.removeEntry(`${taskId}.media`).catch(() => {});
        } catch (e) {
            console.warn('[Offscreen] 정리 실패:', e);
        }
    }, 180_000);
}

async function cancelTask(taskId) {
    if (writers[taskId]) {
        try { await writers[taskId].abort(); } catch {}
        delete writers[taskId];
    }
    const root = await navigator.storage.getDirectory().catch(() => null);
    if (!root) return;
    await root.removeEntry(`${taskId}.media`).catch(() => {});
}

function createPreviewVideoHost() {
    const host = document.createElement('div');
    host.style.cssText = [
        'position:fixed',
        'left:0',
        'top:0',
        'width:320px',
        'height:180px',
        'opacity:1',
        'pointer-events:none',
        'z-index:0',
        'overflow:hidden',
        'contain:layout style paint',
    ].join(';');

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.autoplay = true;
    video.style.cssText = 'width:320px;height:180px;object-fit:cover;background:#000;';
    host.appendChild(video);

    (document.documentElement || document.body || document.head).appendChild(host);
    return { host, video };
}

function waitForVideoReady(video, timeoutMs = 15000) {
    return new Promise((resolve) => {
        if (!(video instanceof HTMLVideoElement)) {
            resolve(false);
            return;
        }
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
            resolve(true);
            return;
        }
        let settled = false;
        let timer = 0;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            video.removeEventListener('loadeddata', onReady);
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('playing', onReady);
            video.removeEventListener('error', onError);
            resolve(!!ok);
        };
        const onReady = () => {
            if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish(true);
        };
        const onError = () => finish(false);
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('canplay', onReady);
        video.addEventListener('playing', onReady);
        video.addEventListener('error', onError);
        timer = setTimeout(() => finish(video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0), timeoutMs);
    });
}

function resetPreviewVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    try { video.pause(); } catch {}
    try {
        video.removeAttribute('src');
        video.load();
    } catch {}
}

class CredentialedFetchLoader {
    constructor(config = {}) {
        this.config = config || {};
        this.controller = null;
    }

    destroy() {
        this.abort();
    }

    abort() {
        if (!this.controller) return;
        try { this.controller.abort(); } catch {}
        this.controller = null;
    }

    load(context, _config, callbacks) {
        this.abort();

        const stats = {
            aborted: false,
            loaded: 0,
            retry: 0,
            total: 0,
            chunkCount: 0,
            loading: {
                start: performance.now(),
                first: 0,
                end: 0
            }
        };

        const headers = new Headers();
        const rangeStart = Number(context?.rangeStart);
        const rangeEnd = Number(context?.rangeEnd);
        if (Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd >= rangeStart) {
            headers.set('Range', `bytes=${rangeStart}-${rangeEnd - 1}`);
        }

        this.controller = new AbortController();
        fetch(context.url, createPreviewFetchOptions(this.config.referrer || '', {
            method: 'GET',
            headers,
            signal: this.controller.signal
        })).then(async (response) => {
            if (!response.ok && response.status !== 206) {
                callbacks.onError?.({
                    code: response.status,
                    text: response.statusText || `HTTP Error ${response.status}`
                }, context, response, stats);
                return;
            }

            stats.loading.first = performance.now();
            const wantsArrayBuffer = context?.responseType === 'arraybuffer';
            const data = wantsArrayBuffer
                ? await response.arrayBuffer()
                : await response.text();
            stats.loaded = wantsArrayBuffer ? data.byteLength : data.length;
            stats.total = stats.loaded;
            stats.loading.end = performance.now();

            callbacks.onSuccess?.({
                url: response.url || context.url,
                data,
                code: response.status
            }, stats, context, response);
        }).catch((error) => {
            if (error?.name === 'AbortError') {
                stats.aborted = true;
                return;
            }
            callbacks.onError?.({
                code: 0,
                text: error?.message || 'fetch failed'
            }, context, null, stats);
        });
    }
}

function createCredentialedFetchLoader(referrer = '') {
    const boundReferrer = String(referrer || '');
    return class BoundCredentialedFetchLoader extends CredentialedFetchLoader {
        constructor(config = {}) {
            super({
                ...config,
                referrer: boundReferrer
            });
        }
    };
}

async function attachHlsToPreviewVideo(video, manifestUrl, referer = '', debug = null) {
    const absoluteUrl = String(manifestUrl || '');
    if (!(video instanceof HTMLVideoElement) || !absoluteUrl) {
        return { ok: false, hls: null, method: 'invalid-input', error: 'invalid-input' };
    }

    let hls = null;
    let hlsError = '';
    let hlsErrorDetail = '';
    try {
        if (typeof Hls === 'function' && (typeof Hls.isSupported !== 'function' || Hls.isSupported())) {
            const usesBlobManifest = absoluteUrl.startsWith('blob:');
            const hlsConfig = {
                autoStartLoad: true,
                enableWorker: false,
                lowLatencyMode: false,
                startPosition: -1,
            };
            if (!usesBlobManifest) {
                hlsConfig.loader = createCredentialedFetchLoader(referer);
            }
            hls = new Hls(hlsConfig);
            const events = Hls.Events || {};
            if (events.ERROR) {
                hls.on(events.ERROR, (_evt, data) => {
                    hlsError = String(data?.details || data?.type || 'hls-error');
                    hlsErrorDetail = [
                        data?.type || '',
                        data?.details || '',
                        data?.response?.code || '',
                        data?.error?.message || ''
                    ].filter(Boolean).join(' / ');
                    if (data?.fatal) {
                        try { hls?.destroy?.(); } catch {}
                    }
                });
            }
            if (events.MANIFEST_PARSED) {
                hls.on(events.MANIFEST_PARSED, (_evt, data) => {
                    pushPreviewDebugStage(debug, 'manifest-parsed', {
                        levels: Array.isArray(data?.levels) ? data.levels.length : 0,
                        manifestScheme: usesBlobManifest ? 'blob' : 'remote'
                    });
                });
            }
            const readyPromise = waitForVideoReady(video);
            if (events.MEDIA_ATTACHED) {
                hls.on(events.MEDIA_ATTACHED, () => {
                    try {
                        hls.loadSource(absoluteUrl);
                    } catch {}
                });
            } else {
                try {
                    hls.loadSource(absoluteUrl);
                } catch {}
            }
            hls.attachMedia(video);
            try { video.play().catch(() => {}); } catch {}
            const ok = await readyPromise;
            return {
                ok,
                hls,
                method: usesBlobManifest ? 'hls.js-blob' : 'hls.js',
                error: ok ? '' : (hlsError || 'ready-timeout'),
                errorDetail: hlsErrorDetail || hlsError || ''
            };
        }
    } catch {
        try { hls?.destroy?.(); } catch {}
        hls = null;
    }

    try {
        video.src = absoluteUrl;
        video.load();
        try { video.play().catch(() => {}); } catch {}
        const ok = await waitForVideoReady(video);
        return { ok, hls: null, method: 'native-video-src', error: ok ? '' : 'ready-timeout', errorDetail: ok ? '' : 'native-video-src / ready-timeout' };
    } catch {
        return { ok: false, hls: null, method: 'native-video-src', error: 'native-load-failed', errorDetail: 'native-video-src / native-load-failed' };
    }
}

function blobToDataUrl(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
    });
}

function drawVideoContain(ctx, video, width, height) {
    const sourceWidth = Number(video?.videoWidth || 0);
    const sourceHeight = Number(video?.videoHeight || 0);
    if (!ctx || !sourceWidth || !sourceHeight || !width || !height) return false;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
    const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
    const dx = Math.round((width - drawWidth) / 2);
    const dy = Math.round((height - drawHeight) / 2);
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(video, dx, dy, drawWidth, drawHeight);
    return true;
}

function sampleCanvasSignature(ctx, width, height) {
    try {
        const { data } = ctx.getImageData(0, 0, width, height);
        const signature = [];
        for (let y = 8; y < height; y += 18) {
            for (let x = 8; x < width; x += 20) {
                const idx = ((y * width) + x) * 4;
                signature.push(Math.round((data[idx] * 0.299) + (data[idx + 1] * 0.587) + (data[idx + 2] * 0.114)));
            }
        }
        return signature;
    } catch {
        return [];
    }
}

function signatureDistance(a = [], b = []) {
    const count = Math.min(a.length, b.length);
    if (!count) return 0;
    let total = 0;
    for (let i = 0; i < count; i += 1) total += Math.abs(a[i] - b[i]);
    return total / count;
}

function captureVideoFrame(video) {
    try {
        if (!(video instanceof HTMLVideoElement)) return '';
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return '';
        if (!drawVideoContain(ctx, video, canvas.width, canvas.height)) return '';
        return canvas.toDataURL('image/jpeg', 0.82);
    } catch {
        return '';
    }
}

function pickPreviewRecorderMimeType() {
    const candidates = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
    ];
    for (const mime of candidates) {
        try {
            if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(mime)) return mime;
        } catch {}
    }
    return '';
}

async function probeVideoPreviewClip(video) {
    if (!(video instanceof HTMLVideoElement)) return '';
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
    if (typeof MediaRecorder === 'undefined') return '';

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
        const stream = canvas.captureStream(frameRate);
        const chunks = [];
        let stopped = false;
        let drawTimer = 0;
        let drawnFrames = 0;
        let changedFrames = 0;
        let firstMediaTime = NaN;
        let lastMediaTime = NaN;
        let lastSignature = [];

        const cleanup = () => {
            if (drawTimer) clearInterval(drawTimer);
            try { stream.getTracks().forEach(track => track.stop()); } catch {}
            try { video.playbackRate = originalPlaybackRate; } catch {}
        };
        const draw = () => {
            if (stopped) return;
            try {
                if (!drawVideoContain(ctx, video, canvas.width, canvas.height)) return;
                const currentTime = Number(video.currentTime || 0);
                if (!Number.isFinite(firstMediaTime)) firstMediaTime = currentTime;
                lastMediaTime = currentTime;
                const signature = sampleCanvasSignature(ctx, canvas.width, canvas.height);
                if (lastSignature.length && signatureDistance(lastSignature, signature) > 3.5) {
                    changedFrames += 1;
                }
                lastSignature = signature;
            } catch {}
            drawnFrames += 1;
        };

        let recorder;
        try {
            recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 420000 });
        } catch {
            cleanup();
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
                const elapsedMediaTime = Number.isFinite(firstMediaTime) && Number.isFinite(lastMediaTime)
                    ? Math.max(0, lastMediaTime - firstMediaTime)
                    : 0;
                if (blob.size < 1024 || drawnFrames < 8 || changedFrames < 2 || elapsedMediaTime < 0.25) {
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

function getRepresentativeTime(duration) {
    const value = Number(duration || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value <= 30) return Math.max(1.2, Math.min(value - 0.4, value * 0.35));
    return Math.max(2.5, Math.min(value - 0.8, value * 0.55));
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
            if (video.currentTime >= targetTime || video.paused || video.ended) finish();
        };
        video.addEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('seeked', onTimeUpdate);
        timer = setTimeout(finish, timeoutMs);
    });
}

async function generateHlsPreview({ url, duration = 0, referer = '', tabId = 0, itemUrl = '' }) {
    const absoluteUrl = String(url || '');
    const debug = createPreviewDebug('hls', {
        url: absoluteUrl,
        duration,
        tabId: Number(tabId || 0),
        itemUrl: String(itemUrl || absoluteUrl)
    });
    pushPreviewDebugStage(debug, 'job-start');
    if (!absoluteUrl) {
        pushPreviewDebugStage(debug, 'init-error', { error: 'missing-url' });
        return {
            thumbnail: '',
            previewUrl: '',
            source: 'offscreen-preview',
            debug: finalizePreviewDebug(debug, 'error', {
                failedStage: 'init-error',
                error: 'missing-url',
                output: { thumbnail: false, preview: false }
            })
        };
    }

    const { host, video } = createPreviewVideoHost();
    let hls = null;
    let cleanupUrls = [];
    try {
        let previewSourceUrl = absoluteUrl;
        let targetTime = 0;
        let compactInfo = null;
        try {
            compactInfo = await buildCompactPreviewPlaylist(absoluteUrl, referer, debug, Number(tabId || 0));
            const compact = compactInfo;
            previewSourceUrl = compact.manifestUrl || absoluteUrl;
            cleanupUrls = compact.cleanupUrls || [];
            targetTime = Math.max(0, Number(compact.targetTime || 0));
            pushPreviewDebugStage(debug, 'compact-build-ok', {
                mediaUrl: compact.mediaUrl || absoluteUrl,
                variantCount: Number(compact.variantCount || 0),
                selectedSegments: Number(compact.selectedSegments || 0),
                targetTime: roundPreviewNumber(targetTime),
                totalDuration: roundPreviewNumber(compact.totalDuration || 0)
            });
        } catch (error) {
            pushPreviewDebugStage(debug, 'compact-build-error', {
                failedStage: error?.previewStage || 'compact-build-error',
                error: error?.message || String(error || 'compact-build-failed'),
                ...sanitizePreviewDebugDetails(error?.previewDetails || {})
            });
            return {
                thumbnail: '',
                previewUrl: '',
                source: 'offscreen-preview',
                debug: finalizePreviewDebug(debug, 'empty', {
                    failedStage: error?.previewStage || 'compact-build-error',
                    previewSource: 'compact-playlist',
                    error: error?.message || String(error || 'compact-build-failed'),
                    ...sanitizePreviewDebugDetails(error?.previewDetails || {}),
                    output: { thumbnail: false, preview: false }
                })
            };
        }

        pushPreviewDebugStage(debug, 'attach-start', {
            previewSource: compactInfo ? 'compact-playlist' : 'original-manifest'
        });
        const attachment = await attachHlsToPreviewVideo(video, previewSourceUrl, referer, debug);
        hls = attachment.hls;
        if (!attachment.ok) {
            pushPreviewDebugStage(debug, 'attach-error', {
                method: attachment.method || '',
                error: attachment.error || 'attach-failed',
                errorDetail: attachment.errorDetail || '',
                ...getVideoSnapshot(video)
            });
            return {
                thumbnail: '',
                previewUrl: '',
                source: 'offscreen-preview',
            debug: finalizePreviewDebug(debug, 'empty', {
                failedStage: 'attach-error',
                attachMethod: attachment.method || '',
                previewSource: compactInfo ? 'compact-playlist' : 'original-manifest',
                errorDetail: attachment.errorDetail || attachment.error || '',
                output: { thumbnail: false, preview: false }
            })
        };
        }
        pushPreviewDebugStage(debug, 'attach-ok', {
            method: attachment.method || '',
            ...getVideoSnapshot(video)
        });

        const durationHint = Number(duration || 0);
        const knownDuration = Number(video.duration || 0);
        const effectiveTargetTime = targetTime > 0
            ? Math.min(targetTime, Math.max((knownDuration || durationHint) - 0.15, 0))
            : getRepresentativeTime(knownDuration || durationHint);

        try {
            video.muted = true;
            try { video.pause(); } catch {}
            if (effectiveTargetTime > 0.05 && Number.isFinite(knownDuration || durationHint) && (knownDuration || durationHint) > effectiveTargetTime) {
                await waitForSeek(video, effectiveTargetTime);
                pushPreviewDebugStage(debug, 'seek-ok', {
                    targetTime: roundPreviewNumber(effectiveTargetTime),
                    duration: roundPreviewNumber(knownDuration || durationHint),
                    currentTime: roundPreviewNumber(video.currentTime || 0)
                });
            } else {
                pushPreviewDebugStage(debug, 'seek-skip', {
                    targetTime: roundPreviewNumber(effectiveTargetTime),
                    duration: roundPreviewNumber(knownDuration || durationHint)
                });
            }
        } catch (error) {
            pushPreviewDebugStage(debug, 'seek-error', {
                targetTime: roundPreviewNumber(effectiveTargetTime),
                error: error?.message || String(error || 'seek-failed')
            });
        }

        let thumbnail = captureVideoFrame(video);
        if (thumbnail) {
            pushPreviewDebugStage(debug, 'frame-ok', {
                currentTime: roundPreviewNumber(video.currentTime || 0)
            });
        } else {
            pushPreviewDebugStage(debug, 'frame-empty', {
                ...getVideoSnapshot(video)
            });
        }
        let previewUrl = '';
        try {
            await video.play();
            pushPreviewDebugStage(debug, 'play-ok', {
                currentTime: roundPreviewNumber(video.currentTime || 0)
            });
        } catch (error) {
            pushPreviewDebugStage(debug, 'play-error', {
                error: error?.message || String(error || 'play-failed')
            });
        }
        const previewMoment = Number.isFinite(knownDuration) && knownDuration > 0
            ? Math.min(effectiveTargetTime + 0.7, Math.max(knownDuration - 0.08, effectiveTargetTime))
            : effectiveTargetTime + 0.7;
        await waitForPreviewMoment(video, previewMoment, 1600);
        previewUrl = await probeVideoPreviewClip(video);
        if (previewUrl) {
            pushPreviewDebugStage(debug, 'clip-ok', {
                currentTime: roundPreviewNumber(video.currentTime || 0)
            });
        } else {
            pushPreviewDebugStage(debug, 'clip-empty', {
                mediaRecorderAvailable: typeof MediaRecorder !== 'undefined'
            });
        }
        if (!thumbnail) {
            thumbnail = captureVideoFrame(video);
            if (thumbnail) {
                pushPreviewDebugStage(debug, 'frame-ok', {
                    currentTime: roundPreviewNumber(video.currentTime || 0),
                    recoveredAfterPlay: true
                });
            }
        }
        try { video.pause(); } catch {}
        return {
            thumbnail,
            previewUrl,
            source: 'offscreen-preview',
            debug: finalizePreviewDebug(debug, (thumbnail || previewUrl) ? 'ok' : 'empty', {
                attachMethod: attachment.method || '',
                previewSource: compactInfo ? 'compact-playlist' : 'original-manifest',
                targetTime: roundPreviewNumber(effectiveTargetTime),
                output: {
                    thumbnail: !!thumbnail,
                    preview: !!previewUrl
                },
                finalVideo: getVideoSnapshot(video)
            })
        };
    } catch (error) {
        pushPreviewDebugStage(debug, error?.previewStage || 'unexpected-error', {
            ...sanitizePreviewDebugDetails(error?.previewDetails || {}),
            error: error?.message || String(error || 'preview-failed')
        });
        error.previewDebug = finalizePreviewDebug(debug, 'error', {
            failedStage: error?.previewStage || debug.stage || 'unexpected-error',
            error: error?.message || String(error || 'preview-failed'),
            output: { thumbnail: false, preview: false }
        });
        throw error;
    } finally {
        try { hls?.destroy?.(); } catch {}
        resetPreviewVideo(video);
        try { host.remove(); } catch {}
        for (const resourceUrl of cleanupUrls) {
            try { URL.revokeObjectURL(resourceUrl); } catch {}
        }
    }
}

async function generatePreviewAsset(msg) {
    if (msg.type === 'hls') {
        return await generateHlsPreview(msg);
    }
    return { thumbnail: '', previewUrl: '', source: '' };
}

console.log('[Offscreen] 초기화 완료 — OPFS 스트리밍 저장소');
