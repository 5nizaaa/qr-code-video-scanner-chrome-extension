/* «QR на видео» — фоновый сервис-воркер:
   скриншот вкладки (фолбэк для кросс-доменных видео),
   история находок, бейдж и системные уведомления. */
'use strict';

const notifyMap = new Map();      // id уведомления -> { text, url }
const notifCooldown = new Map();  // текст -> время последнего уведомления
let badgeCount = 0;

const HISTORY_KEEP = 100;
const TEXT_MAX = 2000;
const DEDUPE_MS = 20000;

function isHttpUrl(t) {
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) { return false; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'capture-tab') {
    const windowId = sender && sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((err) => sendResponse({ error: String((err && err.message) || err) }));
    return true; // ответ придёт асинхронно
  }

  if (msg.type === 'qr-found') { handleFound(msg, sender); return; }

  if (msg.type === 'clear-badge') {
    badgeCount = 0;
    chrome.action.setBadgeText({ text: '' });
  }
});

function handleFound(msg, sender) {
  const text = String(msg.text || '').slice(0, TEXT_MAX).trim();
  if (!text) return;
  const page = (sender && sender.tab && sender.tab.url) || msg.page || '';
  const title = (sender && sender.tab && sender.tab.title) || '';
  const now = Date.now();

  // история для попапа
  chrome.storage.local.get({ history: [] }, (r) => {
    const history = Array.isArray(r.history) ? r.history : [];
    const head = history[0];
    if (head && head.text === text && now - head.time < DEDUPE_MS) return;
    history.unshift({ text, page, title, time: now });
    chrome.storage.local.set({ history: history.slice(0, HISTORY_KEEP) });
  });

  // бейдж на иконке
  badgeCount = Math.min(badgeCount + 1, 99);
  chrome.action.setBadgeBackgroundColor({ color: '#7c5cff' });
  chrome.action.setBadgeText({ text: String(badgeCount) });

  // уведомление — только если вкладка не на переднем плане (там есть плашка)
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const active = tabs && tabs[0];
    if (active && sender && sender.tab && active.id === sender.tab.id) return;
    notify(text, now);
  });
}

function notify(text, now) {
  const last = notifCooldown.get(text) || 0;
  if (now - last < DEDUPE_MS) return;
  notifCooldown.set(text, now);
  if (notifCooldown.size > 300) notifCooldown.clear();

  const url = isHttpUrl(text) ? text : '';
  const short = text.length > 280 ? text.slice(0, 280) + '…' : text;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'QR-код найден на видео',
    message: short,
    buttons: url ? [{ title: 'Открыть ссылку' }] : [],
    silent: true
  }, (id) => {
    if (chrome.runtime.lastError) return;
    notifyMap.set(id, { text, url });
    if (notifyMap.size > 50) {
      const first = notifyMap.keys().next().value;
      notifyMap.delete(first);
    }
  });
}

chrome.notifications.onClicked.addListener((id) => {
  const info = notifyMap.get(id);
  if (info && info.url) chrome.tabs.create({ url: info.url });
  chrome.notifications.clear(id);
});

chrome.notifications.onButtonClicked.addListener((id, index) => {
  const info = notifyMap.get(id);
  if (info && index === 0 && info.url) chrome.tabs.create({ url: info.url });
});

chrome.notifications.onClosed.addListener((id) => notifyMap.delete(id));
