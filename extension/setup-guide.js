// setup-guide.js — MediaNab Companion 설치 가이드

console.log('[MediaNab] setup-guide.js loaded');

document.addEventListener('DOMContentLoaded', () => {
    console.log('[MediaNab] DOMContentLoaded fired');

    const extId = chrome.runtime.id || 'unknown';
    document.getElementById('extId').textContent = extId;

    // 브라우저 감지
    const ua = navigator.userAgent;
    let browserName = 'Chrome';
    let extPage = 'chrome://extensions';
    if (ua.includes('Edg/')) { browserName = 'Edge'; extPage = 'edge://extensions'; }
    else if (ua.includes('Brave')) { browserName = 'Brave'; extPage = 'brave://extensions'; }
    else if (ua.includes('Vivaldi')) { browserName = 'Vivaldi'; extPage = 'vivaldi://extensions'; }
    else if (ua.includes('OPR/')) { browserName = 'Opera'; extPage = 'opera://extensions'; }

    const browserInfoEl = document.getElementById('s2BrowserInfo');
    if (browserInfoEl) {
        browserInfoEl.textContent = `${browserName} — ${extPage}`;
    }

    // OS 자동 선택
    const isMac = navigator.platform.includes('Mac');
    const osBtns = document.querySelectorAll('.os-btn');
    if (osBtns.length >= 2) {
        if (!isMac) {
            osBtns[0].classList.remove('active');
            osBtns[1].classList.add('active');
            const osMac = document.getElementById('os-mac');
            const osWin = document.getElementById('os-win');
            if (osMac) osMac.classList.remove('active');
            if (osWin) osWin.classList.add('active');
        }
    }

    // OS 탭 전환
    osBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            osBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.os-content').forEach(c => c.classList.remove('active'));
            const targetOs = document.getElementById(`os-${btn.dataset.os}`);
            if (targetOs) targetOs.classList.add('active');
        });
    });

    // 코드 블록 복사
    document.querySelectorAll('.code-block').forEach(block => {
        block.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(block.textContent);
                block.classList.add('copied');
                setTimeout(() => block.classList.remove('copied'), 2000);
            } catch (e) {
                console.error('Clipboard error:', e);
            }
        });
    });

    // 연결 테스트
    const testBtn = document.getElementById('testBtn');
    console.log('[MediaNab] testBtn element:', testBtn);
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            console.log('[MediaNab] Test button clicked');
            const result = document.getElementById('testResult');
            if (result) {
                result.style.display = 'block';
                result.className = 'test-result';
                result.textContent = 'Testing...';

                chrome.runtime.sendMessage({ action: 'companionCheckStatus' }, (resp) => {
                    if (resp?.status === 'ok') {
                        result.className = 'test-result ok';
                        let msg = `✅ Connected!\n`;
                        msg += `Companion: v${resp.companion_version || '?'}\n`;
                        msg += `Download engine: ${resp.ytdlp_installed ? resp.ytdlp_version : '❌ Not installed'}\n`;
                        msg += `Deno: ${resp.deno_installed ? resp.deno_version : '❌ Not installed'}\n`;
                        msg += `ffmpeg: ${resp.ffmpeg_installed ? '✅' : '❌ Not installed'}\n`;
                        msg += `Download path: ${resp.download_path || '?'}`;
                        result.textContent = msg;
                        result.style.whiteSpace = 'pre-line';
                    } else {
                        result.className = 'test-result fail';
                        result.textContent = `❌ Connection failed.\n${resp?.message || 'Companion not found'}\n\nMake sure you ran the installer and restarted your browser.`;
                        result.style.whiteSpace = 'pre-line';
                    }
                });
            }
        });
    }

    // macOS 설치기 다운로드
    const downloadMacBtn = document.getElementById('downloadMac');
    let macDownloadedPath = null;

    console.log('[MediaNab] downloadMac element:', downloadMacBtn);

    if (downloadMacBtn) {
        downloadMacBtn.addEventListener('click', async () => {
            console.log('[MediaNab] Download button clicked');
            const btn = downloadMacBtn;
            const textEl = document.getElementById('downloadMacText');
            const codeBlockEl = document.getElementById('macCmd');
            btn.disabled = true;
            if (textEl) textEl.textContent = 'Generating...';

            try {
                const pyRes = await fetch(chrome.runtime.getURL('companion/medianab_host.py') + '?t=' + Date.now());
                const pyCode = await pyRes.text();
                const scriptStr = generateMacInstaller(extId, pyCode);
                const blob = new Blob([scriptStr], { type: 'text/x-shellscript' });
                const blobUrl = URL.createObjectURL(blob);

                const downloadId = await new Promise((resolve, reject) => {
                    chrome.downloads.download({
                        url: blobUrl,
                        filename: 'medianab-install.sh',
                        saveAs: false,
                        conflictAction: 'overwrite',
                    }, (id) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(id);
                        }
                    });
                });

                // 다운로드 완료 대기 후 경로 표시
                const downloadItem = await new Promise((resolve) => {
                    const onChanged = (delta) => {
                        if (delta.id === downloadId && delta.state?.current === 'complete') {
                            chrome.downloads.onChanged.removeListener(onChanged);
                            chrome.downloads.search({ id: downloadId }, (results) => {
                                resolve(results[0]);
                            });
                        }
                    };
                    chrome.downloads.onChanged.addListener(onChanged);
                });

                URL.revokeObjectURL(blobUrl);

                macDownloadedPath = downloadItem?.filename || '~/Downloads/medianab-install.sh';
                const cmd = `bash "${macDownloadedPath}"`;

                if (textEl) {
                    textEl.textContent = '✅ Downloaded!';
                    const lang = localStorage.getItem('mn_lang') || 'en';
                    setTimeout(() => {
                        textEl.textContent = lang === 'ko' ? 'macOS 설치기 다운로드' : 'Download macOS Installer';
                    }, 3000);
                }

                // 코드 블록에 명령어 표시
                if (codeBlockEl) {
                    codeBlockEl.style.display = 'block';
                    codeBlockEl.textContent = cmd;
                }

                btn.disabled = false;
            } catch (e) {
                console.error('Download error:', e);
                const textEl = document.getElementById('downloadMacText');
                if (textEl) textEl.textContent = `Error: ${e.message}`;
                btn.disabled = false;
            }
        });
    }

    // macOS 코드 블록 클릭 복사
    const macCodeBlock = document.getElementById('macCmd');
    if (macCodeBlock) {
        macCodeBlock.addEventListener('click', async () => {
            if (!macDownloadedPath) {
                alert('Please download the installer first!');
                return;
            }

            const cmd = `bash "${macDownloadedPath}"`;

            try {
                await navigator.clipboard.writeText(cmd);
                macCodeBlock.classList.add('copied');
                setTimeout(() => macCodeBlock.classList.remove('copied'), 2000);
            } catch (e) {
                console.error('Copy error:', e);
                alert('Failed to copy: ' + e.message);
            }
        });
    }

    // Windows 설치기 다운로드
    const downloadWinBtn = document.getElementById('downloadWin');
    let winDownloadedPath = null;

    console.log('[MediaNab] downloadWin element:', downloadWinBtn);

    if (downloadWinBtn) {
        downloadWinBtn.addEventListener('click', async () => {
            console.log('[MediaNab] Windows Download button clicked');
            const btn = downloadWinBtn;
            const textEl = document.getElementById('downloadWinText');
            const codeBlockEl = document.getElementById('winCmd');
            btn.disabled = true;
            if (textEl) textEl.textContent = 'Generating...';

            try {
                const pyRes = await fetch(chrome.runtime.getURL('companion/medianab_host.py'));
                const pyCode = await pyRes.text();
                const scriptStr = generateWinInstaller(extId, pyCode);
                const blob = new Blob([scriptStr], { type: 'application/x-bat' });
                const blobUrl = URL.createObjectURL(blob);

                const downloadId = await new Promise((resolve, reject) => {
                    chrome.downloads.download({
                        url: blobUrl,
                        filename: 'medianab-install.bat',
                        saveAs: false,
                        conflictAction: 'overwrite',
                    }, (id) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(id);
                        }
                    });
                });

                // 다운로드 완료 대기 후 경로 표시
                const downloadItem = await new Promise((resolve) => {
                    const onChanged = (delta) => {
                        if (delta.id === downloadId && delta.state?.current === 'complete') {
                            chrome.downloads.onChanged.removeListener(onChanged);
                            chrome.downloads.search({ id: downloadId }, (results) => {
                                resolve(results[0]);
                            });
                        }
                    };
                    chrome.downloads.onChanged.addListener(onChanged);
                });

                URL.revokeObjectURL(blobUrl);

                winDownloadedPath = downloadItem?.filename || '%USERPROFILE%\\Downloads\\medianab-install.bat';
                const cmd = winDownloadedPath;

                if (textEl) {
                    textEl.textContent = '✅ Downloaded!';
                    const lang = localStorage.getItem('mn_lang') || 'en';
                    setTimeout(() => {
                        textEl.textContent = lang === 'ko' ? 'Windows 설치기 다운로드' : 'Download Windows Installer';
                    }, 3000);
                }

                // 코드 블록에 명령어 표시
                if (codeBlockEl) {
                    codeBlockEl.style.display = 'block';
                    codeBlockEl.textContent = cmd;
                }

                btn.disabled = false;
            } catch (e) {
                console.error('Download error:', e);
                const textEl = document.getElementById('downloadWinText');
                if (textEl) textEl.textContent = `Error: ${e.message}`;
                btn.disabled = false;
            }
        });
    }

    // Windows 코드 블록 클릭 복사
    const winCodeBlock = document.getElementById('winCmd');
    if (winCodeBlock) {
        winCodeBlock.addEventListener('click', async () => {
            if (!winDownloadedPath) {
                alert('Please download the installer first!');
                return;
            }

            const cmd = winDownloadedPath;

            try {
                await navigator.clipboard.writeText(cmd);
                winCodeBlock.classList.add('copied');
                setTimeout(() => winCodeBlock.classList.remove('copied'), 2000);
            } catch (e) {
                console.error('Copy error:', e);
                alert('Failed to copy: ' + e.message);
            }
        });
    }

    // i18n
    const lang = localStorage.getItem('mn_lang') || 'en';
    const applyI18n = () => {
        if (lang === 'ko') {
            const subtitle = document.getElementById('subtitle');
            if (subtitle) subtitle.textContent = '로컬 저장과 확장 기능을 사용하려면 Companion 앱을 설치하세요.';

            const s1Title = document.getElementById('s1Title');
            if (s1Title) s1Title.textContent = '① Companion 설치';

            const s1MacDesc = document.getElementById('s1MacDesc');
            if (s1MacDesc) s1MacDesc.textContent = '설치기를 다운로드한 후 터미널에서 실행하세요:';

            const copyMacCmdText = document.getElementById('copyMacCmdText');
            if (copyMacCmdText) copyMacCmdText.textContent = '명령어 복사';

            const downloadMacText = document.getElementById('downloadMacText');
            if (downloadMacText) downloadMacText.textContent = 'macOS 설치기 다운로드';

            const s1MacAfter = document.getElementById('s1MacAfter');
            if (s1MacAfter) s1MacAfter.innerHTML = '다운로드 후 아래 명령어를 클릭하여 복사하세요:';

            const downloadWinText = document.getElementById('downloadWinText');
            if (downloadWinText) downloadWinText.textContent = 'Windows 설치기 다운로드';

            const s1WinDesc = document.getElementById('s1WinDesc');
            if (s1WinDesc) s1WinDesc.textContent = '다운로드 후 실행하세요. Python, Deno, ffmpeg가 없으면 로컬 런타임 도구를 자동으로 내려받습니다.';

            const s1WinAfter = document.getElementById('s1WinAfter');
            if (s1WinAfter) s1WinAfter.textContent = '다운로드 후 일반 사용자로 실행하세요. 관리자 권한 실행은 사용하지 마세요.';

            const extIdLabel = document.getElementById('extIdLabel');
            if (extIdLabel) extIdLabel.textContent = '확장 ID:';

            const s2Title = document.getElementById('s2Title');
            if (s2Title) s2Title.textContent = '② 연결 테스트';

            const s2Desc = document.getElementById('s2Desc');
            if (s2Desc) s2Desc.textContent = '설치 후 브라우저를 재시작하고 연결을 테스트하세요.';

            const testBtnText = document.getElementById('testBtnText');
            if (testBtnText) testBtnText.textContent = '연결 테스트';

            const noteRestart = document.getElementById('noteRestart');
            if (noteRestart) noteRestart.textContent = '⚠️ 설치 후 브라우저를 반드시 재시작해야 합니다.';

            const noteSupported = document.getElementById('noteSupported');
            if (noteSupported) noteSupported.textContent = '✅ 지원: Chrome, Edge, Brave, Vivaldi, Opera, Arc';

            const noteAuto = document.getElementById('noteAuto');
            if (noteAuto) noteAuto.textContent = '🚀 설치기가 필요한 런타임 도구와 Companion 앱을 자동으로 설치합니다.';

            const uninstallTitle = document.getElementById('uninstallTitle');
            if (uninstallTitle) uninstallTitle.textContent = '🗑️ Companion 제거';

            const uninstallDesc = document.getElementById('uninstallDesc');
            if (uninstallDesc) uninstallDesc.textContent = 'Companion 앱과 등록된 Native Messaging 호스트를 모두 제거합니다.';

            const btnUninstallText = document.getElementById('btnUninstallText');
            if (btnUninstallText) btnUninstallText.textContent = 'Companion 제거';

            const uninstallAfter = document.getElementById('uninstallAfter');
            if (uninstallAfter) uninstallAfter.textContent = '제거 후 브라우저를 재시작하면 완료됩니다.';
        }
    };
    applyI18n();

    // Companion 제거
    const btnUninstall = document.getElementById('btnUninstall');
    if (btnUninstall) {
        btnUninstall.addEventListener('click', () => {
            const btn = document.getElementById('btnUninstall');
            const textEl = document.getElementById('btnUninstallText');
            const resultEl = document.getElementById('uninstallResult');
            btn.disabled = true;
            textEl.textContent = lang === 'ko' ? '제거 중...' : 'Uninstalling...';

            try {
                const port = chrome.runtime.connectNative('com.medianab.host');
                let responded = false;

                port.onMessage.addListener((response) => {
                    responded = true;
                    if (response.status === 'ok' || response.status === 'partial') {
                        const removedCount = (response.removed || []).length;
                        const errorCount = (response.errors || []).length;
                        resultEl.style.display = 'block';
                        resultEl.style.background = 'rgba(46,194,126,.1)';
                        resultEl.style.border = '1px solid rgba(46,194,126,.3)';
                        resultEl.style.color = 'var(--success)';
                        resultEl.textContent = lang === 'ko'
                            ? `✅ ${removedCount}개 항목 제거 완료${errorCount > 0 ? ` (${errorCount}개 오류)` : ''} — 브라우저를 재시작하세요.`
                            : `✅ ${removedCount} items removed${errorCount > 0 ? ` (${errorCount} errors)` : ''} — Restart your browser.`;
                        textEl.textContent = '✅';
                    } else {
                        resultEl.style.display = 'block';
                        resultEl.style.background = 'rgba(245,166,35,.1)';
                        resultEl.style.border = '1px solid rgba(245,166,35,.3)';
                        resultEl.style.color = 'var(--error)';
                        resultEl.textContent = response.message || 'Unknown error';
                        btn.disabled = false;
                        textEl.textContent = lang === 'ko' ? 'Companion 제거' : 'Uninstall Companion';
                    }
                    port.disconnect();
                });

                port.onDisconnect.addListener(() => {
                    if (!responded) {
                        resultEl.style.display = 'block';
                        resultEl.style.background = 'rgba(245,166,35,.1)';
                        resultEl.style.border = '1px solid rgba(245,166,35,.3)';
                        resultEl.style.color = 'var(--warning)';
                        resultEl.textContent = lang === 'ko'
                            ? '⚠️ Companion이 연결되지 않았습니다. 설치되어 있지 않은 경우 제거가 불필요합니다.'
                            : '⚠️ Companion is not connected. If not installed, no uninstall needed.';
                        btn.disabled = false;
                        textEl.textContent = lang === 'ko' ? 'Companion 제거' : 'Uninstall Companion';
                    }
                });

                port.postMessage({ action: 'selfUninstall' });
            } catch (e) {
                if (resultEl) {
                    resultEl.style.display = 'block';
                    resultEl.style.background = 'rgba(245,166,35,.1)';
                    resultEl.style.border = '1px solid rgba(245,166,35,.3)';
                    resultEl.style.color = 'var(--error)';
                    resultEl.textContent = e.message;
                }
                btn.disabled = false;
                textEl.textContent = lang === 'ko' ? 'Companion 제거' : 'Uninstall Companion';
            }
        });
    }
});

// ── macOS 설치 스크립트 생성기 ──
function generateMacInstaller(extId, pyCode) {
    const L = [
        '#!/bin/bash',
        '# MediaNab Companion — 자동 설치 스크립트 (macOS)',
        '# 확장 ID: ' + extId,
        'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
        '',
        'BOLD="\\033[1m"',
        'GREEN="\\033[32m"',
        'YELLOW="\\033[33m"',
        'RED="\\033[31m"',
        'CYAN="\\033[36m"',
        'RESET="\\033[0m"',
        '',
        'EXT_ID="' + extId + '"',
        'INSTALL_DIR="$HOME/.medianab"',
        'HOST_SCRIPT="$INSTALL_DIR/medianab_host.py"',
        'HOST_BIN="$INSTALL_DIR/medianab-host"',
        'LOCAL_BIN="$HOME/.local/bin"',
        '',
        'echo -e "${BOLD}🎬 MediaNab Companion 설치${RESET}"',
        'echo ""',
        '',
        '# ── 0. 홈 디렉토리 bin 생성 ──',
        'echo -e "${BOLD}[0/6] 사용자 bin 디렉토리${RESET}"',
        'mkdir -p "$LOCAL_BIN"',
        'export PATH="$LOCAL_BIN:$PATH"',
        '',
        '# PATH에 추가 (없는 경우)',
        'if ! echo "$PATH" | grep -q "$LOCAL_BIN"; then',
        '    echo "export PATH=\\"$LOCAL_BIN:\$PATH\\"" >> "$HOME/.zshrc"',
        '    echo "export PATH=\\"$LOCAL_BIN:\$PATH\\"" >> "$HOME/.bash_profile"',
        '    echo -e "  ${YELLOW}PATH에 $LOCAL_BIN 추가됨${RESET}"',
        'fi',
        'echo -e "  ✅ $LOCAL_BIN"',
        '',
        '# ── 1. yt-dlp ──',
        'echo ""',
        'echo -e "${BOLD}[1/6] yt-dlp${RESET}"',
        'echo -e "  📦 최신 버전 확인/설치 중..."',
        'if command -v brew &>/dev/null; then',
        '    if brew list yt-dlp &>/dev/null; then',
        '        brew upgrade yt-dlp || true',
        '    else',
        '        brew install yt-dlp',
        '    fi',
        'else',
        '    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o "$LOCAL_BIN/yt-dlp"',
        '    chmod +x "$LOCAL_BIN/yt-dlp"',
        'fi',
        'echo -e "  ✅ $(yt-dlp --version)"',
        '',
        '# ── 2. Deno ──',
        'echo ""',
        'echo -e "${BOLD}[2/6] Deno JavaScript runtime${RESET}"',
        'if command -v deno &>/dev/null; then',
        '    echo -e "  ✅ $(deno --version | head -n 1)"',
        'else',
        '    echo -e "  📦 설치 중..."',
        '    if command -v brew &>/dev/null; then',
        '        brew install deno',
        '    else',
        '        ARCH="$(uname -m)"',
        '        DENO_TARGET="x86_64-apple-darwin"',
        '        if [ "$ARCH" = "arm64" ]; then DENO_TARGET="aarch64-apple-darwin"; fi',
        '        curl -L "https://github.com/denoland/deno/releases/latest/download/deno-${DENO_TARGET}.zip" -o "$INSTALL_DIR/deno.zip"',
        '        unzip -oq "$INSTALL_DIR/deno.zip" -d "$LOCAL_BIN"',
        '        chmod +x "$LOCAL_BIN/deno"',
        '        rm -f "$INSTALL_DIR/deno.zip"',
        '    fi',
        '    echo -e "  ✅ $(deno --version | head -n 1)"',
        'fi',
        '',
        '# ── 3. ffmpeg ──',
        'echo ""',
        'echo -e "${BOLD}[3/6] ffmpeg${RESET}"',
        'if command -v ffmpeg &>/dev/null; then',
        '    echo -e "  ✅ installed"',
        'else',
        '    echo -e "  📦 설치 중..."',
        '    if command -v brew &>/dev/null; then',
        '        brew install ffmpeg',
        '    else',
        '        echo -e "  ${YELLOW}ffmpeg 설치가 필요합니다. https://ffmpeg.org${RESET}"',
        '    fi',
        'fi',
        '',
        '# ── 4. Companion 설치 ──',
        'echo ""',
        'echo -e "${BOLD}[4/6] Companion App${RESET}"',
        'mkdir -p "$INSTALL_DIR"',
        '',
        "cat > \"$HOST_SCRIPT\" << 'MEDIANAB_PY_EOF'",
        pyCode,
        'MEDIANAB_PY_EOF',
        '',
        'chmod +x "$HOST_SCRIPT"',
        '',
        'PYTHON3=$(command -v python3 || echo "/usr/bin/python3")',
        '',
        'cat > "$HOST_BIN" << EOF2',
        '#!/bin/bash',
        'exec "$PYTHON3" "$HOST_SCRIPT" "\\$@"',
        'EOF2',
        '',
        'chmod +x "$HOST_BIN"',
        'echo -e "  ✅ $HOST_BIN"',
        '',
        '# ── 5. 브라우저 등록 ──',
        'echo ""',
        'echo -e "${BOLD}[5/6] 브라우저 등록${RESET}"',
        '',
        "MANIFEST='{",
        '  "name": "com.medianab.host",',
        '  "description": "MediaNab Companion",',
        "  \"path\": \"'$HOST_BIN'\",",
        '  "type": "stdio",',
        "  \"allowed_origins\": [\"chrome-extension://'$EXT_ID'/\"]",
        "}'",
        '',
        'BROWSERS=(',
        '    "Google Chrome:$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"',
        '    "Microsoft Edge:$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"',
        '    "Brave:$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"',
        '    "Vivaldi:$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"',
        '    "Opera:$HOME/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts"',
        '    "Arc:$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"',
        '    "Chromium:$HOME/Library/Application Support/Chromium/NativeMessagingHosts"',
        ')',
        '',
        'COUNT=0',
        'for ENTRY in "${BROWSERS[@]}"; do',
        '    NAME="${ENTRY%%:*}"',
        '    DIR="${ENTRY#*:}"',
        '    PARENT="$(dirname "$DIR")"',
        '    if [ -d "$PARENT" ]; then',
        '        mkdir -p "$DIR"',
        '        echo "$MANIFEST" > "$DIR/com.medianab.host.json"',
        '        echo -e "  ✅ ${CYAN}$NAME${RESET}"',
        '        COUNT=$((COUNT + 1))',
        '    fi',
        'done',
        '',
        'if [ $COUNT -eq 0 ]; then',
        '    DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"',
        '    mkdir -p "$DIR"',
        '    echo "$MANIFEST" > "$DIR/com.medianab.host.json"',
        '    echo -e "  ✅ Chrome (기본)"',
        'fi',
        '',
        '# ── 6. 완료 ──',
        'echo ""',
        'echo -e "${GREEN}${BOLD}🎉 설치 완료!${RESET}"',
        'echo -e "${YELLOW}중요: 터미널을 재시작하거나 다음 명령어를 실행하세요:${RESET}"',
        'echo -e "${CYAN}export PATH=\\"$LOCAL_BIN:\$PATH\\"${RESET}"',
        'echo ""',
        'echo -e "${YELLOW}그 후 브라우저를 재시작하세요.${RESET}"',
        'echo ""',
        'read -n1 -r -p "아무 키나 누르면 종료합니다..."',
    ];
    return L.join('\n') + '\n';
}

// ── Windows 설치 스크립트 생성기 ──
function generateWinInstaller(extId, pyCode) {
    const pyCodeBase64 = btoa(unescape(encodeURIComponent(pyCode)));
    const payloadLines = pyCodeBase64.match(/.{1,120}/g) || [pyCodeBase64];

    const L = [
        '@echo off',
        'setlocal EnableExtensions DisableDelayedExpansion',
        'goto :main',
        '',
        ':main',
        'echo ====================================',
        'echo MediaNab Companion installer',
        'echo ====================================',
        'echo.',
        'set "EXT_ID=' + extId + '"',
        'set "SELF=%~f0"',
        'set "INSTALL_DIR=%LOCALAPPDATA%\\MediaNab"',
        'set "HOST_SCRIPT=%INSTALL_DIR%\\medianab_host.py"',
        'set "HOST_BAT=%INSTALL_DIR%\\medianab-host.bat"',
        'set "MANIFEST_PATH=%INSTALL_DIR%\\com.medianab.host.json"',
        'set "PYTHON_DIR=%INSTALL_DIR%\\python"',
        'set "PYTHON_ZIP=%INSTALL_DIR%\\python-embed.zip"',
        'set "YTDLP_EXE=%INSTALL_DIR%\\yt-dlp.exe"',
        'set "DENO_EXE=%INSTALL_DIR%\\deno.exe"',
        'set "DENO_ZIP=%INSTALL_DIR%\\deno.zip"',
        'set "FFMPEG_EXE=%INSTALL_DIR%\\ffmpeg.exe"',
        'set "PYTHON_EXE="',
        'set "PYTHON_ARGS="',
        'set "PATH=%INSTALL_DIR%;%PATH%"',
        'if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"',
        'if errorlevel 1 goto :mkdir_fail',
        'net session >nul 2>&1',
        'if %ERRORLEVEL% equ 0 (',
        '    echo [ERROR] Run this installer as your normal Windows user.',
        '    echo         Do not use Run as administrator.',
        '    pause',
        '    exit /b 1',
        ')',
        'echo [1/5] Python runtime',
        'where py >nul 2>&1',
        'if %ERRORLEVEL% equ 0 (',
        '    set "PYTHON_EXE=py"',
        '    set "PYTHON_ARGS=-3"',
        ') else (',
        '    where python >nul 2>&1',
        '    if %ERRORLEVEL% equ 0 (',
        '        set "PYTHON_EXE=python"',
        '    ) else (',
        '        echo   Python was not found on PATH.',
        '        echo   Downloading portable Python...',
        '        powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri \'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip\' -OutFile $env:PYTHON_ZIP"',
        '        if errorlevel 1 goto :python_fail',
        '        if exist "%PYTHON_DIR%" rmdir /s /q "%PYTHON_DIR%"',
        '        mkdir "%PYTHON_DIR%"',
        '        if errorlevel 1 goto :python_fail',
        '        powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $env:PYTHON_ZIP -DestinationPath $env:PYTHON_DIR -Force"',
        '        if errorlevel 1 goto :python_fail',
        '        del /f /q "%PYTHON_ZIP%" >nul 2>&1',
        '        if not exist "%PYTHON_DIR%\\python.exe" goto :python_fail',
        '        set "PYTHON_EXE=%PYTHON_DIR%\\python.exe"',
        '        set "PYTHON_ARGS="',
        '    )',
        ')',
        'for /f "delims=" %%i in (\'"%PYTHON_EXE%" %PYTHON_ARGS% --version 2^>^&1\') do echo   %%i',
        'echo.',
        'echo [2/5] yt-dlp',
        'if exist "%YTDLP_EXE%" (',
        '    echo   Existing bundled yt-dlp:',
        '    "%YTDLP_EXE%" --version',
        ') else (',
        '    echo   Downloading portable yt-dlp...',
        '    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri \'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe\' -OutFile $env:YTDLP_EXE"',
        '    if errorlevel 1 goto :ytdlp_fail',
        '    if not exist "%YTDLP_EXE%" goto :ytdlp_fail',
        '    "%YTDLP_EXE%" --version',
        ')',
        'echo.',
        'echo [3/5] Deno JavaScript runtime',
        'if exist "%DENO_EXE%" (',
        '    echo   Existing bundled Deno:',
        '    "%DENO_EXE%" --version',
        ') else (',
        '    echo   Downloading portable Deno...',
        '    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri \'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip\' -OutFile $env:DENO_ZIP"',
        '    if errorlevel 1 goto :deno_fail',
        '    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $env:DENO_ZIP -DestinationPath $env:INSTALL_DIR -Force"',
        '    if errorlevel 1 goto :deno_fail',
        '    del /f /q "%DENO_ZIP%" >nul 2>&1',
        '    if not exist "%DENO_EXE%" goto :deno_fail',
        '    "%DENO_EXE%" --version',
        ')',
        'echo.',
        'echo [4/5] ffmpeg',
        'where ffmpeg >nul 2>&1',
        'if %ERRORLEVEL% neq 0 (',
        '    echo   ffmpeg was not found on PATH.',
        '    echo   Downloading portable ffmpeg.exe...',
        '    if exist "%FFMPEG_EXE%" del /f /q "%FFMPEG_EXE%" >nul 2>&1',
        '    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri \'https://github.com/shaka-project/static-ffmpeg-binaries/releases/latest/download/ffmpeg-win-x64.exe\' -OutFile $env:FFMPEG_EXE"',
        '    if errorlevel 1 goto :ffmpeg_fail',
        '    if not exist "%FFMPEG_EXE%" goto :ffmpeg_fail',
        '    echo   Downloaded ffmpeg',
        ') else (',
        '    echo   OK',
        ')',
        'echo.',
        'echo [5/5] Companion + browser registration',
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "$self=$env:SELF; $lines=Get-Content -LiteralPath $self; $marker=\'__MEDIANAB_PAYLOAD__\'; $index=[Array]::IndexOf($lines,$marker); if($index -lt 0){ throw \'Payload marker not found\' }; $payload=($lines[($index+1)..($lines.Length-1)] -join \'\'); $bytes=[Convert]::FromBase64String($payload); [IO.File]::WriteAllBytes($env:HOST_SCRIPT,$bytes)"',
        'if errorlevel 1 goto :payload_fail',
        '> "%HOST_BAT%" (',
        '    echo @echo off',
        '    echo set "PATH=%INSTALL_DIR%;%%PATH%%"',
        '    echo "%PYTHON_EXE%" %PYTHON_ARGS% "%HOST_SCRIPT%" %%*',
        ')',
        'if errorlevel 1 goto :wrapper_fail',
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "$manifest = @{ name = \'com.medianab.host\'; description = \'MediaNab Companion\'; path = $env:HOST_BAT; type = \'stdio\'; allowed_origins = @(\'chrome-extension://\' + $env:EXT_ID + \'/\') }; $manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $env:MANIFEST_PATH -Encoding UTF8"',
        'if errorlevel 1 goto :manifest_fail',
        'call :register_browser "Google Chrome" "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.medianab.host"',
        'call :register_browser "Microsoft Edge" "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.medianab.host"',
        'call :register_browser "Brave" "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.medianab.host"',
        'call :register_browser "Vivaldi" "HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\com.medianab.host"',
        'call :register_browser "Chromium" "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.medianab.host"',
        'echo.',
        'echo ====================================',
        'echo Installation complete.',
        'echo Restart your browser and run the connection test.',
        'echo ====================================',
        'pause',
        'goto :eof',
        '',
        ':register_browser',
        'reg add %~2 /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1',
        'if %ERRORLEVEL% equ 0 echo   Registered %~1',
        'goto :eof',
        '',
        ':mkdir_fail',
        'echo   [ERROR] Failed to create %INSTALL_DIR%',
        'pause',
        'exit /b 1',
        '',
        ':wrapper_fail',
        'echo   [ERROR] Failed to create launcher files.',
        'pause',
        'exit /b 1',
        '',
        ':python_fail',
        'echo   [ERROR] Failed to install the bundled Python runtime.',
        'pause',
        'exit /b 1',
        '',
        ':ytdlp_fail',
        'echo   [ERROR] Failed to download yt-dlp.',
        'pause',
        'exit /b 1',
        '',
        ':deno_fail',
        'echo   [ERROR] Failed to download Deno.',
        'pause',
        'exit /b 1',
        '',
        ':ffmpeg_fail',
        'echo   [ERROR] Failed to download ffmpeg.',
        'pause',
        'exit /b 1',
        '',
        ':payload_fail',
        'echo   [ERROR] Failed to write Companion files.',
        'pause',
        'exit /b 1',
        '',
        ':manifest_fail',
        'echo   [ERROR] Failed to create the browser manifest.',
        'pause',
        'exit /b 1',
        '',
        '__MEDIANAB_PAYLOAD__',
        ...payloadLines,
    ];
    return L.join('\r\n') + '\r\n';
}
