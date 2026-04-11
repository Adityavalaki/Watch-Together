/* ═══════════════════════════════════════════════════
   WatchTogether — app.js  (fixed)
   ═══════════════════════════════════════════════════ */

const CHUNK_SIZE     = 16384;
const HIGH_WATERMARK = 4 * 1024 * 1024;
const LOW_WATERMARK  = 512 * 1024;

let socket, pc;
let role, roomId;
let camStream    = null;
let screenStream = null;
let camEnabled   = false;
let micEnabled   = false;
let screenActive = false;

let chatDC, syncDC, fileDC;

let sendFile      = null;
let sendOffset    = 0;
let sendPaused    = false;

let mediaSource   = null;
let sourceBuffer  = null;
let appendQueue   = [];
let isAppending   = false;
let totalFileSize = 0;
let receivedBytes = 0;

let iceConfig     = null;

// ── ICE Config ─────────────────────────────────────
async function getIceConfig() {
  if (iceConfig) return iceConfig;
  try {
    const res = await fetch('/ice-config');
    iceConfig  = await res.json();
    console.log('[ICE] Config loaded');
    return iceConfig;
  } catch (e) {
    console.warn('[ICE] Fetch failed, using STUN only');
    iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    return iceConfig;
  }
}

// ── Init ───────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  roomId = sessionStorage.getItem('wt_room');
  role   = sessionStorage.getItem('wt_role');
  if (!roomId) { window.location.href = '/'; return; }

  document.getElementById('roomCode').textContent  = roomId;
  document.getElementById('shareCode').textContent = roomId;
  document.getElementById('myRole').textContent    = role === 'host' ? 'Host' : 'Guest';
  if (role === 'guest') document.getElementById('overlay').style.display = 'none';

  // Pre-fetch ICE config before anything else
  await getIceConfig();

  socket = io({ transports: ['polling', 'websocket'] });

  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket.id);
    if (role === 'host') socket.emit('create-room');
    else socket.emit('rejoin-room', roomId);
  });

  socket.on('room-created', (code) => {
    roomId = code;
    document.getElementById('roomCode').textContent  = code;
    document.getElementById('shareCode').textContent = code;
    setStatus('waiting');
  });

  socket.on('room-rejoined', (code) => {
    roomId = code;
    setStatus('waiting');
  });

  socket.on('guest-joined', async () => {
    console.log('[Room] Guest joined — building PC as host');
    systemMsg('Partner joined the room');
    updatePartnerUI(true);
    await buildPC();
    await createOffer();
  });

  socket.on('peer-reconnected', () => {
    systemMsg('Partner reconnected');
    updatePartnerUI(true);
  });

  socket.on('offer', async ({ sdp }) => {
    console.log('[SDP] Got offer');
    if (!pc) await buildPC();
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { sdp: answer.sdp });
    console.log('[SDP] Sent answer');
  });

  socket.on('answer', async ({ sdp }) => {
    console.log('[SDP] Got answer');
    if (pc) await pc.setRemoteDescription({ type: 'answer', sdp });
  });

  socket.on('ice', async ({ candidate }) => {
    try { if (pc) await pc.addIceCandidate(candidate); } catch {}
  });

  socket.on('peer-disconnected', () => {
    systemMsg('Partner disconnected — waiting...');
    setStatus('waiting');
    updatePartnerUI(false);
  });

  socket.on('join-error', (msg) => {
    toast(msg, 5000);
    setTimeout(() => window.location.href = '/', 5000);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 's' || e.key === 'S') toggleScreen();
    if (e.key === 'c' || e.key === 'C') toggleCam();
    if (e.key === 'm' || e.key === 'M') toggleMic();
    if (e.key === ' ') { e.preventDefault(); const v = document.getElementById('mainVideo'); v.paused ? v.play() : v.pause(); }
  });

  document.getElementById('chatInp').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  attachSyncListeners();
});

// ── Build PC ───────────────────────────────────────
async function buildPC() {
  if (pc) { pc.close(); pc = null; }

  const config = await getIceConfig();
  pc = new RTCPeerConnection(config);
  console.log('[PC] Created');

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice', { candidate });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('[ICE] State:', s);
    if (s === 'connected' || s === 'completed') {
      setStatus('connected');
      document.getElementById('syncBar').style.display = 'flex';
    }
    if (s === 'failed') {
      console.error('[ICE] FAILED — TURN server missing or wrong credentials');
      toast('Connection failed — check TURN server.', 6000);
      setStatus('waiting');
    }
    if (s === 'disconnected') setStatus('waiting');
  };

  // Single ontrack — screen share vs cam distinguished by contentHint
  pc.ontrack = ({ track, streams }) => {
    if (!streams[0]) return;
    console.log('[Track]', track.kind, 'hint:', track.contentHint);

    if (track.kind === 'video') {
      const isCam = track.contentHint === 'motion';
      if (isCam) {
        const v = document.getElementById('remCam');
        v.srcObject = streams[0];
        v.style.display = 'block';
        document.getElementById('remCamPlaceholder').style.display = 'none';
        document.getElementById('remCamBox').classList.add('active');
      } else {
        const v = document.getElementById('mainVideo');
        v.srcObject = streams[0];
        v.style.display = 'block';
        document.getElementById('idleState').style.display = 'none';
        document.getElementById('syncBar').style.display = 'flex';
      }
    }
  };

  if (role === 'host') {
    chatDC = pc.createDataChannel('chat', { ordered: true });
    syncDC = pc.createDataChannel('sync', { ordered: true });
    fileDC = pc.createDataChannel('file', { ordered: true });
    fileDC.binaryType = 'arraybuffer';
    setupChatDC(chatDC);
    setupSyncDC(syncDC);
    setupFileDC();
  } else {
    pc.ondatachannel = ({ channel }) => {
      if (channel.label === 'chat') { chatDC = channel; setupChatDC(channel); }
      if (channel.label === 'sync') { syncDC = channel; setupSyncDC(channel); }
      if (channel.label === 'file') { fileDC = channel; fileDC.binaryType = 'arraybuffer'; setupFileDC(); }
    };
  }
}

async function createOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { sdp: offer.sdp });
  console.log('[SDP] Sent offer');
}

async function renegotiate() {
  if (!pc || role !== 'host') return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { sdp: offer.sdp });
}

// ── Data Channels ──────────────────────────────────
function setupChatDC(dc) {
  dc.onmessage = ({ data }) => appendMsg(JSON.parse(data).text, 'them');
}

function setupSyncDC(dc) {
  dc.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const v   = document.getElementById('mainVideo');
    if (msg.type === 'play')  v.play();
    if (msg.type === 'pause') v.pause();
    if (msg.type === 'seek')  v.currentTime = msg.t;
  };
}

function setupFileDC() {
  const onOpen = () => {
    fileDC.bufferedAmountLowThreshold = LOW_WATERMARK;
    fileDC.onbufferedamountlow = () => { if (sendPaused) { sendPaused = false; pumpFile(); } };
  };
  if (fileDC.readyState === 'open') onOpen(); else fileDC.onopen = onOpen;

  fileDC.onmessage = ({ data }) => {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'file-meta') {
        totalFileSize = msg.size; receivedBytes = 0;
        initMediaSource(msg.mimeType);
        document.getElementById('fileProgress').style.display = 'block';
        document.getElementById('progressLabel').textContent  = `Receiving: ${msg.name}`;
        document.getElementById('idleState').style.display    = 'none';
        systemMsg(`Partner streaming: ${msg.name}`);
      }
      if (msg.type === 'file-end') {
        document.getElementById('fileProgress').style.display = 'none';
        systemMsg('Stream complete');
        if (mediaSource?.readyState === 'open') try { mediaSource.endOfStream(); } catch {}
      }
      return;
    }
    receivedBytes += data.byteLength;
    const pct = Math.round((receivedBytes / totalFileSize) * 100);
    document.getElementById('progressFill').style.width = `${pct}%`;
    document.getElementById('progressPct').textContent  = `${pct}%`;
    if (sourceBuffer) { appendQueue.push(data); drainAppendQueue(); }
  };
}

function initMediaSource(mimeType) {
  mediaSource  = new MediaSource();
  appendQueue  = []; isAppending = false; sourceBuffer = null;
  const v      = document.getElementById('mainVideo');
  v.src        = URL.createObjectURL(mediaSource);
  v.style.display = 'block';
  mediaSource.addEventListener('sourceopen', () => {
    const safe = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
    const type = MediaSource.isTypeSupported(mimeType) ? mimeType : safe;
    try {
      sourceBuffer      = mediaSource.addSourceBuffer(type);
      sourceBuffer.mode = 'sequence';
      sourceBuffer.addEventListener('updateend', () => { isAppending = false; trimBuffer(); drainAppendQueue(); });
    } catch (e) { toast('Format not supported. Use MP4 H.264.', 5000); }
  });
}

function drainAppendQueue() {
  if (!sourceBuffer || isAppending || !appendQueue.length || sourceBuffer.updating) return;
  isAppending = true;
  try { sourceBuffer.appendBuffer(appendQueue.shift()); } catch { isAppending = false; }
}

function trimBuffer() {
  const v = document.getElementById('mainVideo');
  if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return;
  if (v.currentTime > 180) try { sourceBuffer.remove(0, v.currentTime - 180); } catch {}
}

// ── File Send ──────────────────────────────────────
async function startFileStream(file) {
  if (!fileDC || fileDC.readyState !== 'open') { toast('Connect with partner first.'); return; }
  sendFile = file; sendOffset = 0; sendPaused = false;
  fileDC.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mimeType: file.type || 'video/mp4' }));
  document.getElementById('fileProgress').style.display = 'block';
  document.getElementById('progressLabel').textContent  = `Streaming: ${file.name}`;
  systemMsg(`Streaming: ${file.name}`);
  const v = document.getElementById('mainVideo');
  v.src   = URL.createObjectURL(file); v.style.display = 'block';
  document.getElementById('idleState').style.display = 'none';
  pumpFile();
}

function pumpFile() {
  if (!sendFile || sendOffset >= sendFile.size) {
    if (sendFile) { fileDC.send(JSON.stringify({ type: 'file-end' })); document.getElementById('fileProgress').style.display = 'none'; sendFile = null; }
    return;
  }
  if (fileDC.bufferedAmount > HIGH_WATERMARK) { sendPaused = true; return; }
  const reader = new FileReader();
  reader.onload = ({ target }) => {
    fileDC.send(target.result);
    sendOffset += target.result.byteLength;
    const pct = Math.round((sendOffset / sendFile.size) * 100);
    document.getElementById('progressFill').style.width = `${pct}%`;
    document.getElementById('progressPct').textContent  = `${pct}%`;
    setTimeout(pumpFile, 0);
  };
  reader.readAsArrayBuffer(sendFile.slice(sendOffset, sendOffset + CHUNK_SIZE));
}

// ── Screen Share ───────────────────────────────────
async function toggleScreen() { screenActive ? stopScreenShare() : await startScreenShare(); }

async function startScreenShare() {
  if (!pc) { toast('Wait for partner to connect.'); return; }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch (e) { if (e.name !== 'NotAllowedError') toast('Screen share failed.'); return; }

  screenActive = true;
  document.getElementById('btnScreen').classList.add('on');
  const v = document.getElementById('mainVideo');
  v.srcObject = screenStream; v.style.display = 'block'; v.muted = true;
  document.getElementById('idleState').style.display = 'none';

  screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));
  if (role === 'host') await renegotiate();
  screenStream.getVideoTracks()[0].onended = stopScreenShare;
  systemMsg('You started screen sharing');
}

function stopScreenShare() {
  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null; screenActive = false;
  document.getElementById('btnScreen').classList.remove('on');
  const v = document.getElementById('mainVideo');
  v.srcObject = null; v.style.display = 'none';
  document.getElementById('idleState').style.display = 'flex';
  document.getElementById('syncBar').style.display = 'none';
  systemMsg('Screen sharing stopped');
}

// ── Webcam ─────────────────────────────────────────
async function toggleCam() { camEnabled ? stopCam() : await startCam(); }

async function startCam() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: 24 }, audio: true });
  } catch { toast('Camera access denied.'); return; }

  camEnabled = true;
  document.getElementById('btnCam').classList.add('on');
  const myCam = document.getElementById('myCam');
  myCam.srcObject = camStream; myCam.style.display = 'block';
  document.getElementById('myCamPlaceholder').style.display = 'none';
  document.getElementById('myCamBox').classList.add('active');

  camStream.getVideoTracks().forEach(t => { t.contentHint = 'motion'; });

  if (pc) { camStream.getTracks().forEach(t => pc.addTrack(t, camStream)); if (role === 'host') await renegotiate(); }
}

function stopCam() {
  camStream?.getTracks().forEach(t => t.stop());
  camStream = null; camEnabled = false;
  document.getElementById('btnCam').classList.remove('on');
  document.getElementById('myCam').style.display = 'none';
  document.getElementById('myCamPlaceholder').style.display = 'flex';
  document.getElementById('myCamBox').classList.remove('active');
}

async function toggleMic() {
  micEnabled = !micEnabled;
  document.getElementById('btnMic').classList.toggle('on', micEnabled);
  if (camStream) camStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  else if (micEnabled) await startCam();
}

// ── Sync ───────────────────────────────────────────
function attachSyncListeners() {
  const v = document.getElementById('mainVideo');
  v.addEventListener('play',   () => { if (syncDC?.readyState === 'open') syncDC.send(JSON.stringify({ type: 'play' })); });
  v.addEventListener('pause',  () => { if (syncDC?.readyState === 'open') syncDC.send(JSON.stringify({ type: 'pause' })); });
  v.addEventListener('seeked', () => { if (syncDC?.readyState === 'open') syncDC.send(JSON.stringify({ type: 'seek', t: document.getElementById('mainVideo').currentTime })); });
}

// ── Chat ───────────────────────────────────────────
function sendChat() {
  const inp = document.getElementById('chatInp');
  const txt = inp.value.trim(); if (!txt) return;
  inp.value = '';
  appendMsg(txt, 'me');
  if (chatDC?.readyState === 'open') chatDC.send(JSON.stringify({ text: txt }));
}

function appendMsg(text, who) {
  const box = document.getElementById('chatMsgs');
  const div = document.createElement('div');
  div.className = `msg ${who === 'me' ? 'mine' : ''}`;
  const now = new Date();
  div.innerHTML = `${who !== 'me' ? '<span class="msg-name">Partner</span>' : ''}<div class="msg-bubble">${escHtml(text)}</div><span class="msg-time">${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}</span>`;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
}

function systemMsg(text) {
  const box = document.getElementById('chatMsgs');
  const div = document.createElement('div');
  div.className = 'sys-msg'; div.textContent = text;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
}

// ── UI ─────────────────────────────────────────────
function setStatus(s) {
  const pill = document.getElementById('connPill');
  const txt  = document.getElementById('connText');
  pill.className = `conn-pill ${s}`;
  txt.textContent = s === 'connected' ? 'Connected' : s === 'waiting' ? 'Waiting for partner' : 'Disconnected';
}

function updatePartnerUI(online) {
  document.getElementById('partnerStatus').textContent = online ? 'Connected' : 'Not connected';
  document.getElementById('partnerDot').className = `peer-status ${online ? '' : 'off'}`;
}

function handleFileSelect(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024 * 1024) { toast('Max 10 GB.'); return; }
  startFileStream(file); input.value = '';
}

function switchTab(name) {
  document.querySelectorAll('.stab').forEach((t, i) => t.classList.toggle('active', ['chat','info'][i] === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}

function copyCode() { navigator.clipboard.writeText(roomId).then(() => toast('Copied!')); }
function dismissOverlay() { document.getElementById('overlay').style.display = 'none'; }
function leaveRoom() { if (confirm('Leave?')) window.location.href = '/'; }

let toastTimer;
function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
