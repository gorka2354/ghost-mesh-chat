# Ghost Mesh Chat

Анонимный P2P мессенджер на WebRTC (PeerJS).

## Стек

- Vanilla JS (без фреймворков, без бандлера)
- PeerJS для WebRTC
- PWA (manifest.json + service worker)
- IndexedDB для локальной истории
- E2E шифрование (ECDH + AES-256-GCM)

## Структура файлов

| Файл | Описание |
|------|----------|
| `state.js` | Глобальные переменные, DOM-рефы, утилиты (dlog, escapeHtml, getChatId и т.д.) |
| `db.js` | IndexedDB — openDB, профиль, rooms CRUD, messages (save/load/sync-queries) |
| `crypto.js` | E2E: генерация ключей ECDH, deriveSharedKey, encrypt/decrypt AES-GCM, fingerprint |
| `ui.js` | UI: аватары, звук, typewriter, сообщения, голос, файлы, rooms list, drag&drop |
| `net.js` | PeerJS: initPeer, handleConnection, hello/peers протокол, grace-период, ping/pong, sync, room connect, rejoin |
| `profile.js` | Модалка профиля, pixel-art редактор аватара (8x8) |
| `app.js` | Обработчики событий (кнопки, input, drag) + async start() |
| `style.css` | Стили — тёмная тема, хакерский CMD-стиль |
| `sw.js` | Service Worker — кэширование для PWA |
| `index.html` | HTML-разметка, подключение скриптов |

Порядок загрузки: `state.js` → `db.js` → `crypto.js` → `ui.js` → `net.js` → `profile.js` → `app.js`

Все файлы работают через глобальный scope (без ES-модулей).

## Правила

- Минимализм — не усложнять
- Каждый инкремент должен работать автономно
- Тёмная тема, хакерский стиль
- Комментарии в коде на русском
