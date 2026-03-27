// === Ghost Mesh Chat — db.js (IndexedDB — локальное хранилище) ===

const DB_NAME = 'ghost-mesh-db';
const DB_VERSION = 3;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Таймаут — если DB заблокирована, не висим вечно
    const timeout = setTimeout(() => {
      dlog('IndexedDB timeout (blocked?), продолжаем без DB', 'warn');
      resolve(null);
    }, 3000);

    req.onblocked = () => {
      dlog('IndexedDB blocked — закрой другие вкладки', 'warn');
    };

    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      // v1: messages
      if (!database.objectStoreNames.contains('messages')) {
        const store = database.createObjectStore('messages', { keyPath: 'msgId' });
        store.createIndex('chatId', 'chatId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      // v2: rooms (список чатов)
      if (!database.objectStoreNames.contains('rooms')) {
        database.createObjectStore('rooms', { keyPath: 'chatId' });
      }
      // v3: profile (профиль пользователя)
      if (!database.objectStoreNames.contains('profile')) {
        database.createObjectStore('profile', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => {
      clearTimeout(timeout);
      db = e.target.result;
      // Закрываем DB при запросе upgrade из другой вкладки
      db.onversionchange = () => {
        db.close();
        db = null;
        dlog('IndexedDB: другая вкладка обновляет схему, DB закрыта', 'warn');
      };
      dlog('IndexedDB opened (v' + DB_VERSION + ')', 'ok');
      resolve(db);
    };
    req.onerror = (e) => {
      clearTimeout(timeout);
      dlog('IndexedDB error: ' + e.target.error, 'error');
      reject(e.target.error);
    };
  });
}

// --- Profile store ---

function saveProfile(data) {
  if (!db) return;
  try {
    const tx = db.transaction('profile', 'readwrite');
    tx.objectStore('profile').put(Object.assign({ id: 'main' }, data));
  } catch (e) {
    dlog('saveProfile error: ' + e.message, 'error');
  }
}

function loadProfileFromDB() {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('profile', 'readonly');
      const req = tx.objectStore('profile').get('main');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

// --- Rooms store ---

function saveRoom(chatId, data) {
  if (!db || !chatId) return;
  try {
    const tx = db.transaction('rooms', 'readwrite');
    const store = tx.objectStore('rooms');
    const getReq = store.get(chatId);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      store.put(Object.assign(existing, data, { chatId: chatId }));
    };
  } catch (e) {
    dlog('saveRoom error: ' + e.message, 'error');
  }
}

function updateRoomLastMessage(chatId, text, author) {
  if (!db || !chatId) return;
  try {
    const tx = db.transaction('rooms', 'readwrite');
    const store = tx.objectStore('rooms');
    const getReq = store.get(chatId);
    getReq.onsuccess = () => {
      const room = getReq.result;
      if (room) {
        room.lastMsg = (author ? author + ': ' : '') + (text || '').substring(0, 80);
        room.lastTs = Date.now();
        store.put(room);
      }
    };
  } catch (e) {}
}

function loadAllRooms() {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('rooms', 'readonly');
      const req = tx.objectStore('rooms').getAll();
      req.onsuccess = () => {
        const rooms = req.result || [];
        rooms.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
        resolve(rooms);
      };
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}

function deleteRoom(chatId) {
  if (!db || !chatId) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['rooms', 'messages'], 'readwrite');
      tx.objectStore('rooms').delete(chatId);
      const index = tx.objectStore('messages').index('chatId');
      const cur = index.openCursor(IDBKeyRange.only(chatId));
      cur.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => { dlog('deleted room: ' + chatId, 'ok'); resolve(); };
      tx.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}

// --- Messages store ---

function saveMessageToDB(msg) {
  if (!db || !msg.chatId) return;
  try {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(msg);
  } catch (e) {
    dlog('DB save error: ' + e.message, 'error');
  }
}

function loadHistory(chatId) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const index = store.index('chatId');
      const req = index.getAll(chatId);
      req.onsuccess = () => {
        const msgs = req.result || [];
        msgs.sort((a, b) => a.timestamp - b.timestamp);
        resolve(msgs);
      };
      req.onerror = () => resolve([]);
    } catch (e) {
      resolve([]);
    }
  });
}

function getLastTimestamp(chatId) {
  if (!db) return Promise.resolve(0);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const index = store.index('chatId');
      const req = index.getAll(chatId);
      req.onsuccess = () => {
        const msgs = req.result || [];
        if (msgs.length === 0) return resolve(0);
        let maxTs = 0;
        for (const m of msgs) {
          if (m.timestamp > maxTs) maxTs = m.timestamp;
        }
        resolve(maxTs);
      };
      req.onerror = () => resolve(0);
    } catch (e) {
      resolve(0);
    }
  });
}

function getMessagesSince(chatId, sinceTs, limit = 100) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const index = store.index('chatId');
      const req = index.getAll(chatId);
      req.onsuccess = () => {
        const msgs = (req.result || [])
          .filter(m => m.timestamp > sinceTs && (m.type === 'msg' || m.type === 'system'))
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(0, limit);
        resolve(msgs);
      };
      req.onerror = () => resolve([]);
    } catch (e) {
      resolve([]);
    }
  });
}
