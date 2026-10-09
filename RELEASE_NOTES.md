# Feishin Custom 1.17.0 - Windows x64

Includes the current custom fullscreen word lyrics, visual lyric styles, Ship + Visual, compact player footer, lyric source integrations, and separate left/right AudioMotion visualizers.

Downloads:
- Windows x64 .exe installer.
- Extractable Windows x64 application ZIP.
- Matching modified source ZIP.
- SHA256SUMS.txt for file verification.

Install Feishin Custom, add your own music server, and sign in. The package does not include music, accounts, saved settings, timing caches, or personal runtime paths. This build uses a separate application identity/profile and manual updates.

Generating local word timings from audio requires the optional Python 3.13 / FFmpeg / PyTorch runtime. Its worker source, registration script, and setup instructions are included. Word-synchronized lyric providers, imports, and visual display do not need this runtime.

Validation completed on 10-08-2026:
- Production Electron main/preload/renderer and remote builds passed.
- Eight existing focused lyric/visualizer regression scripts passed.
- Code and CSS lint passed.
- All 15,033 archived file integrity hashes verified; compiled files match the fresh build.
- All 75 production dependency versions match the build environment.
- Windows runtime executable architecture verified as x64.

The installer is unsigned. The existing nonfatal bundler warnings remain. Fresh-computer installation of the optional alignment environment and live music playback were not exercised in this packaging session.

Based on Feishin upstream commit 5c169aca8d550032c9aa6e8e2b9f624d03d42fec. GPLv3 license and third-party notices are included. Provide recipients the matching source and license when sharing a binary.
