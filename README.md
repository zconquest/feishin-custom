# Feishin Custom

Private Windows x64 build of Feishin 1.17.0 with fullscreen word lyrics, visual lyric styles, Ship + Visual, a compact footer, and independently configurable left/right AudioMotion visualizers.

## Install

1. Open this repository's Releases page and download the Windows .exe installer.
2. Install **Feishin Custom** and launch it. This uses its own app identity and profile.
3. Add your music server and sign in with your own account.
4. Open the fullscreen lyric viewer to select a lyric style. Open **Side visualizers** to configure either side. Enable Web Audio playback for the simplest visualizer setup.

No music, server addresses, passwords, saved settings, timing caches, or personal model caches are included. Your server must be reachable from the recipient's computer.

An extractable Windows ZIP is included as an alternative. Extract the entire ZIP before launching the executable.

Automatic upstream updates are disabled so they cannot replace custom features. Download future custom releases manually.

Word-synchronized providers, imports, and visual lyric displays are included. Generating local word timings from audio requires the optional Python/FFmpeg runtime described in [SHARING.md](SHARING.md).

## Build from source

Install Node.js 24 and pnpm 11.5.2, then run:

~~~powershell
pnpm install --frozen-lockfile
pnpm run package:custom:win
~~~

Output: release/custom/. Target: Windows x64. The locally distributed binary is unsigned.

## Sharing and license

Invite a recipient as a collaborator to this private repository to download releases directly. Anyone receiving a binary must also receive its matching source, build files, and GPL license; they retain the GPL rights to modify and redistribute it.

This source snapshot is based on upstream commit 5c169aca8d550032c9aa6e8e2b9f624d03d42fec and includes local modifications. Feishin is GPLv3; see [LICENSE](LICENSE). Additional attribution is in [distribution/notices](distribution/notices). See [README.upstream.md](README.upstream.md) for upstream documentation.
