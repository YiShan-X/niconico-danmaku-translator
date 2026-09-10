// ==UserScript==
// @name         网页实时字幕翻译 (AI Subtitle Translator)
// @name:ja      ウェブリアルタイム字幕翻訳 (AI)
// @namespace    web-subtitle-translator
// @version      0.3.0
// @description  捕获当前标签页音频，用阿里云百炼 Qwen (qwen3-asr-flash) 识别语音，并用 MiniMax 翻译，在任意网站上实时显示字幕。
// @author       YiShan-X
// @license      MIT
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      api.minimaxi.com
// @connect      dashscope.aliyuncs.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULTS = {
    apiKey: '',
    endpoint: 'https://api.minimaxi.com/v1/chat/completions',
    model: 'MiniMax-M3',
    targetLang: '简体中文',
    enabled: false,
    translateEnabled: true,
    asrKey: '',
    asrUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    asrModel: 'qwen3-asr-flash',
    asrLang: 'ja',
    segSec: 8,
    silenceRms: 0.006,
    showOriginal: true,
    fontSize: 24,
  };

  const cfg = Object.assign({}, DEFAULTS, GM_getValue('nst_cfg', {}));
  function saveCfg() { GM_setValue('nst_cfg', cfg); }
  function num(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }

  const state = {
    capturing: false,
    audioCtx: null,
    processor: null,
    source: null,
    sink: null,
    stream: null,
    pcmParts: [],
    pcmCount: 0,
    sampleRate: 16000,
    asrQueue: [],
    asrBusy: false,
    dropped: 0,
    recognized: 0,
    translated: 0,
  };

  const el = { caption: null, ja: null, zh: null, status: null, panel: null, stats: null, toast: null };

  function diag(kind, text) {
    try {
      if (kind === 'error') document.documentElement.setAttribute('data-nst-error', String(text));
      document.documentElement.setAttribute('data-nst-status', String(text));
    } catch (e) {}
  }

  function clearError() {
    try { document.documentElement.removeAttribute('data-nst-error'); } catch (e) {}
  }

  function setStatus(text) {
    if (el.status) el.status.textContent = text || '';
    if (el.toast) {
      el.toast.textContent = text || '';
      el.toast.classList.toggle('show', !!text);
    }
    diag('status', text || '');
    if (text) { try { console.log('[NST]', text); } catch (e) {} }
  }

  function stripThink(s) {
    return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  function isMeaningful(text) {
    if (!text) return false;
    if (/^[\s\p{P}\p{S}\d]+$/u.test(text)) return false;
    return true;
  }

  function encodeWav(float32, sampleRate) {
    const n = float32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const ws = function (off, s) { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
    ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Uint8Array(buf);
  }

  function bytesToBase64(u8) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function postJson(url, payload, key) {
    if (!key) return Promise.reject(new Error('未设置 API Key'));
    const data = JSON.stringify(payload);
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        data: data,
        timeout: 90000,
        onload: function (r) {
          try {
            if (r.status >= 200 && r.status < 300) resolve(JSON.parse(r.responseText));
            else {
              let msg = 'HTTP ' + r.status;
              try { const j = JSON.parse(r.responseText); msg += ' ' + ((j.error && j.error.message) || j.message || ''); } catch (e) {}
              reject(new Error(msg));
            }
          } catch (e) { reject(e); }
        },
        onerror: function () { reject(new Error('network error')); },
        ontimeout: function () { reject(new Error('timeout')); },
      });
    });
  }

  async function qwenAsr(audio) {
    if (!cfg.asrKey) throw new Error('未设置 Qwen API Key');
    const wav = encodeWav(audio, 16000);
    if (wav.length > 9.5 * 1024 * 1024) throw new Error('音频段过大 (>10MB)');
    const dataUri = 'data:audio/wav;base64,' + bytesToBase64(wav);
    const payload = {
      model: cfg.asrModel,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
      asr_options: { language: cfg.asrLang, enable_itn: true },
    };
    const res = await postJson(cfg.asrUrl, payload, cfg.asrKey);
    let c = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    if (Array.isArray(c)) c = c.map(function (p) { return (p && p.text) || ''; }).join('');
    return typeof c === 'string' ? c.trim() : '';
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

  function buildTranslatePayload(ja, withThinking) {
    const sys =
      '你是日译中字幕翻译器。用户会给你一句日语，请翻译成自然、口语化、贴近网络语气的' + cfg.targetLang + '。' +
      '只输出译文本身，不要引号、不要解释、不要重复原文；若无需翻译则原样返回。';
    const payload = {
      model: cfg.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: ja },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    };
    if (withThinking) payload.thinking = { type: 'disabled' };
    return payload;
  }

  async function translate(ja) {
    let res;
    try {
      res = await requestJson(cfg.endpoint, buildTranslatePayload(ja, true));
    } catch (e) {
      res = await requestJson(cfg.endpoint, buildTranslatePayload(ja, false));
    }
    const c = (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '';
    return stripThink(c).split('\n')[0].trim();
  }

  function rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / Math.max(1, buf.length));
  }

  function resampleLinear(buf, from, to) {
    if (from === to) return buf;
    const ratio = to / from;
    const outLen = Math.max(1, Math.round(buf.length * ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i / ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(buf.length - 1, i0 + 1);
      const frac = pos - i0;
      out[i] = buf[i0] * (1 - frac) + buf[i1] * frac;
    }
    return out;
  }

  function concatParts(parts, total) {
    const out = new Float32Array(total);
    let off = 0;
    for (let i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }

  function pushPcm(mono, rate) {
    state.sampleRate = rate;
    state.pcmParts.push(mono);
    state.pcmCount += mono.length;
    const need = Math.max(1, Math.floor(cfg.segSec * rate));
    if (state.pcmCount >= need) {
      const full = concatParts(state.pcmParts, state.pcmCount);
      state.pcmParts = [];
      state.pcmCount = 0;
      handleSegment(full, rate);
    }
  }

  function handleSegment(pcm, rate) {
    const audio = resampleLinear(pcm, rate, 16000);
    if (rms(audio) < cfg.silenceRms) return;
    if (state.asrQueue.length >= 4) {
      state.dropped++;
      updateStats('识别跟不上：可增大“分片秒数”或检查网络');
      return;
    }
    state.asrQueue.push(audio);
    pumpAsr();
  }

  async function pumpAsr() {
    if (state.asrBusy) return;
    state.asrBusy = true;
    while (state.asrQueue.length) {
      const seg = state.asrQueue.shift();
      try { await processSegment(seg); }
      catch (e) {
        try { console.warn('[NST] ASR/翻译失败', e); } catch (e2) {}
        setStatus('识别失败: ' + (e && e.message ? e.message : e));
      }
    }
    state.asrBusy = false;
    setStatus('就绪');
  }

  async function processSegment(audio) {
    setStatus('识别中…');
    const ja = stripThink(await qwenAsr(audio)).replace(/\s+/g, ' ').trim();
    if (!ja || !isMeaningful(ja)) { setStatus('就绪'); return; }
    state.recognized++;
    updateStats();
    showCaption(ja, null);
    if (cfg.translateEnabled && cfg.apiKey) {
      try {
        const zh = await translate(ja);
        if (zh && zh !== ja) { state.translated++; updateStats(); showCaption(ja, zh); }
      } catch (e) { /* fall back to original */ }
    }
    setStatus('就绪');
  }

  async function startCapture() {
    if (state.capturing) return;
    clearError();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setStatus('当前浏览器不支持标签页音频捕获');
      return;
    }
    let ctx = null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('AudioContext 不可用');
      try { ctx = new AC({ sampleRate: 16000 }); }
      catch (e1) { ctx = new AC(); }
      if (ctx.state === 'suspended') { ctx.resume().catch(function () {}); }
    } catch (e) {
      setStatus('音频上下文创建失败: ' + (e && e.message ? e.message : e));
      return;
    }
    state.audioCtx = ctx;

    setStatus('请在弹窗中选择本标签页并勾选「分享标签页音频」');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      try { ctx.close(); } catch (e2) {}
      state.audioCtx = null;
      setStatus('已取消或失败: ' + (e && e.name ? e.name + ' ' : '') + (e && e.message ? e.message : e));
      return;
    }
    const audioTracks = stream.getAudioTracks();
    stream.getVideoTracks().forEach(function (t) { t.stop(); });
    if (!audioTracks.length) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      try { ctx.close(); } catch (e2) {}
      state.audioCtx = null;
      setStatus('未获取到音频：请在弹窗里勾选「同时共享标签页音频 / 系统音频」后重试');
      return;
    }
    setStatus('已获取音频轨道，正在初始化…');

    state.stream = stream;
    audioTracks[0].addEventListener('ended', function () { stopCapture('音频轨道已结束'); });
    if (ctx.state === 'suspended') {
      try { await Promise.race([ctx.resume(), new Promise(function (r) { setTimeout(r, 1500); })]); } catch (e) {}
    }

    try {
      state.source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
      state.processor = ctx.createScriptProcessor(4096, 2, 1);
      state.processor.onaudioprocess = function (e) {
        const inb = e.inputBuffer;
        const n = inb.length;
        const ch = inb.numberOfChannels;
        const mono = new Float32Array(n);
        for (let c = 0; c < ch; c++) {
          const d = inb.getChannelData(c);
          for (let i = 0; i < n; i++) mono[i] += d[i];
        }
        if (ch > 1) for (let i = 0; i < n; i++) mono[i] /= ch;
        pushPcm(mono, inb.sampleRate);
      };

      const gain = ctx.createGain();
      gain.gain.value = 0;
      state.source.connect(state.processor);
      state.processor.connect(gain);
      gain.connect(ctx.destination);
      state.sink = gain;
    } catch (e) {
      const msg = '音频处理初始化失败: ' + (e && e.message ? e.message : e);
      diag('error', msg + (e && e.stack ? ' @' + e.stack.split('\n')[1] : ''));
      setStatus(msg);
      stopCapture(msg);
      return;
    }

    state.pcmParts = [];
    state.pcmCount = 0;
    state.capturing = true;
    cfg.enabled = true;
    saveCfg();
    syncFab();
    setStatus('已开始捕获（云端 Qwen 识别）');
  }

  function stopCapture(reason) {
    state.capturing = false;
    try { if (state.processor) { state.processor.onaudioprocess = null; state.processor.disconnect(); } } catch (e) {}
    try { if (state.source) state.source.disconnect(); } catch (e) {}
    try { if (state.sink) state.sink.disconnect(); } catch (e) {}
    try { if (state.audioCtx) state.audioCtx.close(); } catch (e) {}
    try { if (state.stream) state.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    state.processor = null;
    state.source = null;
    state.sink = null;
    state.audioCtx = null;
    state.stream = null;
    state.pcmParts = [];
    state.pcmCount = 0;
    state.asrQueue = [];
    cfg.enabled = false;
    saveCfg();
    syncFab();
    hideCaption();
    setStatus(reason || '已停止');
  }

  function ensureCaptionEl() {
    if (!document.body) return;
    if (el.caption && document.body.contains(el.caption)) return;
    const wrap = document.createElement('div');
    wrap.className = 'nst-caption';
    wrap.innerHTML = '<div class="nst-zh"></div><div class="nst-ja"></div>';
    document.body.appendChild(wrap);
    el.caption = wrap;
    el.zh = wrap.querySelector('.nst-zh');
    el.ja = wrap.querySelector('.nst-ja');
    el.status = null;
    wrap.style.fontSize = cfg.fontSize + 'px';
  }

  function showCaption(ja, zh) {
    ensureCaptionEl();
    if (!el.caption) return;
    const hasZh = !!zh;
    if (hasZh) {
      el.zh.textContent = zh;
      if (cfg.showOriginal && ja) {
        el.ja.textContent = ja;
        el.ja.style.display = 'block';
      } else {
        el.ja.style.display = 'none';
      }
    } else {
      el.zh.textContent = ja || '';
      el.ja.style.display = 'none';
    }
    el.caption.style.fontSize = cfg.fontSize + 'px';
    el.caption.classList.add('show');
  }

  function hideCaption() {
    if (el.caption) el.caption.classList.remove('show');
  }

  GM_addStyle(
    '.nst-caption{position:fixed;left:0;right:0;bottom:9%;z-index:2147483646;display:flex;flex-direction:column;' +
    'align-items:center;gap:2px;pointer-events:none;opacity:0;transition:opacity .25s;' +
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;text-align:center;padding:0 6vw}' +
    '.nst-caption.show{opacity:1}' +
    '.nst-zh{color:#fff;font-weight:600;line-height:1.35;' +
    'text-shadow:0 1px 3px #000,0 0 8px rgba(0,0,0,.9);word-break:break-word}' +
    '.nst-ja{color:#cfe8ff;font-size:.62em;line-height:1.3;' +
    'text-shadow:0 1px 3px #000;word-break:break-word;opacity:.92}' +
    '.nst-status{color:#7fd;font-size:11px;margin-top:2px;text-shadow:0 1px 3px #000;opacity:.8}' +
    '.nst-fab{position:fixed;right:16px;top:196px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;' +
    'padding:9px 14px;border-radius:20px;background:#3a3a3a;color:#fff;border:1px solid #666;cursor:pointer;' +
    'font:13px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.55);user-select:none}' +
    '.nst-fab.on{background:#0a84ff;border-color:#0a84ff}' +
    '.nst-gear{position:fixed;right:16px;top:242px;z-index:2147483647;width:34px;height:34px;border-radius:50%;' +
    'background:#252525;color:#ccc;border:1px solid #444;font-size:16px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}' +
    '.nst-panel{position:fixed;right:16px;top:196px;z-index:2147483647;width:310px;max-height:80vh;overflow:auto;' +
    'background:#1b1b1b;color:#eee;border:1px solid #444;border-radius:10px;padding:12px;' +
    'font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.6)}' +
    '.nst-panel h3{margin:0 0 8px;font-size:13px;display:flex;justify-content:space-between;align-items:center}' +
    '.nst-panel label{display:block;margin:8px 0 2px;color:#aaa}' +
    '.nst-panel input[type=text],.nst-panel input[type=password],.nst-panel input[type=number],.nst-panel select{width:100%;box-sizing:border-box;' +
    'background:#111;border:1px solid #3a3a3a;color:#eee;border-radius:6px;padding:5px 7px}' +
    '.nst-panel .nst-row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}' +
    '.nst-panel button{background:#333;color:#eee;border:1px solid #555;border-radius:6px;padding:4px 10px;cursor:pointer}' +
    '.nst-panel .nst-close{cursor:pointer;color:#888;border:none;background:none;font-size:16px}' +
    '.nst-panel .nst-big{display:block;width:100%;box-sizing:border-box;padding:9px;margin-bottom:4px;border-radius:8px;' +
    'font-size:13px;cursor:pointer;border:none;color:#fff}' +
    '.nst-panel .nst-big.on{background:#0a84ff}' +
    '.nst-panel .nst-big.off{background:#666}' +
    '.nst-panel .nst-stats{color:#7fd;margin-top:8px;font-size:11px}' +
    '.nst-panel .nst-hint{color:#888;font-size:11px;margin-top:4px}' +
    '.nst-toast{position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:60vw;padding:6px 12px;border-radius:8px;' +
    'background:rgba(0,0,0,.82);color:#7fd;font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.5);display:none;pointer-events:none;white-space:pre-wrap;word-break:break-word}' +
    '.nst-toast.show{display:block}'
  );

  function ensureToast() {
    if (!document.body) return;
    if (el.toast && document.body.contains(el.toast)) return;
    const t = document.createElement('div');
    t.className = 'nst-toast';
    document.body.appendChild(t);
    el.toast = t;
  }

  function ensureUI() {
    if (!document.body) return;
    if (el.panel && !document.body.contains(el.panel)) { el.panel = null; el.stats = null; }
    let fab = document.getElementById('nst-fab');
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'nst-fab';
      document.body.appendChild(fab);
    }
    fab.className = 'nst-fab' + (cfg.enabled ? ' on' : '');
    fab.onclick = function () { if (cfg.enabled) stopCapture(); else startCapture(); };
    let gear = document.getElementById('nst-gear');
    if (!gear) {
      gear = document.createElement('button');
      gear.id = 'nst-gear';
      gear.className = 'nst-gear';
      gear.textContent = '⚙';
      gear.title = '字幕翻译设置';
      document.body.appendChild(gear);
    }
    gear.onclick = togglePanel;
    ensureToast();
    ensureCaptionEl();
    syncFab();
  }

  function syncFab() {
    const fab = document.getElementById('nst-fab');
    if (!fab) return;
    fab.classList.toggle('on', cfg.enabled);
    fab.textContent = cfg.enabled ? '字幕：开' : '字幕：关';
    fab.title = '点击' + (cfg.enabled ? '停止' : '开始') + '字幕；⚙ 打开设置';
  }

  function togglePanel() {
    if (el.panel) { closePanel(); return; }
    buildPanel();
  }

  let panelTimer = null;
  function closePanel() {
    if (panelTimer) { clearInterval(panelTimer); panelTimer = null; }
    if (el.panel) el.panel.remove();
    el.panel = null;
    el.stats = null;
  }

  function field(label, id, value, type) {
    return '<label>' + label + '</label><input type="' + (type || 'text') + '" id="' + id + '" value="' +
      String(value == null ? '' : value).replace(/"/g, '&quot;') + '">';
  }

  function buildPanel() {
    if (el.panel || !document.body) return;
    const p = document.createElement('div');
    p.className = 'nst-panel';
    p.innerHTML =
      '<h3>网页字幕翻译 <button class="nst-close" title="关闭">×</button></h3>' +
      '<button id="nst-toggle" class="nst-big"></button>' +
      '<label>MiniMax API Key</label><input type="password" id="nst-key" value="' + String(cfg.apiKey).replace(/"/g, '&quot;') + '">' +
      field('MiniMax 模型', 'nst-model', cfg.model) +
      field('目标语言', 'nst-tlang', cfg.targetLang) +
      '<label>Qwen API Key</label><input type="password" id="nst-asrkey" value="' + String(cfg.asrKey).replace(/"/g, '&quot;') + '">' +
      field('Qwen 识别地址', 'nst-asrurl', cfg.asrUrl) +
      field('Qwen 模型', 'nst-asrmodel', cfg.asrModel) +
      field('Qwen 语言(ja/zh/en)', 'nst-asrlang', cfg.asrLang) +
      field('分片秒数', 'nst-seg', cfg.segSec, 'number') +
      field('字幕字号(px)', 'nst-font', cfg.fontSize, 'number') +
      '<div class="nst-row"><label style="margin:0"><input type="checkbox" id="nst-orig"' + (cfg.showOriginal ? ' checked' : '') + '> 显示原文</label></div>' +
      '<div class="nst-row"><label style="margin:0"><input type="checkbox" id="nst-trans"' + (cfg.translateEnabled ? ' checked' : '') + '> 启用翻译</label></div>' +
      '<div class="nst-stats" id="nst-stats"></div>' +
      '<div class="nst-row"><button id="nst-test">测试翻译</button><button id="nst-stop">停止捕获</button><button id="nst-recommend">恢复默认</button></div>' +
      '<div class="nst-hint">首次使用：点右上角「字幕：关」→ 弹窗里选本标签页并勾选「分享标签页音频」。识别用阿里云百炼 Qwen（无需下载模型），翻译用 MiniMax，两个 Key 都填上即可。</div>';
    document.body.appendChild(p);
    el.panel = p;
    el.stats = p.querySelector('#nst-stats');

    const elToggle = p.querySelector('#nst-toggle');
    const renderToggle = function () {
      elToggle.textContent = cfg.enabled ? '● 字幕已开启 · 点击停止' : '○ 字幕已关闭 · 点击开始';
      elToggle.className = 'nst-big ' + (cfg.enabled ? 'on' : 'off');
    };
    renderToggle();
    elToggle.addEventListener('click', function () {
      if (cfg.enabled) stopCapture(); else startCapture();
      renderToggle();
    });

    p.querySelector('.nst-close').addEventListener('click', function () { closePanel(); });
    p.querySelector('#nst-key').addEventListener('change', function (e) { cfg.apiKey = e.target.value.trim(); saveCfg(); });
    p.querySelector('#nst-model').addEventListener('change', function (e) { cfg.model = e.target.value.trim() || DEFAULTS.model; saveCfg(); });
    p.querySelector('#nst-tlang').addEventListener('change', function (e) { cfg.targetLang = e.target.value.trim() || DEFAULTS.targetLang; saveCfg(); });
    p.querySelector('#nst-asrkey').addEventListener('change', function (e) { cfg.asrKey = e.target.value.trim(); saveCfg(); });
    p.querySelector('#nst-asrurl').addEventListener('change', function (e) { cfg.asrUrl = e.target.value.trim() || DEFAULTS.asrUrl; saveCfg(); });
    p.querySelector('#nst-asrmodel').addEventListener('change', function (e) { cfg.asrModel = e.target.value.trim() || DEFAULTS.asrModel; saveCfg(); });
    p.querySelector('#nst-asrlang').addEventListener('change', function (e) { cfg.asrLang = e.target.value.trim() || DEFAULTS.asrLang; saveCfg(); });
    p.querySelector('#nst-seg').addEventListener('change', function (e) { cfg.segSec = Math.max(2, num(e.target.value, DEFAULTS.segSec)); saveCfg(); });
    p.querySelector('#nst-font').addEventListener('change', function (e) { cfg.fontSize = Math.max(12, num(e.target.value, DEFAULTS.fontSize)); saveCfg(); if (el.caption) el.caption.style.fontSize = cfg.fontSize + 'px'; });
    p.querySelector('#nst-orig').addEventListener('change', function (e) { cfg.showOriginal = e.target.checked; saveCfg(); });
    p.querySelector('#nst-trans').addEventListener('change', function (e) { cfg.translateEnabled = e.target.checked; saveCfg(); });

    p.querySelector('#nst-test').addEventListener('click', function (e) {
      const b = e.target;
      b.textContent = '测试中…';
      translate('テスト').then(function (r) { b.textContent = '成功: ' + (r || '(空)'); })
        .catch(function (err) { b.textContent = '失败: ' + (err && err.message ? err.message : err); });
    });
    p.querySelector('#nst-stop').addEventListener('click', function () { stopCapture(); renderToggle(); });
    p.querySelector('#nst-recommend').addEventListener('click', function () {
      cfg.asrUrl = DEFAULTS.asrUrl;
      cfg.asrModel = DEFAULTS.asrModel;
      cfg.asrLang = DEFAULTS.asrLang;
      cfg.segSec = DEFAULTS.segSec;
      saveCfg();
      closePanel();
      buildPanel();
      setStatus('已恢复默认识别设置');
    });

    panelTimer = setInterval(function () { if (el.panel) renderToggle(); }, 1500);
    updateStats();
  }

  function updateStats(extra) {
    if (!el.stats) return;
    el.stats.textContent = '已识别 ' + state.recognized + ' · 已翻译 ' + state.translated +
      ' · 队列 ' + state.asrQueue.length + (state.dropped ? ' · 丢弃 ' + state.dropped : '') +
      (extra ? ' · ' + extra : '');
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('开始 / 停止字幕', function () { if (cfg.enabled) stopCapture(); else startCapture(); });
    GM_registerMenuCommand('打开字幕设置', function () { if (!el.panel) buildPanel(); });
  }

  function boot() {
    ensureUI();
    setInterval(ensureUI, 2000);
    if (!cfg.apiKey) buildPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
