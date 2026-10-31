const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Private temporary image storage on own Node.js server disk
const PRIVATE_UPLOADS_DIR = path.join(__dirname, 'private_uploads');
if (!fs.existsSync(PRIVATE_UPLOADS_DIR)) {
  fs.mkdirSync(PRIVATE_UPLOADS_DIR, { recursive: true });
}

// In-memory room store with authoritative state and sessions
const rooms = new Map();
const playerSockets = new Map(); // socketId -> { roomCode, playerNumber, sessionToken }
const roomCleanupTimers = new Map(); // roomCode -> timeout

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateSecureToken(prefix = 'tok') {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

function sanitizeCode(str) {
  return (str || '').replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase().trim();
}

function sanitizeFilename(str) {
  return path.basename((str || '').replace(/[^a-zA-Z0-9._-]/g, ''));
}

// Inspect magic bytes to strictly validate image formats (JPG, PNG, WEBP)
function validateImageMagicBytes(buffer) {
  if (!buffer || buffer.length < 12) return false;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  // WEBP: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return false;
}

function cleanRoomUploads(roomCode) {
  const cleanCode = sanitizeCode(roomCode);
  const roomDir = path.join(PRIVATE_UPLOADS_DIR, cleanCode);
  if (fs.existsSync(roomDir)) {
    try {
      fs.rmSync(roomDir, { recursive: true, force: true });
      console.log(`[Storage Cleaned] Temporary images deleted for room ${cleanCode}`);
    } catch (err) {
      console.error(`[Storage Clean Error] Failed to delete directory for room ${cleanCode}:`, err);
    }
  }
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      const { pathname, query } = parsedUrl;

      // Custom API: Active room verification (debugging/monitoring)
      if (pathname === '/api/rooms/active' && req.method === 'GET') {
        const publicRooms = Array.from(rooms.values()).map(r => ({
          code: r.code,
          gameId: r.gameId,
          status: r.status,
          playerCount: (r.p1 ? 1 : 0) + (r.p2 ? 1 : 0),
          createdAt: r.createdAt
        }));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ rooms: publicRooms, total: rooms.size }));
        return;
      }

      // OWN SERVER TEMPORARY IMAGE UPLOAD ENDPOINT
      // POST /api/rooms/:code/upload
      const uploadMatch = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/upload$/);
      if (uploadMatch && req.method === 'POST') {
        const roomCode = sanitizeCode(uploadMatch[1]);
        const room = rooms.get(roomCode);

        if (!room) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Room not found or expired.' }));
          return;
        }

        let body = '';
        const MAX_BODY_SIZE = 8 * 1024 * 1024; // 8MB to allow 5MB base64 overhead
        let sizeExceeded = false;

        req.on('data', chunk => {
          body += chunk;
          if (body.length > MAX_BODY_SIZE) {
            sizeExceeded = true;
            req.destroy();
          }
        });

        req.on('end', () => {
          if (sizeExceeded) {
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'File size exceeds maximum allowed limit of 5 MB.' }));
            return;
          }

          try {
            const data = JSON.parse(body);
            const { imageBase64, filename, sessionToken, playerNumber } = data;

            // Strict Room Membership & Session Authorization
            const isAuthorizedP1 = room.p1 && room.p1.sessionToken === sessionToken && playerNumber === 1;
            const isAuthorizedP2 = room.p2 && room.p2.sessionToken === sessionToken && playerNumber === 2;
            if (!isAuthorizedP1 && !isAuthorizedP2) {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Unauthorized: invalid room session token.' }));
              return;
            }

            if (!imageBase64) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Missing image data.' }));
              return;
            }

            // Extract base64 payload
            const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            const base64Data = matches ? matches[2] : imageBase64;
            const buffer = Buffer.from(base64Data, 'base64');

            // Validate file size (strict 5 MB check)
            if (buffer.length > 5 * 1024 * 1024) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Image file size exceeds the 5 MB limit.' }));
              return;
            }

            // Validate magic bytes (JPG, PNG, WEBP)
            const detectedMime = validateImageMagicBytes(buffer);
            if (!detectedMime) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Unsupported file format. Only JPG, PNG, and WEBP photos are allowed.' }));
              return;
            }

            // Create room-specific private directory
            const roomUploadDir = path.join(PRIVATE_UPLOADS_DIR, roomCode);
            if (!fs.existsSync(roomUploadDir)) {
              fs.mkdirSync(roomUploadDir, { recursive: true });
            }

            // Generate cryptographically unique filename
            const ext = detectedMime === 'image/jpeg' ? 'jpg' : detectedMime === 'image/png' ? 'png' : 'webp';
            const uniqueFilename = `img_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
            const targetPath = path.join(roomUploadDir, uniqueFilename);

            // Write image buffer to disk
            fs.writeFileSync(targetPath, buffer);

            const servedUrl = `/api/rooms/${roomCode}/images/${uniqueFilename}?token=${sessionToken}`;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              filename: uniqueFilename,
              url: servedUrl,
              mimeType: detectedMime,
              size: buffer.length
            }));
          } catch (err) {
            console.error('[Upload Parse Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Failed to process image upload.' }));
          }
        });
        return;
      }

      // AUTHENTICATED ROOM IMAGE SERVING ENDPOINT
      // GET /api/rooms/:code/images/:filename?token=...
      const imageMatch = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/images\/([a-zA-Z0-9._-]+)$/);
      if (imageMatch && req.method === 'GET') {
        const roomCode = sanitizeCode(imageMatch[1]);
        const safeFilename = sanitizeFilename(imageMatch[2]);
        const token = query.token || req.headers['x-room-token'];

        const room = rooms.get(roomCode);
        if (!room) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Room not found or image has been cleaned up.' }));
          return;
        }

        // Check if token matches either Player 1 or Player 2 in this room
        const isAuthorizedP1 = room.p1 && (room.p1.sessionToken === token || room.p1.id === token);
        const isAuthorizedP2 = room.p2 && (room.p2.sessionToken === token || room.p2.id === token);

        if (!token || (!isAuthorizedP1 && !isAuthorizedP2)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Forbidden: You do not have permission to view private images from this room.' }));
          return;
        }

        const filePath = path.join(PRIVATE_UPLOADS_DIR, roomCode, safeFilename);
        if (!fs.existsSync(filePath)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Image not found or has expired.' }));
          return;
        }

        const ext = path.extname(safeFilename).toLowerCase();
        const mimeTypes = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.webp': 'image/webp'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
        return;
      }

      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  io.on('connection', (socket) => {
    // CREATE PRIVATE ROOM (STRICT 2-PLAYER, HOST REGISTRATION)
    socket.on('create-room', ({ gameId, player }) => {
      let code = generateRoomCode();
      while (rooms.has(code)) {
        code = generateRoomCode();
      }

      const p1SessionToken = generateSecureToken('p1');
      const invitationToken = generateSecureToken('inv');

      const roomData = {
        code,
        gameId: gameId || 'hottiktok',
        p1: {
          id: socket.id,
          uid: player.uid || socket.id,
          name: player.name || 'Player 1 (Host)',
          avatar: player.avatar || '👑',
          ready: false,
          score: 0,
          connected: true,
          sessionToken: p1SessionToken,
        },
        p2: null,
        invitationToken,
        invitationUsed: false,
        gameState: null,
        turn: 1, // 1 for P1, 2 for P2
        currentPlayer: 'P1', // 'P1' for Player 1, 'P2' for Player 2
        currentChallenge: null,
        status: 'waiting_for_partner', // waiting_for_partner, active, playing, finished, closed
        messages: [],
        createdAt: Date.now(),
      };

      rooms.set(code, roomData);
      playerSockets.set(socket.id, { roomCode: code, playerNumber: 1, sessionToken: p1SessionToken });
      socket.join(code);

      console.log(`[Room Created] ${code} by ${player.name} for game ${roomData.gameId}`);
      socket.emit('room-created', {
        room: roomData,
        playerNumber: 1,
        sessionToken: p1SessionToken,
        invitationToken
      });
    });

    // JOIN PRIVATE ROOM (SECURE ADMISSION & RECONNECTION)
    socket.on('join-room', ({ code, player, sessionToken }) => {
      const upperCode = sanitizeCode(code);
      const room = rooms.get(upperCode);

      if (!room) {
        socket.emit('error-msg', { message: 'Room not found! Check code or create new.' });
        return;
      }

      // Clear any pending room destruction timer if players are reconnecting
      if (roomCleanupTimers.has(upperCode)) {
        clearTimeout(roomCleanupTimers.get(upperCode));
        roomCleanupTimers.delete(upperCode);
      }

      // Reconnection check for Player 1
      if (room.p1 && (room.p1.sessionToken === sessionToken || room.p1.uid === player.uid || (room.p1.name === player.name && !room.p1.connected))) {
        room.p1.id = socket.id;
        room.p1.connected = true;
        if (room.status === 'temporarily_disconnected') {
          room.status = room.p2?.connected ? 'active' : 'waiting_for_partner';
        }
        playerSockets.set(socket.id, { roomCode: upperCode, playerNumber: 1, sessionToken: room.p1.sessionToken });
        socket.join(upperCode);
        io.to(upperCode).emit('room-updated', { room });
        socket.emit('room-joined', {
          room,
          playerNumber: 1,
          sessionToken: room.p1.sessionToken,
          reconnected: true
        });
        return;
      }

      // Reconnection check for Player 2
      if (room.p2 && (room.p2.sessionToken === sessionToken || room.p2.uid === player.uid || (room.p2.name === player.name && !room.p2.connected))) {
        room.p2.id = socket.id;
        room.p2.connected = true;
        if (room.status === 'temporarily_disconnected') {
          room.status = room.p1?.connected ? 'active' : 'waiting_for_partner';
        }
        playerSockets.set(socket.id, { roomCode: upperCode, playerNumber: 2, sessionToken: room.p2.sessionToken });
        socket.join(upperCode);
        io.to(upperCode).emit('room-updated', { room });
        socket.emit('room-joined', {
          room,
          playerNumber: 2,
          sessionToken: room.p2.sessionToken,
          reconnected: true
        });
        return;
      }

      // New Partner Admission into Player 2 Slot
      if (!room.p2) {
        const p2SessionToken = generateSecureToken('p2');
        room.p2 = {
          id: socket.id,
          uid: player.uid || socket.id,
          name: player.name || 'Partner',
          avatar: player.avatar || '💖',
          ready: false,
          score: 0,
          connected: true,
          sessionToken: p2SessionToken,
        };
        room.invitationUsed = true;
        room.status = 'active';
        playerSockets.set(socket.id, { roomCode: upperCode, playerNumber: 2, sessionToken: p2SessionToken });
        socket.join(upperCode);

        console.log(`[Room Joined] ${upperCode} by ${player.name} as Player 2`);
        io.to(upperCode).emit('room-updated', { room });
        socket.emit('room-joined', {
          room,
          playerNumber: 2,
          sessionToken: p2SessionToken,
          reconnected: false
        });
        return;
      }

      // STRICT 2-PLAYER LIMIT: Reject any third player attempting to enter
      console.log(`[Room Access Denied] 3rd player blocked from room ${upperCode}`);
      socket.emit('error-msg', { message: 'This couple room is already full (2 players max).' });
    });

    // TOGGLE PLAYER READY STATUS
    socket.on('toggle-ready', ({ code, ready, sessionToken }) => {
      const room = rooms.get(sanitizeCode(code));
      if (!room) return;

      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo) return;

      if (playerInfo.playerNumber === 1 && room.p1) {
        room.p1.ready = ready;
      } else if (playerInfo.playerNumber === 2 && room.p2) {
        room.p2.ready = ready;
      }

      if (room.p1?.ready && room.p2?.ready) {
        room.status = 'playing';
      }

      io.to(room.code).emit('room-updated', { room });
    });

    // START GAME
    socket.on('start-game', ({ code }) => {
      const room = rooms.get(sanitizeCode(code));
      if (!room) return;
      room.status = 'playing';
      io.to(room.code).emit('room-updated', { room });
    });

    // SWITCH GAME
    socket.on('switch-game', ({ code, gameId }) => {
      const room = rooms.get(sanitizeCode(code));
      if (!room) return;

      room.gameId = gameId;
      room.gameState = null;
      room.turn = 1;
      room.currentPlayer = 'P1';
      room.currentChallenge = null;
      if (room.p1) room.p1.ready = false;
      if (room.p2) room.p2.ready = false;
      room.status = 'active';

      io.to(room.code).emit('game-switched', { gameId, room });
    });

    // GAME ACTION BROADCAST & AUTHORITATIVE TURN LOGIC
    socket.on('game-action', ({ code, action, payload }) => {
      const room = rooms.get(sanitizeCode(code));
      if (!room) return;

      const playerInfo = playerSockets.get(socket.id);
      const playerNum = playerInfo ? playerInfo.playerNumber : 0;

      // Security check: only authorized room players can trigger game actions
      if (playerNum !== 1 && playerNum !== 2) {
        socket.emit('error-msg', { message: 'Unauthorized action.' });
        return;
      }

      // Handle Hot TikTok Wheel Spin
      if (action === 'HT_SPIN' || action === 'spin-wheel') {
        room.currentChallenge = payload?.card || null;
        if (!payload) payload = {};
        payload.spinner = playerNum;
        payload.activeTurn = playerNum;
        console.log(`[Wheel Spun] Room ${room.code}: Player ${playerNum} spun: "${payload.card?.text?.substring(0, 30)}..."`);
      }

      // Handle Hot TikTok Challenge Completion & Authoritative Turn Switch
      if (action === 'HT_VERIFY' || action === 'challengeCompleted' || action === 'complete-challenge') {
        const performer = payload?.performer || (room.currentPlayer === 'P1' ? 1 : 2);
        const completed = !!payload?.completed;

        if (completed) {
          if (performer === 1 && room.p1) room.p1.score = (room.p1.score || 0) + 100;
          if (performer === 2 && room.p2) room.p2.score = (room.p2.score || 0) + 100;
        }

        // Authoritative Turn Toggle
        room.currentPlayer = (room.currentPlayer === 'P1') ? 'P2' : 'P1';
        room.turn = room.currentPlayer === 'P1' ? 1 : 2;
        room.currentChallenge = null;

        console.log(`[Next Turn Event] Room ${room.code}: Switched turn to ${room.currentPlayer} (Player ${room.turn})`);

        // Emit dedicated Socket.IO event 'next-turn' to room
        io.to(room.code).emit('next-turn', {
          currentPlayer: room.currentPlayer,
          turn: room.turn,
          player: room.currentPlayer,
          nextTurn: room.turn,
          performer,
          completed,
          p1Score: room.p1?.score || 0,
          p2Score: room.p2?.score || 0,
        });

        // Emit dedicated Socket.IO event 'challenge-completed' to room
        io.to(room.code).emit('challenge-completed', {
          performer,
          completed,
          nextPlayer: room.currentPlayer,
          nextTurn: room.turn,
        });
      }

      if (action === 'HT_REPLACE') {
        room.currentChallenge = payload?.card || null;
      }

      io.to(room.code).emit('game-action-broadcast', {
        action,
        payload,
        senderNumber: playerNum,
        timestamp: Date.now()
      });
    });

    // DIRECT NEXT-TURN SOCKET HANDLER
    socket.on('next-turn', ({ code }) => {
      const room = rooms.get(sanitizeCode(code));
      if (!room) return;

      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || (playerInfo.playerNumber !== 1 && playerInfo.playerNumber !== 2)) return;

      room.currentPlayer = (room.currentPlayer === 'P1') ? 'P2' : 'P1';
      room.turn = room.currentPlayer === 'P1' ? 1 : 2;
      room.currentChallenge = null;

      console.log(`[Socket next-turn] Room ${room.code}: Next player is ${room.currentPlayer} (Player ${room.turn})`);
      io.to(room.code).emit('next-turn', {
        currentPlayer: room.currentPlayer,
        turn: room.turn,
        player: room.currentPlayer,
        nextTurn: room.turn,
        p1Score: room.p1?.score || 0,
        p2Score: room.p2?.score || 0,
      });
    });

    // DIRECT CHALLENGE-COMPLETED SOCKET HANDLER
    socket.on('challenge-completed', ({ code, completed, performer }) => {
      const room = rooms.get(sanitizeCode(code));
      if (!room) return;

      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || (playerInfo.playerNumber !== 1 && playerInfo.playerNumber !== 2)) return;

      const perf = performer || (room.currentPlayer === 'P1' ? 1 : 2);
      if (completed) {
        if (perf === 1 && room.p1) room.p1.score = (room.p1.score || 0) + 100;
        if (perf === 2 && room.p2) room.p2.score = (room.p2.score || 0) + 100;
      }

      room.currentPlayer = (room.currentPlayer === 'P1') ? 'P2' : 'P1';
      room.turn = room.currentPlayer === 'P1' ? 1 : 2;
      room.currentChallenge = null;

      console.log(`[Socket challenge-completed] Room ${room.code}: Completed by P${perf}. Next: ${room.currentPlayer}`);
      io.to(room.code).emit('next-turn', {
        currentPlayer: room.currentPlayer,
        turn: room.turn,
        player: room.currentPlayer,
        nextTurn: room.turn,
        performer: perf,
        completed: !!completed,
        p1Score: room.p1?.score || 0,
        p2Score: room.p2?.score || 0,
      });

      io.to(room.code).emit('challenge-completed', {
        performer: perf,
        completed: !!completed,
        nextPlayer: room.currentPlayer,
        nextTurn: room.turn,
      });
    });

    // SYNC STATE
    socket.on('sync-state', ({ code, gameState }) => {
      const room = rooms.get(sanitizeCode(code));
      if (!room) return;

      room.gameState = gameState;
      socket.to(room.code).emit('state-synced', { gameState, senderId: socket.id });
    });

    // REACTION
    socket.on('send-reaction', ({ code, emoji, senderName }) => {
      const cleanCode = sanitizeCode(code);
      io.to(cleanCode).emit('reaction-received', {
        id: Math.random().toString(36).substring(2, 9),
        emoji,
        senderName: senderName || 'Partner',
        timestamp: Date.now()
      });
    });

    // SEND IN-GAME CHAT (TEXT & IMAGE ATTACHMENTS)
    socket.on('send-chat', ({ id, code, message, imageUrl, imageFilename, senderName, avatar, senderNumber, sessionToken }) => {
      const cleanCode = sanitizeCode(code);
      const room = rooms.get(cleanCode);
      if (!room) return;

      const playerInfo = playerSockets.get(socket.id);
      const actualNumber = playerInfo?.playerNumber || senderNumber;

      const chatItem = {
        id: id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        message: message || '',
        imageUrl: imageUrl || null,
        imageFilename: imageFilename || null,
        senderName: senderName || (actualNumber === 1 ? room.p1?.name : room.p2?.name) || 'Partner',
        avatar: avatar || (actualNumber === 1 ? room.p1?.avatar : room.p2?.avatar) || '❤️',
        senderNumber: actualNumber,
        timestamp: Date.now(),
        isDeleted: false,
        deletedFor: [] // Array of player numbers who selected 'Delete for me'
      };

      if (!room.messages) room.messages = [];
      room.messages.push(chatItem);
      if (room.messages.length > 80) room.messages.shift();

      io.to(cleanCode).emit('chat-received', chatItem);
    });

    // DELETE CHAT MESSAGE (DELETE FOR ME & DELETE FOR EVERYONE WITH STRICT AUTHORIZATION)
    socket.on('delete-chat', ({ code, messageId, deleteType, playerNumber, sessionToken }) => {
      const cleanCode = sanitizeCode(code);
      const room = rooms.get(cleanCode);
      if (!room || !room.messages) return;

      const playerInfo = playerSockets.get(socket.id);
      const requestingNumber = playerInfo?.playerNumber || playerNumber;

      const targetIndex = room.messages.findIndex(m => m.id === messageId);
      if (targetIndex === -1) return;

      const targetMsg = room.messages[targetIndex];

      if (deleteType === 'for-everyone') {
        // STRICT SENDER CHECK: Only the sender can delete a message for everyone!
        if (targetMsg.senderNumber !== requestingNumber) {
          socket.emit('error-msg', { message: 'Unauthorized: You can only delete your own messages for everyone.' });
          return;
        }

        // If the message contains an image, delete the physical temporary file from disk
        if (targetMsg.imageFilename) {
          const filePath = path.join(PRIVATE_UPLOADS_DIR, cleanCode, sanitizeFilename(targetMsg.imageFilename));
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
              console.log(`[Storage Cleaned] Deleted image file ${targetMsg.imageFilename} for deleted message`);
            } catch (err) {
              console.error('[File Delete Error]', err);
            }
          }
        }

        // Update in-memory chat record
        targetMsg.isDeleted = true;
        targetMsg.message = 'This message was deleted';
        targetMsg.imageUrl = null;
        targetMsg.imageFilename = null;

        // Broadcast to BOTH players in real time
        io.to(cleanCode).emit('chat-deleted', {
          messageId,
          deleteType: 'for-everyone',
          message: 'This message was deleted'
        });
      } else if (deleteType === 'for-me') {
        // Delete for me: Record that this player has hidden the message
        if (!targetMsg.deletedFor) targetMsg.deletedFor = [];
        if (!targetMsg.deletedFor.includes(requestingNumber)) {
          targetMsg.deletedFor.push(requestingNumber);
        }

        // Emit only to requesting player
        socket.emit('chat-deleted', {
          messageId,
          deleteType: 'for-me',
          playerNumber: requestingNumber
        });
      }
    });

    // REMATCH REQUEST & ACCEPT
    socket.on('rematch-request', ({ code }) => {
      const cleanCode = sanitizeCode(code);
      const playerInfo = playerSockets.get(socket.id);
      socket.to(cleanCode).emit('rematch-requested', { requesterNumber: playerInfo?.playerNumber });
    });

    socket.on('rematch-accept', ({ code }) => {
      const cleanCode = sanitizeCode(code);
      const room = rooms.get(cleanCode);
      if (room) {
        room.gameState = null;
        room.status = 'playing';
        io.to(cleanCode).emit('rematch-started', { room });
      }
    });

    // LEAVE ROOM
    socket.on('leave-room', ({ code }) => {
      const cleanCode = sanitizeCode(code);
      const room = rooms.get(cleanCode);
      const playerInfo = playerSockets.get(socket.id);
      if (room && playerInfo) {
        if (playerInfo.playerNumber === 1) {
          room.p1 = null;
        } else {
          room.p2 = null;
        }
        socket.to(cleanCode).emit('player-left', { playerNumber: playerInfo.playerNumber });
        if (!room.p1 && !room.p2) {
          cleanRoomUploads(cleanCode);
          rooms.delete(cleanCode);
        } else {
          room.status = 'waiting_for_partner';
          io.to(cleanCode).emit('room-updated', { room });
        }
      }
      socket.leave(cleanCode);
      playerSockets.delete(socket.id);
    });

    // DISCONNECT & RECONNECT GRACE PERIOD (2 MINUTES)
    socket.on('disconnect', () => {
      const playerInfo = playerSockets.get(socket.id);
      if (playerInfo) {
        const { roomCode, playerNumber } = playerInfo;
        const room = rooms.get(roomCode);
        if (room) {
          const targetPlayer = playerNumber === 1 ? room.p1 : room.p2;
          if (targetPlayer) {
            targetPlayer.connected = false;
            room.status = 'temporarily_disconnected';
            io.to(roomCode).emit('player-disconnected', { playerNumber, room });
            console.log(`[Disconnect] Player ${playerNumber} disconnected from ${roomCode}`);

            // If both players are disconnected, schedule room expiration & upload cleanup in 2 minutes
            const bothDisconnected = (!room.p1 || !room.p1.connected) && (!room.p2 || !room.p2.connected);
            if (bothDisconnected) {
              console.log(`[Grace Period] Both players disconnected from ${roomCode}. Starting 2-minute cleanup timer.`);
              if (roomCleanupTimers.has(roomCode)) {
                clearTimeout(roomCleanupTimers.get(roomCode));
              }

              const timer = setTimeout(() => {
                const currentRoom = rooms.get(roomCode);
                if (currentRoom && (!currentRoom.p1?.connected && !currentRoom.p2?.connected)) {
                  cleanRoomUploads(roomCode);
                  rooms.delete(roomCode);
                  roomCleanupTimers.delete(roomCode);
                  console.log(`[Room Expired] Deleted inactive room ${roomCode} and all private uploads.`);
                }
              }, 120000); // 2 minutes grace period

              roomCleanupTimers.set(roomCode, timer);
            }
          }
        }
        playerSockets.delete(socket.id);
      }
    });
  });

  server.listen(port, hostname, () => {
    console.log(`> CoupleVerse server ready on http://localhost:${port}`);
    console.log(`> Local network mobile access: http://<your-lan-ip>:${port}`);
  });
});
