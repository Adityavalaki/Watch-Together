# WatchTogether

Private watch-party app. Screen share any tab (Netflix, NetMirror, anything) or
stream a local MP4 — with live facecam, mic, and chat. Zero media hits the server.

## Quick Start

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # dev mode with nodemon
```

User A → Create room → share the 6-char code
User B → Enter code → Join

## Features
- Screen share with audio (any tab/window)
- P2P file stream: local .mp4 up to 10 GB
- Floating facecam overlay for both users
- Live chat (WebRTC data channel)
- Play/pause/seek sync

## Keyboard Shortcuts
- S   Screen share
- C   Webcam
- M   Mic
- Space   Play/pause

## Supported Formats
- .mp4 H.264  All browsers
- .webm VP9   Chrome/Firefox
- .mkv        NOT supported — convert first:
  ffmpeg -i movie.mkv -c copy movie.mp4

## Deploy Free (Railway)
1. Push to GitHub
2. railway.app → New Project → Deploy from GitHub
3. Start command: node server.js
4. Use the public URL on both sides

## Architecture
Server = signaling only (~100 bytes/msg)
All video/audio/file = direct peer-to-peer WebRTC
File chunks: 16 KB each, backpressure controlled
Receiver: MediaSource API, 3-min rolling buffer
