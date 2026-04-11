const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'],
  path: '/socket.io/',
  pingTimeout: 60000,      // wait 60s before declaring disconnect
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'room.html'))
);

app.get('/ice-config', (_req, res) => {
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'PASTE_YOUR_USERNAME',
        credential: 'PASTE_YOUR_CREDENTIAL'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'PASTE_YOUR_USERNAME',
        credential: 'PASTE_YOUR_CREDENTIAL'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'PASTE_YOUR_USERNAME',
        credential: 'PASTE_YOUR_CREDENTIAL'
      }
    ]
  });
});

const rooms = new Map();
// rooms: code -> { host: socketId, guest: socketId|null, createdAt: timestamp }

function genCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Clean up rooms older than 4 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > 4 * 60 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[cleanup] Room ${code} expired`);
    }
  }
}, 30 * 60 * 1000);

io.on('connection', (socket) => {
  let roomCode = null;
  let myRole   = null;

    socket.on('create-room', () => {
    // Check if there's already a room with a dead host socket
    for (const [code, room] of rooms.entries()) {
      const hostAlive = room.host && io.sockets.sockets.get(room.host)?.connected;
      if (!hostAlive && myRole === null) {
        // This might be the host reconnecting — update socket ID
        room.host = socket.id;
        roomCode  = code;
        myRole    = 'host';
        socket.join(code);
        socket.emit('room-created', code);
        console.log(`[~] Host reconnected to room ${code}`);
        return;
      }
    }

  // Fresh room
  let code = genCode();
  while (rooms.has(code)) code = genCode();
  rooms.set(code, { host: socket.id, guest: null, createdAt: Date.now() });
  roomCode = code;
  myRole   = 'host';
  socket.join(code);
  socket.emit('room-created', code);
  console.log(`[+] Room ${code} created`);
});
  socket.on('join-room', (code) => {
    const c    = (code || '').toUpperCase().trim();
    const room = rooms.get(c);

    if (!room) {
      socket.emit('join-error', 'Room not found. Check the code.');
      return;
    }
    // Allow rejoin if same socket or guest slot is free
  if (room.guest && room.guest !== socket.id) {
  // Check if the existing guest socket is still connected
  const existingSocket = io.sockets.sockets.get(room.guest);
  if (existingSocket && existingSocket.connected) {
    socket.emit('join-error', 'Room is already full.');
    return;
  }
  // Old socket is dead — allow takeover
  room.guest = null;
}

    room.guest = socket.id;
    roomCode   = c;
    myRole     = 'guest';
    socket.join(c);
    socket.emit('room-joined', c);
    socket.to(c).emit('guest-joined');
    console.log(`[+] ${socket.id} joined room ${c}`);
  });

  socket.on('rejoin-room', (code) => {
  const c    = (code || '').toUpperCase().trim();
  const room = rooms.get(c);
  if (!room) { socket.emit('join-error', 'Session expired. Create a new room.'); return; }

  // Check which slot this socket should take
  const hostAlive  = room.host  && io.sockets.sockets.get(room.host)?.connected;
  const guestAlive = room.guest && io.sockets.sockets.get(room.guest)?.connected;

  if (!hostAlive)  room.host  = null;
  if (!guestAlive) room.guest = null;

  if (!room.host)       { room.host  = socket.id; myRole = 'host'; }
  else if (!room.guest) { room.guest = socket.id; myRole = 'guest'; }
  else {
    socket.emit('join-error', 'Room is already full.');
    return;
  }

  roomCode = c;
  socket.join(c);
  socket.emit('room-rejoined', c);
  socket.to(c).emit('peer-reconnected');
  console.log(`[~] ${socket.id} rejoined room ${c} as ${myRole}`);
});

  // Pure relay
  socket.on('offer',  (d) => { if (roomCode) socket.to(roomCode).emit('offer',  d); });
  socket.on('answer', (d) => { if (roomCode) socket.to(roomCode).emit('answer', d); });
  socket.on('ice',    (d) => { if (roomCode) socket.to(roomCode).emit('ice',    d); });

  socket.on('disconnect', (reason) => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    console.log(`[~] ${socket.id} disconnected (${reason}) from room ${roomCode}`);

    // Notify partner but DON'T delete the room yet
    // Give 30 seconds for reconnection
    socket.to(roomCode).emit('peer-disconnected');

    setTimeout(() => {
      const r = rooms.get(roomCode);
      if (!r) return;
      // Check if socket reconnected (slot would have been updated)
      if (r.host === socket.id || r.guest === socket.id) {
        // Still the same disconnected socket — clean the slot
        if (r.host === socket.id)  r.host  = null;
        if (r.guest === socket.id) r.guest = null;

        // If both slots empty, delete room
        if (!r.host && !r.guest) {
          rooms.delete(roomCode);
          console.log(`[-] Room ${roomCode} deleted (empty)`);
        }
      }
    }, 30000); // 30 second grace period
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () =>
  console.log(`\n  WatchTogether  →  http://localhost:${PORT}\n`)
);
