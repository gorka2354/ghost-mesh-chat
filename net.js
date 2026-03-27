// === Ghost Mesh Chat — net.js (PeerJS, соединения, протокол) ===

// --- Ping/pong и peer reconnect ---
const PING_INTERVAL = 15000;
const PONG_TIMEOUT = 5000;
const PEER_GRACE_PERIOD = 30000;
const MAX_PEER_RECONNECT = 3;
let pingIntervalId = null;
const peerPongTimers = new Map();

// --- Signaling ---
let peerRetries = 0;
const MAX_PEER_RETRIES = 3;
let signalingState = 'offline';
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_BEFORE_REINIT = 3;

const SIGNAL_HOST = 'ghost-mesh-signal.onrender.com';
const SIGNAL_URL = 'https://' + SIGNAL_HOST;

const PEER_CONFIG = {
  host: SIGNAL_HOST,
  port: 443,
  path: '/peerjs',
  secure: true,
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

// --- Keep-alive для signaling-сервера ---
const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000;
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    fetch(SIGNAL_URL + '/health')
      .then(r => r.json())
      .then(data => dlog('keep-alive: server uptime ' + Math.round(data.uptime) + 's', 'ok'))
      .catch(() => dlog('keep-alive: signaling не отвечает', 'warn'));
  }, KEEP_ALIVE_INTERVAL);
  dlog('keep-alive started (every 10 min)');
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// --- Signaling status ---
function setSignalingStatus(state) {
  signalingState = state;
  signalStatusEl.className = 'signal-dot ' + state;
  const titles = { online: 'signaling: online', reconnecting: 'signaling: переподключение...', offline: 'signaling: offline' };
  signalStatusEl.title = titles[state] || state;
  dlog('signaling status: ' + state, state === 'online' ? 'ok' : state === 'offline' ? 'error' : 'warn');
}

function getReconnectDelay() {
  const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), 30000);
  return delay;
}

function scheduleSignalingReconnect() {
  if (peer.destroyed) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectAttempts++;

  if (reconnectAttempts > MAX_RECONNECT_BEFORE_REINIT) {
    dlog('reconnect не помог (' + MAX_RECONNECT_BEFORE_REINIT + ' попыток), полная переинициализация', 'warn');
    reinitPeer();
    return;
  }

  const delay = getReconnectDelay();
  dlog('signaling reconnect in ' + (delay / 1000) + 's (attempt ' + reconnectAttempts + '/' + MAX_RECONNECT_BEFORE_REINIT + ')', 'warn');
  setStatus('signaling переподключение... (' + reconnectAttempts + '/' + MAX_RECONNECT_BEFORE_REINIT + ')');

  reconnectTimer = setTimeout(() => {
    if (!peer.destroyed && !peer.open) {
      dlog('attempting signaling reconnect...');
      peer.reconnect();
    }
  }, delay);
}

function resetReconnectState() {
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// --- Полная переинициализация peer ---
function reinitPeer() {
  resetReconnectState();
  peerRetries = 0;

  const savedPeers = [];
  for (const [peerId, entry] of connections) {
    savedPeers.push(peerId);
  }
  for (const [peerId] of peerGraceTimers) {
    if (!savedPeers.includes(peerId)) savedPeers.push(peerId);
  }
  dlog('reinit: сохранены пиры для реконнекта: ' + (savedPeers.length > 0 ? savedPeers.join(', ') : 'нет'));

  for (const [peerId] of peerGraceTimers) cancelPeerGrace(peerId);
  connections.clear();
  stopPingLoop();

  if (peer && !peer.destroyed) {
    try { peer.destroy(); } catch (e) {}
  }

  const onReconnected = () => {
    if (savedPeers.length > 0) {
      dlog('reinit: переподключаюсь к ' + savedPeers.length + ' пир(ам)', 'ok');
      for (const peerId of savedPeers) {
        connectToPeer(peerId);
      }
    }
    if (roomId && !isHost && !savedPeers.includes(roomId)) {
      connectToRoom(roomId);
    }
  };

  if (isHost && roomId) {
    dlog('reinit: переинициализация как хост ' + roomId, 'warn');
    setSignalingStatus('reconnecting');
    initPeer(roomId, () => { onOpenAsHost(); onReconnected(); });
  } else {
    dlog('reinit: переинициализация как ' + myNickname, 'warn');
    setSignalingStatus('reconnecting');
    initPeer(myNickname, onReconnected);
  }
}

// --- Инициализация PeerJS ---
function initPeer(peerId, onOpen) {
  dlog('initPeer: id=' + peerId + ', retry=' + peerRetries);
  resetReconnectState();
  const thisPeer = new Peer(peerId, PEER_CONFIG);
  peer = thisPeer;

  const connectTimeout = setTimeout(() => {
    if (peer !== thisPeer) return;
    if (!thisPeer.open && !thisPeer.destroyed) {
      if (peerRetries < MAX_PEER_RETRIES) {
        peerRetries++;
        dlog('signaling timeout, retry ' + peerRetries, 'warn');
        setStatus('signaling не отвечает, повтор ' + peerRetries + '/' + MAX_PEER_RETRIES);
        thisPeer.destroy();
        initPeer(peerId, onOpen);
      } else {
        dlog('signaling failed after ' + MAX_PEER_RETRIES + ' retries', 'error');
        setStatus('signaling недоступен');
      }
    }
  }, 10000);

  thisPeer.on('open', (id) => {
    if (peer !== thisPeer) return;
    clearTimeout(connectTimeout);
    peerRetries = 0;
    resetReconnectState();
    setSignalingStatus('online');
    startKeepAlive();
    dlog('peer.open: id=' + id, 'ok');
    myIdEl.textContent = myNickname;
    myIdCopyEl.textContent = myNickname;
    setStatus('online — ожидание');
    if (onOpen) onOpen(id);
  });

  thisPeer.on('connection', (incoming) => {
    if (peer !== thisPeer) return;
    dlog('incoming connection from ' + incoming.peer);
    handleConnection(incoming, null, true);
  });

  thisPeer.on('error', (err) => {
    if (peer !== thisPeer) return;
    clearTimeout(connectTimeout);
    dlog('peer.error: type=' + err.type + ' msg=' + err.message, 'error');
    if (err.type === 'unavailable-id') {
      thisPeer.destroy();
      if (isHost) {
        roomId = generateRoomId();
        initPeer(roomId, onOpenAsHost);
      } else {
        initPeer(myNickname + '-' + Math.random().toString(16).substring(2, 4), onOpen);
      }
      return;
    }
    if (err.type === 'peer-unavailable') {
      setStatus('пир не найден');
      return;
    }
    setStatus('ошибка: ' + err.type);
  });

  thisPeer.on('disconnected', () => {
    if (peer !== thisPeer) return;
    dlog('peer.disconnected (destroyed=' + thisPeer.destroyed + ')', 'warn');
    if (thisPeer.destroyed) return;
    setSignalingStatus('reconnecting');
    scheduleSignalingReconnect();
  });

  thisPeer.on('close', () => {
    if (peer !== thisPeer) return;
    dlog('peer.close — полное отключение', 'error');
    setSignalingStatus('offline');
  });
}

// --- Отправка ---
function connectToPeer(remotePeerId) {
  const id = remotePeerId.trim();
  if (!id) { dlog('connectToPeer: пустой ID', 'warn'); return; }
  if (connections.has(id)) { dlog('connectToPeer: уже подключён к ' + id, 'warn'); return; }
  if (!peer || !peer.open) {
    dlog('connectToPeer: signaling не подключён, невозможно соединиться', 'error');
    setStatus('signaling не подключён');
    return;
  }
  dlog('connectToPeer: подключаюсь к ' + id);
  setStatus('подключение к ' + id + '...');
  const conn = peer.connect(id, { reliable: true });
  handleConnection(conn);
}

function sendToRaw(conn, obj) {
  conn.send(JSON.stringify(obj));
}

async function sendToEncrypted(conn, peerId, obj) {
  const entry = connections.get(peerId);
  if (!entry || !entry.sharedKey) {
    sendToRaw(conn, obj);
    return;
  }
  const plaintext = JSON.stringify(obj);
  const encrypted = await encryptData(entry.sharedKey, plaintext);
  sendToRaw(conn, { type: 'encrypted', iv: encrypted.iv, data: encrypted.data });
}

async function broadcastEncrypted(obj) {
  for (const [peerId, entry] of chatConnections()) {
    if (entry.conn.open) {
      await sendToEncrypted(entry.conn, peerId, obj);
    }
  }
}

// --- Ping/pong ---
function startPingLoop() {
  if (pingIntervalId) return;
  pingIntervalId = setInterval(() => {
    for (const [peerId, entry] of connections) {
      if (entry.conn.open) {
        try {
          sendToRaw(entry.conn, { type: 'ping', ts: Date.now() });
        } catch (e) {}
        if (!peerPongTimers.has(peerId)) {
          peerPongTimers.set(peerId, setTimeout(() => {
            peerPongTimers.delete(peerId);
            dlog('ping timeout: ' + (entry.nickname || peerId) + ' не ответил', 'warn');
            if (entry.conn.open) {
              try { entry.conn.close(); } catch (e) {}
            }
          }, PONG_TIMEOUT));
        }
      }
    }
  }, PING_INTERVAL);
}

function stopPingLoop() {
  if (pingIntervalId) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }
  for (const [, timer] of peerPongTimers) clearTimeout(timer);
  peerPongTimers.clear();
}

function handlePong(peerId) {
  const timer = peerPongTimers.get(peerId);
  if (timer) {
    clearTimeout(timer);
    peerPongTimers.delete(peerId);
  }
}

// --- Грейс-период и reconnect к пиру ---
function startPeerGrace(peerId, nickname, publicKeyRaw) {
  const graceKey = nickname || peerId;
  if (peerGraceTimers.has(graceKey)) return;

  const graceInfo = { reconnectCount: 0, nickname: nickname, peerId: peerId, publicKeyRaw: publicKeyRaw, timer: null };
  peerGraceTimers.set(graceKey, graceInfo);

  dlog('grace: ' + graceKey + ' — ждём реконнект (' + (PEER_GRACE_PERIOD / 1000) + 's)', 'warn');
  updateOnlineCount();

  attemptPeerReconnect(graceKey, graceInfo);

  graceInfo.timer = setTimeout(() => {
    if (peerGraceTimers.has(graceKey)) {
      peerGraceTimers.delete(graceKey);
      dlog('grace: ' + graceKey + ' — грейс истёк, отключён', 'error');
      addSystemMessage(graceKey + ' отключился');
      updateOnlineCount();
      updateLockIcon();
      if (chatConnectionsCount() === 0 && peerGraceTimers.size === 0) {
        setChatInputEnabled(false);
        setStatus('ожидание собеседника...');
      }
    }
  }, PEER_GRACE_PERIOD);
}

function attemptPeerReconnect(graceKey, graceInfo) {
  if (!peerGraceTimers.has(graceKey)) return;
  if (!peer || !peer.open) return;
  if (graceInfo.reconnectCount >= MAX_PEER_RECONNECT) return;

  graceInfo.reconnectCount++;
  dlog('peer reconnect: ' + graceKey + ' попытка ' + graceInfo.reconnectCount + '/' + MAX_PEER_RECONNECT);

  const conn = peer.connect(graceInfo.peerId, { reliable: true });
  handleConnection(conn, graceInfo);
}

function cancelGraceByNickname(nickname) {
  if (!nickname) return;
  const grace = peerGraceTimers.get(nickname);
  if (grace) {
    if (grace.timer) clearTimeout(grace.timer);
    peerGraceTimers.delete(nickname);
    dlog('grace cancelled for ' + nickname, 'ok');
  }
}

function cancelPeerGrace(peerId) {
  const grace = peerGraceTimers.get(peerId);
  if (grace) {
    if (grace.timer) clearTimeout(grace.timer);
    peerGraceTimers.delete(peerId);
    return;
  }
  for (const [key, info] of peerGraceTimers) {
    if (info.peerId === peerId) {
      if (info.timer) clearTimeout(info.timer);
      peerGraceTimers.delete(key);
      return;
    }
  }
}

function checkAllConnections() {
  for (const [peerId, entry] of connections) {
    if (!entry.conn.open) {
      const nickname = entry.nickname;
      const graceKey = nickname || peerId;
      dlog('check: DataChannel с ' + graceKey + ' мёртв', 'warn');
      const pubKey = entry.publicKeyRaw;
      connections.delete(peerId);
      if (!peerGraceTimers.has(graceKey)) {
        startPeerGrace(peerId, nickname, pubKey);
      }
    }
  }
}

// --- Выход из чата ---
const disconnectedPeers = new Set();
let disconnectedClearTimer = null;

function teardownChatSession() {
  disconnectedPeers.clear();
  if (disconnectedClearTimer) { clearTimeout(disconnectedClearTimer); disconnectedClearTimer = null; }

  const cid = getChatId();
  const conns = [];
  for (const [peerId, entry] of connections) {
    if (!cid || entry.chatId === cid || !entry.chatId) {
      disconnectedPeers.add(peerId);
      conns.push(entry);
      connections.delete(peerId);
    }
  }

  stopPingLoop();

  for (const [, info] of peerGraceTimers) {
    if (info.timer) clearTimeout(info.timer);
  }
  peerGraceTimers.clear();

  for (const [, timer] of typingTimers) {
    clearTimeout(timer);
  }
  typingTimers.clear();
  typingIndicator.classList.add('hidden');

  for (const entry of conns) {
    try { entry.conn.close(); } catch (e) {}
  }

  roomId = null;
  isHost = false;
  currentChatId = null;
  historyLoaded = false;

  messagesEl.innerHTML = '';
  updateOnlineCount();
  updateLockIcon();

  disconnectedClearTimer = setTimeout(() => {
    disconnectedPeers.clear();
    disconnectedClearTimer = null;
  }, 60000);

  dlog('teardownChatSession: сессия очищена, blocked peers: ' + [...disconnectedPeers].join(', '));
}

function leaveChat() {
  teardownChatSession();
  if (peer && !peer.destroyed) peer.destroy();
  initPeer(myNickname);

  chatScreen.classList.add('hidden');
  hideInviteBar();
  connectScreen.classList.remove('hidden');
  window.history.replaceState(null, '', window.location.pathname);
  setStatus('online — главный экран');
  dlog('leaveChat: вернулись на главный экран');
  renderRoomsList();
}

// --- Rejoin из карточки чата ---
function rejoinFromRoomCard(room) {
  if (room.mode === 'direct' && room.peers && room.peers.length > 0) {
    const alreadyConnected = room.peers.some(pid => {
      const entry = connections.get(pid);
      return entry && entry.conn.open;
    });
    if (alreadyConnected) {
      currentChatId = room.chatId;
      for (const pid of room.peers) {
        const entry = connections.get(pid);
        if (entry) {
          entry.silent = false;
          entry.chatId = room.chatId;
          sendToRaw(entry.conn, { type: 'chat-active' });
        }
      }
      showChat();
      setChatInputEnabled(true);
      loadChatHistory();
      updateOnlineCount();
      setStatus('подключён — ' + chatConnectionsCount() + ' пир(ов)');
      dlog('rooms: rejoin direct — reusing existing connection');
      return;
    }
  }

  teardownChatSession();

  currentChatId = room.chatId;
  if (room.mode === 'room') {
    roomId = room.roomId || room.chatId;
  }

  showChat();
  setChatInputEnabled(false);
  setStatus('ожидание собеседника...');
  loadChatHistory();

  if (room.mode === 'room' && room.isHost) {
    isHost = true;
    dlog('rooms: rejoin как хост ' + roomId);
    if (peer && !peer.destroyed) peer.destroy();
    initPeer(roomId, () => {
      onOpenAsHost();
      // Активно подключаемся к известным пирам (они не знают что хост вернулся)
      if (room.peers && room.peers.length > 0) {
        dlog('rooms: хост подключается к пирам: ' + room.peers.join(', '));
        for (const peerId of room.peers) {
          connectToPeer(peerId);
        }
      }
    });
  } else if (room.mode === 'room') {
    dlog('rooms: rejoin как гость ' + roomId);
    connectToRoom(roomId);
  } else if (room.mode === 'direct' && room.peers && room.peers.length > 0) {
    dlog('rooms: rejoin direct → ' + room.peers.join(', '));
    for (const peerId of room.peers) {
      connectToPeer(peerId);
    }
  }
}

// --- Обработка соединения ---
function handleConnection(conn, graceInfo, isIncoming) {
  const ownerPeer = peer;

  conn.on('open', () => {
    if (peer !== ownerPeer) {
      dlog('stale conn.open from old peer, ignoring');
      try { conn.close(); } catch (e) {}
      return;
    }

    if (disconnectedPeers.has(conn.peer)) {
      dlog('rejecting reconnect from disconnected peer: ' + conn.peer);
      try { conn.close(); } catch (e) {}
      return;
    }

    const wasInGrace = peerGraceTimers.has(conn.peer);
    if (wasInGrace) {
      cancelPeerGrace(conn.peer);
      dlog('peer reconnected: ' + conn.peer + ' (из грейса)', 'ok');
    }

    const inChat = !chatScreen.classList.contains('hidden');
    const busyInChat = inChat && !wasInGrace && isIncoming && chatConnectionsCount() > 0 && !roomId;
    if (busyInChat) {
      dlog('incoming while in chat: accepting silently (will appear in rooms list)');
    }

    const isSilent = (isIncoming && !inChat) || busyInChat;
    const isFromGrace = wasInGrace;

    const existing = connections.get(conn.peer);
    if (existing && !existing.silent && isSilent) {
      dlog('duplicate conn from ' + conn.peer + ': keeping active, closing silent duplicate');
      try { conn.close(); } catch (e) {}
      return;
    }

    const entryChatId = isSilent ? null : getChatId();

    connections.set(conn.peer, {
      conn: conn,
      nickname: (graceInfo && graceInfo.nickname) || null,
      sharedKey: null,
      publicKeyRaw: (graceInfo && graceInfo.publicKeyRaw) || null,
      chatId: entryChatId,
      silent: isSilent,
      fromGrace: isFromGrace
    });

    sendToRaw(conn, { type: 'hello', nickname: myNickname, publicKey: myPublicKeyJwk, active: !isSilent, avatar: myAvatarData });

    if (isHost) {
      const peerList = [];
      for (const [peerId, e] of connections) {
        if (peerId !== conn.peer && e.chatId === getChatId()) peerList.push(peerId);
      }
      if (peerList.length > 0) {
        sendToRaw(conn, { type: 'peers', list: peerList });
      }
    }

    if (inChat && !busyInChat) {
      // grace reconnect — input разблокируется в hello
    } else if (!isIncoming) {
      showChat();
      setChatInputEnabled(false);
      setStatus('ожидание ответа...');
    } else {
      dlog('incoming on main screen: accepted silently');
    }
    startPingLoop();
    updateOnlineCount();
    if (!isSilent) {
      setStatus('подключён — ' + chatConnectionsCount() + ' пир(ов)');
    }
  });

  conn.on('data', async (raw) => {
    if (!connections.has(conn.peer)) return;
    let parsed = null;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) {}
    }

    if (!parsed) {
      const entry = connections.get(conn.peer);
      if (entry && entry.silent) return;
      const author = (entry && entry.nickname) || conn.peer;
      addMessage(author, raw);
      playNotificationSound();
      showBrowserNotification(author, raw);
      return;
    }

    if (parsed.type === 'encrypted') {
      const entry = connections.get(conn.peer);
      if (!entry || !entry.sharedKey) return;
      try {
        const decrypted = await decryptData(entry.sharedKey, parsed.iv, parsed.data);
        const inner = JSON.parse(decrypted);
        await handleDecryptedMessage(conn, inner);
      } catch (e) {
        addSystemMessage('ошибка расшифровки от ' + conn.peer);
      }
      return;
    }

    // --- hello ---
    if (parsed.type === 'hello') {
      const entry = connections.get(conn.peer);
      let syncTsPromise = null;
      if (entry) {
        entry.nickname = parsed.nickname;
        entry.publicKeyRaw = parsed.publicKey;
        if (parsed.avatar) peerAvatars.set(parsed.nickname, parsed.avatar);

        const wasInGrace = peerGraceTimers.has(parsed.nickname);
        if (wasInGrace) {
          cancelGraceByNickname(parsed.nickname);
        }

        for (const [oldPeerId, oldEntry] of connections) {
          if (oldPeerId !== conn.peer && oldEntry.nickname === parsed.nickname) {
            dlog('removing stale connection: ' + oldPeerId + ' (replaced by ' + conn.peer + ')');
            try { oldEntry.conn.close(); } catch (e) {}
            connections.delete(oldPeerId);
          }
        }

        if (parsed.publicKey) {
          try {
            entry.sharedKey = await deriveSharedKey(parsed.publicKey);
          } catch (e) {}
        }

        if (entry.silent) {
          const silentChatId = 'dm:' + [myNickname, parsed.nickname].sort().join(',');
          entry.chatId = silentChatId;
          saveRoom(silentChatId, {
            name: '@ ' + parsed.nickname,
            mode: 'direct',
            isHost: false,
            roomId: null,
            peers: [conn.peer],
            lastTs: Date.now()
          });
          renderRoomsList();
          dlog('silent hello from ' + parsed.nickname + ' → saved room ' + silentChatId);
          updateOnlineCount();
          return;
        }

        const preSyncChatId = getChatId() || (roomId ? roomId : ('dm:' + [myNickname, parsed.nickname].sort().join(',')));
        syncTsPromise = getLastTimestamp(preSyncChatId);

        const now = Date.now();
        const dedup = handleConnection._lastHello || (handleConnection._lastHello = {});
        const isDuplicate = dedup[parsed.nickname] && (now - dedup[parsed.nickname] < 3000);
        dedup[parsed.nickname] = now;

        if (!isDuplicate) {
          if (parsed.publicKey && entry.sharedKey) {
            const fp = getFingerprint(parsed.publicKey);
            if (wasInGrace) {
              addSystemMessage(parsed.nickname + ' переподключился 🔒 [' + fp + ']');
            } else {
              addSystemMessage(parsed.nickname + ' подключился 🔒 [' + fp + ']');
            }
          } else {
            addSystemMessage(parsed.nickname + (wasInGrace ? ' переподключился' : ' подключился') + ' (без шифрования)');
          }
        }
        updateLockIcon();
      }

      updateChatId(entry);
      if (entry) entry.chatId = getChatId();
      loadChatHistory();
      updateOnlineCount();

      const syncChatId = getChatId();
      if (syncChatId && entry && entry.sharedKey && syncTsPromise) {
        syncTsPromise.then(lastTs => {
          sendToEncrypted(conn, conn.peer, {
            type: 'sync-request',
            chatId: syncChatId,
            lastTimestamp: lastTs
          });
          dlog('sync: отправлен sync-request для ' + syncChatId + ' (после ts=' + lastTs + ')');
        });
      }

      const inChatNow = !chatScreen.classList.contains('hidden');
      if (inChatNow && currentChatId && currentChatId.startsWith('dm:')) {
        const nicks = currentChatId.replace('dm:', '').split(',');
        const other = nicks.find(n => n !== myNickname) || 'direct';
        roomIdDisplay.textContent = '@ ' + other;
      }

      if (parsed.active === false) {
        setChatInputEnabled(false);
        setStatus('собеседник не в чате...');
      } else {
        setChatInputEnabled(true);
        setStatus('подключён — ' + chatConnectionsCount() + ' пир(ов)');
      }

      if (inChatNow && entry && entry.chatId === getChatId()) {
        sendToRaw(conn, { type: 'chat-active' });
      }

      const cid = getChatId();
      if (cid) {
        const peersList = [];
        for (const [pid, e] of connections) {
          if (e.chatId === cid) peersList.push(pid);
        }
        saveRoom(cid, {
          name: roomId ? '# ' + roomId : '@ ' + parsed.nickname,
          mode: roomId ? 'room' : 'direct',
          isHost: isHost,
          roomId: roomId || null,
          peers: peersList,
          lastTs: Date.now()
        });
        if (chatScreen.classList.contains('hidden')) {
          renderRoomsList();
        }
      }
      return;
    }

    if (parsed.type === 'chat-active') {
      const entry = connections.get(conn.peer);
      const inChatNow = !chatScreen.classList.contains('hidden');
      if (entry && inChatNow && entry.chatId === getChatId()) {
        setChatInputEnabled(true);
        setStatus('подключён — ' + chatConnectionsCount() + ' пир(ов)');
      }
      return;
    }

    if (parsed.type === 'peers') {
      for (const peerId of parsed.list) {
        if (!connections.has(peerId) && peerId !== peer.id) {
          connectToPeer(peerId);
        }
      }
      return;
    }

    if (parsed.type === 'ping') {
      try { sendToRaw(conn, { type: 'pong', ts: parsed.ts }); } catch (e) {}
      return;
    }
    if (parsed.type === 'pong') {
      handlePong(conn.peer);
      return;
    }

    await handleDecryptedMessage(conn, parsed);
  });

  conn.on('close', () => {
    const entry = connections.get(conn.peer);
    if (!entry) return;
    const name = entry.nickname || conn.peer;
    const pubKey = entry.publicKeyRaw;
    connections.delete(conn.peer);
    clearTypingTimer(conn.peer);

    const graceKey = (entry && entry.nickname) || conn.peer;

    let stillConnected = false;
    if (entry && entry.nickname) {
      for (const [, e] of connections) {
        if (e.nickname === entry.nickname) { stillConnected = true; break; }
      }
    }

    if (stillConnected) {
      dlog('stale conn closed: ' + conn.peer + ' (nickname ' + name + ' still connected)', 'info');
    } else if (entry.silent || entry.fromGrace) {
      dlog('no-grace close: ' + name + ' (silent=' + !!entry.silent + ' fromGrace=' + !!entry.fromGrace + ')');
    } else if (peer && peer.open && !peerGraceTimers.has(graceKey)) {
      startPeerGrace(conn.peer, name, pubKey);
    } else if (!peerGraceTimers.has(graceKey)) {
      addSystemMessage(name + ' отключился');
      updateOnlineCount();
      updateLockIcon();
    }

    const cc = chatConnectionsCount();
    if (cc > 0) {
      setStatus('подключён — ' + cc + ' пир(ов)');
    } else if (peerGraceTimers.size > 0) {
      setStatus('переподключение...');
    } else {
      setStatus('ожидание собеседника...');
      setChatInputEnabled(false);
    }

    if (connections.size === 0 && peerGraceTimers.size === 0) stopPingLoop();
  });

  conn.on('error', (err) => {
    addSystemMessage('ошибка соединения с ' + conn.peer + ': ' + err);
  });
}

// --- Обработка расшифрованного сообщения ---
async function handleDecryptedMessage(conn, parsed) {
  const senderEntry = connections.get(conn.peer);
  if (senderEntry && senderEntry.silent) return;

  if (parsed.type === 'msg') {
    addMessage(parsed.nickname, parsed.text);
    playNotificationSound();
    showBrowserNotification(parsed.nickname, parsed.text);
    return;
  }

  if (parsed.type === 'typing') {
    showTypingIndicator(parsed.nickname, conn.peer);
    return;
  }

  if (parsed.type === 'voice') {
    addVoiceMessage(parsed.nickname, parsed.audio, parsed.duration, false, parsed.mimeType);
    playNotificationSound();
    showBrowserNotification(parsed.nickname, '🎤 голосовое сообщение');
    return;
  }

  if (parsed.type === 'file-meta') {
    incomingFiles.set(parsed.transferId, {
      meta: parsed, chunks: [], received: 0, progressEl: null
    });
    const entry = connections.get(conn.peer);
    const nick = (entry && entry.nickname) || parsed.nickname;
    addFileMessage(nick, parsed, false);
    return;
  }

  if (parsed.type === 'file-chunk') {
    const transfer = incomingFiles.get(parsed.transferId);
    if (!transfer) return;
    transfer.chunks.push(parsed.data);
    transfer.received++;
    const pct = Math.round((transfer.received / transfer.meta.totalChunks) * 100);
    if (transfer.progressEl) transfer.progressEl.style.width = pct + '%';
    return;
  }

  if (parsed.type === 'file-done') {
    const transfer = incomingFiles.get(parsed.transferId);
    if (!transfer) return;
    finalizeFileReceive(transfer);
    incomingFiles.delete(parsed.transferId);
    playNotificationSound();
    showBrowserNotification(transfer.meta.nickname, '📎 ' + transfer.meta.fileName);
    return;
  }

  // --- Синхронизация истории ---
  if (parsed.type === 'sync-request') {
    const reqChatId = getChatId();
    if (!reqChatId) return;
    const sinceTs = parsed.lastTimestamp || 0;
    dlog('sync: получен sync-request от ' + conn.peer + ' (sinceTs=' + sinceTs + ')');
    getMessagesSince(reqChatId, sinceTs, 100).then(msgs => {
      if (msgs.length > 0) {
        sendToEncrypted(conn, conn.peer, {
          type: 'sync-response',
          chatId: reqChatId,
          messages: msgs
        });
        dlog('sync: отправлен sync-response: ' + msgs.length + ' сообщений');
      }
    });
    return;
  }

  if (parsed.type === 'sync-response') {
    const myChatId = getChatId();
    if (!myChatId) return;
    const msgs = parsed.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return;
    dlog('sync: получен sync-response: ' + msgs.length + ' сообщений');

    loadHistory(myChatId).then(existing => {
      const existingIds = new Set(existing.map(m => m.msgId));
      let added = 0;

      for (const msg of msgs) {
        if (msg.type !== 'msg' && msg.type !== 'system') continue;
        if (msg.msgId && existingIds.has(msg.msgId)) continue;
        msg.chatId = myChatId;
        saveMessageToDB(msg);
        added++;
      }

      if (added > 0) {
        dlog('sync: добавлено ' + added + ' новых сообщений', 'ok');
        addSystemMessage('синхронизировано: +' + added + ' сообщений');
        messagesEl.innerHTML = '';
        historyLoaded = false;
        loadChatHistory();
      }
    });
    return;
  }
}

// --- Подключение к комнате ---
let roomRetries = 0;
const MAX_ROOM_RETRIES = 5;

function connectToRoom(roomPeerId) {
  dlog('connectToRoom: attempt ' + (roomRetries + 1) + ', target=' + roomPeerId);
  setStatus('подключение к комнате...');

  const conn = peer.connect(roomPeerId, { reliable: true });

  const timeout = setTimeout(() => {
    dlog('room connect timeout', 'warn');
    try { conn.close(); } catch (e) {}
    retryRoomConnect(roomPeerId);
  }, 8000);

  conn.on('open', () => {
    clearTimeout(timeout);
    roomRetries = 0;
    dlog('room connected!', 'ok');
  });

  conn.on('error', (err) => {
    clearTimeout(timeout);
    dlog('room conn error: ' + err, 'error');
    retryRoomConnect(roomPeerId);
  });

  handleConnection(conn);
}

function retryRoomConnect(roomPeerId) {
  roomRetries++;
  if (roomRetries <= MAX_ROOM_RETRIES) {
    const delay = roomRetries * 2000;
    dlog('retry room in ' + delay + 'ms (' + roomRetries + '/' + MAX_ROOM_RETRIES + ')', 'warn');
    setStatus('комната не найдена, повтор ' + roomRetries + '/' + MAX_ROOM_RETRIES);
    setTimeout(() => connectToRoom(roomPeerId), delay);
  } else {
    dlog('room connect failed after ' + MAX_ROOM_RETRIES + ' attempts', 'error');
    setStatus('комната не найдена');
    chatScreen.classList.add('hidden');
    hideInviteBar();
    connectScreen.classList.remove('hidden');
    window.history.replaceState(null, '', window.location.pathname);
  }
}
