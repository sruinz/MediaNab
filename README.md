<div align="center">
  <img src="extension/icons/icon-128.png" alt="MediaNab Logo" width="100"/>
  <h1>MediaNab</h1>
  <p><strong>브라우저에서 재생되는 미디어를 감지하고 가장 알맞은 저장 경로로 연결하는 Chromium 확장</strong></p>
  <p>현재 안정 버전: <code>v1.2.4.06</code></p>
</div>

---

**MediaNab**은 웹페이지에서 재생되는 직접 링크형 영상과 적응형 스트림을 감지하고, 상황에 맞는 저장 경로로 자동 라우팅하는 브라우저 확장 프로그램입니다.

`Native Messaging Companion`과 연결되면 로컬 파일 저장, 재생, 폴더 열기, 보조 런타임 연동까지 브라우저 팝업 안에서 자연스럽게 이어집니다.

## 주요 특징

- **미디어 감지와 저장 라우팅**
  - 직접 링크형 영상과 적응형 스트림 자동 감지
  - 화질 선택, 진행률, 속도, ETA 표시
  - Companion 연결 여부에 따라 저장 경로 자동 선택

- **큐 중심 작업 흐름**
  - 진행 중/대기 중/완료 상태 구분
  - 완료 후 재생 버튼, 폴더 열기 버튼 제공
  - 취소 및 정리 흐름 지원

- **Companion 연동**
  - 로컬 폴더 직접 저장
  - 보조 런타임 자동 연결
  - 브라우저 팝업 안에서 연결 상태 확인 가능

- **플랫폼 호환성**
  - Finder 파일 아이콘 썸네일
  - QuickLook 미리보기 재생

## 현재 동작 방식

MediaNab은 감지한 미디어 종류에 따라 저장 경로를 다르게 선택합니다.

### 직접 링크형 미디어

- Companion이 연결되어 있으면 로컬 파일 저장 경로와 함께 처리합니다.
- Companion이 없으면 브라우저 기본 다운로드(`chrome.downloads`)로 저장합니다.

### 적응형 스트림 (`.m3u8` 등)

- 사이트 쿠키/토큰/Referer가 필요한 스트림을 고려해 기본적으로 브라우저 세션 기반 흐름을 사용합니다.
- Companion이 연결되면 브라우저가 가져온 데이터를 로컬 파일로 직접 저장할 수 있습니다.
- Companion이 없으면 브라우저 다운로드 방식으로 fallback합니다.

## 설치 방법

### 1. 확장 프로그램 로드

1. Chromium 계열 브라우저에서 `chrome://extensions/` 로 이동합니다.
2. 우측 상단의 `개발자 모드`를 활성화합니다.
3. `압축해제된 확장 프로그램 로드`를 눌러 저장소의 `extension/` 폴더를 선택합니다.

### 2. Companion 설치

확장 팝업에서 `설치 가이드`를 열어 운영체제에 맞는 설치 스크립트를 실행합니다.

- **macOS**
  - 설치 가이드에서 생성된 설치 스크립트를 다운로드
  - 표시된 `bash ".../medianab-install.sh"` 명령을 실행

- **Windows**
  - 설치 가이드에서 생성된 `.bat` 설치기를 다운로드
  - 브라우저를 사용하는 동일한 Windows 계정으로 일반 실행
  - `관리자 권한으로 실행`은 사용하지 않음
  - Python, Deno, ffmpeg가 없는 환경에서는 설치기가 로컬 런타임 도구를 자동으로 내려받아 사용

설치가 끝나면 **브라우저를 완전히 종료한 뒤 다시 실행**해야 합니다.

## 지원 환경

- **플랫폼**: macOS, Windows
- **브라우저**: Chrome, Edge, Brave, Vivaldi, Opera, Arc 등 Chromium 기반 브라우저

## 제한 사항

- DRM이 걸린 스트리밍은 지원하지 않습니다.
- 모든 사이트의 커스텀 플레이어 구조를 100% 동일하게 처리할 수는 없어서, 특이한 신규 사이트는 추가 대응이 필요할 수 있습니다.
- 배포 채널에 따라 일부 기능 가용성은 달라질 수 있습니다.

## 개인정보 및 보안

MediaNab은 다운로드 기록이나 개인정보를 외부 서버로 전송하지 않습니다.  
다운로드 감지와 Companion 통신은 사용자 PC 내부에서만 처리됩니다.

자세한 내용은 [`PRIVACY.md`](PRIVACY.md)를 참고하세요. 지원 및 문의는 [`SUPPORT.md`](SUPPORT.md)를 참고하세요.

## License

MediaNab is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE).

Third-party notices are listed in [`NOTICE`](NOTICE).
