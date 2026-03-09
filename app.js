'use strict';

/* ── API BASE URL ───────────────────────────────────── */
const API = (() => {
  const h = location.hostname;
  const p = location.port;
  if (p === '5000') return '';
  return `https://${h}:5000`;
})();

/* ── API TOKEN ──────────────────────────────────────── */
// Loaded from localStorage — set once via Settings or URL param
// URL param example: https://localhost:5000?token=abc123
const API_TOKEN = (() => {
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    localStorage.setItem('robot_api_token', urlToken);
    // Remove token from URL bar for safety
    history.replaceState({}, '', location.pathname);
    return urlToken;
  }
  return localStorage.getItem('robot_api_token') || '';
})();

/* ── SECURE FETCH ───────────────────────────────────── */
function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (API_TOKEN) headers['Authorization'] = 'Bearer ' + API_TOKEN;
  return fetch(API + path, Object.assign({}, options, { headers }));
}

/* ── MQTT TOPICS ────────────────────────────────────── */
const TOPIC = {
  QUERY:   'robot/query/text',
  RESP:    'robot/response/text',
  STATUS:  'robot/response/status',
  DRIVE:   'robot/cmd/drive',
  CONTROL: 'robot/cmd/control'
};

/* ── THEMES ─────────────────────────────────────────── */
const THEMES = ['soft-neural', 'robo-minimal', 'classic-cortex', 'aether-ai'];
const THEME_NAMES = {
  'soft-neural':    'Iron Forge',
  'robo-minimal':   'Stealth Ops',
  'classic-cortex': 'Classic Cortex',
  'aether-ai':      'Crimson Core'
};

/* ── STATE ──────────────────────────────────────────── */
const state = {
  client:      null,
  connected:   false,
  msgCount:    0,
  cmdCount:    0,
  connectTime: null,
  uptimeTick:  null,
  speedLevels: [1, 3, 5, 7, 10],
  speedIdx:    2,
  logLines:    [],
  currentTheme: localStorage.getItem('pcbrain-theme') || 'classic-cortex',
  themeOpen:   false
};

/* ── HELPERS ────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* ══════════════════════════════════════════════════════
   THEME SYSTEM
══════════════════════════════════════════════════════ */
function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  state.currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('pcbrain-theme', theme);

  // Update checkmarks in panel
  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });

  closeThemePanel();
  showToast(`◈ ${THEME_NAMES[theme]}`);
}

function toggleThemePanel() {
  state.themeOpen = !state.themeOpen;
  const panel = $('themePanel');
  panel.classList.toggle('open', state.themeOpen);
}

function closeThemePanel() {
  state.themeOpen = false;
  $('themePanel').classList.remove('open');
}

// Close theme panel when clicking outside
document.addEventListener('click', e => {
  const sw = $('themeSwitcher');
  if (sw && !sw.contains(e.target)) closeThemePanel();
});

/* ══════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════ */
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  $('page-' + name).classList.add('active');
  $('nav-' + name).classList.add('active');
}

/* ══════════════════════════════════════════════════════
   MQTT CONNECTION
══════════════════════════════════════════════════════ */
function toggleConnect() {
  state.connected ? disconnectMQTT() : connectMQTT();
}

function connectMQTT() {
  const broker = $('broker').value.trim();
  if (!broker) { showToast('⚠ Enter broker host'); return; }

  const port     = $('port').value.trim() || '8884';
  const username = $('mqttUser').value.trim();
  const password = $('mqttPass').value.trim();

  // Always use wss:// for cloud brokers (HiveMQ, EMQX etc.)
  const url = `wss://${broker}:${port}/mqtt`;
  sysLog(`Connecting → ${url}`);

  const opts = {
    reconnectPeriod: 4000,
    connectTimeout:  10000,
    keepalive:       25,
    clean:           true,
    protocolVersion: 4,
    clientId:        'pcbrain_' + Math.random().toString(16).slice(2, 10),
  };
  if (username) { opts.username = username; opts.password = password; }

  state.client = mqtt.connect(url, opts);

  state.client.on('connect', () => {
    state.connected   = true;
    state.connectTime = Date.now();

    state.client.subscribe(TOPIC.RESP);
    state.client.subscribe(TOPIC.STATUS);

    setOnline(true);
    sysLog('Link established', 'ok');
    showToast('✦ Connection established');

    clearInterval(state.uptimeTick);
    state.uptimeTick = setInterval(tickUptime, 1000);
  });

  state.client.on('message', (topic, buf) => {
    const raw = buf.toString();
    state.msgCount++;
    $('msgCount').textContent = state.msgCount;

    let display = raw;
    try {
      const j = JSON.parse(raw);
      display = j.reply || j.text || j.response || j.message || j.answer || raw;
    } catch {}

    sysLog(`← ${topic.split('/').pop()}: ${raw.slice(0, 55)}`);
    pushMsg(display, 'robot');
  });

  // Auto-reconnect silently — never change UI on temporary drop
  state.client.on('reconnect', () => sysLog('↻ Reconnecting…'));
  state.client.on('close',     () => { if (state._manualDisconnect) onDisconnect(); });
  state.client.on('offline',   () => sysLog('↻ Offline — retrying…'));
  state.client.on('error',     e  => sysLog('ERR: ' + e.message, 'err'));
}

function disconnectMQTT() {
  state._manualDisconnect = true;
  if (state.client) state.client.end(true);
  onDisconnect();
}

function onDisconnect() {
  state.connected = false;
  state._manualDisconnect = false;
  setOnline(false);
  sysLog('Link terminated', 'err');
  clearInterval(state.uptimeTick);
  $('uptimeVal').textContent = '—';
}

function setOnline(on) {
  const badge = $('statusBadge');
  const label = $('statusLabel');

  badge.classList.toggle('online', on);
  label.textContent = on ? 'ONLINE' : 'OFFLINE';

  // Show/hide connect and disconnect buttons separately
  const connectBtn    = $('connectBtn');
  const disconnectBtn = $('disconnectBtn');
  if (connectBtn)    connectBtn.style.display    = on ? 'none'  : '';
  if (disconnectBtn) disconnectBtn.style.display = on ? ''      : 'none';
}

function tickUptime() {
  if (!state.connectTime) return;
  const s = Math.floor((Date.now() - state.connectTime) / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  $('uptimeVal').textContent = m > 0
    ? `${m}m${String(sec).padStart(2,'0')}s`
    : `${s}s`;
}

/* ══════════════════════════════════════════════════════
   DRIVE
══════════════════════════════════════════════════════ */
function sendDrive(cmd) {
  if (!needConn()) return;
  const speed = state.speedLevels[state.speedIdx];
  pub(TOPIC.DRIVE, { cmd, speed });
  bumpCmd();
  const labels = {
    move_forward:  '▲ Forward',
    move_backward: '▼ Backward',
    turn_left:     '◀ Left',
    turn_right:    '▶ Right',
    stop:          '■ STOP'
  };
  showToast(labels[cmd] || cmd);
}

function sendControl(cmd) {
  if (!needConn()) return;
  pub(TOPIC.CONTROL, { cmd });
  bumpCmd();
  showToast('⚙ ' + cmd.replace(/_/g,' ').toUpperCase());
}

function confirmShutdown() {
  if (confirm('Confirm robot shutdown?\nAll operations will terminate.')) {
    sendControl('shutdown');
  }
}

/* ── GREET ──────────────────────────────────────────── */
let _greetActive = false;

function triggerGreet() {
  if (_greetActive) { showToast('⚠ Scan already running'); return; }
  if (!needConn()) return;

  _greetActive = true;
  const btn      = $('greetBtn');
  const lbl      = $('greetLabel');
  const SCAN_SECS = 10;

  btn.classList.add('scanning');
  sysLog('Greet scan started — collecting faces for 10s…', 'cmd');
  showToast('👋 Scanning for faces…');

  // Send greet command to Pi via MQTT
  pub(TOPIC.CONTROL, { cmd: 'greet', duration: SCAN_SECS });

  // Countdown on button
  let remaining = SCAN_SECS;
  lbl.textContent = `Scanning ${remaining}s`;
  const timer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      lbl.textContent = `Scanning ${remaining}s`;
    } else {
      clearInterval(timer);
      btn.classList.remove('scanning');
      lbl.textContent = 'Greet';
      _greetActive = false;
      sysLog('Greet scan complete — Pi is greeting', 'ok');
      showToast('👋 Greeting sent!');
    }
  }, 1000);
}

/* Speed dial */
function cycleSpeed() {
  state.speedIdx = (state.speedIdx + 1) % state.speedLevels.length;
  const val = state.speedLevels[state.speedIdx];
  $('speedNum').textContent = val;
  updateDialArc(val);
  showToast(`Speed → ${val}`);
}

function updateDialArc(val) {
  const max = state.speedLevels[state.speedLevels.length - 1];
  const pct = val / max;
  // 75% of full circle → circumference 188.5 (r=30)
  const C = 2 * Math.PI * 30;
  const offset = C * (1 - pct * 0.75);
  const arc = $('dialFill');
  if (arc) arc.style.strokeDashoffset = offset;
}

/* Mode */
function setMode(mode) {
  ['manual', 'auto', 'patrol'].forEach(m => {
    $('mode-' + m).classList.toggle('active', m === mode);
  });
  if (state.connected) sendControl('mode_' + mode);
  else showToast('Mode → ' + mode.toUpperCase());
}

/* ══════════════════════════════════════════════════════
   CHAT
══════════════════════════════════════════════════════ */
function sendText(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (!needConn()) return;
  const input = $('textQuery');
  const text  = input.value.trim();
  if (!text) return;
  pub(TOPIC.QUERY, { id: Date.now().toString(), data: { text }, lang: 'hinglish' });
  pushMsg(text, 'user');
  input.value = '';
  input.focus();
  return false;
}

/* ══════════════════════════════════════════════════════
   VOICE RECOGNITION
══════════════════════════════════════════════════════ */
let recognizer  = null;
let isRecording = false;

// ── Debug helpers ─────────────────────────────────────
function dbgSet(id, val, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = color
    ? `<span style="color:${color}">${val}</span>`
    : val;
}

function dbgInit() {
  // Browser
  const ua = navigator.userAgent;
  const br = /Chrome\//.test(ua) ? 'Chrome ✓' :
             /Firefox\//.test(ua) ? 'Firefox ✗' :
             /Safari\//.test(ua)  ? 'Safari ⚠' : ua.slice(0,20);
  dbgSet('dbgBrowserVal', br, /Chrome/.test(br) ? '#4fc' : '#f90');

  // Protocol
  const proto = location.protocol;
  dbgSet('dbgProtoVal', proto,
    (proto === 'https:' || location.hostname === 'localhost' || /^192\.168/.test(location.hostname))
      ? '#4fc' : '#f55');

  // SR API
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  dbgSet('dbgSR', 'SR API: ' + (SR ? '<span style="color:#4fc">supported ✓</span>' : '<span style="color:#f55">NOT supported ✗</span>'));

  // Permission
  if (navigator.permissions) {
    navigator.permissions.query({ name: 'microphone' }).then(r => {
      const c = r.state === 'granted' ? '#4fc' : r.state === 'prompt' ? '#f90' : '#f55';
      dbgSet('dbgPerm', 'Permission: <span style="color:' + c + '">' + r.state + '</span>');
    }).catch(() => dbgSet('dbgPerm', 'Permission: <span style="color:#f90">unknown</span>'));
  }
}

function runMicTest() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    dbgSet('dbgErrorVal', 'SpeechRecognition API not available', '#f55');
    dbgSet('dbgStateVal', 'FAILED', '#f55');
    return;
  }
  dbgSet('dbgErrorVal', 'none', '#888');
  dbgSet('dbgStateVal', 'STARTING…', '#f90');

  const t = new SR();
  t.lang = 'hi-IN';
  t.interimResults = false;
  t.maxAlternatives = 1;

  t.onstart  = () => dbgSet('dbgStateVal', 'LISTENING ●', '#4fc');
  t.onresult = ev => {
    const txt = ev.results[0][0].transcript;
    dbgSet('dbgLastVal',  txt, '#7ef');
    dbgSet('dbgStateVal', 'GOT RESULT ✓', '#4fc');
    showToast('🎙 Heard: ' + txt);
  };
  t.onerror  = e => {
    dbgSet('dbgErrorVal', e.error, '#f55');
    dbgSet('dbgStateVal', 'ERROR', '#f55');
  };
  t.onend    = () => {
    const sv = document.getElementById('dbgStateVal');
    if (sv && sv.textContent === 'LISTENING ●') dbgSet('dbgStateVal', 'ENDED', '#f90');
  };

  try {
    t.start();
  } catch(e) {
    dbgSet('dbgErrorVal', e.message, '#f55');
    dbgSet('dbgStateVal', 'START FAILED', '#f55');
  }
}

(function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Run debug init after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', dbgInit);
  } else {
    setTimeout(dbgInit, 100);
  }

  if (!SR) {
    console.warn('SpeechRecognition not supported');
    const lbl = document.getElementById('micLabel');
    if (lbl) lbl.textContent = 'NOT SUPPORTED';
    return;
  }

  function createRecognizer() {
    const r = new SR();
    r.lang            = 'hi-IN';
    r.interimResults  = false;
    r.continuous      = false;
    r.maxAlternatives = 1;

    r.onstart  = () => dbgSet('dbgStateVal', 'LISTENING ●', '#4fc');
    r.onresult = ev => {
      const text = ev.results[0][0].transcript.trim();
      dbgSet('dbgLastVal',  text, '#7ef');
      dbgSet('dbgStateVal', 'GOT RESULT ✓', '#4fc');
      $('textQuery').value = text;
      sysLog(`Voice: "${text}"`, 'ok');
      if (state.connected && text) {
        pub(TOPIC.QUERY, { id: Date.now().toString(), data: { text }, lang: 'hinglish' });
        pushMsg(text, 'user');
        $('textQuery').value = '';
      }
      stopRec();
    };
    r.onerror = e => {
      dbgSet('dbgErrorVal', e.error, '#f55');
      dbgSet('dbgStateVal', 'ERROR', '#f55');
      sysLog('Mic: ' + e.error, 'err');
      showToast('⚠ Mic: ' + e.error);
      stopRec();
    };
    r.onend = () => {
      if (isRecording) stopRec();
      const sv = document.getElementById('dbgStateVal');
      if (sv && sv.textContent === 'LISTENING ●') dbgSet('dbgStateVal', 'ENDED', '#f90');
    };
    return r;
  }

  recognizer = createRecognizer();
  window._createRecognizer = createRecognizer;
})();

function startRec() {
  if (!recognizer) { showToast('⚠ Not supported in this browser'); return; }
  if (isRecording) { stopRec(); return; }
  try {
    if (window._createRecognizer) recognizer = window._createRecognizer();
    dbgSet('dbgErrorVal', 'none', '#888');
    dbgSet('dbgStateVal', 'STARTING…', '#f90');
    recognizer.start();
    isRecording = true;
    $('micBtn').classList.add('rec');
    $('micLabel').textContent = '● TAP TO STOP';
    showToast('🎙 Listening…');
  } catch(e) {
    dbgSet('dbgErrorVal', e.message, '#f55');
    dbgSet('dbgStateVal', 'START FAILED', '#f55');
    sysLog('Mic start error: ' + e.message, 'err');
    showToast('⚠ Mic error: ' + e.message);
    isRecording = false;
  }
}

function stopRec() {
  isRecording = false;
  try { if (recognizer) recognizer.stop(); } catch {}
  dbgSet('dbgStateVal', 'IDLE', '#aaa');
  const btn = $('micBtn');
  if (btn) btn.classList.remove('rec');
  const lbl = $('micLabel');
  if (lbl) lbl.textContent = 'TAP TO SPEAK';
}

/* ══════════════════════════════════════════════════════
   FACE / BIOMETRIC
══════════════════════════════════════════════════════ */
function selectPhoto() {
  $('faceFile').click();
}

function loadPhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = $('faceImg');
    img.src = ev.target.result;
    img.style.display = 'block';
    $('fvPh').style.display = 'none';
    triggerScan();
    sysLog('Biometric image loaded', 'ok');
  };
  reader.readAsDataURL(file);
}

function triggerScan() {
  const scan = $('fvScan');
  scan.classList.add('scanning');
  setTimeout(() => scan.classList.remove('scanning'), 3200);
}

function enrollFace() {
  const name = $('faceName').value.trim();
  if (!name) { showToast('⚠ Enter subject name'); return; }
  if (!hasPhoto()) return;

  const fileInput = $('faceFile');
  if (!fileInput.files[0]) { showToast('⚠ Select a photo file first'); return; }

  showToast(`⊕ Enrolling ${name}…`);
  $('faceResult').innerHTML = `<span style="color:var(--accent-a)">⏳ Enrolling <b>${esc(name)}</b>…</span>`;
  sysLog(`Enroll: ${name}`, 'cmd');

  const formData = new FormData();
  formData.append('image', fileInput.files[0]);
  formData.append('name',  name);

  apiFetch('/face/enroll', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'ok') {
        $('faceResult').innerHTML =
          `<span style="color:var(--success)">✓ Enrolled <b>${esc(name)}</b> successfully!<br>
           Database rebuilt — ${data.total} persons enrolled.</span>`;
        showToast(`✓ ${name} enrolled!`);
        sysLog(`Enrolled: ${name} (total: ${data.total})`, 'ok');
      } else {
        $('faceResult').innerHTML =
          `<span style="color:#f55">✗ Enroll failed: ${esc(data.error || 'unknown error')}</span>`;
        showToast('✗ Enroll failed');
      }
    })
    .catch(err => {
      $('faceResult').innerHTML = `<span style="color:#f55">✗ Network error: ${esc(err.message)}</span>`;
      showToast('✗ Network error');
      sysLog('Enroll error: ' + err.message, 'err');
    });
}

function recognizeFace() {
  if (!hasPhoto()) return;

  const fileInput = $('faceFile');
  if (!fileInput.files[0]) { showToast('⚠ Select a photo file first'); return; }

  showToast('⊙ Identifying subject…');
  $('faceResult').innerHTML = `<span style="color:var(--accent-a)">⏳ Identifying…</span>`;
  triggerScan();
  sysLog('Identify request', 'cmd');

  const formData = new FormData();
  formData.append('image', fileInput.files[0]);

  apiFetch('/recognize', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      const faces = data.faces || [];
      if (faces.length === 0) {
        $('faceResult').innerHTML = `<span style="color:#f90">⚠ No face detected in image</span>`;
        showToast('No face detected');
      } else {
        const names = faces.map(f => typeof f === 'object' ? f.name : f);
        $('faceResult').innerHTML =
          `<span style="color:var(--success)">✓ Identified: <b>${esc(names.join(', '))}</b></span>`;
        showToast('✓ ' + names.join(', '));
        sysLog('Identified: ' + names.join(', '), 'ok');
      }
    })
    .catch(err => {
      $('faceResult').innerHTML = `<span style="color:#f55">✗ Error: ${esc(err.message)}</span>`;
      showToast('✗ Identify failed');
    });
}

function hasPhoto() {
  const img = $('faceImg');
  if (img.style.display === 'none' || !img.getAttribute('src')) {
    showToast('⚠ Select a photo first'); return false;
  }
  return true;
}

/* ══════════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════════ */
function pub(topic, obj) {
  if (!state.client || !state.connected) return;
  state.client.publish(topic, JSON.stringify(obj));
  sysLog(`→ ${topic.split('/').pop()}: ${JSON.stringify(obj).slice(0,55)}`, 'cmd');
}

function needConn() {
  if (!state.connected) { showToast('⚠ Not connected'); return false; }
  return true;
}

function bumpCmd() {
  state.cmdCount++;
  $('cmdCount').textContent = state.cmdCount;
}

function pushMsg(text, type) {
  const log = $('responses');
  const ph  = log.querySelector('.convo-sys');
  if (ph) ph.remove();

  const div  = document.createElement('div');
  const time = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
  div.className = `convo-msg ${type}`;
  div.innerHTML = `<div>${esc(text)}</div><div class="msg-ts">${time}</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function sysLog(msg, cls = '') {
  const box  = $('sysLog');
  if (!box) return;
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  line.className   = 'log-line ' + cls;
  line.textContent = `[${time}] ${msg}`;
  box.prepend(line);
  state.logLines.push(line);
  if (state.logLines.length > 120) state.logLines.shift().remove();
}

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ══════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  // Apply saved theme
  setTheme(state.currentTheme);

  // Enter key → send text
  $('textQuery').addEventListener('keypress', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sendText(e); }
  });

  // Mic — tap to start, tap again to stop (works on mobile)
  const micBtn = $('micBtn');
  micBtn.addEventListener('click', e => {
    e.preventDefault();
    startRec();
  });
  micBtn.addEventListener('touchend', e => {
    e.preventDefault();
    startRec();
  }, { passive: false });

  // Face file input
  $('faceFile').addEventListener('change', loadPhoto);

  // Speed dial arc init
  updateDialArc(state.speedLevels[state.speedIdx]);

  sysLog(`PC Brain v3.0 — Theme: ${THEME_NAMES[state.currentTheme]}`, 'ok');
});