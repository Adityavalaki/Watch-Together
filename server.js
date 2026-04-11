const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'],
  path: '/socket.io/'
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'room.html'))
);

// rooms: code -> { host: socketId, guest: socketId | null }
const rooms = new Map();

function genCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

io.on('connection', (socket) => {
  let roomCode = null;

  socket.on('create-room', () => {
    let code = genCode();
    while (rooms.has(code)) code = genCode();
    rooms.set(code, { host: socket.id, guest: null });
    roomCode = code;
    socket.join(code);
    socket.emit('room-created', code);
    console.log(`[+] Room ${code} created`);
  });

  socket.on('join-room', (code) => {
    const c = (code || '').toUpperCase().trim();
    const room = rooms.get(c);
    if (!room)       { socket.emit('join-error', 'Room not found. Check the code.'); return; }
    if (room.guest)  { socket.emit('join-error', 'Room is already full.'); return; }
    room.guest = socket.id;
    roomCode = c;
    socket.join(c);
    socket.emit('room-joined', c);
    socket.to(c).emit('guest-joined');
    console.log(`[+] Guest joined room ${c}`);
  });

  // Pure relay — server never inspects WebRTC payloads
  socket.on('offer',  (d) => { if (roomCode) socket.to(roomCode).emit('offer',  d); });
  socket.on('answer', (d) => { if (roomCode) socket.to(roomCode).emit('answer', d); });
  socket.on('ice',    (d) => { if (roomCode) socket.to(roomCode).emit('ice',    d); });

  socket.on('disconnect', () => {
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  // Give 10 seconds grace period before destroying room
  // handles brief Render connection drops
  setTimeout(() => {
    const current = rooms.get(roomCode);
    if (!current) return;
    rooms.delete(roomCode);
    io.to(roomCode).emit('peer-disconnected');
    console.log(`[-] Room ${roomCode} closed`);
  }, 10000);
});
});
// Keep Render from sleeping mid-session
setInterval(() => {
  io.emit('ping-keep-alive');
}, 25000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () =>
  console.log(`\n  WatchTogether  →  http://localhost:${PORT}\n`)
);
// Add this route in server.js
app.get('/ice-config', (_req, res) => {
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: '59f9ee3667a83d0d0e585834',
        credential: 'NbVQiGBbHvjC7HLS'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: '59f9ee3667a83d0d0e585834',
        credential: 'NbVQiGBbHvjC7HLS'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: '59f9ee3667a83d0d0e585834',
        credential: 'NbVQiGBbHvjC7HLS'
      }
    ]
  });
});