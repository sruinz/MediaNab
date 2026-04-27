#!/usr/bin/env python3
"""
MediaNab Companion — Chrome Native Messaging Host
로컬 helper runtime을 실행하는 브릿지 역할

프로토콜: Chrome Native Messaging (stdin/stdout, 4바이트 길이 헤더 + JSON)
"""

import sys
import os
import json
import struct
import subprocess
import shutil
import signal
import threading
import platform
import locale
import re
import ntpath
import time
import base64
import ctypes
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

VERSION = "1.2.4.06"
RAW_BUILD_VARIANT = "__BUILD_VARIANT__"
RAW_ENABLE_YOUTUBE_DOWNLOAD = "__ENABLE_YOUTUBE_DOWNLOAD__"
RAW_ENABLE_YOUTUBE_LIVE_RECORD = "__ENABLE_YOUTUBE_LIVE_RECORD__"
COOKIE_AUTH_BROWSERS = {'chrome', 'edge'}
COOKIE_AUTH_REQUIRED_MESSAGE = (
    'Browser cookie authentication is required. Enable Cookie auth in MediaNab '
    'and select Chrome, Edge, or cookies.txt.'
)

def resolve_build_variant(value):
    raw = str(value or '').strip()
    return raw if raw and not raw.startswith('__') else 'full'

def resolve_build_bool(value, fallback=True):
    raw = str(value or '').strip()
    if not raw or raw.startswith('__'):
        return bool(fallback)
    return raw == 'true'

BUILD_VARIANT = resolve_build_variant(RAW_BUILD_VARIANT)
ENABLE_YOUTUBE_DOWNLOAD = resolve_build_bool(RAW_ENABLE_YOUTUBE_DOWNLOAD, True)
ENABLE_YOUTUBE_LIVE_RECORD = resolve_build_bool(RAW_ENABLE_YOUTUBE_LIVE_RECORD, True)

# ── 설정 파일 경로 ──
def get_config_path():
    if platform.system() == 'Darwin':
        return Path.home() / 'Library' / 'Application Support' / 'MediaNab' / 'config.json'
    elif platform.system() == 'Windows':
        return Path(os.environ.get('LOCALAPPDATA', '')) / 'MediaNab' / 'config.json'
    else:
        return Path.home() / '.config' / 'medianab' / 'config.json'

def normalize_download_path(path):
    value = str(path or '').strip().strip('"')
    if not value:
        return str(Path.home() / 'Downloads')
    if value.startswith('file://'):
        parsed = urlparse(value)
        value = unquote(parsed.path or value)
    if platform.system() == 'Windows':
        value = unquote(value).replace('\\', '/')
        drive_match = re.match(r'^/+([A-Za-z]):/*(.*)$', value) or re.match(r'^([A-Za-z]):/*(.*)$', value)
        if drive_match:
            drive = drive_match.group(1).upper()
            rest = drive_match.group(2).replace('/', '\\')
            return f'{drive}:\\{rest}' if rest else f'{drive}:\\'
        return value.replace('/', '\\')
    return value

def normalize_local_path(path):
    value = str(path or '').strip().strip('"')
    if not value:
        return ''
    if value.startswith('file://'):
        parsed = urlparse(value)
        value = unquote(parsed.path or value)
    if platform.system() == 'Windows':
        value = unquote(value).replace('\\', '/')
        drive_match = re.match(r'^/+([A-Za-z]):/*(.*)$', value) or re.match(r'^([A-Za-z]):/*(.*)$', value)
        if drive_match:
            drive = drive_match.group(1).upper()
            rest = drive_match.group(2).replace('/', '\\')
            return f'{drive}:\\{rest}' if rest else f'{drive}:\\'
        return value.replace('/', '\\')
    return value

def join_output_path(download_path, file_name):
    if platform.system() == 'Windows':
        return ntpath.join(download_path, file_name)
    return os.path.join(download_path, file_name)

def normalize_cookie_auth_mode(value):
    mode = str(value or '').strip().lower()
    return mode if mode in {'off', 'browser', 'file'} else 'off'

def normalize_cookie_auth_browser(value):
    browser = str(value or '').strip().lower()
    return browser if browser in COOKIE_AUTH_BROWSERS else 'chrome'

def load_config():
    path = get_config_path()
    default = {
        'download_path': str(Path.home() / 'Downloads'),
        'ytdlp_path': '',  # 빈 문자열 = 자동 감지
        'ffmpeg_path': '',
        'deno_path': '',
        'cookie_auth_mode': 'off',
        'cookie_auth_browser': 'chrome',
        'cookie_auth_file': '',
    }
    try:
        if path.exists():
            with open(path, 'r', encoding='utf-8') as f:
                saved = json.load(f)
                default.update(saved)
    except Exception:
        pass
    default['download_path'] = normalize_download_path(default.get('download_path'))
    default['cookie_auth_mode'] = normalize_cookie_auth_mode(default.get('cookie_auth_mode'))
    default['cookie_auth_browser'] = normalize_cookie_auth_browser(default.get('cookie_auth_browser'))
    default['cookie_auth_file'] = normalize_local_path(default.get('cookie_auth_file'))
    return default

def save_config(config):
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

# ── helper runtime / ffmpeg 경로 찾기 ──
def find_binary(name, custom_path=''):
    if custom_path and os.path.isfile(custom_path):
        return custom_path
    found = shutil.which(name)
    if found:
        return found
    # Mac: homebrew 경로
    for p in [f'/usr/local/bin/{name}', f'/opt/homebrew/bin/{name}']:
        if os.path.isfile(p):
            return p
    return None

def get_version(binary_path, flag='--version'):
    try:
        r = subprocess.run([binary_path, flag], capture_output=True, text=True, timeout=10)
        return r.stdout.strip().split('\n')[0]
    except Exception:
        return None

def subprocess_output_encoding():
    if platform.system() == 'Windows':
        return locale.getpreferredencoding(False) or 'utf-8'
    return 'utf-8'

def get_variant_policy_message():
    return 'Google Web Store 정책으로 인해 이 빌드에서는 YouTube 다운로드/녹화를 지원하지 않습니다. Edge, Firefox 또는 direct build를 사용하세요.'

def is_youtube_request_blocked(url, live_record=False):
    if not is_youtube_url(url):
        return False
    return not ENABLE_YOUTUBE_LIVE_RECORD if live_record else not ENABLE_YOUTUBE_DOWNLOAD

def is_missing_or_suspect_path(path):
    if not path or '\ufffd' in str(path):
        return True
    try:
        return not os.path.exists(path)
    except Exception:
        return True

# ── Chrome Native Messaging 프로토콜 ──
def read_message():
    """stdin에서 Chrome 메시지 읽기 (4바이트 길이 헤더 + JSON)"""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    msg_length = struct.unpack('<I', raw_length)[0]
    if msg_length == 0:
        return None
    msg_data = sys.stdin.buffer.read(msg_length)
    return json.loads(msg_data.decode('utf-8'))

def send_message(msg):
    """stdout으로 Chrome 메시지 전송"""
    encoded = json.dumps(msg, ensure_ascii=False).encode('utf-8')
    with _send_lock:
        sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()

def send_debug(scope, message, data=None, level='info', download_id=''):
    payload = {
        'type': 'debug',
        'level': level,
        'scope': scope,
        'message': message,
        'data': data or {},
    }
    if download_id:
        payload['download_id'] = download_id
    send_message(payload)

# ── 활성 다운로드 프로세스 관리 ──
_active_downloads = {}  # download_id → subprocess.Popen
_active_streams = {}    # download_id → {'file': fh, 'filepath': str, 'size': int}
_cancelled_downloads = set()
_send_lock = threading.Lock()
ANSI_ESCAPE_RE = re.compile(r'\x1B\[[0-?]*[ -/]*[@-~]')
DEFAULT_COMPAT_FORMAT = 'bv*[vcodec^=avc1][ext=mp4][protocol!=m3u8_native][protocol!=m3u8]+ba[ext=m4a][protocol!=m3u8_native][protocol!=m3u8]/bv*[vcodec^=avc1][protocol!=m3u8_native][protocol!=m3u8]+ba[protocol!=m3u8_native][protocol!=m3u8]/b[ext=mp4][protocol!=m3u8_native][protocol!=m3u8]/best[protocol!=m3u8_native][protocol!=m3u8]/best'
DEFAULT_NO_FFMPEG_FORMAT = 'best[ext=mp4][protocol!=m3u8_native][protocol!=m3u8]/best[protocol!=m3u8_native][protocol!=m3u8]/best'
DEFAULT_YOUTUBE_FORMAT = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
YTDLP_YOUTUBE_ANDROID_WORKAROUND_UNTIL = (2026, 3, 17)

def clean_output_line(line):
    return ANSI_ESCAPE_RE.sub('', line).strip()

def normalize_progress_field(value):
    value = (value or '').strip()
    if value in ('', 'NA', 'N/A', 'Unknown B/s', 'Unknown ETA', 'None'):
        return ''
    return value

def format_speed_bytes(bytes_per_sec):
    try:
        value = float(bytes_per_sec or 0)
    except (TypeError, ValueError):
        return ''
    if value <= 0:
        return ''
    units = [('GiB', 1024 ** 3), ('MiB', 1024 ** 2), ('KiB', 1024)]
    for suffix, factor in units:
        if value >= factor:
            return f'{value / factor:.1f}{suffix}/s'
    return f'{value:.0f}B/s'

def managed_popen_kwargs(create_hidden_console=False):
    if platform.system() == 'Windows':
        flags = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
        kwargs = {'creationflags': flags}
        if create_hidden_console:
            flags |= getattr(subprocess, 'CREATE_NEW_CONSOLE', 0)
            kwargs['creationflags'] = flags
            try:
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= getattr(subprocess, 'STARTF_USESHOWWINDOW', 1)
                startupinfo.wShowWindow = getattr(subprocess, 'SW_HIDE', 0)
                kwargs['startupinfo'] = startupinfo
            except Exception:
                pass
        return kwargs
    return {'start_new_session': True}

def managed_run_kwargs():
    if platform.system() != 'Windows':
        return {}
    kwargs = {}
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    if flags:
        kwargs['creationflags'] = flags
    try:
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= getattr(subprocess, 'STARTF_USESHOWWINDOW', 1)
        startupinfo.wShowWindow = getattr(subprocess, 'SW_HIDE', 0)
        kwargs['startupinfo'] = startupinfo
    except Exception:
        pass
    return kwargs

def send_windows_console_ctrl_event(proc, ctrl_event):
    if platform.system() != 'Windows' or not proc or proc.poll() is not None:
        return False
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.FreeConsole()
        if not kernel32.AttachConsole(int(proc.pid)):
            return False
        kernel32.SetConsoleCtrlHandler(None, True)
        try:
            ok = kernel32.GenerateConsoleCtrlEvent(ctrl_event, int(proc.pid))
            if ok:
                time.sleep(0.25)
            return bool(ok)
        finally:
            kernel32.FreeConsole()
            kernel32.SetConsoleCtrlHandler(None, False)
    except Exception:
        return False

def stop_process_tree(proc, timeout=8, prefer_console_ctrl=False):
    if not proc or proc.poll() is not None:
        return

    if platform.system() == 'Windows':
        if prefer_console_ctrl:
            for sig, wait_time in (
                (getattr(signal, 'CTRL_C_EVENT', None), timeout),
                (getattr(signal, 'CTRL_BREAK_EVENT', None), min(max(timeout // 3, 5), 15)),
            ):
                if sig is None or proc.poll() is not None:
                    continue
                if not send_windows_console_ctrl_event(proc, sig):
                    continue
                try:
                    proc.wait(timeout=wait_time)
                    return
                except subprocess.TimeoutExpired:
                    continue
                except Exception:
                    continue

        # yt-dlp treats Ctrl+C as the graceful "finish and merge" path. Ctrl+Break is
        # kept as a fallback because it can interrupt too aggressively on Windows.
        for sig, wait_time in (
            (getattr(signal, 'CTRL_C_EVENT', None), timeout),
            (getattr(signal, 'CTRL_BREAK_EVENT', None), min(max(timeout // 3, 5), 15)),
        ):
            if sig is None or proc.poll() is not None:
                continue
            try:
                proc.send_signal(sig)
                proc.wait(timeout=wait_time)
                return
            except subprocess.TimeoutExpired:
                continue
            except Exception:
                continue
        try:
            subprocess.run(
                ['taskkill', '/PID', str(proc.pid), '/T'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            proc.wait(timeout=min(max(timeout // 3, 5), 15))
            return
        except subprocess.TimeoutExpired:
            pass
        except Exception:
            pass
        try:
            subprocess.run(
                ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            return
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass
        return

    try:
        pgid = os.getpgid(proc.pid)
    except Exception:
        pgid = None

    if pgid:
        for sig, wait_time in ((signal.SIGINT, timeout), (signal.SIGTERM, 3), (signal.SIGKILL, 3)):
            try:
                os.killpg(pgid, sig)
                proc.wait(timeout=wait_time)
                return
            except ProcessLookupError:
                return
            except subprocess.TimeoutExpired:
                continue
            except Exception:
                break

    try:
        proc.terminate()
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

def stop_matching_download_processes(download_path='', file_name='', download_id=''):
    if platform.system() == 'Windows':
        return []

    needles = []
    for value in (
        download_id,
        file_name,
        join_output_path(download_path, file_name) if download_path and file_name else '',
    ):
        value = str(value or '').strip()
        if value and len(value) >= 8 and value not in needles:
            needles.append(value)
    if not needles:
        return []

    try:
        result = subprocess.run(
            ['ps', '-axo', 'pid=,pgid=,command='],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
        )
    except Exception:
        return []

    targets = []
    current_pid = os.getpid()
    for raw_line in result.stdout.splitlines():
        parts = raw_line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        try:
            pid = int(parts[0])
            pgid = int(parts[1])
        except Exception:
            continue
        if pid == current_pid:
            continue
        command = parts[2]
        if not re.search(r'(^|/)(yt-dlp|ffmpeg)(\s|$)', command):
            continue
        if any(needle in command for needle in needles):
            targets.append({'pid': pid, 'pgid': pgid, 'command': command[:240]})

    stopped = []
    for target in targets:
        try:
            os.kill(target['pid'], signal.SIGTERM)
            stopped.append({**target, 'signal': 'SIGTERM'})
        except ProcessLookupError:
            stopped.append({**target, 'signal': 'gone'})
        except Exception as e:
            stopped.append({**target, 'signal': f'error:{type(e).__name__}'})

    if targets:
        time.sleep(0.5)
        for target in targets:
            try:
                os.kill(target['pid'], 0)
            except ProcessLookupError:
                continue
            except Exception:
                continue
            try:
                os.kill(target['pid'], signal.SIGKILL)
                stopped.append({**target, 'signal': 'SIGKILL'})
            except ProcessLookupError:
                pass
            except Exception as e:
                stopped.append({**target, 'signal': f'kill-error:{type(e).__name__}'})

    return stopped

def should_forward_ytdlp_line(line):
    value = line or ''
    if value.startswith(('[youtube]', '[download] Destination:', '[Merger]', '[Fixup]', '[ExtractAudio]')):
        return True
    return any(token in value for token in ('ERROR:', 'WARNING:', 'Deno', 'Sign in', 'HTTP Error', '403', '429', 'PoToken'))

def sanitize_ytdlp_debug_line(line):
    value = line or ''
    if re.search(r'\bExtracting cookies from\b', value, re.IGNORECASE):
        return ''
    if re.search(r'\bExtracted\s+\d+\s+cookies from\b', value, re.IGNORECASE):
        return ''
    return value

def parse_template_progress(line):
    candidate = line[9:] if line.startswith('download:') else line
    if candidate.count('|') < 2 or '%' not in candidate:
        return None
    parts = candidate.split('|', 2)
    pct_match = re.search(r'(\d+\.?\d*)', parts[0])
    if not pct_match:
        return None
    try:
        pct = float(pct_match.group(1))
    except ValueError:
        return None
    return pct, normalize_progress_field(parts[1]), normalize_progress_field(parts[2])

def codec_score(codec):
    codec = (codec or '').lower()
    if codec.startswith('avc1') or codec.startswith('h264'):
        return 3
    if codec.startswith('hev1') or codec.startswith('hvc1') or codec.startswith('vp9'):
        return 2
    if codec.startswith('av01'):
        return 1
    return 0

def display_quality_label(fmt):
    width = int(fmt.get('width') or 0)
    height = int(fmt.get('height') or 0)
    note = str(fmt.get('format_note') or fmt.get('resolution') or '')
    note_match = re.search(r'(\d{3,4})p(?:\d+)?', note)
    if note_match and height and abs(int(note_match.group(1)) - height) <= 120:
        return f"{note_match.group(1)}p"
    if width >= 3800 and height >= 1600:
        return '2160p'
    if width >= 2500 and height >= 1000:
        return '1440p'
    if width >= 1900 and height >= 800:
        return '1080p'
    return f"{height}p" if height else 'Default'

def display_resolution(fmt):
    width = int(fmt.get('width') or 0)
    height = int(fmt.get('height') or 0)
    if width and height:
        return f'{width}x{height}'
    return f'{height}p' if height else ''

def is_youtube_url(url):
    try:
        host = (urlparse(url).hostname or '').lower()
        return 'youtube.com' in host or 'youtu.be' in host or 'googlevideo.com' in host
    except Exception:
        return False

def is_direct_media_url(url):
    value = url or ''
    if re.search(r'\.(mp4|webm|flv|m4v|mkv|mov)(?:[?#]|$)', value, re.IGNORECASE):
        return True
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or '').lower()
        query = parse_qs(parsed.query or '')
        mime_value = (query.get('mime', ['']) or [''])[0].lower()
        if 'googlevideo.com' in host and mime_value.startswith(('video/', 'audio/')):
            return True
    except Exception:
        pass
    return False

def parse_version_tuple(version_text):
    match = re.search(r'(\d{4})\.(\d{1,2})\.(\d{1,2})', version_text or '')
    if not match:
        return ()
    return tuple(int(match.group(i)) for i in range(1, 4))

def should_use_youtube_android_workaround(ytdlp_version):
    version_tuple = parse_version_tuple(ytdlp_version)
    return not version_tuple or version_tuple < YTDLP_YOUTUBE_ANDROID_WORKAROUND_UNTIL

def get_cookie_auth_status(config=None):
    cfg = config or {}
    cookies_file = normalize_local_path(cfg.get('cookie_auth_file', ''))
    return {
        'cookie_auth_mode': normalize_cookie_auth_mode(cfg.get('cookie_auth_mode')),
        'cookie_auth_browser': normalize_cookie_auth_browser(cfg.get('cookie_auth_browser')),
        'cookie_auth_file': cookies_file,
        'cookie_auth_file_configured': bool(cookies_file),
        'cookie_auth_file_exists': bool(cookies_file and os.path.isfile(cookies_file)),
    }

def build_cookie_auth_args(config=None):
    status = get_cookie_auth_status(config)
    mode = status['cookie_auth_mode']
    if mode == 'browser':
        return ['--cookies-from-browser', status['cookie_auth_browser']], status, ''
    if mode == 'file':
        cookies_file = status['cookie_auth_file']
        if not cookies_file:
            return [], status, 'cookies.txt file is not selected'
        if not os.path.isfile(cookies_file):
            return [], status, f'cookies.txt file not found: {cookies_file}'
        return ['--cookies', cookies_file], status, ''
    return [], status, ''

def mask_ytdlp_cmd(cmd):
    masked = []
    previous = ''
    for token in cmd or []:
        if previous == '--cookies':
            masked.append('<cookies-file>')
        elif previous == '--cookies-from-browser':
            masked.append('<browser>')
        else:
            masked.append(token)
        previous = str(token)
    return masked

def is_cookie_auth_required_message(message):
    text = unquote(str(message or '')).lower()
    return any(token in text for token in (
        'sign in to confirm',
        'not a bot',
        '--cookies-from-browser',
        '--cookies for the authentication',
        'cookies for the authentication',
    ))

def cookie_auth_required_response(raw_message=''):
    return {
        'status': 'cookie_auth_required',
        'error_code': 'cookie_auth_required',
        'message': COOKIE_AUTH_REQUIRED_MESSAGE,
        'raw_message': str(raw_message or '')[:800],
    }

def append_extractor_client_args(cmd, url, ytdlp_version='', config=None, allow_cookie_auth=False):
    if not is_youtube_url(url):
        return {'status': 'ok', 'cookie_auth_allowed': False, **get_cookie_auth_status(config)}
    deno = find_binary('deno', (config or {}).get('deno_path', ''))
    if deno:
        cmd.extend(['--js-runtimes', f'deno:{deno}'])
    if should_use_youtube_android_workaround(ytdlp_version):
        # 2025.04.30 yt-dlp 기준 YouTube SABR 케이스에서 android client가
        # 접근 가능한 progressive mp4(format 18 등)를 가장 안정적으로 노출한다.
        cmd.extend(['--extractor-args', 'youtube:player_client=android'])
    if not allow_cookie_auth:
        return {
            'status': 'ok',
            'cookie_auth_enabled': False,
            'cookie_auth_allowed': False,
            **get_cookie_auth_status(config),
        }
    cookie_args, cookie_status, cookie_error = build_cookie_auth_args(config)
    if cookie_error:
        return {
            'status': 'error',
            'error_code': 'cookie_auth_file_missing',
            'message': cookie_error,
            **cookie_status,
        }
    cmd.extend(cookie_args)
    return {
        'status': 'ok',
        'cookie_auth_enabled': bool(cookie_args),
        'cookie_auth_allowed': True,
        **cookie_status,
    }

def get_default_format(url, ytdlp_version):
    if not is_youtube_url(url):
        return DEFAULT_COMPAT_FORMAT
    if should_use_youtube_android_workaround(ytdlp_version):
        return DEFAULT_NO_FFMPEG_FORMAT
    return DEFAULT_YOUTUBE_FORMAT

def remove_ytdlp_format_args(cmd):
    result = []
    skip_next = False
    for token in cmd:
        if skip_next:
            skip_next = False
            continue
        if token in ('-f', '--format'):
            skip_next = True
            continue
        if str(token).startswith('--format='):
            continue
        result.append(token)
    return result

def set_ytdlp_format_arg(cmd, selector):
    result = remove_ytdlp_format_args(cmd)
    if not selector:
        return result
    insert_at = max(len(result) - 1, 0)
    result[insert_at:insert_at] = ['-f', selector]
    return result

def is_requested_format_unavailable(lines):
    text = '\n'.join(lines or [])
    return bool(re.search(r'(requested format.*not available|format .*is not available|no video formats found)', text, re.IGNORECASE))

def parse_positive_int(value, default=0):
    try:
        parsed = int(float(value))
        return parsed if parsed > 0 else default
    except Exception:
        return default

def build_youtube_height_selector(height):
    height = parse_positive_int(height, 0)
    if height <= 0:
        return ''
    return (
        f'bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/'
        f'bestvideo[height<={height}]+bestaudio/'
        f'best[height<={height}][ext=mp4]/best[height<={height}]'
    )

def sanitize_output_name(name):
    cleaned = re.sub(r'[\\/:*?"<>|]+', '_', (name or '').strip())
    return cleaned.strip('. ')[:180]

KNOWN_MEDIA_EXTENSIONS = {
    '.mp4', '.m4v', '.mkv', '.webm', '.flv', '.mov',
    '.ts', '.m2ts', '.mp3', '.m4a', '.aac', '.opus', '.wav'
}

def ensure_extension(name, default_ext='.ts'):
    base = sanitize_output_name(name or '')
    if not base:
        return f'video{default_ext}'
    if Path(base).suffix.lower() in KNOWN_MEDIA_EXTENSIONS:
        return base
    return f'{base}{default_ext}'

def normalize_container_ext(value):
    ext = str(value or '').lower().lstrip('.')
    return ext if ext in {'ts', 'mp4', 'm4v', 'webm', 'mkv', 'flv'} else 'ts'

def build_ffmpeg_header_arg(referer=''):
    lines = ['User-Agent: Mozilla/5.0']
    if referer:
        lines.append(f'Referer: {referer}')
    return '\r\n'.join(lines) + '\r\n'

def detect_media_ext(url, fallback='mp4'):
    value = (url or '').strip()
    match = re.search(r'\.(mp4|webm|flv|m4v|mkv|mov|m4a|aac)(?:[?#]|$)', value, re.IGNORECASE)
    if match:
        return match.group(1).lower()
    try:
        parsed = urlparse(value)
        query = parse_qs(parsed.query or '')
        mime_value = (query.get('mime', ['']) or [''])[0].lower()
        if mime_value.startswith('video/'):
            return mime_value.split('/', 1)[1].split(';', 1)[0] or fallback
        if mime_value.startswith('audio/'):
            return mime_value.split('/', 1)[1].split(';', 1)[0] or fallback
    except Exception:
        pass
    return fallback

def choose_merged_output_ext(video_ext='', audio_ext=''):
    video = (video_ext or '').lower()
    audio = (audio_ext or '').lower()
    if video in ('mp4', 'm4v') and audio in ('m4a', 'aac', 'mp4'):
        return 'mp4'
    return 'mkv'

def representative_preview_time(duration):
    try:
        duration = float(duration or 0)
    except Exception:
        duration = 0
    if duration <= 0:
        return 8.0
    if duration <= 30:
        return max(1.2, min(duration - 0.6, duration * 0.35))
    if duration <= 300:
        return max(3.0, min(duration - 1.0, duration * 0.45))
    return max(8.0, min(duration - 2.0, duration * 0.55))

def bytes_to_data_url(data, mime):
    if not data:
        return ''
    encoded = base64.b64encode(data).decode('ascii')
    return f'data:{mime};base64,{encoded}'

def run_ffmpeg_capture(ffmpeg_path, args, timeout=45):
    proc = subprocess.run(
        [ffmpeg_path, '-hide_banner', '-loglevel', 'error', *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if proc.returncode != 0:
        message = proc.stderr.decode('utf-8', errors='replace').strip() or 'ffmpeg failed'
        raise RuntimeError(message)
    return proc.stdout

def handle_generate_preview(msg):
    config = load_config()
    ffmpeg_path = find_binary('ffmpeg', config.get('ffmpeg_path', ''))
    if not ffmpeg_path:
        return {'status': 'error', 'message': 'ffmpeg not installed'}

    url = msg.get('url', '')
    if not url:
        return {'status': 'error', 'message': 'No URL provided'}

    referer = (msg.get('referer') or '').strip()
    duration = msg.get('duration', 0)
    seek_time = msg.get('seek_time')
    try:
        seek_time = float(seek_time) if seek_time is not None else representative_preview_time(duration)
    except Exception:
        seek_time = representative_preview_time(duration)
    seek_time = max(0.0, seek_time)

    preview_seconds = msg.get('preview_seconds', 2.2)
    try:
        preview_seconds = max(0.8, min(float(preview_seconds), 4.0))
    except Exception:
        preview_seconds = 2.2

    header_arg = build_ffmpeg_header_arg(referer)
    input_args = [
        '-headers', header_arg,
        '-allowed_extensions', 'ALL',
        '-extension_picky', '0',
        '-ss', f'{seek_time:.3f}',
        '-i', url
    ]

    thumbnail = ''
    preview_url = ''

    try:
        thumb_bytes = run_ffmpeg_capture(ffmpeg_path, [
            *input_args,
            '-frames:v', '1',
            '-vf', 'scale=320:-2',
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            'pipe:1',
        ], timeout=45)
        thumbnail = bytes_to_data_url(thumb_bytes, 'image/jpeg')
    except Exception as e:
        thumbnail = ''
        thumb_error = str(e)
    else:
        thumb_error = ''

    if msg.get('thumbnail_only'):
        if not thumbnail:
            return {'status': 'error', 'message': thumb_error or 'thumbnail generation failed'}
        return {
            'status': 'ok',
            'thumbnail': thumbnail,
            'thumbnail_kind': 'frame',
            'preview_url': '',
            'preview_kind': '',
            'seek_time': seek_time,
        }

    clip_errors = []
    for clip_args in (
        [
            *input_args,
            '-t', f'{preview_seconds:.3f}',
            '-an',
            '-vf', 'scale=320:-2,fps=8',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '34',
            '-pix_fmt', 'yuv420p',
            '-movflags', 'frag_keyframe+empty_moov+faststart',
            '-f', 'mp4',
            'pipe:1',
        ],
        [
            *input_args,
            '-t', f'{preview_seconds:.3f}',
            '-an',
            '-vf', 'scale=320:-2,fps=8',
            '-c:v', 'mpeg4',
            '-q:v', '9',
            '-movflags', 'frag_keyframe+empty_moov+faststart',
            '-f', 'mp4',
            'pipe:1',
        ],
    ):
        try:
            clip_bytes = run_ffmpeg_capture(ffmpeg_path, clip_args, timeout=60)
            if clip_bytes and len(clip_bytes) <= 900_000:
                preview_url = bytes_to_data_url(clip_bytes, 'video/mp4')
                break
        except Exception as e:
            clip_errors.append(str(e))

    if not thumbnail and not preview_url:
        message = thumb_error or (clip_errors[-1] if clip_errors else 'preview generation failed')
        return {'status': 'error', 'message': message}

    return {
        'status': 'ok',
        'thumbnail': thumbnail,
        'thumbnail_kind': 'frame' if thumbnail else 'unknown',
        'preview_url': preview_url,
        'preview_kind': 'video' if preview_url else '',
        'seek_time': seek_time,
    }

def uniquify_output_path(download_path, file_name):
    root = Path(download_path)
    root.mkdir(parents=True, exist_ok=True)
    candidate = root / file_name
    stem = candidate.stem
    suffix = candidate.suffix
    index = 1
    while candidate.exists():
        candidate = root / f'{stem} ({index}){suffix}'
        index += 1
    return candidate

def cleanup_cancelled_files(download_path, file_name):
    if not download_path or not file_name:
        return []
    root = Path(download_path)
    if not root.exists():
        return []

    removed = []
    temp_patterns = [
        f'{file_name}*.part',
        f'{file_name}*.ytdl',
        f'{file_name}*.temp.*',
    ]
    thumb_patterns = [
        f'{file_name}.jpg',
        f'{file_name}.jpeg',
        f'{file_name}.png',
        f'{file_name}.webp',
    ]
    media_patterns = [
        f'{file_name}.mp4',
        f'{file_name}.mkv',
        f'{file_name}.webm',
        f'{file_name}.m4a',
    ]

    for pattern in temp_patterns:
        for path in root.glob(pattern):
            if path.is_file():
                try:
                    path.unlink()
                    removed.append(str(path))
                except Exception:
                    pass

    has_finished_media = any(any(root.glob(pattern)) for pattern in media_patterns)
    if not has_finished_media:
        for pattern in thumb_patterns:
            for path in root.glob(pattern):
                if path.is_file():
                    try:
                        path.unlink()
                        removed.append(str(path))
                    except Exception:
                        pass

    return removed

def find_existing_output(download_path, file_name):
    if not download_path or not file_name:
        return '', 0
    root = Path(download_path)
    if not root.exists():
        return '', 0

    base = sanitize_output_name(file_name)
    stem = Path(base).stem if base else ''
    candidates = []
    thumbnail_exts = {'.jpg', '.jpeg', '.png', '.webp'}
    media_exts = {'.mp4', '.mkv', '.webm', '.m4a', '.mp3', '.ts', '.mov', '.m4v'}
    for pattern in {f'{base}*', f'{stem}*'}:
        if not pattern or pattern == '*':
            continue
        for path in root.glob(pattern):
            if not path.is_file():
                continue
            name = path.name.lower()
            if name.endswith(('.ytdl', '.temp', '.fpart')) or '.temp.' in name:
                continue
            suffix = path.suffix.lower()
            if suffix in thumbnail_exts:
                continue
            if suffix not in media_exts and not name.endswith(tuple(f'{ext}.part' for ext in media_exts)):
                continue
            candidates.append(path)

    if not candidates:
        return '', 0

    playable = [p for p in candidates if not p.name.lower().endswith('.part')]
    chosen = max(playable or candidates, key=lambda p: p.stat().st_mtime)
    try:
        return str(chosen), chosen.stat().st_size
    except Exception:
        return str(chosen), 0

def output_match_key(value):
    return re.sub(r'[\W_]+', '', str(value or ''), flags=re.UNICODE).casefold()

def output_stem_candidates(file_name='', expected_path=''):
    stems = []
    for value in (file_name, expected_path):
        value = str(value or '').strip()
        if not value:
            continue
        stem = Path(value).stem
        if stem and stem not in stems:
            stems.append(stem)
    return stems

def path_matches_output_stem(path, stems):
    key = output_match_key(path.stem)
    if not key:
        return False
    for stem in stems:
        expected = output_match_key(stem)
        if expected and (key.startswith(expected) or expected.startswith(key)):
            return True
    return False

def is_live_window_fragment(path):
    name = path.name.lower()
    return bool(re.search(r'\.f\d+\.[a-z0-9]+(?:\.part)?$', name)) or name.endswith('.part')

def is_ignored_live_window_artifact(path):
    name = path.name.lower()
    return (
        name.endswith(('.ytdl', '.temp', '.jpg', '.jpeg', '.png', '.webp')) or
        '.temp.' in name
    )

def find_live_window_final_output(download_path, file_name, expected_path=''):
    if expected_path:
        exact = Path(expected_path)
        if exact.exists() and exact.is_file() and not is_live_window_fragment(exact):
            try:
                return str(exact), exact.stat().st_size
            except Exception:
                return str(exact), 0

    root = Path(download_path) if download_path else None
    if not root or not root.exists():
        return '', 0

    stems = output_stem_candidates(file_name, expected_path)
    media_exts = {'.mp4', '.mkv', '.webm', '.m4v', '.mov'}
    candidates = []
    for path in root.iterdir():
        if not path.is_file() or is_ignored_live_window_artifact(path):
            continue
        if path.suffix.lower() not in media_exts:
            continue
        if is_live_window_fragment(path):
            continue
        if not path_matches_output_stem(path, stems):
            continue
        candidates.append(path)

    if not candidates:
        return '', 0

    chosen = max(candidates, key=lambda p: p.stat().st_mtime)
    try:
        return str(chosen), chosen.stat().st_size
    except Exception:
        return str(chosen), 0

def measure_live_window_recording_size(download_path, file_name, expected_path='', known_paths=None):
    final_path, final_size = find_live_window_final_output(download_path, file_name, expected_path)
    if final_path:
        return final_path, final_size

    total = 0
    seen = set()
    for raw_path in known_paths or []:
        path = Path(str(raw_path or ''))
        if not path.is_file() or is_ignored_live_window_artifact(path):
            continue
        if not is_live_window_fragment(path):
            continue
        try:
            total += path.stat().st_size
            seen.add(str(path))
        except Exception:
            pass

    root = Path(download_path) if download_path else None
    if root and root.exists():
        stems = output_stem_candidates(file_name, expected_path)
        for path in root.iterdir():
            path_key = str(path)
            if path_key in seen:
                continue
            if not path.is_file() or is_ignored_live_window_artifact(path):
                continue
            if not is_live_window_fragment(path):
                continue
            if not path_matches_output_stem(path, stems):
                continue
            try:
                total += path.stat().st_size
            except Exception:
                pass

    return '', total

def stat_file_size(path):
    try:
        return os.path.getsize(path) if path and os.path.exists(path) else 0
    except Exception:
        return 0

def command_error_tail(result):
    text = ((result.stderr or '') + '\n' + (result.stdout or '')).strip()
    if not text:
        return ''
    return text[-800:]

def run_ffmpeg_command(cmd, timeout=900):
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding=subprocess_output_encoding(),
        errors='replace',
        timeout=timeout,
        **managed_run_kwargs(),
    )

def parse_ffmpeg_progress_duration(output):
    text = str(output or '')
    values = re.findall(r'^out_time_(?:us|ms)=(\d+)\s*$', text, flags=re.MULTILINE)
    if values:
        try:
            return int(values[-1]) / 1000000
        except Exception:
            return 0
    matches = re.findall(r'^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)\s*$', text, flags=re.MULTILINE)
    if matches:
        try:
            hours, minutes, seconds = matches[-1]
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        except Exception:
            return 0
    return 0

def measure_stream_duration(ffmpeg_path, filepath, stream_selector, timeout=300):
    if not ffmpeg_path or not filepath or not os.path.exists(filepath):
        return 0
    cmd = [
        ffmpeg_path,
        '-hide_banner',
        '-v', 'error',
        '-nostats',
        '-i', filepath,
        '-map', stream_selector,
        '-c', 'copy',
        '-f', 'null',
        '-',
        '-progress', 'pipe:1',
    ]
    try:
        result = run_ffmpeg_command(cmd, timeout=timeout)
    except Exception:
        return 0
    if result.returncode != 0:
        return 0
    return parse_ffmpeg_progress_duration(result.stdout)

def stream_duration_mismatch_error(ffmpeg_path, filepath):
    video_duration = measure_stream_duration(ffmpeg_path, filepath, '0:v:0')
    audio_duration = measure_stream_duration(ffmpeg_path, filepath, '0:a:0')
    if video_duration <= 0 or audio_duration <= 0:
        return ''
    delta = abs(video_duration - audio_duration)
    tolerance = max(2.0, min(video_duration, audio_duration) * 0.02)
    if delta <= tolerance:
        return ''
    return f'stream duration mismatch: video {video_duration:.3f}s, audio {audio_duration:.3f}s'

def validate_media_output(ffmpeg_path, filepath, timeout=900, require_stream_parity=False):
    if not ffmpeg_path:
        return False, 'ffmpeg not installed'
    if not filepath or not os.path.exists(filepath):
        return False, 'output file not found'
    if stat_file_size(filepath) <= 0:
        return False, 'output file is empty'
    cmd = [
        ffmpeg_path,
        '-hide_banner',
        '-loglevel', 'error',
        '-i', filepath,
        '-map', '0',
        '-c', 'copy',
        '-f', 'null',
        '-',
    ]
    try:
        result = run_ffmpeg_command(cmd, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, 'ffmpeg validation timeout'
    except Exception as e:
        return False, str(e)
    if result.returncode == 0:
        if require_stream_parity:
            mismatch = stream_duration_mismatch_error(ffmpeg_path, filepath)
            if mismatch:
                return False, mismatch
        return True, ''
    return False, command_error_tail(result) or f'ffmpeg validation failed ({result.returncode})'

def temporary_output_path(filepath, suffix_override=''):
    source = Path(filepath)
    suffix = suffix_override or source.suffix or '.mp4'
    if suffix and not suffix.startswith('.'):
        suffix = f'.{suffix}'
    stamp = f'{os.getpid()}_{int(time.time() * 1000)}'
    candidate = source.with_name(f'.{source.stem}.medianab_tmp_{stamp}{suffix}')
    index = 2
    while candidate.exists():
        candidate = source.with_name(f'.{source.stem}.medianab_tmp_{stamp}_{index}{suffix}')
        index += 1
    return str(candidate)

def repair_ts_output(ffmpeg_path, source_path, target_path):
    cmd = [
        ffmpeg_path,
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-fflags', '+genpts',
        '-i', source_path,
        '-map', '0',
        '-c', 'copy',
        '-mpegts_flags', '+resend_headers',
        target_path,
    ]
    return run_ffmpeg_command(cmd, timeout=1800)

def repair_mp4_output(ffmpeg_path, source_path, target_path):
    video_duration = measure_stream_duration(ffmpeg_path, source_path, '0:v:0')
    cmd = [
        ffmpeg_path,
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-fflags', '+genpts',
        '-i', source_path,
        '-map', '0:v:0?',
        '-map', '0:a:0?',
    ]
    if video_duration > 0:
        cmd.extend(['-t', f'{video_duration:.6f}'])
    cmd.extend([
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-af', 'aresample=async=1:first_pts=0',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        target_path,
    ])
    result = run_ffmpeg_command(cmd, timeout=3600)
    if result.returncode == 0:
        return result
    fallback = [
        ffmpeg_path,
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-fflags', '+genpts',
        '-i', source_path,
        '-map', '0',
    ]
    if video_duration > 0:
        fallback.extend(['-t', f'{video_duration:.6f}'])
    fallback.extend([
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        target_path,
    ])
    fallback_result = run_ffmpeg_command(fallback, timeout=1800)
    if fallback_result.returncode == 0:
        return fallback_result
    fallback_result.stderr = (result.stderr or '') + '\n' + (fallback_result.stderr or '')
    return fallback_result

def finalize_youtube_live_now_ts_as_mp4(ffmpeg_path, original_path, original_size, download_id):
    source = Path(original_path)
    final_mp4_path = str(uniquify_output_path(str(source.parent), f'{source.stem}.mp4'))
    temp_mp4_path = temporary_output_path(final_mp4_path, '.mp4')
    repair_error = ''
    try:
        repair_result = repair_mp4_output(ffmpeg_path, original_path, temp_mp4_path)
    except subprocess.TimeoutExpired:
        repair_result = None
        repair_error = 'ffmpeg mp4 remux timeout'
    except Exception as e:
        repair_result = None
        repair_error = str(e)
    else:
        repair_error = command_error_tail(repair_result) if repair_result and repair_result.returncode != 0 else ''

    temp_size = stat_file_size(temp_mp4_path)
    if repair_result and repair_result.returncode == 0 and temp_size > 0:
        temp_ok, fixed_error = validate_media_output(
            ffmpeg_path,
            temp_mp4_path,
            require_stream_parity=True,
        )
        if temp_ok:
            try:
                os.replace(temp_mp4_path, final_mp4_path)
                try:
                    os.remove(original_path)
                except Exception as e:
                    send_debug('companion.download', 'Could not remove original YouTube live TS after MP4 remux', {
                        'original_filepath': original_path,
                        'final_filepath': final_mp4_path,
                        'error': str(e),
                    }, level='warn', download_id=download_id)
                return {
                    'ok': True,
                    'filepath': final_mp4_path,
                    'filesize': stat_file_size(final_mp4_path),
                    'original_filepath': original_path,
                }
            except Exception as e:
                repair_error = str(e)
        else:
            repair_error = fixed_error

    if temp_mp4_path and os.path.exists(temp_mp4_path):
        try:
            os.remove(temp_mp4_path)
        except Exception:
            pass
    send_debug('companion.download', 'YouTube live TS to MP4 remux failed; keeping original TS', {
        'original_filepath': original_path,
        'original_filesize': original_size,
        'error': repair_error,
    }, level='warn', download_id=download_id)
    return {
        'ok': False,
        'error': repair_error,
    }

def send_live_finalize_progress(download_id, stage, message, filepath='', filesize=0):
    send_message({
        'type': 'progress',
        'download_id': download_id,
        'percent': 0,
        'speed': '',
        'eta': '',
        'stage': stage,
        'message': message,
        'filepath': filepath,
        'filesize': filesize,
    })

def finalize_live_output(active, filepath, filesize, ffmpeg_path, download_id):
    result = {
        'result_status': 'done',
        'filepath': filepath or '',
        'filesize': filesize or stat_file_size(filepath),
        'original_filepath': filepath or '',
        'warning': '',
        'error': '',
    }
    if not isinstance(active, dict):
        return result
    is_youtube_live_record = bool(active.get('live_record') and is_youtube_url(active.get('url', '')))
    if not is_youtube_live_record:
        return result

    original_path = filepath or ''
    original_size = filesize or stat_file_size(original_path)
    if not original_path or original_size <= 0:
        result.update({
            'result_status': 'failed',
            'filepath': '',
            'filesize': 0,
            'original_filepath': original_path,
            'error': 'Recording stopped, but no usable output file was preserved',
        })
        return result

    result.update({
        'filepath': original_path,
        'filesize': original_size,
        'original_filepath': original_path,
    })
    send_live_finalize_progress(
        download_id,
        'finalizing',
        '마무리 중',
        filepath=original_path,
        filesize=original_size,
    )

    if not ffmpeg_path:
        return result

    suffix = Path(original_path).suffix.lower()
    youtube_live_now_ts = bool(
        suffix == '.ts' and
        active.get('live_record_mode') == 'now' and
        not active.get('live_from_start')
    )
    if youtube_live_now_ts:
        send_live_finalize_progress(
            download_id,
            'normalizing',
            'MP4로 마무리 중',
            filepath=original_path,
            filesize=original_size,
        )
        mp4_result = finalize_youtube_live_now_ts_as_mp4(
            ffmpeg_path,
            original_path,
            original_size,
            download_id,
        )
        if mp4_result.get('ok'):
            result.update({
                'filepath': mp4_result.get('filepath', original_path),
                'filesize': mp4_result.get('filesize', original_size),
                'original_filepath': mp4_result.get('original_filepath', original_path),
            })
            return result
        result['warning'] = mp4_result.get('error', '') or 'MP4 remux failed; kept original TS'
        return result

    require_stream_parity = suffix == '.mp4'
    original_ok, original_error = validate_media_output(
        ffmpeg_path,
        original_path,
        require_stream_parity=require_stream_parity,
    )
    if original_ok:
        return result

    send_live_finalize_progress(
        download_id,
        'normalizing',
        '정규화 중',
        filepath=original_path,
        filesize=original_size,
    )
    temp_path = temporary_output_path(original_path)
    try:
        if suffix == '.ts':
            repair_result = repair_ts_output(ffmpeg_path, original_path, temp_path)
        else:
            repair_result = repair_mp4_output(ffmpeg_path, original_path, temp_path)
    except subprocess.TimeoutExpired:
        repair_result = None
        repair_error = 'ffmpeg repair timeout'
    except Exception as e:
        repair_result = None
        repair_error = str(e)
    else:
        repair_error = command_error_tail(repair_result) if repair_result and repair_result.returncode != 0 else ''

    temp_size = stat_file_size(temp_path)
    if repair_result and repair_result.returncode == 0 and temp_size > 0:
        temp_ok, fixed_error = validate_media_output(
            ffmpeg_path,
            temp_path,
            require_stream_parity=require_stream_parity,
        )
        if temp_ok:
            try:
                os.replace(temp_path, original_path)
                result['filesize'] = stat_file_size(original_path)
                return result
            except Exception as e:
                repair_error = str(e)
        repair_error = fixed_error

    if temp_path and os.path.exists(temp_path):
        try:
            os.remove(temp_path)
        except Exception:
            pass
    return result

# ── 액션 핸들러 ──

def handle_check_status(msg):
    config = load_config()
    ytdlp = find_binary('yt-dlp', config.get('ytdlp_path', ''))
    ffmpeg = find_binary('ffmpeg', config.get('ffmpeg_path', ''))
    deno = find_binary('deno', config.get('deno_path', ''))

    return {
        'status': 'ok',
        'companion_version': VERSION,
        'ytdlp_installed': ytdlp is not None,
        'ytdlp_version': get_version(ytdlp) if ytdlp else None,
        'ytdlp_path': ytdlp,
        'ffmpeg_installed': ffmpeg is not None,
        'ffmpeg_version': get_version(ffmpeg) if ffmpeg else None,
        'ffmpeg_path': ffmpeg,
        'deno_installed': deno is not None,
        'deno_version': get_version(deno) if deno else None,
        'deno_path': deno,
        'download_path': normalize_download_path(config.get('download_path', str(Path.home() / 'Downloads'))),
        'platform': platform.system(),
        **get_cookie_auth_status(config),
    }

def handle_get_formats(msg):
    config = load_config()
    ytdlp = find_binary('yt-dlp', config.get('ytdlp_path', ''))
    if not ytdlp:
        return {'status': 'error', 'message': 'yt-dlp not installed'}
    ytdlp_version = get_version(ytdlp) or ''

    url = msg.get('url', '')
    if not url:
        return {'status': 'error', 'message': 'No URL provided'}

    try:
        cmd = [ytdlp, '-J', '--no-playlist']
        client_args_status = append_extractor_client_args(
            cmd,
            url,
            ytdlp_version,
            config,
            allow_cookie_auth=bool(msg.get('allow_cookie_auth')),
        )
        if client_args_status.get('status') == 'error':
            return client_args_status
        cmd.append(url)
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            message = r.stderr.strip() or 'yt-dlp failed'
            if is_cookie_auth_required_message(message):
                return cookie_auth_required_response(message)
            return {'status': 'error', 'message': message}

        info = json.loads(r.stdout)
        formats_raw = info.get('formats', [])

        # 비디오+오디오 합치기 가능한 포맷 계산
        video_fmts = [f for f in formats_raw if f.get('vcodec', 'none') != 'none' and f.get('acodec', 'none') == 'none']
        audio_fmts = [f for f in formats_raw if f.get('acodec', 'none') != 'none' and f.get('vcodec', 'none') == 'none']
        combined = [f for f in formats_raw if f.get('vcodec', 'none') != 'none' and f.get('acodec', 'none') != 'none']

        best_audio = None
        if audio_fmts:
            mp4_audio_fmts = [
                f for f in audio_fmts
                if f.get('ext') == 'm4a' or str(f.get('acodec', '')).startswith('mp4a')
            ]
            best_audio = max(mp4_audio_fmts or audio_fmts, key=lambda f: f.get('abr', 0) or f.get('tbr', 0) or 0)

        result_formats = []
        seen_heights = set()

        # 비디오+오디오 합성 포맷 (호환 코덱 우선 + 해상도 높은 순)
        for vf in sorted(video_fmts, key=lambda f: (codec_score(f.get('vcodec', '')), f.get('height', 0) or 0), reverse=True):
            height = vf.get('height', 0)
            if not height or height in seen_heights:
                continue
            ext = 'mp4' if vf.get('ext') == 'mp4' or vf.get('vcodec', '').startswith('avc') else vf.get('ext', 'mp4')
            fmt_id = f"{vf['format_id']}+{best_audio['format_id']}" if best_audio else vf['format_id']
            vsize = vf.get('filesize') or vf.get('filesize_approx') or 0
            asize = (best_audio.get('filesize') or best_audio.get('filesize_approx') or 0) if best_audio else 0
            result_formats.append({
                'id': fmt_id,
                'label': display_quality_label(vf),
                'height': height,
                'width': vf.get('width', 0) or 0,
                'resolution': display_resolution(vf),
                'format_note': vf.get('format_note', ''),
                'ext': ext,
                'filesize': vsize + asize,
                'vcodec': vf.get('vcodec', ''),
                'acodec': best_audio.get('acodec', '') if best_audio else '',
            })
            seen_heights.add(height)

        # 이미 합쳐진 포맷 (audio+video)
        for cf in sorted(combined, key=lambda f: (codec_score(f.get('vcodec', '')), f.get('height', 0) or 0), reverse=True):
            height = cf.get('height', 0)
            if not height or height in seen_heights:
                continue
            result_formats.append({
                'id': cf['format_id'],
                'label': display_quality_label(cf),
                'height': height,
                'width': cf.get('width', 0) or 0,
                'resolution': display_resolution(cf),
                'format_note': cf.get('format_note', ''),
                'ext': cf.get('ext', 'mp4'),
                'filesize': cf.get('filesize') or cf.get('filesize_approx') or 0,
                'vcodec': cf.get('vcodec', ''),
                'acodec': cf.get('acodec', ''),
            })
            seen_heights.add(height)

        # 최종 정렬: 코덱 호환성 우선 + 해상도
        result_formats.sort(key=lambda f: (codec_score(f.get('vcodec', '')), f['height']), reverse=True)

        return {
            'status': 'ok',
            'title': info.get('title', ''),
            'thumbnail': info.get('thumbnail', ''),
            'duration': info.get('duration', 0),
            'uploader': info.get('uploader', ''),
            'webpage_url': info.get('webpage_url', url),
            'is_live': bool(info.get('is_live')),
            'was_live': bool(info.get('was_live')),
            'live_status': info.get('live_status', ''),
            'ytdlp_version': ytdlp_version,
            'formats': result_formats,
        }

    except subprocess.TimeoutExpired:
        return {'status': 'error', 'message': 'yt-dlp timeout (30s)'}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def handle_download(msg):
    config = load_config()
    ytdlp = find_binary('yt-dlp', config.get('ytdlp_path', ''))
    if not ytdlp:
        return {'status': 'error', 'message': 'yt-dlp not installed'}
    ytdlp_version = get_version(ytdlp) or ''

    url = msg.get('url', '')
    requested_format_id = (msg.get('requested_format_id') or msg.get('format_id') or '').strip()
    quality_height = parse_positive_int(msg.get('quality_height'), 0)
    quality_label = (msg.get('quality_label') or '').strip()
    quality_resolution = (msg.get('quality_resolution') or '').strip()
    direct_media = is_direct_media_url(url)
    referer = (msg.get('referer') or '').strip()
    audio_url = (msg.get('audio_url') or '').strip()
    video_ext = (msg.get('video_ext') or '').strip()
    audio_ext = (msg.get('audio_ext') or '').strip()
    download_path = normalize_download_path(msg.get('download_path', config.get('download_path', str(Path.home() / 'Downloads'))))
    download_id = msg.get('download_id', f"dl_{id(msg)}")
    file_name = sanitize_output_name(msg.get('file_name', ''))
    keep_partial = bool(msg.get('keep_partial'))
    live_record = bool(msg.get('live_record'))
    live_record_mode = 'window' if msg.get('live_record_mode') == 'window' else 'now'
    allow_cookie_auth = bool(msg.get('allow_cookie_auth'))
    if is_youtube_request_blocked(url, live_record=live_record):
        return {'status': 'blocked_by_channel_policy', 'message': get_variant_policy_message()}
    live_from_start = bool(live_record and live_record_mode == 'window' and is_youtube_url(url))
    youtube_live_record = bool(live_record and is_youtube_url(url))
    youtube_height_selector = build_youtube_height_selector(quality_height) if is_youtube_url(url) and (not live_record or live_from_start) else ''
    if requested_format_id:
        format_id = requested_format_id
    elif direct_media or youtube_live_record:
        format_id = ''
    elif youtube_height_selector:
        format_id = youtube_height_selector
    else:
        format_id = get_default_format(url, ytdlp_version)

    if not url:
        return {'status': 'error', 'message': 'No URL provided'}

    # 다운로드 디렉터리 확인/생성
    Path(download_path).mkdir(parents=True, exist_ok=True)

    ffmpeg_path = find_binary('ffmpeg', config.get('ffmpeg_path', ''))
    if audio_url:
        if not ffmpeg_path:
            return {'status': 'error', 'message': 'ffmpeg not installed'}

        output_ext = choose_merged_output_ext(video_ext or detect_media_ext(url), audio_ext or detect_media_ext(audio_url, 'm4a'))
        output_name = ensure_extension(file_name or 'video', f'.{output_ext}')
        output_path = uniquify_output_path(download_path, output_name)
        header_arg = build_ffmpeg_header_arg(referer)
        cmd = [
            ffmpeg_path,
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-headers', header_arg,
            '-i', url,
            '-headers', header_arg,
            '-i', audio_url,
            '-c', 'copy',
            str(output_path),
        ]

        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                **managed_popen_kwargs(),
            )
            _active_downloads[download_id] = {
                'proc': proc,
                'download_path': download_path,
                'file_name': Path(output_path).stem,
            }

            def stream_ffmpeg_merge():
                recent_lines = []
                try:
                    for line in proc.stdout:
                        line = clean_output_line(line)
                        if not line:
                            continue
                        recent_lines.append(line)
                        if len(recent_lines) > 8:
                            recent_lines.pop(0)

                    proc.wait()
                    if proc.returncode == 0:
                        filesize = os.path.getsize(output_path) if os.path.exists(output_path) else 0
                        send_message({
                            'type': 'complete',
                            'download_id': download_id,
                            'filepath': str(output_path),
                            'filesize': filesize,
                        })
                    else:
                        tail = ' | '.join(recent_lines[-3:]).strip()
                        send_message({
                            'type': 'error',
                            'download_id': download_id,
                            'message': f'ffmpeg exited with code {proc.returncode}' + (f' - {tail}' if tail else ''),
                        })
                except Exception as e:
                    send_message({
                        'type': 'error',
                        'download_id': download_id,
                        'message': str(e),
                    })
                finally:
                    _active_downloads.pop(download_id, None)

            threading.Thread(target=stream_ffmpeg_merge, daemon=True).start()
            return {'status': 'started', 'download_id': download_id}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    if not direct_media and not youtube_live_record and not ffmpeg_path and (not format_id or '+' in format_id or format_id == 'bestvideo+bestaudio/best'):
        format_id = f'best[height<={quality_height}]/best' if quality_height > 0 and is_youtube_url(url) else DEFAULT_NO_FFMPEG_FORMAT

    output_path = None
    if direct_media and file_name and not live_record:
        output_ext = detect_media_ext(url, 'mp4')
        output_name = ensure_extension(file_name, f'.{output_ext}')
        output_path = uniquify_output_path(download_path, output_name)
        output_template = str(output_path)
        file_name = output_path.stem
    elif file_name and is_youtube_url(url) and not live_record:
        output_name = ensure_extension(file_name, '.mp4')
        output_path = uniquify_output_path(download_path, output_name)
        output_template = str(output_path)
        file_name = output_path.stem
    elif file_name:
        if live_record:
            output_ext = 'mp4' if live_from_start and is_youtube_url(url) else 'ts'
            output_name = ensure_extension(file_name, f'.{output_ext}')
            output_path = uniquify_output_path(download_path, output_name)
            output_template = str(output_path)
            file_name = output_path.stem
        else:
            output_template = join_output_path(download_path, f'{file_name}.%(ext)s')
    else:
        output_template = join_output_path(download_path, '%(title)s.%(ext)s')
    cmd = [
        ytdlp,
        '-o', output_template,
        '--no-playlist',
        '--newline',  # 진행률을 줄 단위로 출력
        '--progress-template', 'download:download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    ]
    client_args_status = append_extractor_client_args(
        cmd,
        url,
        ytdlp_version,
        config,
        allow_cookie_auth=allow_cookie_auth,
    )
    if client_args_status.get('status') == 'error':
        return client_args_status
    if referer:
        cmd.extend(['--referer', referer, '--add-header', f'Referer:{referer}'])
    if direct_media:
        cmd.extend(['--add-header', 'User-Agent:Mozilla/5.0'])

    # format_id 지정 (비어있으면 생략)
    if format_id:
        cmd.extend(['-f', format_id])
    if (format_id and '+' in format_id and not live_record) or live_from_start:
        cmd.extend(['--merge-output-format', 'mp4'])

    if ffmpeg_path and not direct_media:
        cmd.extend(['--ffmpeg-location', ffmpeg_path])
        if live_record:
            cmd.extend(['--no-write-thumbnail'])
        else:
            cmd.extend([
                '--embed-metadata',
                '--embed-thumbnail',
                '--convert-thumbnails', 'jpg',
            ])
    if live_record:
        if live_from_start:
            cmd.append('--live-from-start')
        cmd.extend(['--hls-use-mpegts', '--no-part'])
    cmd.append(url)

    try:
        send_debug('companion.download', 'yt-dlp process spawning', {
            'platform': platform.system(),
            'format_id': format_id,
            'requested_format_id': requested_format_id,
            'format_selector': format_id,
            'quality_label': quality_label,
            'quality_resolution': quality_resolution,
            'quality_height': quality_height,
            'height_selector': youtube_height_selector,
            'retried_without_format': False,
            'direct_media': direct_media,
            'has_ffmpeg': bool(ffmpeg_path),
            'download_path': download_path,
            'output_template': output_template,
            'download_path_exists': os.path.isdir(download_path),
            'cwd': os.getcwd(),
            'file_name': file_name,
            'live_record': live_record,
            'live_record_mode': live_record_mode if live_record else '',
            'live_from_start': live_from_start,
            'cookie_auth_mode': client_args_status.get('cookie_auth_mode', 'off'),
            'cookie_auth_allowed': bool(client_args_status.get('cookie_auth_allowed')),
            'cookie_auth_enabled': bool(client_args_status.get('cookie_auth_enabled')),
            'cookie_auth_file_configured': bool(client_args_status.get('cookie_auth_file_configured')),
            'cmd_preview': mask_ytdlp_cmd(cmd)[:24],
        }, download_id=download_id)
        windows_live_console = bool(youtube_live_record and platform.system() == 'Windows')
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding=subprocess_output_encoding(),
            errors='replace',
            bufsize=1,
            **managed_popen_kwargs(create_hidden_console=windows_live_console),
        )
        _active_downloads[download_id] = {
            'proc': proc,
            'download_path': download_path,
            'file_name': file_name,
            'keep_partial': keep_partial,
            'filepath': '',
            'output_path': str(output_path) if output_path else '',
            'fragment_paths': [],
            'windows_live_console': windows_live_console,
            'live_from_start': live_from_start,
            'live_record_mode': live_record_mode if live_record else '',
            'live_record': live_record,
            'url': url,
        }
        proc_holder = {'proc': proc}
        cmd_holder = {'cmd': cmd}

        # 진행률 파싱 + 전송 (별도 스레드에서 stdout 읽기)
        output_state = {'count': 0, 'last': time.time()}
        progress_state = {'filepath': '', 'started_at': time.time()}

        def output_watchdog():
            time.sleep(8)
            current_proc = proc_holder.get('proc')
            if current_proc and current_proc.poll() is None and output_state['count'] == 0:
                send_debug('companion.download', 'yt-dlp produced no output yet', {
                    'platform': platform.system(),
                    'download_path': download_path,
                    'output_template': output_template,
                    'path_exists': os.path.isdir(download_path),
                    'cwd': os.getcwd(),
                }, level='warn', download_id=download_id)

        def stream_progress():
            nonlocal format_id
            filepath = ''
            last_progress_time = 0
            recent_lines = []
            debug_lines_sent = 0
            retried_without_format = False
            try:
                while True:
                    current_proc = proc_holder.get('proc')
                    if not current_proc:
                        raise RuntimeError('yt-dlp process was not started')
                    for line in current_proc.stdout:
                        line = clean_output_line(line)
                        if not line:
                            continue
                        output_state['count'] += 1
                        output_state['last'] = time.time()

                        recent_lines.append(line)
                        if len(recent_lines) > 8:
                            recent_lines.pop(0)
                        debug_line = sanitize_ytdlp_debug_line(line)
                        if debug_line and debug_lines_sent < 12 and (debug_lines_sent < 3 or should_forward_ytdlp_line(debug_line)):
                            send_debug('companion.download', 'yt-dlp output', {
                                'line': debug_line[:500],
                            }, level='warn' if ('ERROR:' in debug_line or 'WARNING:' in debug_line) else 'info', download_id=download_id)
                            debug_lines_sent += 1

                        # progress template 파싱: "download:12.3%|1.2MiB/s|00:32" 또는 "12.3%|1.2MiB/s|00:32"
                        template_progress = parse_template_progress(line)
                        if template_progress and not live_from_start:
                            pct, speed_raw, eta_raw = template_progress
                            current_time = time.time()
                            if current_time - last_progress_time >= 0.5:
                                send_message({
                                    'type': 'progress',
                                    'download_id': download_id,
                                    'percent': pct,
                                    'speed': speed_raw,
                                    'eta': eta_raw,
                                })
                                last_progress_time = current_time

                        # 진행률 템플릿이 작동하지 않을 경우를 위한 폴백
                        # "[download]   5.2% of 10.00MiB at 1.2MiB/s ETA 00:32"
                        elif not live_from_start and line.startswith('[download]') and '%' in line:
                            match = re.search(r'(\d+\.?\d*)%', line)
                            if match:
                                try:
                                    pct = float(match.group(1))
                                except ValueError:
                                    continue
                                speed_match = re.search(r'at\s+([~]?[\d\.\w/]+)', line)
                                eta_match = re.search(r'ETA\s+([\d:]+)', line)
                                current_time = time.time()
                                if current_time - last_progress_time >= 0.5:
                                    send_message({
                                        'type': 'progress',
                                        'download_id': download_id,
                                        'percent': pct,
                                        'speed': normalize_progress_field(speed_match.group(1) if speed_match else ''),
                                        'eta': normalize_progress_field(eta_match.group(1) if eta_match else ''),
                                    })
                                    last_progress_time = current_time

                        # 파일 경로 추출: [Merger] Merging formats into "..."
                        if '[Merger]' in line or '[download]' in line:
                            match = re.search(r'"(.+?)"', line)
                            if match:
                                filepath = match.group(1)
                                progress_state['filepath'] = filepath
                                if download_id in _active_downloads:
                                    _active_downloads[download_id]['filepath'] = filepath

                        # 완료 후 최종 파일 경로: [download] ... has already been downloaded
                        if 'Destination:' in line:
                            match = re.search(r'Destination:\s*(.+)', line)
                            if match:
                                filepath = match.group(1).strip()
                                progress_state['filepath'] = filepath
                                if download_id in _active_downloads:
                                    _active_downloads[download_id]['filepath'] = filepath
                                    if live_from_start:
                                        paths = _active_downloads[download_id].setdefault('fragment_paths', [])
                                        if filepath not in paths:
                                            paths.append(filepath)

                    current_proc.wait()

                    if download_id in _cancelled_downloads:
                        return

                    if current_proc.returncode == 0:
                        filesize = 0
                        if is_missing_or_suspect_path(filepath):
                            found_path, found_size = find_existing_output(download_path, file_name)
                            if found_path:
                                filepath, filesize = found_path, found_size
                        elif filepath and os.path.exists(filepath):
                            try:
                                filesize = os.path.getsize(filepath)
                            except Exception:
                                filesize = 0
                        active = _active_downloads.get(download_id, {})
                        final_result = finalize_live_output(active, filepath, filesize, ffmpeg_path, download_id)
                        send_message({
                            'type': 'complete',
                            'download_id': download_id,
                            'filepath': final_result.get('filepath', filepath),
                            'filesize': final_result.get('filesize', filesize),
                            'result_status': final_result.get('result_status', 'done'),
                            'original_filepath': final_result.get('original_filepath', filepath),
                            'warning': final_result.get('warning', ''),
                            'error': final_result.get('error', ''),
                        })
                        return

                    tail = ' | '.join(filter(None, (sanitize_ytdlp_debug_line(line) for line in recent_lines[-3:]))).strip()
                    if (
                        is_youtube_url(url) and
                        format_id and
                        not retried_without_format and
                        is_requested_format_unavailable(recent_lines) and
                        ((youtube_height_selector and format_id != youtube_height_selector) or live_from_start)
                    ):
                        retried_without_format = True
                        retry_selector = youtube_height_selector if youtube_height_selector and format_id != youtube_height_selector else ''
                        retry_cmd = set_ytdlp_format_arg(cmd_holder['cmd'], retry_selector)
                        send_debug('companion.download', 'Retrying YouTube download with fallback format selector', {
                            'requested_format_id': format_id,
                            'quality_label': quality_label,
                            'quality_resolution': quality_resolution,
                            'quality_height': quality_height,
                            'fallback_format_selector': retry_selector,
                            'live_record_mode': live_record_mode,
                            'live_from_start': live_from_start,
                            'retried_without_format': True,
                            'retried_to_best': not bool(retry_selector),
                            'error_tail': tail[:500],
                            'cmd_preview': mask_ytdlp_cmd(retry_cmd)[:24],
                        }, level='warn', download_id=download_id)
                        if live_record and live_from_start and not retry_selector:
                            send_message({
                                'type': 'warning',
                                'download_id': download_id,
                                'warning_code': 'live_quality_fallback_best',
                                'message': '선택 화질을 사용할 수 없어 Best로 녹화 중입니다.',
                                'data': {
                                    'requested_format_id': format_id,
                                    'quality_label': quality_label,
                                    'quality_resolution': quality_resolution,
                                    'quality_height': quality_height,
                                    'fallback_format_selector': retry_selector,
                                    'retried_to_best': True,
                                },
                            })
                        retry_proc = subprocess.Popen(
                            retry_cmd,
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT,
                            text=True,
                            encoding=subprocess_output_encoding(),
                            errors='replace',
                            bufsize=1,
                            **managed_popen_kwargs(create_hidden_console=windows_live_console),
                        )
                        format_id = retry_selector
                        cmd_holder['cmd'] = retry_cmd
                        proc_holder['proc'] = retry_proc
                        if download_id in _active_downloads:
                            _active_downloads[download_id]['proc'] = retry_proc
                            _active_downloads[download_id]['filepath'] = ''
                        filepath = ''
                        progress_state['filepath'] = ''
                        recent_lines = []
                        debug_lines_sent = 0
                        continue

                    if is_cookie_auth_required_message(tail or '\n'.join(recent_lines)):
                        send_message({
                            'type': 'error',
                            'download_id': download_id,
                            'error_code': 'cookie_auth_required',
                            'message': COOKIE_AUTH_REQUIRED_MESSAGE,
                            'raw_message': tail[:800],
                        })
                    else:
                        send_message({
                            'type': 'error',
                            'download_id': download_id,
                            'message': f'yt-dlp exited with code {current_proc.returncode}' + (f' - {tail}' if tail else ''),
                        })
                    return
            except Exception as e:
                send_message({
                    'type': 'error',
                    'download_id': download_id,
                    'message': str(e),
                })
            finally:
                _cancelled_downloads.discard(download_id)
                _active_downloads.pop(download_id, None)

        def live_progress_reporter():
            last_size = 0
            last_time = time.time()
            while download_id in _active_downloads and download_id not in _cancelled_downloads:
                current_proc = _active_downloads.get(download_id, {}).get('proc') or proc_holder.get('proc')
                if not current_proc or current_proc.poll() is not None:
                    time.sleep(0.5)
                    continue
                time.sleep(2)
                now = time.time()
                filepath = progress_state.get('filepath') or ''
                filesize = 0
                if live_from_start and platform.system() == 'Windows':
                    filepath, filesize = measure_live_window_recording_size(
                        download_path,
                        file_name,
                        str(output_path) if output_path else '',
                        _active_downloads.get(download_id, {}).get('fragment_paths', []),
                    )
                    if filepath:
                        progress_state['filepath'] = filepath
                        if download_id in _active_downloads:
                            _active_downloads[download_id]['filepath'] = filepath
                elif is_missing_or_suspect_path(filepath):
                    filepath, _ = find_existing_output(download_path, file_name)
                    if filepath:
                        progress_state['filepath'] = filepath
                        if download_id in _active_downloads:
                            _active_downloads[download_id]['filepath'] = filepath
                if not (live_from_start and platform.system() == 'Windows') and filepath and os.path.exists(filepath):
                    try:
                        filesize = os.path.getsize(filepath)
                    except Exception:
                        filesize = 0
                interval = max(now - last_time, 0.001)
                speed = format_speed_bytes(max(filesize - last_size, 0) / interval)
                last_size = filesize
                last_time = now
                send_message({
                    'type': 'progress',
                    'download_id': download_id,
                    'percent': 0,
                    'speed': speed,
                    'eta': '',
                    'elapsedSec': int(max(now - progress_state['started_at'], 0)),
                    'filesize': filesize,
                })

        t = threading.Thread(target=stream_progress, daemon=True)
        t.start()
        threading.Thread(target=output_watchdog, daemon=True).start()
        if live_record:
            threading.Thread(target=live_progress_reporter, daemon=True).start()

        return {
            'status': 'started',
            'download_id': download_id,
        }

    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def handle_cancel(msg):
    download_id = msg.get('download_id', '')
    active = _active_downloads.get(download_id)
    proc = active.get('proc') if isinstance(active, dict) else active
    if proc:
        keep_partial = bool(active.get('keep_partial')) if isinstance(active, dict) else False
        live_window_record = bool(
            isinstance(active, dict) and (
                active.get('live_from_start') or active.get('live_record_mode') == 'window'
            )
        )
        live_youtube_record = bool(
            isinstance(active, dict) and
            active.get('live_record') and
            is_youtube_url(active.get('url', ''))
        )
        _cancelled_downloads.add(download_id)
        stop_timeout = 45 if platform.system() == 'Windows' and live_youtube_record else 8
        stop_process_tree(
            proc,
            timeout=stop_timeout,
            prefer_console_ctrl=bool(
                platform.system() == 'Windows' and
                live_youtube_record and
                isinstance(active, dict) and
                active.get('windows_live_console')
            ),
        )
        fallback_stopped = []
        if isinstance(active, dict):
            fallback_stopped = stop_matching_download_processes(
                active.get('download_path', ''),
                active.get('file_name', ''),
                download_id,
            )
        still_running = proc.poll() is None
        removed = []
        filepath, filesize = '', 0
        final_result = {}
        if isinstance(active, dict):
            if keep_partial:
                if live_window_record:
                    filepath, filesize = find_live_window_final_output(
                        active.get('download_path', ''),
                        active.get('file_name', ''),
                        active.get('output_path', ''),
                    )
                else:
                    remembered_path = active.get('filepath', '') or ''
                    candidate_paths = [remembered_path]
                    if remembered_path and not remembered_path.endswith('.part'):
                        candidate_paths.append(f'{remembered_path}.part')
                    for candidate in candidate_paths:
                        if candidate and os.path.exists(candidate):
                            filepath = candidate
                            try:
                                filesize = os.path.getsize(candidate)
                            except Exception:
                                filesize = 0
                            break
                    if not filepath:
                        filepath, filesize = find_existing_output(active.get('download_path', ''), active.get('file_name', ''))
            else:
                removed = cleanup_cancelled_files(active.get('download_path', ''), active.get('file_name', ''))
            if keep_partial and live_youtube_record:
                config = load_config()
                ffmpeg_path = find_binary('ffmpeg', config.get('ffmpeg_path', ''))
                final_result = finalize_live_output(active, filepath, filesize, ffmpeg_path, download_id)
                filepath = final_result.get('filepath', filepath)
                filesize = final_result.get('filesize', filesize)
        send_debug('companion.download', 'Cancel process stop checked', {
            'download_id': download_id,
            'still_running': still_running,
            'fallback_stopped': fallback_stopped,
            'kept': keep_partial,
            'filepath': filepath,
            'filesize': filesize,
            'result_status': final_result.get('result_status', ''),
        }, level='warn' if still_running or fallback_stopped else 'info', download_id=download_id)
        _active_downloads.pop(download_id, None)
        return {
            'status': 'cancelled',
            'download_id': download_id,
            'removed': removed,
            'kept': keep_partial,
            'filepath': filepath,
            'filesize': filesize,
            'result_status': final_result.get('result_status', ''),
            'original_filepath': final_result.get('original_filepath', ''),
            'warning': final_result.get('warning', ''),
            'error': final_result.get('error', ''),
        }
    return {'status': 'error', 'message': 'Download not found'}

def handle_stream_start(msg):
    download_id = msg.get('download_id', '')
    if not download_id:
        return {'status': 'error', 'message': 'download_id required'}
    if download_id in _active_streams:
        return {'status': 'started', 'download_id': download_id, 'filepath': _active_streams[download_id]['filepath']}

    config = load_config()
    download_path = normalize_download_path(msg.get('download_path', config.get('download_path', str(Path.home() / 'Downloads'))))
    container_ext = normalize_container_ext(msg.get('container_ext', ''))
    file_name = ensure_extension(msg.get('file_name', ''), f'.{container_ext}')
    finalpath = uniquify_output_path(download_path, file_name)
    filepath = Path(str(finalpath) + '.part')
    try:
        if filepath.exists():
            filepath.unlink()
    except Exception:
        pass

    try:
        fh = open(filepath, 'wb')
        _active_streams[download_id] = {
            'file': fh,
            'filepath': str(filepath),
            'finalpath': str(finalpath),
            'size': 0,
        }
        return {'status': 'started', 'download_id': download_id, 'filepath': str(finalpath)}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def handle_stream_write(msg):
    download_id = msg.get('download_id', '')
    active = _active_streams.get(download_id)
    if not active:
        return {'status': 'error', 'message': 'Stream not found'}

    try:
        chunk = bytes(msg.get('bytes', []))
        if chunk:
            active['file'].write(chunk)
            active['size'] += len(chunk)
        return {'status': 'ok', 'written': len(chunk)}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def handle_stream_finish(msg):
    download_id = msg.get('download_id', '')
    active = _active_streams.pop(download_id, None)
    if not active:
        return {'status': 'error', 'message': 'Stream not found'}

    try:
        active['file'].close()
        temp_path = active['filepath']
        filepath = active.get('finalpath', temp_path)
        container_ext = normalize_container_ext(msg.get('container_ext', ''))
        if temp_path and os.path.exists(temp_path):
            current_final = Path(filepath)
            desired_name = ensure_extension(msg.get('file_name', '') or current_final.stem, f'.{container_ext}')
            desired_path = current_final.parent / desired_name
            if desired_path.exists() and str(desired_path) != str(current_final):
                desired_path = uniquify_output_path(str(current_final.parent), desired_name)
            os.replace(temp_path, desired_path)
            filepath = str(desired_path)

        filesize = os.path.getsize(filepath) if filepath and os.path.exists(filepath) else active.get('size', 0)
        return {
            'status': 'complete',
            'download_id': download_id,
            'filepath': filepath,
            'filesize': filesize,
        }
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def handle_stream_cancel(msg):
    download_id = msg.get('download_id', '')
    active = _active_streams.pop(download_id, None)
    if not active:
        return {'status': 'cancelled', 'download_id': download_id, 'removed': []}

    removed = []
    try:
        try:
            active['file'].close()
        except Exception:
            pass
        if os.path.exists(active['filepath']):
            os.remove(active['filepath'])
            removed.append(active['filepath'])
        return {'status': 'cancelled', 'download_id': download_id, 'removed': removed}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def handle_set_config(msg):
    config = load_config()
    if 'download_path' in msg:
        path = normalize_download_path(msg['download_path'])
        # 경로 유효성 검사
        try:
            Path(path).mkdir(parents=True, exist_ok=True)
            config['download_path'] = path
        except Exception as e:
            return {'status': 'error', 'message': f'Invalid path: {e}'}
    if 'ytdlp_path' in msg:
        config['ytdlp_path'] = msg['ytdlp_path']
    if 'ffmpeg_path' in msg:
        config['ffmpeg_path'] = msg['ffmpeg_path']
    if 'deno_path' in msg:
        config['deno_path'] = msg['deno_path']
    if 'cookie_auth_mode' in msg:
        config['cookie_auth_mode'] = normalize_cookie_auth_mode(msg['cookie_auth_mode'])
    if 'cookie_auth_browser' in msg:
        config['cookie_auth_browser'] = normalize_cookie_auth_browser(msg['cookie_auth_browser'])
    if 'cookie_auth_file' in msg:
        cookies_file = normalize_local_path(msg['cookie_auth_file'])
        if cookies_file and not os.path.isfile(cookies_file):
            return {'status': 'error', 'message': f'cookies.txt file not found: {cookies_file}'}
        config['cookie_auth_file'] = cookies_file
    save_config(config)
    return {'status': 'ok', 'config': config}

def handle_update_ytdlp(msg):
    """yt-dlp 자체 업데이트"""
    config = load_config()
    ytdlp = find_binary('yt-dlp', config.get('ytdlp_path', ''))
    if not ytdlp:
        return {'status': 'error', 'message': 'yt-dlp not installed'}
    try:
        r = subprocess.run([ytdlp, '-U'], capture_output=True, text=True, timeout=60)
        output = '\n'.join(filter(None, [r.stdout.strip(), r.stderr.strip()])).strip()
        if r.returncode == 0 and 'Use that to update' not in output:
            return {'status': 'ok', 'output': output, 'version': get_version(ytdlp)}

        # pip/wheel 설치본은 yt-dlp -U가 실패하므로 현재 Python으로 직접 갱신
        if 'Use that to update' in output or 'PyPi' in output:
            pip = subprocess.run(
                [sys.executable, '-m', 'pip', 'install', '-U', 'yt-dlp'],
                capture_output=True,
                text=True,
                timeout=180,
            )
            pip_output = '\n'.join(filter(None, [pip.stdout.strip(), pip.stderr.strip()])).strip()
            if pip.returncode == 0:
                return {'status': 'ok', 'output': pip_output, 'version': get_version(ytdlp)}
            return {'status': 'error', 'message': pip_output or 'pip install failed'}

        return {'status': 'error', 'message': output or 'yt-dlp update failed'}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def handle_pick_folder(msg):
    """네이티브 폴더 선택 다이얼로그 표시"""
    config = load_config()
    current_path = msg.get('current_path', config.get('download_path', str(Path.home() / 'Downloads')))

    if platform.system() == 'Darwin':
        # macOS: osascript로 폴더 선택 다이얼로그
        script = f'''
        set defaultPath to POSIX file "{current_path}" as alias
        try
            set chosenFolder to choose folder with prompt "MediaNab 다운로드 폴더 선택" default location defaultPath
            return POSIX path of chosenFolder
        on error
            return ""
        end try
        '''
        try:
            r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=120)
            chosen = r.stdout.strip().rstrip('/')
            if chosen:
                config['download_path'] = chosen
                save_config(config)
                return {'status': 'ok', 'path': chosen}
            return {'status': 'cancelled'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    elif platform.system() == 'Windows':
        # Windows: PowerShell로 폴더 선택 다이얼로그
        ps_script = '''
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "MediaNab Download Folder"
        $dialog.SelectedPath = "%s"
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            Write-Output $dialog.SelectedPath
        }
        ''' % current_path.replace('"', '`"')
        try:
            r = subprocess.run(['powershell', '-Command', ps_script],
                             capture_output=True, text=True, timeout=120)
            chosen = r.stdout.strip()
            if chosen:
                config['download_path'] = chosen
                save_config(config)
                return {'status': 'ok', 'path': chosen}
            return {'status': 'cancelled'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    return {'status': 'error', 'message': 'Unsupported platform'}

def applescript_string(value):
    return str(value or '').replace('\\', '\\\\').replace('"', '\\"')

def powershell_string(value):
    return "'" + str(value or '').replace("'", "''") + "'"

def handle_pick_cookies_file(msg):
    """cookies.txt 파일 선택"""
    current_path = normalize_local_path(msg.get('current_path', ''))
    default_dir = str(Path(current_path).parent if current_path and os.path.exists(current_path) else Path.home() / 'Downloads')

    if platform.system() == 'Darwin':
        script = f'''
        set defaultPath to POSIX file "{applescript_string(default_dir)}" as alias
        try
            set chosenFile to choose file with prompt "MediaNab cookies.txt 선택" default location defaultPath
            return POSIX path of chosenFile
        on error
            return ""
        end try
        '''
        try:
            r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=120)
            chosen = normalize_local_path(r.stdout.strip())
            if chosen:
                if not os.path.isfile(chosen):
                    return {'status': 'error', 'message': f'File not found: {chosen}'}
                return {'status': 'ok', 'path': chosen}
            return {'status': 'cancelled'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    elif platform.system() == 'Windows':
        ps_script = f'''
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = "Select cookies.txt"
        $dialog.Filter = "Cookies files (*.txt)|*.txt|All files (*.*)|*.*"
        $dialog.InitialDirectory = {powershell_string(default_dir)}
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
            Write-Output $dialog.FileName
        }}
        '''
        try:
            r = subprocess.run(['powershell', '-Command', ps_script], capture_output=True, text=True, timeout=120)
            chosen = normalize_local_path(r.stdout.strip())
            if chosen:
                if not os.path.isfile(chosen):
                    return {'status': 'error', 'message': f'File not found: {chosen}'}
                return {'status': 'ok', 'path': chosen}
            return {'status': 'cancelled'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    return {'status': 'error', 'message': 'Unsupported platform'}

def handle_open_folder(msg):
    """파인더/탐색기에서 폴더 열기"""
    folder_path = msg.get('path', '')
    if not folder_path:
        config = load_config()
        folder_path = config.get('download_path', str(Path.home() / 'Downloads'))

    if not os.path.isdir(folder_path):
        return {'status': 'error', 'message': f'Folder not found: {folder_path}'}

    try:
        if platform.system() == 'Darwin':
            subprocess.Popen(['open', folder_path])
        elif platform.system() == 'Windows':
            subprocess.Popen(['explorer', folder_path])
        else:
            subprocess.Popen(['xdg-open', folder_path])
        return {'status': 'ok'}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def handle_self_uninstall(msg):
    """Companion 자체 제거 — 모든 설치 파일 삭제"""
    removed = []
    errors = []
    home = str(Path.home())

    # 1) ~/.medianab/ 삭제
    medianab_dir = os.path.join(home, '.medianab')
    if os.path.isdir(medianab_dir):
        try:
            import shutil
            shutil.rmtree(medianab_dir)
            removed.append(medianab_dir)
        except Exception as e:
            errors.append(f'{medianab_dir}: {e}')

    # 2) /usr/local/bin/medianab-host 삭제 (권한 필요 시 osascript 사용)
    host_bin = '/usr/local/bin/medianab-host'
    if os.path.isfile(host_bin):
        try:
            os.remove(host_bin)
            removed.append(host_bin)
        except PermissionError:
            try:
                subprocess.run([
                    'osascript', '-e',
                    f'do shell script "rm -f {host_bin}" with administrator privileges'
                ], check=True, capture_output=True, timeout=30)
                removed.append(f'{host_bin} (sudo)')
            except Exception as e:
                errors.append(f'{host_bin}: {e}')

    # 3) 설정 디렉터리 삭제
    config_dir = os.path.join(home, 'Library', 'Application Support', 'MediaNab')
    if os.path.isdir(config_dir):
        try:
            import shutil
            shutil.rmtree(config_dir)
            removed.append(config_dir)
        except Exception as e:
            errors.append(f'{config_dir}: {e}')

    # 4) NM 매니페스트 삭제
    nm_dirs = [
        os.path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
        os.path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'),
        os.path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
        os.path.join(home, 'Library', 'Application Support', 'Vivaldi', 'NativeMessagingHosts'),
        os.path.join(home, 'Library', 'Application Support', 'com.operasoftware.Opera', 'NativeMessagingHosts'),
        os.path.join(home, 'Library', 'Application Support', 'Arc', 'User Data', 'NativeMessagingHosts'),
        os.path.join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
    ]
    for nm_dir in nm_dirs:
        manifest = os.path.join(nm_dir, 'com.medianab.host.json')
        if os.path.isfile(manifest):
            try:
                os.remove(manifest)
                removed.append(manifest)
            except Exception as e:
                errors.append(f'{manifest}: {e}')

    return {
        'status': 'ok' if not errors else 'partial',
        'removed': removed,
        'errors': errors,
    }

def handle_play(msg):
    """지정된 미디어 파일을 기본 플레이어로 재생"""
    filepath = msg.get('path', '')
    if not filepath or not os.path.exists(filepath):
        return {'status': 'error', 'message': 'File not found'}
    try:
        if platform.system() == 'Darwin':
            subprocess.Popen(['open', filepath])
        elif platform.system() == 'Windows':
            os.startfile(filepath)
        else:
            subprocess.Popen(['xdg-open', filepath])
        return {'status': 'ok'}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

# ── 메인 루프 ──
HANDLERS = {
    'checkStatus': handle_check_status,
    'getFormats': handle_get_formats,
    'generatePreview': handle_generate_preview,
    'download': handle_download,
    'cancel': handle_cancel,
    'streamStart': handle_stream_start,
    'streamWrite': handle_stream_write,
    'streamFinish': handle_stream_finish,
    'streamCancel': handle_stream_cancel,
    'setConfig': handle_set_config,
    'updateYtdlp': handle_update_ytdlp,
    'pickFolder': handle_pick_folder,
    'pickCookiesFile': handle_pick_cookies_file,
    'openFolder': handle_open_folder,
    'selfUninstall': handle_self_uninstall,
    'play': handle_play,
}

def main():
    while True:
        msg = read_message()
        if msg is None:
            break

        action = msg.get('action', '')
        handler = HANDLERS.get(action)

        if handler:
            try:
                response = handler(msg)
            except Exception as e:
                response = {'status': 'error', 'message': f'Handler error: {e}'}
        else:
            response = {'status': 'error', 'message': f'Unknown action: {action}'}

        send_message(response)

if __name__ == '__main__':
    main()
