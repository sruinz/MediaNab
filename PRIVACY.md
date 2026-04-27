# MediaNab Privacy Policy

Effective date: April 30, 2026

MediaNab is a Chromium extension that detects media on pages you visit and routes save actions through the browser or an optional local Companion app.

## Data Collection

MediaNab does not collect, sell, rent, or share personal information.

MediaNab does not operate a cloud service for analytics, tracking, account management, or download history. Media detection, queue state, settings, thumbnails, and Companion communication are handled on your device.

## Data Stored Locally

MediaNab may store the following data in browser extension storage or on your device:

- Extension settings, such as language, download preferences, and optional cookie authentication mode.
- Temporary queue state, detected media metadata, progress state, and thumbnail references.
- Local Companion configuration, such as the selected save folder.
- Local debug logs shown inside the extension popup when logging is enabled by the extension workflow.

This data is used only to provide the extension features and is not sent to MediaNab servers.

## Browser Permissions

MediaNab requests browser permissions so it can detect media on pages selected by the user, manage download tasks, show progress, communicate with the optional local Companion, and save files through the browser when Companion is not available.

The broad host permission is used for media detection across user-visited pages. It does not allow MediaNab to bypass DRM, access paid content without authorization, or upload your browsing data to a MediaNab service.

## Optional Companion

The Companion is a local Native Messaging helper. When installed, it runs on your computer and helps MediaNab save files to a chosen local folder, record supported streams, and open completed files or folders.

Companion communication stays on your device through the browser Native Messaging channel.

## Optional Cookie Authentication

Cookie authentication is off by default. If you explicitly enable it, MediaNab may ask the local Companion to pass browser cookies or a selected cookies.txt file to the local media tool for a user-initiated download or recording.

Cookie authentication is not used for automatic page detection or background metadata checks. It is intended only for cases where a site requires the user's own browser session for an action the user starts.

## Third Parties

MediaNab includes third-party open-source components listed in `NOTICE`. Those components run as part of the extension or local Companion workflow.

MediaNab does not add third-party analytics or advertising SDKs.

## User Responsibility

You are responsible for using MediaNab only with media you have the right to access and save. MediaNab does not remove DRM and does not grant permission to download content from third-party services.

## Contact

For support, bug reports, or privacy questions, use the support resources in `SUPPORT.md`.
