(() => {
    const RAW_BUILD_VARIANT = '__BUILD_VARIANT__';
    const RAW_ENABLE_YOUTUBE_DETECTION = '__ENABLE_YOUTUBE_DETECTION__';
    const RAW_ENABLE_YOUTUBE_DOWNLOAD = '__ENABLE_YOUTUBE_DOWNLOAD__';
    const RAW_ENABLE_YOUTUBE_LIVE_RECORD = '__ENABLE_YOUTUBE_LIVE_RECORD__';

    function resolveBuildVariant(value) {
        const raw = String(value || '').trim();
        return raw && !raw.startsWith('__') ? raw : 'full';
    }

    function resolveBuildBool(value, fallback) {
        const raw = String(value || '').trim();
        if (!raw || raw.startsWith('__')) return !!fallback;
        return raw === 'true';
    }

    const buildVariant = resolveBuildVariant(RAW_BUILD_VARIANT);
    const flags = Object.freeze({
        enableYouTubeDetection: resolveBuildBool(RAW_ENABLE_YOUTUBE_DETECTION, true),
        enableYouTubeDownload: resolveBuildBool(RAW_ENABLE_YOUTUBE_DOWNLOAD, true),
        enableYouTubeLiveRecord: resolveBuildBool(RAW_ENABLE_YOUTUBE_LIVE_RECORD, true),
    });

    globalThis.__MEDIANAB_VARIANT__ = Object.freeze({
        buildVariant,
        flags,
        policy: Object.freeze({
            blockedStatus: 'blocked_by_channel_policy',
            blockedMessage: Object.freeze({
                ko: 'Google Web Store 정책으로 인해 이 빌드에서는 YouTube 다운로드/녹화를 지원하지 않습니다. Edge, Firefox 또는 direct build를 사용하세요.',
                en: 'Due to Google Web Store policy, this build does not support YouTube downloads or recording. Use the Edge, Firefox, or direct build.',
            }),
        }),
    });
})();
