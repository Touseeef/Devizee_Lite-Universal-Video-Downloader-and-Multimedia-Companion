# Privacy Policy for Devizee Lite

**Last updated:** September 2026

Devizee Lite is an open-source, offline-first desktop application developed with a strict privacy-by-design architecture. Your data belongs to you, and your activity remains entirely on your machine.

---

## 1. Zero Telemetry & Analytics
- Devizee Lite does **not** collect, store, transmit, or share any personal information, telemetry, usage statistics, crash logs, or IP addresses.
- No analytics SDKs, trackers, advertising identifiers, or pingbacks are bundled with or loaded by the software.
- The software does not communicate with any central Devizee server.

## 2. Direct Network Communications
- When you paste a URL and initiate a download, the network request is established directly between your computer and the host server providing the media stream (e.g., YouTube, TikTok, SoundCloud).
- Devizee Lite does not operate or route your traffic through intermediary proxies, scraping servers, or cloud relays.

## 3. Local Storage & Offline Persistence
- All application state—including download history, format presets, audio equalizer configurations, and UI themes—is stored strictly locally on your computer in an offline SQLite database (`downloads.db`) in your user application data directory.
- This data is never synchronized with any remote server or third party.

## 4. Third-Party Binaries & Sidecars
- Devizee Lite packages `yt-dlp` and `ffmpeg` as local sidecar binaries.
- These utilities execute locally within your Windows user context under sandboxed Windows Job Objects.
- Neither binary transmits data to Devizee.

## 5. Local Browser Cookies
- If you explicitly enable the optional "Cookies from Browser" feature to download age-restricted videos, `yt-dlp` reads session cookies directly from your local browser profile (Chrome, Edge, Firefox, Brave, Opera, Vivaldi).
- These credentials are passed directly to the media provider's server to authenticate the session. They are never captured, logged, or exfiltrated by Devizee Lite.

## 6. Open Source Transparency
Devizee Lite is released under the **MIT License**. The complete source code is public and reproducible at:
[https://github.com/Touseeef/devizee-lite-universal-video-downloader](https://github.com/Touseeef/devizee-lite-universal-video-downloader)

---

## Contact
If you have any questions about this Privacy Policy or wish to report a security matter, please open an issue or security advisory on our GitHub repository.
