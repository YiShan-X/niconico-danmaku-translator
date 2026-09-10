// ==UserScript==
// @name         niconico 弹幕翻译 (AI Danmaku Translator)
// @name:ja      niconico コメント翻訳 (AI)
// @namespace    niconico-danmaku-translator
// @version      0.1.0
// @description  用 MiniMax 大模型实时把 niconico 弹幕翻译成中文，直接注入播放器 Canvas 层。需在设置面板填入自己的 API Key。
// @author       YiShan-X
// @license      MIT
// @homepageURL  https://github.com/YiShan-X/niconico-danmaku-translator
// @match        https://www.nicovideo.jp/watch/*
// @match        https://www.video.nicovideo.jp/watch/*
// @match        https://nico.ms/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      api.minimaxi.com
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULTS = {
    apiKey: '',
    endpoint: 'https://api.minimaxi.com/v1/chat/completions',
    model: 'MiniMax-M3',
    targetLang: '简体中文',
    lookAheadMs: 15000,
    batchSize: 25,
    concurrency: 4,
    disableThinking: true,
    enabled: true,
  };

  const CACHE_KEY = 'nt_cache_entries';
  const CACHE_MAX = 3000;

  const cfg = Object.assign({}, DEFAULTS, GM_getValue('nt_cfg', {}));

  const stats = { translated: 0, comments: 0 };

  const transCache = new Map();
  try {
    const saved = GM_getValue(CACHE_KEY, []);
    if (Array.isArray(saved)) {
      saved.forEach(function (e) {
        if (Array.isArray(e) && e.length === 2) transCache.set(e[0], e[1]);
      });
    }
  } catch (e) {}

  const queue = [];
  const queuedSet = new Set();
  const inFlight = new Set();
  const failed = new Set();
  const attempts = new Map();
  let active = 0;
  let pumping = false;
  let comments = [];

  let cacheDirty = false;
  setInterval(function () {
    if (!cacheDirty) return;
    cacheDirty = false;
    try { GM_setValue(CACHE_KEY, Array.from(transCache.entries()).slice(-CACHE_MAX)); } catch (e) {}
  }, 3000);

  function saveCfg() { GM_setValue('nt_cfg', cfg); }

  function stripThink(s) {
    return String(s).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  function parseArray(content) {
    content = stripThink(content);
    const s = content.indexOf('[');
    const e = content.lastIndexOf(']');
    if (s >= 0 && e > s) {
      try {
        const arr = JSON.parse(content.slice(s, e + 1));
        if (Array.isArray(arr)) return arr.map(function (x) { return typeof x === 'string' ? x : String(x); });
      } catch (err) {}
    }
    return content
      .split('\n')
      .map(function (l) { return l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/^["']|["'],?$/g, '').trim(); })
      .filter(function (l) { return l.length; });
  }

  function needsTranslate(text) {
    if (!text || text.length > 200) return false;
    return /[\u3040-\u309f\u30a0-\u30ff]/.test(text);
  }

  function storeTranslation(orig, tr) {
    if (!tr) return;
    transCache.set(orig, tr);
    if (orig.indexOf('\n') >= 0 && tr.indexOf('\n') >= 0) {
      const ol = orig.split('\n');
      const tl = tr.split('\n');
      if (ol.length === tl.length) {
        for (let i = 0; i < ol.length; i++) {
          if (ol[i].trim()) transCache.set(ol[i], tl[i]);
        }
      }
    }
    cacheDirty = true;
  }

  function requestJson(url, payload) {
    if (!cfg.apiKey) return Promise.reject(new Error('未设置 API Key'));
    const data = JSON.stringify(payload);
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST',
          url: url,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
          data: data,
          timeout: 60000,
          onload: function (r) {
            try {
              if (r.status >= 200 && r.status < 300) resolve(JSON.parse(r.responseText));
              else reject(new Error('HTTP ' + r.status));
            } catch (e) { reject(e); }
          },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timeout')); },
        });
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
          body: data,
        }).then(function (r) { return r.json(); }).then(resolve, reject);
      }
    });
  }

  function buildPayload(texts, withThinking) {
    const sys =
      '你是专业的日译中弹幕翻译器。用户会给你一个 JSON 字符串数组，元素是日本弹幕。' +
      '请把每条翻译成自然、口语化、贴近网络语气的' + cfg.targetLang + '。' +
      '要求：保留原意与语气（梗、双关、流行语尽量意译）；尽量简短以适配弹幕；' +
      '若某条是纯符号、颜文字、ASCII 画、数字或不需要翻译的内容，则原样返回。' +
      '严格只输出一个 JSON 字符串数组，长度和顺序必须与输入完全一致，' +
      '不要输出解释、markdown 代码块、编号或任何多余文字。';
    const payload = {
      model: cfg.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(texts) },
      ],
      temperature: 0.3,
      max_tokens: 6000,
    };
    if (withThinking && cfg.disableThinking) payload.thinking = { type: 'disabled' };
    return payload;
  }

  function parseContent(j) {
    const content =
      (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return parseArray(content);
  }

  function translateBatch(texts) {
    return requestJson(cfg.endpoint, buildPayload(texts, true))
      .then(parseContent)
      .catch(function (e) {
        if (cfg.disableThinking) return requestJson(cfg.endpoint, buildPayload(texts, false)).then(parseContent);
        throw e;
      });
  }

  function takeBatch() {
    const batch = [];
    while (batch.length < cfg.batchSize && queue.length) {
      const t = queue.shift();
      queuedSet.delete(t);
      if (transCache.has(t) || inFlight.has(t) || failed.has(t)) continue;
      inFlight.add(t);
      batch.push(t);
    }
    return batch;
  }

  function retryLater(t) {
    const a = (attempts.get(t) || 0) + 1;
    attempts.set(t, a);
    if (a <= 2 && !transCache.has(t)) {
      if (!queuedSet.has(t)) { queue.push(t); queuedSet.add(t); }
    } else {
      failed.add(t);
    }
  }

  function runBatch(batch) {
    translateBatch(batch)
      .then(function (arr) {
        if (!Array.isArray(arr) || arr.length !== batch.length) {
          batch.forEach(function (t) { inFlight.delete(t); retryLater(t); });
          return;
        }
        batch.forEach(function (t, i) {
          inFlight.delete(t);
          const tr = arr[i];
          if (typeof tr === 'string' && tr.trim() && tr.trim() !== t) {
            storeTranslation(t, tr.trim());
            stats.translated++;
          } else if (typeof tr === 'string') {
            transCache.set(t, t);
          } else {
            retryLater(t);
          }
        });
      })
      .catch(function () {
        batch.forEach(function (t) { inFlight.delete(t); retryLater(t); });
      })
      .then(function () {
        active--;
        schedulePump();
        updatePanel();
      });
  }

  function pump() {
    while (active < cfg.concurrency) {
      const batch = takeBatch();
      if (!batch.length) break;
      active++;
      runBatch(batch);
    }
  }

  function schedulePump() {
    if (pumping) return;
    pumping = true;
    setTimeout(function () { pumping = false; pump(); }, 0);
  }

  function enqueue(text) {
    if (!text) return;
    if (!cfg.apiKey) return;
    if (transCache.has(text) || inFlight.has(text) || failed.has(text) || queuedSet.has(text)) return;
    if (!needsTranslate(text)) { transCache.set(text, text); return; }
    queue.push(text);
    queuedSet.add(text);
    schedulePump();
  }

  function extractThreads(json) {
    const list = [];
    const data = json && json.data;
    if (!data) return list;
    const threads = data.threads || [];
    for (let i = 0; i < threads.length; i++) {
      const cs = threads[i].comments || [];
      for (let k = 0; k < cs.length; k++) {
        if (cs[k] && cs[k].body) list.push({ vposMs: cs[k].vposMs || 0, body: cs[k].body });
      }
    }
    return list;
  }

  function handleThreadsJson(json) {
    const list = extractThreads(json);
    if (list.length) {
      comments = list;
      stats.comments = list.length;
      prefetchTick();
    }
  }

  function isThreadsUrl(url) {
    return typeof url === 'string' && url.indexOf('nvcomment.nicovideo.jp') >= 0 && url.indexOf('/threads') >= 0;
  }

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = origFetch.apply(this, arguments);
      if (isThreadsUrl(url)) {
        p.then(function (resp) {
          try {
            if (resp && typeof resp.clone === 'function') {
              resp.clone().json().then(handleThreadsJson, function () {});
            }
          } catch (e) {}
        }, function () {});
      }
      return p;
    };
  }

  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ntUrl = url;
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const self = this;
    if (isThreadsUrl(this.__ntUrl)) {
      this.addEventListener('load', function () {
        try { handleThreadsJson(JSON.parse(self.responseText)); } catch (e) {}
      });
    }
    return origXhrSend.apply(this, arguments);
  };

  function prefetchTick() {
    const v = document.querySelector('video');
    if (!v || !cfg.enabled || !comments.length) return;
    const cur = v.currentTime * 1000;
    const from = cur - 2000;
    const to = cur + cfg.lookAheadMs;
    const cand = [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      if (c.vposMs < from || c.vposMs > to) continue;
      const b = c.body;
      if (transCache.has(b) || inFlight.has(b) || failed.has(b) || queuedSet.has(b)) continue;
      cand.push(c);
    }
    cand.sort(function (a, b) { return a.vposMs - b.vposMs; });
    for (let i = 0; i < cand.length; i++) enqueue(cand[i].body);
    updatePanel();
  }

  setInterval(prefetchTick, 1000);

  const DANMAKU_FONT_RE = /MS\s?-?P?Gothic|ＭＳ\s?Ｐ?ゴシック|Yu\s?Mincho|游明朝|Ume-?[PG]/i;

  function isDanmaku(ctx, text) {
    if (DANMAKU_FONT_RE.test(ctx.font || '')) return true;
    const c = ctx.canvas;
    return !!(c && !c.isConnected && /[\u3040-\u30ff]/.test(text));
  }

  function fitFont(ctx, text, font) {
    const cw = ctx.canvas.width;
    if (!cw) return font;
    let w = 0;
    try { w = ctx.measureText(text).width; } catch (e) { return font; }
    if (w <= cw - 2) return font;
    const m = /(\d+(?:\.\d+)?)px/.exec(font);
    if (!m) return font;
    const size = parseFloat(m[1]);
    const ns = Math.max(9, Math.floor((size * (cw - 4)) / w));
    if (ns >= size) return font;
    return font.replace(/(\d+(?:\.\d+)?)px/, ns + 'px');
  }

  function makeHook(orig) {
    return function () {
      try {
        if (!cfg.enabled) return orig.apply(this, arguments);
        const text = String(arguments[0]);
        if (!text) return orig.apply(this, arguments);
        if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) return orig.apply(this, arguments);
        if (!isDanmaku(this, text)) return orig.apply(this, arguments);

        const tr = transCache.get(text);
        if (tr && tr !== text) {
          const args = Array.prototype.slice.call(arguments);
          args[0] = tr;
          const origFont = this.font;
          if (args.length <= 3) {
            const fitted = fitFont(this, tr, origFont);
            if (fitted !== origFont) {
              this.font = fitted;
              try { return orig.apply(this, args); } finally { this.font = origFont; }
            }
          }
          return orig.apply(this, args);
        }
        enqueue(text);
        return orig.apply(this, arguments);
      } catch (e) {
        return orig.apply(this, arguments);
      }
    };
  }

  CanvasRenderingContext2D.prototype.fillText = makeHook(CanvasRenderingContext2D.prototype.fillText);
  CanvasRenderingContext2D.prototype.strokeText = makeHook(CanvasRenderingContext2D.prototype.strokeText);

  let panel = null;
  let elStats = null;

  GM_addStyle(
    '.nt-fab{position:fixed;right:16px;top:96px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;' +
    'padding:9px 14px;border-radius:20px;background:#3a3a3a;color:#fff;border:1px solid #666;cursor:pointer;' +
    'font:13px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.55);user-select:none}' +
    '.nt-fab.on{background:#0a84ff;border-color:#0a84ff}' +
    '.nt-fab::before{content:"";width:8px;height:8px;border-radius:50%;background:#888}' +
    '.nt-fab.on::before{background:#fff;box-shadow:0 0 6px #fff}' +
    '.nt-gear{position:fixed;right:16px;top:142px;z-index:2147483647;width:34px;height:34px;border-radius:50%;' +
    'background:#252525;color:#ccc;border:1px solid #444;font-size:16px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}' +
    '.nt-panel{position:fixed;right:16px;top:96px;z-index:2147483647;width:290px;background:#1b1b1b;color:#eee;' +
    'border:1px solid #444;border-radius:10px;padding:12px;font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.6)}' +
    '.nt-panel h3{margin:0 0 8px;font-size:13px;display:flex;justify-content:space-between;align-items:center}' +
    '.nt-panel label{display:block;margin:8px 0 2px;color:#aaa}' +
    '.nt-panel input[type=text],.nt-panel input[type=password]{width:100%;box-sizing:border-box;' +
    'background:#111;border:1px solid #3a3a3a;color:#eee;border-radius:6px;padding:5px 7px}' +
    '.nt-panel .nt-row{display:flex;gap:8px;align-items:center;margin-top:8px}' +
    '.nt-panel button{background:#333;color:#eee;border:1px solid #555;border-radius:6px;padding:4px 10px;cursor:pointer}' +
    '.nt-panel .nt-close{cursor:pointer;color:#888;border:none;background:none;font-size:16px}' +
    '.nt-big{display:block;width:100%;box-sizing:border-box;padding:9px;margin-bottom:4px;border-radius:8px;' +
    'font-size:13px;cursor:pointer;border:none;color:#fff}' +
    '.nt-big.on{background:#0a84ff}' +
    '.nt-big.off{background:#666}' +
    '.nt-stats{color:#7fd;margin-top:8px;font-size:11px}'
  );

  function ensureUI() {
    if (!document.body) return;
    if (panel && !document.body.contains(panel)) { panel = null; elStats = null; }
    let fab = document.getElementById('nt-fab');
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'nt-fab';
      document.body.appendChild(fab);
    }
    fab.className = 'nt-fab' + (cfg.enabled ? ' on' : '');
    fab.onclick = function () {
      cfg.enabled = !cfg.enabled;
      saveCfg();
      syncFab();
      updatePanel();
    };
    let gear = document.getElementById('nt-gear');
    if (!gear) {
      gear = document.createElement('button');
      gear.id = 'nt-gear';
      gear.className = 'nt-gear';
      gear.textContent = '⚙';
      gear.title = '弹幕翻译设置';
      document.body.appendChild(gear);
    }
    gear.onclick = togglePanel;
    syncFab();
  }

  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    buildPanel();
  }

  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.className = 'nt-panel';
    panel.innerHTML =
      '<h3>niconico 弹幕翻译 <button class="nt-close" title="关闭">×</button></h3>' +
      '<button id="nt-toggle" class="nt-big"></button>' +
      '<label>API Key</label><input type="password" id="nt-key">' +
      '<label>目标语言</label><input type="text" id="nt-lang">' +
      '<label>模型</label><input type="text" id="nt-model">' +
      '<div class="nt-stats" id="nt-stats"></div>' +
      '<div class="nt-row"><button id="nt-test">测试连接</button><button id="nt-clear">清空缓存</button></div>';
    document.body.appendChild(panel);

    const elKey = panel.querySelector('#nt-key');
    const elLang = panel.querySelector('#nt-lang');
    const elModel = panel.querySelector('#nt-model');
    const elToggle = panel.querySelector('#nt-toggle');
    elStats = panel.querySelector('#nt-stats');
    elKey.value = cfg.apiKey;
    elLang.value = cfg.targetLang;
    elModel.value = cfg.model;

    const renderToggle = function () {
      elToggle.textContent = cfg.enabled ? '● 翻译已开启 · 点击关闭' : '○ 翻译已关闭 · 点击开启';
      elToggle.className = 'nt-big ' + (cfg.enabled ? 'on' : 'off');
    };
    elToggle.addEventListener('click', function () {
      cfg.enabled = !cfg.enabled;
      saveCfg();
      syncFab();
      renderToggle();
      updatePanel();
    });
    renderToggle();

    panel.querySelector('.nt-close').addEventListener('click', function () { panel.remove(); panel = null; });
    elKey.addEventListener('change', function () { cfg.apiKey = elKey.value.trim(); saveCfg(); });
    elLang.addEventListener('change', function () { cfg.targetLang = elLang.value.trim() || DEFAULTS.targetLang; saveCfg(); });
    elModel.addEventListener('change', function () { cfg.model = elModel.value.trim() || DEFAULTS.model; saveCfg(); });
    panel.querySelector('#nt-test').addEventListener('click', function () {
      const b = panel.querySelector('#nt-test');
      b.textContent = '测试中…';
      translateBatch(['テスト']).then(function (arr) {
        b.textContent = '成功: ' + (arr[0] || '(空)');
      }).catch(function (e) {
        b.textContent = '失败: ' + e.message;
      });
    });
    panel.querySelector('#nt-clear').addEventListener('click', function () {
      transCache.clear();
      failed.clear();
      attempts.clear();
      stats.translated = 0;
      cacheDirty = true;
      updatePanel();
    });
    updatePanel();
  }

  function syncFab() {
    const fab = document.getElementById('nt-fab');
    if (!fab) return;
    fab.classList.toggle('on', cfg.enabled);
    fab.textContent = cfg.enabled ? '弹幕翻译：开' : '弹幕翻译：关';
    fab.title = '点击' + (cfg.enabled ? '关闭' : '开启') + '弹幕翻译；⚙ 打开设置';
  }

  function updatePanel() {
    if (!elStats) return;
    elStats.textContent =
      '已翻译 ' + stats.translated + ' 条 · 队列 ' + queue.length + ' · 弹幕 ' + stats.comments +
      (failed.size ? ' · 失败 ' + failed.size : '');
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('切换弹幕翻译开关', function () {
      cfg.enabled = !cfg.enabled;
      saveCfg();
      ensureUI();
      updatePanel();
    });
    GM_registerMenuCommand('打开设置面板', function () { if (!panel) buildPanel(); });
    GM_registerMenuCommand('清空翻译缓存', function () {
      transCache.clear();
      failed.clear();
      attempts.clear();
      stats.translated = 0;
      cacheDirty = true;
    });
  }

  function bootUI() {
    ensureUI();
    setInterval(ensureUI, 2000);
    if (!cfg.apiKey) buildPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootUI);
  } else {
    bootUI();
  }
})();
