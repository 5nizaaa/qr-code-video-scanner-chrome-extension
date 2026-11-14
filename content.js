/* «QR на видео» — контент-скрипт.
   Периодически берёт кадры всех <video> на странице, рисует их на canvas
   и распознаёт QR-коды библиотекой jsQR. Найденное показывает плашкой
   и отправляет в фоновый скрипт (история, уведомления, бейдж). */
(() => {
  'use strict';

  // ---------- Настройки ----------
  const TICK_MS = 500;             // шаг основного цикла
  const PLAYING_INTERVAL = 600;    // пауза между распознаваниями играющего видео, мс
  const PAUSED_INTERVAL = 2200;    // пауза для видео на паузе, мс
  const SHADOW_SCAN_EVERY = 4;     // каждые N тиков обходить теневые DOM
  const MIN_SIZE = 96;             // игнорировать видео меньше этой стороны, px
  const MAX_DIM = 720;             // даунскейл кадра перед распознаванием, px
  const CAPTURE_THROTTLE = 1500;   // пауза между скриншотами вкладки (фолбэк), мс
  const DEDUPE_MS = 20000;         // не показывать один и тот же QR слишком часто, мс
  const TOAST_HIDE_MS = 10000;     // сколько висит плашка
  const PER_TICK_BUDGET = 4;       // сколько видео сканируем за один тик

  let enabled = true;
  let tickCount = 0;
  let videoCache = [];
  let lastCapture = 0;
  let toastTimer = null;
  let toastEls = null;

  const videoState = new WeakMap(); // video -> { canvas, last, tainted }
  const seen = new Map();           // текст -> время последнего показа

  // jsQR в разных сборках экспортируется по-разному — подстраховка
  const decodeQR = (() => {
    try {
      if (typeof jsQR === 'function') return jsQR;
      if (typeof jsQR !== 'undefined' && jsQR && typeof jsQR.default === 'function') return jsQR.default;
    } catch (e) {}
    return null;
  })();

  // ---------- Вкл/выкл из попапа ----------
  try {
    chrome.storage.local.get({ enabled: true }, (r) => { enabled = r.enabled !== false; });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'enabled')) {
        enabled = changes.enabled.newValue !== false;
      }
    });
  } catch (e) { /* контекст расширения недоступен (после перезагрузки) */ }

  // ---------- Поиск видео ----------
  function classify(v) {
    try {
      if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
      const r = v.getBoundingClientRect();
      if (r.width < MIN_SIZE || r.height < MIN_SIZE) return null;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
      const st = getComputedStyle(v);
      if (st.visibility === 'hidden' || st.display === 'none') return null;
      return (v.paused || v.ended) ? 'paused' : 'playing';
    } catch (e) { return null; }
  }

  // Обход в том числе теневых DOM (некоторые плееры прячут <video> в shadow root)
  function deepCollectVideos() {
    const out = [];
    const start = performance.now();
    const walk = (root, depth) => {
      if (depth > 10 || performance.now() - start > 25) return;
      for (const v of root.querySelectorAll('video')) out.push(v);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      }
    };
    try { walk(document, 0); } catch (e) {}
    return out;
  }

  // ---------- Распознавание ----------
  function scanVideo(v, mode) {
    if (!decodeQR) return;
    const now = Date.now();
    let st = videoState.get(v);
    if (!st) {
      st = { canvas: document.createElement('canvas'), last: 0, tainted: false };
      videoState.set(v, st);
    }
    const interval = mode === 'paused' ? PAUSED_INTERVAL : PLAYING_INTERVAL;
    if (now - st.last < interval) return;
    st.last = now;

    // Кадр этого видео недоступен напрямую (кросс-доменное видео) — фолбэк
    if (st.tainted) { captureTabAndScan(); return; }

    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.min(1, MAX_DIM / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const c = st.canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

    try {
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const code = decodeQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) onFound(code.data);
    } catch (e) {
      // Канвас «запачкан» — снимаем вкладку целиком через фоновый скрипт
      st.tainted = true;
      captureTabAndScan();
    }
  }

  // Фолбэк: скриншот видимой части вкладки (не зависит от CORS видео)
  function captureTabAndScan() {
    const now = Date.now();
    if (now - lastCapture < CAPTURE_THROTTLE) return;
    lastCapture = now;
    try {
      chrome.runtime.sendMessage({ type: 'capture-tab' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.dataUrl) return;
        const im = new Image();
        im.onload = () => {
          try {
            const k = Math.min(1, 1280 / Math.max(im.width, im.height));
            const w = Math.max(1, Math.round(im.width * k));
            const h = Math.max(1, Math.round(im.height * k));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(im, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const code = decodeQR(img.data, w, h, {});
            if (code && code.data) onFound(code.data);
          } catch (e) {}
        };
        im.onerror = () => {};
        im.src = res.dataUrl;
      });
    } catch (e) {}
  }

  function onFound(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return;
    const now = Date.now();
    const prev = seen.get(text) || 0;
    if (now - prev < DEDUPE_MS) return;

    // подчищаем старые записи
    if (seen.size > 200) {
      const old = [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
      for (const [k] of old) seen.delete(k);
    }
    seen.set(text, now);

    try { chrome.runtime.sendMessage({ type: 'qr-found', text, page: location.href }); } catch (e) {}
    showToast(text);
  }

  // ---------- Плашка на странице ----------
  const TOAST_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .card {
      pointer-events: auto; cursor: default;
      width: 330px; padding: 13px 14px 12px;
      background: #17181d; color: #eceef4;
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 14px;
      box-shadow: 0 10px 34px rgba(0,0,0,.4);
      animation: qr-in .16s ease-out;
    }
    @keyframes qr-in { from { opacity: 0; transform: translateY(8px); } }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
    .badge { width: 18px; height: 18px; border-radius: 5px; background: #7c5cff; color: #fff;
             font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .title { font-size: 11.5px; letter-spacing: .6px; text-transform: uppercase; color: #9aa1b5; flex: 1; }
    .x { cursor: pointer; color: #9aa1b5; font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 6px; }
    .x:hover { color: #fff; background: rgba(255,255,255,.08); }
    .text { font-size: 13.5px; line-height: 1.45; word-break: break-all; max-height: 110px; overflow: auto; }
    .row { display: flex; gap: 8px; margin-top: 11px; }
    .btn { flex: 1; text-align: center; padding: 7px 8px; font-size: 13px; border-radius: 9px; cursor: pointer;
           background: #25262e; color: #eceef4; border: 1px solid rgba(255,255,255,.1); user-select: none; }
    .btn:hover { background: #2c2e38; }
    .btn.primary { background: #7c5cff; border-color: transparent; color: #fff; }
    .btn.primary:hover { background: #8a6dff; }
  `;

  function isHttpUrl(t) {
    try { const u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch (e) { return false; }
  }

  function showToast(text) {
    if (!toastEls) {
      const host = document.createElement('div');
      host.id = 'qr-video-scanner-host';
      host.style.cssText = 'position:fixed; right:16px; bottom:16px; z-index:2147483647;';
      const sh = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = TOAST_CSS;
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="head">' +
          '<div class="badge">▣</div>' +
          '<div class="title">QR-код в видео</div>' +
          '<div class="x">✕</div>' +
        '</div>' +
        '<div class="text"></div>' +
        '<div class="row">' +
          '<div class="btn primary open">Открыть</div>' +
          '<div class="btn copy">Копировать</div>' +
        '</div>';
      sh.appendChild(style);
      sh.appendChild(card);
      (document.documentElement || document.body).appendChild(host);

      toastEls = {
        host, card,
        textEl: card.querySelector('.text'),
        openBtn: card.querySelector('.open'),
        copyBtn: card.querySelector('.copy'),
        closeBtn: card.querySelector('.x'),
      };

      toastEls.closeBtn.addEventListener('click', hideToast);
      toastEls.copyBtn.addEventListener('click', () => {
        copyText(toastEls.textEl.dataset.full || '');
        toastEls.copyBtn.textContent = 'Скопировано ✓';
        setTimeout(() => { if (toastEls) toastEls.copyBtn.textContent = 'Копировать'; }, 1400);
      });
      toastEls.openBtn.addEventListener('click', () => {
        const t = toastEls.textEl.dataset.full || '';
        if (isHttpUrl(t)) window.open(t, '_blank', 'noopener');
      });
    }

    toastEls.textEl.textContent = text;
    toastEls.textEl.dataset.full = text;
    toastEls.openBtn.style.display = isHttpUrl(text) ? '' : 'none';
    toastEls.copyBtn.textContent = 'Копировать';
    toastEls.host.style.display = '';

    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, TOAST_HIDE_MS);
  }

  function hideToast() {
    if (!toastEls) return;
    toastEls.host.style.display = 'none';
    clearTimeout(toastTimer);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed; left:-9999px; top:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ---------- Основной цикл ----------
  function tick() {
    tickCount++;
    if (!enabled || document.visibilityState !== 'visible') return;

    if (tickCount % SHADOW_SCAN_EVERY === 0) videoCache = deepCollectVideos();

    const set = new Set(document.querySelectorAll('video'));
    for (const v of videoCache) if (v.isConnected) set.add(v);

    let budget = PER_TICK_BUDGET;
    for (const v of set) {
      if (budget <= 0) break;
      const mode = classify(v);
      if (!mode) continue;
      budget--;
      scanVideo(v, mode);
    }
  }

  setInterval(tick, TICK_MS);
})();
