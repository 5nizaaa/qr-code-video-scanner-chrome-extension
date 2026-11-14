/* «QR на видео» — логика попапа: вкл/выкл сканирования + история находок. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const listEl = $('#list');
  const enabledEl = $('#enabled');
  const statusEl = $('#status');
  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);

  const EMPTY_HTML =
    '<div class="empty">Пока ничего не найдено.<br>Включите на странице видео с QR-кодом — ' +
    'нашедшееся появится здесь.</div>';

  function isHttpUrl(t) {
    try {
      const u = new URL(t);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
  }

  function fmtTime(ts) {
    const d = Date.now() - ts;
    if (d < 45e3) return 'только что';
    if (d < 3600e3) return Math.round(d / 60e3) + ' мин назад';
    const t = new Date(ts);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    if (t.toDateString() === new Date().toDateString()) return hh + ':' + mm;
    return t.toLocaleDateString('ru-RU') + ' ' + hh + ':' + mm;
  }

  function render(history) {
    listEl.innerHTML = '';
    if (!Array.isArray(history) || !history.length) {
      listEl.innerHTML = EMPTY_HTML;
      return;
    }
    for (const it of history) {
      const item = document.createElement('div');
      item.className = 'item';

      const txt = document.createElement('div');
      txt.className = 'txt';
      txt.textContent = it.text;

      const meta = document.createElement('div');
      meta.className = 'meta';
      const host = it.page ? hostOf(it.page) : '';
      meta.textContent = (host ? host + ' · ' : '') + fmtTime(it.time);

      const acts = document.createElement('div');
      acts.className = 'acts';

      const copy = document.createElement('button');
      copy.className = 'btn';
      copy.textContent = 'Копировать';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(it.text).catch(() => {});
        copy.textContent = 'Готово ✓';
        setTimeout(() => { copy.textContent = 'Копировать'; }, 1200);
      });
      acts.appendChild(copy);

      if (isHttpUrl(it.text)) {
        const open = document.createElement('button');
        open.className = 'btn pri';
        open.textContent = 'Открыть';
        open.addEventListener('click', () => {
          if (hasChrome && chrome.tabs && chrome.tabs.create) {
            chrome.tabs.create({ url: it.text });
          } else {
            window.open(it.text, '_blank');
          }
        });
        acts.appendChild(open);
      }

      item.append(txt, meta, acts);
      listEl.appendChild(item);
    }
  }

  function applyEnabled(v) {
    enabledEl.checked = v !== false;
    statusEl.textContent = enabledEl.checked ? 'сканирование включено' : 'сканирование выключено';
  }

  if (hasChrome) {
    chrome.storage.local.get({ enabled: true, history: [] }, (r) => {
      applyEnabled(r.enabled);
      render(r.history);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.history) render(changes.history.newValue);
      if (changes.enabled) applyEnabled(changes.enabled.newValue);
    });

    enabledEl.addEventListener('change', () => {
      chrome.storage.local.set({ enabled: enabledEl.checked });
    });

    $('#clear').addEventListener('click', () => {
      chrome.storage.local.set({ history: [] });
    });

    // открытие попапа сбрасывает счётчик на бейдже
    try { chrome.runtime.sendMessage({ type: 'clear-badge' }); } catch (e) {}
  } else {
    // предпросмотр страницы без окружения расширения — демо-данные
    applyEnabled(true);
    render([{
      text: 'https://example.com/promo?code=ABC123',
      page: 'https://www.youtube.com/watch?v=demo',
      time: Date.now() - 5 * 60000,
    }]);
  }
})();
