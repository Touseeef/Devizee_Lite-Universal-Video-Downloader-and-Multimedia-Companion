# Devizee Lite

**A fast, privacy-first desktop download manager and media player for Windows.**
Built with Tauri v2, Rust, React, and powered by `yt-dlp` + `ffmpeg`.

[![Tauri v2](https://img.shields.io/badge/Tauri-v2.0-24C8D8?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.78+-DEA584?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Zero Telemetry](https://img.shields.io/badge/Zero_Telemetry-100%25-brightgreen?style=flat-square)](#privacy)
[![Release](https://img.shields.io/github/v/release/Touseeef/devizee-lite-universal-video-downloader?style=flat-square)](https://github.com/Touseeef/devizee-lite-universal-video-downloader/releases)

---

## What is Devizee Lite?

Devizee Lite is a **native Windows desktop app** that downloads videos and audio from YouTube, TikTok, Instagram, Twitter/X, Facebook, Twitch, and 1,000+ other sites — with a modern UI, an 8-band equalizer, a built-in media player, and a **zero-telemetry, zero-ads, zero-nonsense** approach.

It is **not** a browser extension. It is **not** Electron. It is a 40 MB installer that starts in under a second and does exactly what it says.

---

## Why Devizee?

Most download tools force a trade-off: pay for IDM, tolerate adware-adjacent "free" managers, or drop into yt-dlp's command line. Devizee Lite sits in the middle — modern GUI, no subscription, no telemetry, genuinely open source.

| Feature | **Devizee Lite** | IDM | 4K Video Downloader | yt-dlp CLI | JDownloader 2 |
|---|---|---|---|---|---|
| **Price** | Free, MIT | $25 one-time | Free (limited) / $15+ | Free | Free |
| **Open source** | ✅ MIT | ❌ | ❌ | ✅ | ✅ |
| **Zero telemetry** | ✅ | ❌ | ❌ | ✅ | Partial |
| **Ads / upsells** | None | Nag screens | Upsell banners | N/A | None |
| **Installer size** | ~40 MB | ~200 MB | ~180 MB | Python + deps | Java runtime |
| **Video sites** | 1,000+ (via yt-dlp) | Limited | YouTube / Vimeo | 1,000+ | 300+ |
| **Audio extraction** | MP3 / M4A / FLAC / WAV / Opus | ❌ | MP3 / M4A | ✅ | ✅ |
| **8-band hardware EQ** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Built-in media player** | ✅ with waveform | ❌ | Basic preview | ❌ | ❌ |
| **Clip-before-download** | ✅ | ❌ | ✅ (paid) | ✅ CLI | ❌ |
| **Batch playlists** | ✅ with per-track formats | Basic | ✅ (paid) | ✅ CLI | ✅ |
| **"Already downloaded" awareness** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Windows Job Object sandboxing** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Platform** | Windows 10/11 | Windows | Win/Mac/Linux | All | All (Java) |
| **Updated** | Active | Slow | Active | Weekly | Active |

**Honest caveats about Devizee Lite:**
- Windows-only (macOS/Linux support is not planned for Lite; a future AIO release may add it)
- Installer is unsigned — Windows SmartScreen will warn on first run (click "More info" → "Run anyway")
- No BitTorrent support yet (planned for Devizee AIO)
- No browser extension yet (planned for Devizee AIO)

See [COMPARISON.md](COMPARISON.md) for a deeper breakdown.

---

## Features

### 📥 Downloading
- **1,000+ supported sites** via yt-dlp — YouTube, YouTube Music, Shorts, TikTok, Instagram, Twitter/X, Facebook, Twitch, Vimeo, SoundCloud, and more
- **Playlist batch downloads** with per-track quality selection and one-click queue
- **Smart format selection** — resolution chips for 4K / 1440p / 1080p / 720p / 480p / 360p, with codec badges and estimated sizes
- **Audio extraction** to MP3 (320 kbps), M4A, FLAC (lossless), WAV, or Opus
- **Clip-before-download trimmer** — download only a specific section without fetching the whole file (unique in a GUI downloader)
- **Batch Links modal** — paste multiple URLs, import a `.txt` file, or load example links
- **Concurrent download limit** — runs 3 downloads at a time to prevent disk thrash; queue the rest
- **Auto-retry** for transient failures (network blips, rate limits) — silent, invisible to the user
- **Refresh URL** for expired download tokens — paste a fresh link, resume from the existing `.part` file
- **Interrupted download recovery** — resume after a crash, sleep, or forced shutdown

### 🎵 Media & Playback
- **Built-in multimedia hub** — play downloaded audio and video without leaving the app
- **8-band hardware equalizer** with presets (Flat, Bass Boost, Vocal, EDM, Rock, Movie, Acoustic, Classical) — applied to previews and playback
- **Waveform visualizer** — hardware-accelerated canvas, 0% CPU when paused
- **Hardware audio output selector** — route audio to a specific DAC, headphones, or speaker
- **0ms YouTube preview** — click a thumbnail, video plays instantly (no 4-7 second stream extraction wait)
- **In-line audio preview** for bandwidth-conscious users
- **Full-screen video player** with Netflix-style queue drawer

### 🎨 Interface
- **4 curated themes** — Signature (plum/rose), Light (crisp high-contrast), Frost (refined dark), OLED (pure black)
- **IDE-style zoom** — `Ctrl+=`, `Ctrl+-`, `Ctrl+0`, persisted across sessions
- **Collapsible sidebar** with a clickable "Now Playing" pill
- **Responsive across window sizes** — from narrow split screens to 4K

### 🔒 Privacy & Engineering
- **Zero telemetry** — no analytics, no crash reporting, no pingbacks, no third-party proxies
- **Windows Job Objects** — every child process (`yt-dlp`, `ffmpeg`) is bound to a job object with `KILL_ON_JOB_CLOSE`. Force-quitting Devizee or crashing never leaves zombie processes
- **Atomic `.part` staging** — files rename only after size + duration sanity checks pass
- **SQLite WAL mode** with throttled writes — no UI stalls during multi-download bursts
- **Corruption recovery** — if the database is corrupted by a power cut, Devizee quarantines it and starts fresh rather than refusing to launch
- **Sidecar fingerprint verification** — SHA-256 hashing of yt-dlp and ffmpeg with tamper detection
- **Cookie authentication** for age-restricted videos via browser cookies (Chrome, Edge, Firefox, Brave, Opera, Vivaldi) — read locally, never sent to any Devizee server

---

## Screenshots

> *(Add screenshots to `/docs/screenshots/` and update the paths below)*

| Dashboard | Multimedia Hub |
|---|---|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Multimedia](docs/screenshots/multimedia.png) |

| Downloads Queue | Settings — Sound & EQ |
|---|---|
| ![Downloads](docs/screenshots/downloads.png) | ![EQ](docs/screenshots/eq.png) |

---

## Installation

### Windows (recommended)
1. Download the latest installer from the [Releases page](https://github.com/Touseeef/devizee-lite-universal-video-downloader/releases):
   - **`Devizee-Lite-Setup-x.y.z.exe`** (NSIS installer — recommended)
   - or **`Devizee-Lite-x.y.z.msi`** (MSI installer)
2. Run the installer
3. On first launch, Windows SmartScreen may display an initial warning until reputation accumulates — click **"More info"** → **"Run anyway"**

> **Code Signing Notice:**
> Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

**System requirements:** Windows 10 (build 1809+) or Windows 11, ~150 MB free disk space. WebView2 is bundled with modern Windows.

### Build from source
```bash
# Prerequisites: Node.js 18+, Rust 1.78+, Tauri CLI
git clone https://github.com/Touseeef/devizee-lite-universal-video-downloader.git
cd devizee-lite-universal-video-downloader
npm install
npm run tauri dev
```

Production build:
```bash
npm run tauri build
```

Installers appear in `src-tauri/target/release/bundle/`.

---

## Privacy

Devizee Lite is built around a **privacy-first** philosophy:

- **No analytics.** No crash reporter phones home. No usage data leaves your machine.
- **No intermediary servers.** Media traffic goes directly from your PC to the source (YouTube, TikTok, etc.). Devizee does not proxy downloads.
- **No account required.** You never enter an email, name, or password into Devizee.
- **Cookie handling is local.** If you enable "Cookies from Browser" for age-restricted videos, yt-dlp reads them from your local browser profile and sends them only to the source site — exactly as your browser would. They are never sent to Devizee or any Devizee server.
- **Zero bundled bloatware.** No toolbars, no "recommended" software, no ad SDKs.

Read our full [PRIVACY.md](PRIVACY.md) and see [SECURITY.md](SECURITY.md) for the threat model and disclosure policy.

---

## Roadmap

### Devizee Lite (current line)
- ✅ v0.3.0 — Stability, auto-retry, network recovery, duplicate detection
- ✅ v0.4.0 — Sleep/watchdog detection, Refresh URL, DB corruption recovery, GitHub issue templates
- 🔄 v0.4.x — Ongoing polish and bug fixes
- ⏳ v0.5.0 — Real ffmpeg merge progress, additional platform support for the extension

### Devizee AIO — All-In-One Download Manager (separate product, in development)
A broader-scope download manager that will add:
- Multi-segment HTTP acceleration (IDM-class, 16–32 parallel chunk downloads)
- BitTorrent / P2P client with sequential streaming
- Browser companion extension (Chromium Manifest V3 + Firefox)
- Smart content routing and MIME-type auto-sorting
- AcoustID / MusicBrainz audio fingerprinting and auto-tagging
- Advanced scheduling with auto-shutdown / sleep on completion
- Fake-4K / bitrate upscale detection

Follow the repo to see progress.

---

## Contributing

Contributions are welcome. Before opening a PR:
- Read [CONTRIBUTING.md](CONTRIBUTING.md)
- For bugs, use the [Bug Report template](.github/ISSUE_TEMPLATE/bug.md)
- For features, use the [Feature Request template](.github/ISSUE_TEMPLATE/feature.md)
- For questions, start a [Discussion](https://github.com/Touseeef/devizee-lite-universal-video-downloader/discussions)
- For security issues, use [private disclosure](https://github.com/Touseeef/devizee-lite-universal-video-downloader/security/advisories/new)

---

## License

MIT — see [LICENSE](LICENSE).

Devizee Lite bundles `yt-dlp` (Unlicense) and `ffmpeg` (LGPL/GPL as compiled) as sidecar binaries. Their licenses apply to those binaries respectively.

---

## Star History

If Devizee saves you time, a star helps other people find it.

[![Star History Chart](https://api.star-history.com/svg?repos=Touseeef/devizee-lite-universal-video-downloader&type=Date)](https://star-history.com/#Touseeef/devizee-lite-universal-video-downloader&Date)