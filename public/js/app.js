/* ════════════════════════════════════════════════════
   WatchTogether — app.js
   Full WebRTC: screen share, P2P file stream, facecam, chat, sync
   ════════════════════════════════════════════════════ */

const CHUNK_SIZE     = 16384;          // 16 KB per DataChannel message
const HIGH_WATERMARK = 4 * 1024 * 1024; // pause sending above 4 MB buffered
const LOW_WATERMARK  = 512 * 1024;     // resume when below 512 KB

async function getIceConfig() {
  const res = await fetch('/ice-config');
  return await res.json();
}

// ── State ──────────────────────────────────────────
let socket, pc;
let role, roomId;
let camStream      = null;
let screenStream   = null;
let camEnabled     = false;
let micEnabled     = false;
let screenActive   = false;

// Data channels
let chatDC, syncDC, fileDC;

// File streaming state (sender)
let sendFile       = null;
let sendOffset     = 0;
let sendPaused     = false;

// File streaming state (receiver)
let mediaSource    = null;
let sourceBuffer   = null;
let appendQueue    = [];
let isAppending    = false;
let totalFileSize  = 0;
let receivedBytes  = 0;

// ── Init ───────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  roomId = sessionStorage.getItem('wt_room');
  role   = sessionStorage.getItem('wt_role');

  if (!roomId) { window.location.href = '/'; return; }

  // Set UI
  document.getElementById('roomCode').textContent = roomId;
  document.getElementById('shareCode').textContent = roomId;
  document.getElementById('myRole').textContent = (role === 'host') ? 'Host' : 'Guest';

  if (role === 'guest') {
    document.getElementById('overlay').style.display = 'none';
  }

  socket = io();

  socket.on('connect', () => {
    socket.emit(role === 'host' ? 'create-room' : 'join-room', roomId);
  });

  socket.on('room-created', () => setStatus('waiting'));
  socket.on('room-joined',  () => setStatus('waiting'));

  socket.on('guest-joined', async () => {
    systemMsg('Partner joined the room');
    setStatus('connected');
    updatePartnerUI(true);
    if (role === 'host') await createOffer();
  });

  socket.on('offer',  async ({ sdp }) => {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { sdp: answer.sdp });
  });

  socket.on('answer', async ({ sdp }) => {
    await pc.setRemoteDescription({ type: 'answer', sdp });
  });

  socket.on('ice', async ({ candidate }) => {
    try { await pc.addIceCandidate(candidate); } catch {}
  });

  socket.on('peer-disconnected', () => {
    systemMsg('Partner left the room');
    setStatus('waiting');
    updatePartnerUI(false);
    stopRemoteVideo();
  });

  socket.on('join-error', msg => {
    toast(msg, 4000);
    setTimeout(() => window.location.href = '/', 4000);
  });

  // Build peer connection
  await buildPC();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 's' || e.key === 'S') toggleScreen();
    if (e.key === 'c' || e.key === 'C') toggleCam();
    if (e.key === 'm' || e.key === 'M') toggleMic();
    if (e.key === ' ') {
      e.preventDefault();
      const v = document.getElementById('mainVideo');
      v.paused ? v.play() : v.pause();
    }
  });

  // Chat enter key
  document.getElementById('chatInp').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
  });
});

// ── Peer Connection ────────────────────────────────
async function buildPC() {
  const config = await getIceConfig();
  pc = new RTCPeerConnection(config);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice', { candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log('ICE state:', pc.iceConnectionState);
    if (pc.connectionState === 'connected') {
      setStatus('connected');
      document.getElementById('syncBar').style.display = 'flex';
    }
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      setStatus('waiting');
    }
  };

  // Remote cam track
  pc.ontrack = (e) => {
    const { track, streams } = e;
    if (track.kind === 'video') {
      const mainV = document.getElementById('mainVideo');
      const remCamV = document.getElementById('remCam');

      // Heuristic: screen share streams have many video tracks, cam has exactly 1
      // We differentiate by the stream label convention we set on sender side
      const streamLabel = streams[0] ? streams[0].id : '';

      if (streamLabel.startsWith('cam-')) {
        remCamV.srcObject = streams[0];
        remCamV.style.display = 'block';
        document.getElementById('remCamPlaceholder').style.display = 'none';
        document.getElementById('remCamBox').classList.add('active');
      } else {
        mainV.srcObject = streams[0];
        mainV.style.display = 'block';
        document.getElementById('idleState').style.display = 'none';
        showSyncBar();
      }
    }
  };

  if (role === 'host') {
    // Host creates data channels
    chatDC = pc.createDataChannel('chat');
    syncDC = pc.createDataChannel('sync');
    fileDC = pc.createDataChannel('file', { ordered: true });
    fileDC.binaryType = 'arraybuffer';
    setupFileDC();
    setupChatDC(chatDC);
    setupSyncDC(syncDC);
  } else {
    // Guest receives data channels
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      if (dc.label === 'chat') { chatDC = dc; setupChatDC(dc); }
      if (dc.label === 'sync') { syncDC = dc; setupSyncDC(dc); }
      if (dc.label === 'file') { fileDC = dc; dc.binaryType = 'arraybuffer'; setupFileDC(); }
    };
  }
}

async function createOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { sdp: offer.sdp });
}

// ── Data Channels ──────────────────────────────────
function setupChatDC(dc) {
  dc.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    appendMsg(msg.text, 'them');
  };
}

function setupSyncDC(dc) {
  dc.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const v   = document.getElementById('mainVideo');
    if (msg.type === 'play')  { v.play(); }
    if (msg.type === 'pause') { v.pause(); }
    if (msg.type === 'seek')  { v.currentTime = msg.t; }
  };
}

function setupFileDC() {
  fileDC.onmessage = (e) => {
    const data = e.data;

    // JSON control messages
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'file-meta') {
        totalFileSize = msg.size;
        receivedBytes = 0;
        initMediaSource(msg.mimeType);
        document.getElementById('fileProgress').style.display = 'block';
        document.getElementById('progressLabel').textContent = `Receiving: ${msg.name}`;
        document.getElementById('idleState').style.display = 'none';
        systemMsg(`Partner is streaming: ${msg.name}`);
      }
      if (msg.type === 'file-end') {
        if (mediaSource && mediaSource.readyState === 'open') {
          // End of stream after any pending appends
          const endStream = () => {
            if (sourceBuffer && !sourceBuffer.updating) {
              try { mediaSource.endOfStream(); } catch {}
            } else {
              sourceBuffer && sourceBuffer.addEventListener('updateend', endStream, { once: true });
            }
          };
          endStream();
        }
        document.getElementById('fileProgress').style.display = 'none';
        systemMsg('File stream complete');
      }
      return;
    }

    // Binary chunk
    receivedBytes += data.byteLength;
    const pct = Math.round((receivedBytes / totalFileSize) * 100);
    document.getElementById('progressFill').style.width = `${pct}%`;
    document.getElementById('progressPct').textContent = `${pct}%`;

    if (sourceBuffer) {
      appendQueue.push(data);
      drainAppendQueue();
    }
  };

  // Backpressure: resume sending when buffer drains
  if (fileDC.readyState === 'open') {
    fileDC.bufferedAmountLowThreshold = LOW_WATERMARK;
    fileDC.onbufferedamountlow = () => {
      if (sendPaused) { sendPaused = false; pumpFile(); }
    };
  } else {
    fileDC.onopen = () => {
      fileDC.bufferedAmountLowThreshold = LOW_WATERMARK;
      fileDC.onbufferedamountlow = () => {
        if (sendPaused) { sendPaused = false; pumpFile(); }
      };
    };
  }
}

// ── MediaSource API (receiver) ─────────────────────
function initMediaSource(mimeType) {
  mediaSource = new MediaSource();
  appendQueue = [];
  isAppending = false;
  sourceBuffer = null;
  receivedBytes = 0;

  const v = document.getElementById('mainVideo');
  v.src = URL.createObjectURL(mediaSource);
  v.style.display = 'block';

  mediaSource.addEventListener('sourceopen', () => {
    // Try provided mimeType first, fallback to safe H.264 codec
    const safeType = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
    const useType  = MediaSource.isTypeSupported(mimeType) ? mimeType : safeType;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(useType);
      sourceBuffer.mode = 'sequence';
      sourceBuffer.addEventListener('updateend', () => {
        isAppending = false;
        // Keep only a 3-minute window to avoid memory overflow
        trimBuffer();
        drainAppendQueue();
      });
    } catch (err) {
      console.error('SourceBuffer error:', err);
      toast('File format may not be supported. Use MP4/H.264 for best results.', 5000);
    }
  });
}

function drainAppendQueue() {
  if (!sourceBuffer || isAppending || appendQueue.length === 0) return;
  if (sourceBuffer.updating) return;
  isAppending = true;
  try {
    sourceBuffer.appendBuffer(appendQueue.shift());
  } catch (e) {
    isAppending = false;
    console.warn('appendBuffer error:', e);
  }
}

function trimBuffer() {
  const v = document.getElementById('mainVideo');
  if (!sourceBuffer || sourceBuffer.updating) return;
  if (sourceBuffer.buffered.length === 0) return;
  const t = v.currentTime;
  if (t > 180) { // keep last 3 min
    try { sourceBuffer.remove(0, t - 180); } catch {}
  }
}

// ── File Streaming (sender) ────────────────────────
async function startFileStream(file) {
  if (!fileDC || fileDC.readyState !== 'open') {
    toast('No connection yet — wait for partner to join.'); return;
  }
  sendFile   = file;
  sendOffset = 0;
  sendPaused = false;

  fileDC.send(JSON.stringify({
    type:     'file-meta',
    name:     file.name,
    size:     file.size,
    mimeType: file.type || 'video/mp4'
  }));

  document.getElementById('fileProgress').style.display = 'block';
  document.getElementById('progressLabel').textContent  = `Streaming: ${file.name}`;
  systemMsg(`You started streaming: ${file.name}`);

  showMainVideo();
  const v = document.getElementById('mainVideo');
  v.src = URL.createObjectURL(file);
  v.style.display = 'block';
  document.getElementById('idleState').style.display = 'none';

  pumpFile();
}

function pumpFile() {
  if (!sendFile || sendOffset >= sendFile.size) {
    if (sendFile) {
      fileDC.send(JSON.stringify({ type: 'file-end' }));
      document.getElementById('fileProgress').style.display = 'none';
      sendFile = null;
    }
    return;
  }

  if (fileDC.bufferedAmount > HIGH_WATERMARK) {
    sendPaused = true;
    return;
  }

  const slice  = sendFile.slice(sendOffset, sendOffset + CHUNK_SIZE);
  const reader = new FileReader();
  reader.onload = (e) => {
    fileDC.send(e.target.result);
    sendOffset += e.target.result.byteLength;

    const pct = Math.round((sendOffset / sendFile.size) * 100);
    document.getElementById('progressFill').style.width  = `${pct}%`;
    document.getElementById('progressPct').textContent   = `${pct}%`;

    setTimeout(pumpFile, 0);
  };
  reader.readAsArrayBuffer(slice);
}

// ── Screen Share ───────────────────────────────────
async function toggleScreen() {
  if (screenActive) {
    stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: { echoCancellation: false, noiseSuppression: false }
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Screen share failed: ' + e.message);
    return;
  }

  screenActive = true;
  document.getElementById('btnScreen').classList.add('on');

  // Show locally
  const v = document.getElementById('mainVideo');
  v.srcObject = screenStream;
  v.style.display = 'block';
  v.muted = true;
  document.getElementById('idleState').style.display = 'none';
  showSyncBar();

  // Add to peer connection
  ensurePC();
  screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));

  // If already connected → renegotiate
  if (pc.connectionState === 'connected') {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { sdp: offer.sdp });
  }

  screenStream.getVideoTracks()[0].onended = () => stopScreenShare();

  systemMsg('You started screen sharing');
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  screenActive = false;
  document.getElementById('btnScreen').classList.remove('on');
  stopMainVideo();
  systemMsg('Screen sharing stopped');
}

// ── Webcam ─────────────────────────────────────────
async function toggleCam() {
  if (camEnabled) {
    stopCam();
  } else {
    await startCam();
  }
}

async function startCam() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, frameRate: 24 },
      audio: micEnabled
    });
  } catch (e) {
    toast('Camera access denied or unavailable.'); return;
  }

  camEnabled = true;
  document.getElementById('btnCam').classList.add('on');

  // Show own cam
  const myCam = document.getElementById('myCam');
  myCam.srcObject = camStream;
  myCam.style.display = 'block';
  document.getElementById('myCamPlaceholder').style.display = 'none';
  document.getElementById('myCamBox').classList.add('active');

  // Label the cam stream so receiver can differentiate from screen share
  const labeledStream = new MediaStream();
  camStream.getTracks().forEach(t => labeledStream.addTrack(t));
  // Naming convention: set track content hint
  camStream.getVideoTracks().forEach(t => t.contentHint = 'motion');

  // Add to PC
  ensurePC();
  camStream.getTracks().forEach(t => pc.addTrack(t, camStream));

  if (pc.connectionState === 'connected') {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { sdp: offer.sdp });
  }
}

function stopCam() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  camEnabled = false;
  document.getElementById('btnCam').classList.remove('on');
  const myCam = document.getElementById('myCam');
  myCam.style.display = 'none';
  document.getElementById('myCamPlaceholder').style.display = 'flex';
  document.getElementById('myCamBox').classList.remove('active');
}

async function toggleMic() {
  micEnabled = !micEnabled;
  document.getElementById('btnMic').classList.toggle('on', micEnabled);
  if (camStream) {
    camStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  }
  if (micEnabled && !camStream) await startCam();
}

// ── Video Sync ─────────────────────────────────────
// Attach sync events once mainVideo has a local src
function attachSyncListeners() {
  const v = document.getElementById('mainVideo');
  v.addEventListener('play',  () => { if (syncDC?.readyState === 'open') syncDC.send(JSON.stringify({ type: 'play' })); });
  v.addEventListener('pause', () => { if (syncDC?.readyState === 'open') syncDC.send(JSON.stringify({ type: 'pause' })); });
  v.addEventListener('seeked',() => { if (syncDC?.readyState === 'open') syncDC.send(JSON.stringify({ type: 'seek', t: v.currentTime })); });
}

// ── Chat ───────────────────────────────────────────
function sendChat() {
  const inp = document.getElementById('chatInp');
  const txt = inp.value.trim();
  if (!txt) return;
  inp.value = '';
  appendMsg(txt, 'me');
  if (chatDC?.readyState === 'open') chatDC.send(JSON.stringify({ text: txt }));
}

function appendMsg(text, who) {
  const box = document.getElementById('chatMsgs');
  const div = document.createElement('div');
  div.className = `msg ${who === 'me' ? 'mine' : ''}`;

  const now = new Date();
  const t   = `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;

  div.innerHTML = `
    ${who !== 'me' ? '<span class="msg-name">Partner</span>' : ''}
    <div class="msg-bubble">${escHtml(text)}</div>
    <span class="msg-time">${t}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function systemMsg(text) {
  const box = document.getElementById('chatMsgs');
  const div = document.createElement('div');
  div.className = 'sys-msg';
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── UI Helpers ─────────────────────────────────────
function setStatus(s) {
  const pill = document.getElementById('connPill');
  const txt  = document.getElementById('connText');
  pill.className = `conn-pill ${s}`;
  if (s === 'waiting')      txt.textContent = 'Waiting for partner';
  if (s === 'connected')    txt.textContent = 'Connected';
  if (s === 'disconnected') txt.textContent = 'Disconnected';
}

function updatePartnerUI(online) {
  document.getElementById('partnerStatus').textContent = online ? 'Connected' : 'Not connected';
  document.getElementById('partnerDot').className = `peer-status ${online ? '' : 'off'}`;
}

function stopMainVideo() {
  const v = document.getElementById('mainVideo');
  v.srcObject = null; v.src = ''; v.style.display = 'none';
  document.getElementById('idleState').style.display = 'flex';
  document.getElementById('syncBar').style.display   = 'none';
}

function stopRemoteVideo() {
  const v = document.getElementById('mainVideo');
  if (v.srcObject) { v.srcObject = null; v.style.display = 'none'; }
  document.getElementById('idleState').style.display = 'flex';
}

function showMainVideo() {
  document.getElementById('mainVideo').style.display  = 'block';
  document.getElementById('idleState').style.display  = 'none';
}

function showSyncBar() {
  document.getElementById('syncBar').style.display = 'flex';
}

function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024 * 1024) {
    toast('File too large. Max 10 GB supported.'); return;
  }
  startFileStream(file);
  input.value = '';
}

function switchTab(name) {
  document.querySelectorAll('.stab').forEach((t, i) => {
    t.classList.toggle('active', ['chat','info'][i] === name);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${name}`);
  });
}

function copyCode() {
  navigator.clipboard.writeText(roomId).then(() => toast('Room code copied!'));
}

function dismissOverlay() {
  document.getElementById('overlay').style.display = 'none';
}

function leaveRoom() {
  if (confirm('Leave the room?')) window.location.href = '/';
}

let toastTimer;
function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function ensurePC() {
  if (!pc) buildPC();
}

// Attach sync listeners when page loads
document.addEventListener('DOMContentLoaded', () => {
  attachSyncListeners();
});
