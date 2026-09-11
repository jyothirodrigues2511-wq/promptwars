const state = {
  activeTab: 'text',
  board: [],
  recorder: null,
  recorderChunks: [],
  userCoords: null,
  sectors: null,
  sectorCells: null,
  hazardsCache: null,
  scoutDepots: null,
};

const $ = (sel) => document.querySelector(sel);
const DEFAULT_CENTER = [47.6062, -122.3321]; // Seattle, WA

async function checkApi() {
  try {
    const r = await fetch('/health');
    if (r.ok) {
      $('#apiStatus').textContent = '● API Connected';
      $('#apiStatus').classList.add('online');
    }
  } catch {
    $('#apiStatus').textContent = '● API Offline';
    $('#apiStatus').classList.add('offline');
  }
}

function getLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userCoords = [pos.coords.latitude, pos.coords.longitude];
      $('#locationLabel').textContent =
        `📍 Auto-detected: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
    },
    () => {},
    { enableHighAccuracy: true, timeout: 5000 }
  );
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.type;
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
      $(`#pane-${tab.dataset.type}`).classList.remove('hidden');
    });
  });
}

function initRecorder() {
  $('#recordBtn').addEventListener('click', async () => {
    if (state.recorder) {
      state.recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Recording not supported in this browser — attach an audio file instead.');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recorder = new MediaRecorder(stream);
    state.recorderChunks = [];
    state.recorder.ondataavailable = (e) => state.recorderChunks.push(e.data);
    state.recorder.onstop = () => {
      clearInterval(state.recTimerId);
      const blob = new Blob(state.recorderChunks, { type: state.recorder.mimeType });
      const url = URL.createObjectURL(blob);
      $('#audioPlayback').src = url;
      $('#audioPlayback').classList.remove('hidden');
      $('#audioFile').value = '';
      $('#recordBtn').textContent = '🎙️ Record Now';
      $('#recTimer').classList.add('hidden');
      state.recorder = null;
      stream.getTracks().forEach((t) => t.stop());
    };
    state.recorder.start();
    $('#recordBtn').textContent = '⏹ Stop';
    $('#recTimer').classList.remove('hidden');
    let s = 0;
    state.recTimerId = setInterval(() => {
      s++;
      $('#recTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
  });
}

/* ---------- Grid & Sector Matrix ---------- */

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function coordsFor(card) {
  const d = card.data || {};
  if (d.location && d.location.confidence > 0 &&
      d.location.latitude && d.location.longitude) {
    return [d.location.latitude, d.location.longitude];
  }
  if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
    return [d.latitude, d.longitude];
  }
  if (state.userCoords) return state.userCoords;
  return null;
}

function nearestSectorForCoords(lat, lng) {
  const sectors = state.sectors;
  if (!sectors || !sectors.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const s of sectors) {
    const d = haversineKm(lat, lng, s.latitude, s.longitude);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  if (bestDist > 60) return { id: 'EXT', name: 'External Regional Zone', latitude: lat, longitude: lng };
  return best;
}

function sectorForCard(card) {
  if (card.data && card.data.sector_id) return card.data.sector_id;
  if (card.data && card.data.grid_sector_id) return card.data.grid_sector_id;
  if (!card.coords) return null;
  const s = nearestSectorForCoords(card.coords[0], card.coords[1]);
  return s ? s.id : null;
}

const SECTOR_ROW_LABELS = ['A', 'B', 'C', 'D'];

function loadSectorMatrix() {
  fetch('/api/sectors')
    .then((r) => r.json())
    .then((data) => {
      state.sectors = data.sectors || [];
      renderSectorBoard();
    })
    .catch(() => {
      state.sectors = buildFallbackSectors();
      renderSectorBoard();
    });
}

function buildFallbackSectors() {
  const ids = [];
  for (const row of 'ABCD') for (let c = 1; c <= 4; c++) ids.push(`${row}${c}`);
  return ids.map((id, i) => ({
    id,
    name: id.startsWith('A') ? `North ${['West','Central','East','Far East'][i % 4]}`
      : id.startsWith('B') ? `Central ${['West','Downtown','Hill','East'][i % 4]}`
      : id.startsWith('C') ? `South ${['West','Harbor','Hill','Valley'][i % 4]}`
      : `South End ${['Ferry','Industrial','Field','Airport'][i % 4]}`,
    latitude: 47.66 - Math.floor(i / 4) * 0.05 - (i % 4) * 0.0,
    longitude: -122.38 + (i % 4) * 0.035,
    primary_hub: null,
    serving_hubs: [],
    hazards: [],
  }));
}

function hazardCountForSector(sectorId) {
  const hs = state.hazardsCache;
  if (!hs || !hs.length) return 0;
  let count = 0;
  for (const h of hs) {
    const s = nearestSectorForCoords(h.latitude, h.longitude);
    if (s && s.id === sectorId) count++;
  }
  return count;
}

function loadHazards() {
  fetch('/api/hazards')
    .then((r) => r.json())
    .then((data) => {
      state.hazardsCache = data.hazards || [];
      renderSectorBoard();
      renderNearbyWatch();
    })
    .catch(() => {});
}

function incidentsInSector(sectorId) {
  return state.board.filter((c) => !isScamFlagged(c) && sectorForCard(c) === sectorId);
}

function highestTriage(incidents) {
  let level = null;
  const rank = { RED: 3, YELLOW: 2, GREEN: 1, critical: 3, high: 2 };
  let best = 0;
  for (const c of incidents) {
    const d = c.data || {};
    let lv = null;
    if (c.type === 'triage') lv = d.triage_level;
    else if (c.type === 'drone') lv = d.severity_score >= 8 ? 'RED' : d.severity_score >= 5 ? 'YELLOW' : 'GREEN';
    else if (d.detected_urgency === 'critical') lv = 'RED';
    else if (d.detected_urgency === 'high') lv = 'YELLOW';
    else if (d.detected_urgency) lv = 'GREEN';
    if (!lv) continue;
    const r = rank[lv] || 0;
    if (r > best) {
      best = r;
      level = lv;
    }
  }
  return level;
}

function sectorCellHtml(cell) {
  const incidents = incidentsInSector(cell.id);
  const triage = highestTriage(incidents);
  const hazardCount = hazardCountForSector(cell.id);
  const cellClass = triage ? `sector-cell lvl-${triage.toLowerCase()}` : 'sector-cell';
  const hub = cell.primary_hub || (cell.serving_hubs || [])[0] || null;

  let hubHtml = '';
  if (hub) {
    hubHtml = `<div class="sector-meta">🏪 ${escapeHtml(hub.name)}</div>`;
  } else {
    hubHtml = '<div class="sector-meta muted">🏪 No hub assigned</div>';
  }

  return `
    <div class="${cellClass}" id="sector-cell-${cell.id}">
      <div class="sector-head">
        <span class="sector-id">${cell.id}</span>
        <span class="sector-name">${escapeHtml(cell.name)}</span>
      </div>
      <div class="sector-counts">
        <span class="chip sector-incident-chip ${triage ? `lvl-${triage.toLowerCase()}` : ''}">${incidents.length} incident${incidents.length === 1 ? '' : 's'}</span>
        ${hazardCount ? `<span class="chip">⚠️ ${hazardCount} hazard${hazardCount === 1 ? '' : 's'}</span>` : ''}
        <span class="chip">📍 ${escapeHtml(cell.id)}</span>
      </div>
      ${hubHtml}
    </div>`;
}

function renderSectorBoard() {
  const boardEl = $('#sectorBoard') || $('#dispatchBoard');
  if (!state.sectors || !state.sectors.length) return;
  const grid = $('#sectorGrid');
  if (!grid) return;
  grid.innerHTML = state.sectors.map(sectorCellHtml).join('');
}

/* ---------- Sector Matrix board ---------- */

function pushCard(type, data) {
  const card = {
    id: `inc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toLocaleTimeString(),
    type,
    data,
  };
  card.coords = coordsFor(card);
  state.board.unshift(card);
  renderBoard();
  return card;
}

function renderBoard() {
  const board = $('#dispatchBoard');
  if (state.board.length === 0) {
    board.innerHTML = '<div class="empty-state">No incidents yet. Submit a report to begin.</div>';
  } else {
    board.innerHTML = state.board.map((c) => renderCard(c)).join('');
  }
  renderSectorBoard();
  renderNearbyWatch();
}

function renderNearbyWatch() {
  const panel = $('#gridResult');
  if (!panel) return;
  const reports = state.board.filter((c) => c.type !== 'scam');
  const active = reports.filter((c) => !isScamFlagged(c));
  const flagged = reports.filter((c) => isScamFlagged(c));
  const red = active.filter((c) => highestTriage([c]) === 'RED').length;
  const yellow = active.filter((c) => highestTriage([c]) === 'YELLOW').length;
  const green = active.length - red - yellow;
  const hazardTotal = (state.hazardsCache || []).length;

  const reportRows = active.length
    ? active.slice(0, 6).map((c) => {
        const d = c.data || {};
        const label = c.type === 'translate' ? d.english_translation : c.type === 'triage' ? d.condition_summary : d.damage_type;
        return `<div class="watch-row">
          <span class="badge ${cardColor(c)}">${c.type === 'triage' ? d.triage_level : c.type === 'drone' ? sevLabel(d.severity_score) : d.detected_urgency || 'low'}</span>
          <span class="watch-text">${escapeHtml(String(label || '').slice(0, 90))}</span>
          ${sectorChipHtml(c)}
        </div>`;
      }).join('')
    : '<div class="watch-row muted">No active reports in the grid yet.</div>';

  panel.innerHTML = `
    <div class="grid-result-box">
      <div class="grid-result-head">
        <span class="badge ${red ? 'red' : ''}">${red} RED</span>
        <span class="badge ${yellow ? 'yellow' : ''}">${yellow} YELLOW</span>
        <span class="badge green">${green} LOW</span>
        <span class="badge">⚠️ ${hazardTotal} hazards</span>
        <span class="badge ${flagged.length ? 'scam' : ''}">🕵️ ${flagged.length} flagged</span>
      </div>
      ${reportRows}
    </div>`;
}

function scamChipHtml(card) {
  const conf = scamConfidence(card);
  if (conf === null) return '';
  if (isScamFlagged(card)) {
    return `<span class="chip scam-chip">⚠️ FLAGGED SCAM ${conf}%</span>`;
  }
  if (conf < 50) {
    return `<span class="chip ok-chip">✓ VERIFIED GENUINE ${conf}%</span>`;
  }
  return `<span class="chip review-chip">🔎 UNDER REVIEW ${conf}%</span>`;
}

function isScamFlagged(card) {
  const d = card.type === 'scam' ? card.data : card.scam;
  if (!d || typeof d !== 'object') return false;
  const conf = typeof d.confidence_score === 'number' ? d.confidence_score : 0;
  return d.is_flagged_as_scam === true || conf >= 70;
}

function scamConfidence(card) {
  if (card.scam && typeof card.scam.confidence_score === 'number') return card.scam.confidence_score;
  if (card.type === 'scam') return card.data.confidence_score;
  return null;
}

function cardColor(card) {
  const d = card.data || {};
  if (card.type === 'triage') {
    if (d.triage_level === 'RED') return 'red';
    if (d.triage_level === 'YELLOW') return 'yellow';
    return 'green';
  }
  if (card.type === 'drone') {
    if (d.severity_score >= 8) return 'red';
    if (d.severity_score >= 5) return 'yellow';
    return 'green';
  }
  if (d.detected_urgency === 'critical') return 'red';
  if (d.detected_urgency === 'high') return 'yellow';
  return 'green';
}

function sectorChipHtml(card) {
  const sid = card.data && card.data.sector_id ? card.data.sector_id : sectorForCard(card);
  if (!sid) return '';
  if (sid === 'EXT') return '<span class="chip sector-chip">🗺️ EXT · External Regional Zone</span>';
  const s = state.sectors ? state.sectors.find((x) => x.id === sid) : null;
  return `<span class="chip sector-chip">🗺️ ${escapeHtml(sid)}${s ? ` · ${escapeHtml(s.name)}` : ''}</span>`;
}

function renderCard(c) {
  const d = c.data;
  const parts = [];

  if (c.type === 'translate') {
    parts.push(`
      <div class="card" id="card-${c.id}">
        <div class="card-top">
          ${isScamFlagged(c)
            ? '<span class="badge scam">⚠️ FLAGGED SCAM</span>'
            : `<span class="badge ${urgencyBadge(d.detected_urgency)}">${d.detected_urgency}</span>`}
          <span class="card-title">🗣️ Translator Report</span>
          <span class="card-time">${c.time}</span>
        </div>
        <div class="card-body">
          <div><em>${languages(d.original_language)}</em></div>
          <div><strong>${escapeHtml(d.english_translation || '')}</strong></div>
          <div class="card-meta">
            ${sectorChipHtml(c)}
            ${d.location && d.location.address ? `<span class="chip">📍 ${escapeHtml(d.location.address)}</span>` : ''}
            <span class="chip">Intent: ${escapeHtml(d.key_intent || '—')}</span>${scamChipHtml(c)}
          </div>
        </div>
      </div>`);
  } else if (c.type === 'drone') {
    parts.push(`
      <div class="card" id="card-${c.id}">
        <div class="card-top">
          <span class="badge ${sevBadge(d.severity_score)}">${sevLabel(d.severity_score)}</span>
          <span class="card-title">🛰️ Drone/Satellite Analysis</span>
          <span class="card-time">${c.time}</span>
        </div>
        <div class="card-body">
          <div><strong>${escapeHtml(d.damage_type || 'unknown')}</strong>
          ${d.survivors_detected
            ? '<span class="badge red" style="margin-left:0.5rem">🆘 Survivors detected</span>'
            : '<span class="badge ok" style="margin-left:0.5rem">No survivors seen</span>'}</div>
          <div class="severity-bar"><div style="width:${(d.severity_score / 10) * 100}%;background:${sevColor(d.severity_score)}"></div></div>
          ${d.summary ? `<div style="margin-top:0.4rem">${escapeHtml(d.summary)}</div>` : ''}
          <div class="card-meta">
            ${sectorChipHtml(c)}
            ${(d.passable_routes || []).length
              ? d.passable_routes.map((r) => `<span class="chip">✅ ${escapeHtml(r)}</span>`).join('')
              : '<span class="chip">No passable routes identified</span>'}
          </div>
        </div>
      </div>`);
  } else if (c.type === 'triage') {
    parts.push(`
      <div class="card" id="card-${c.id}">
        <div class="card-top">
          <span class="badge ${d.triage_level === 'RED' ? 'red' : d.triage_level === 'YELLOW' ? 'yellow' : 'green'}">${d.triage_level}</span>
          <span class="card-title">🏥 Medical Triage</span>
          <span class="card-time">${c.time}</span>
        </div>
        <div class="card-body">
          <div style="margin-bottom:0.3rem">${sectorChipHtml(c)}</div>
          <div>${escapeHtml(d.condition_summary || '')}</div>
          <div><strong style="color:var(--accent)">First Aid:</strong></div>
          <div style="font-size:0.76rem;color:var(--muted)">${(d.recommended_first_aid_steps || []).map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join('<br/>') || '—'}</div>
          <div style="margin-top:0.4rem"><strong style="color:var(--accent)">Supplies:</strong></div>
          <div class="card-meta">${(d.required_medical_supplies || []).map((s) => `<span class="chip">${escapeHtml(s)}</span>`).join('')}</div>
        </div>
      </div>`);
  } else if (c.type === 'scam') {
    const flagged = isScamFlagged(c);
    const conf = typeof d.confidence_score === 'number' ? d.confidence_score : 0;
    const barColor = flagged ? 'var(--scam)' : conf < 50 ? 'var(--green)' : 'var(--yellow)';
    parts.push(`
      <div class="card">
        <div class="card-top">
          ${flagged
            ? '<span class="badge scam">⚠️ FLAGGED SCAM</span>'
            : conf < 50
              ? '<span class="badge ok">✓ VERIFIED GENUINE</span>'
              : '<span class="badge yellow">🔎 UNDER REVIEW</span>'}
          <span class="card-title">🕵️ AI Sybil Filter</span>
          <span class="card-time">${c.time}</span>
        </div>
        <div class="card-body">
          <div class="severity-bar"><div style="width:${conf}%;background:${barColor}"></div></div>
          <div style="margin-top:0.4rem"><strong>Scam likelihood: ${conf}%/100</strong> — ${flagged ? 'Resource-hijack attempt, do not dispatch.' : conf < 50 ? 'Genuine real-world report.' : 'Review before dispatch.'}</div>
          <div style="margin-top:0.4rem;font-size:0.76rem;color:var(--muted)">${escapeHtml(d.reasoning || '')}</div>
          <div class="card-meta">${(d.risk_factors || []).map((r) => `<span class="chip">❗ ${escapeHtml(r)}</span>`).join('')}</div>
        </div>
      </div>`);
  }

  return parts.join('');
}

function urgencyBadge(u) {
  if (u === 'critical') return 'red';
  if (u === 'high') return 'yellow';
  return 'green';
}
function sevBadge(s) {
  if (s >= 8) return 'red';
  if (s >= 5) return 'yellow';
  return 'green';
}
function sevLabel(s) {
  if (s >= 8) return `SEVERITY ${s}/10 — CRITICAL`;
  if (s >= 5) return `SEVERITY ${s}/10 — HIGH`;
  return `SEVERITY ${s}/10 — MODERATE`;
}
function sevColor(s) {
  if (s >= 8) return 'var(--red)';
  if (s >= 5) return 'var(--yellow)';
  return 'var(--green)';
}
function languages(lang) {
  if (!lang) return '—';
  return `🌐 ${escapeHtml(lang)}`;
}

/* ---------- Intake senders ---------- */

function setLoading(el, on) {
  if (on) el.disabled = true;
  else el.disabled = false;
}
function showResult(html) {
  $('#intakeResult').innerHTML = html;
}
function showError(msg) {
  showResult(`<div class="error-box">${escapeHtml(msg)}</div>`);
}

async function sendText() {
  const text = $('#incidentText').value.trim();
  if (!text) return showError('Please enter a crisis report first.');
  const btn = $('#sendBtn');
  setLoading(btn, true);
  showResult('<div class="result-box"><span class="spinner"></span>Translating, verifying, and dispatching…</div>');

  try {
    const [trans, scam] = await Promise.all([
      fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(r => r.json()),
      fetch('/api/scam', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(r => r.json()),
    ]);
    if (trans.error) throw new Error(trans.detail || trans.error);
    if (trans.is_invalid_input) {
      showResult(`<div class="error-box">⚠️ That doesn't look like a real crisis report (received: "${escapeHtml(text.slice(0, 60))}…"). No card was created. Please describe where you are, what happened, and what help is needed.</div>`);
      return;
    }
    const card = pushCard('translate', trans);
    card.scam = scam;
    pushCard('scam', scam);
    if (card.coords) {
      const sector = nearestSectorForCoords(card.coords[0], card.coords[1]);
      if (sector) card.data.sector_id = sector.id;
    }
    renderBoard();
    const scamFlagged = isScamFlagged(card);
    const scamLabel = scamFlagged
      ? '<span class="badge scam">FLAGGED SCAM — do not dispatch</span>'
      : scam.confidence_score < 50
        ? '<span class="badge ok">VERIFIED GENUINE</span>'
        : '<span class="badge yellow">UNDER REVIEW</span>';
    showResult(`
      <div class="result-box">
        <h4>🗣️ Translation</h4>
        <div>Language: <strong>${escapeHtml(trans.original_language)}</strong></div>
        <div>${escapeHtml(trans.english_translation)}</div>
        <div>Intent: <em>${escapeHtml(trans.key_intent)}</em></div>
        ${sectorChipHtml(card) ? `<div style="margin-top:0.4rem">${sectorChipHtml(card)}</div>` : ''}
        ${trans.location && trans.location.address ? `<div style="margin-top:0.4rem">📍 ${escapeHtml(trans.location.address)}</div>` : ''}
        <div style="margin-top:0.6rem"><h4>🕵️ Verification</h4>
        Scam likelihood: <strong>${scam.confidence_score}%/100</strong> ${scamLabel}</div>
      </div>`);
  } catch (e) {
    showError(`Request failed: ${e.message}`);
  } finally {
    setLoading(btn, false);
  }
}

async function sendAudio() {
  const file = getAudioFile();
  if (!file) return showError('Please upload or record a voice note first.');
  const btn = $('#sendBtn');
  setLoading(btn, true);
  showResult('<div class="result-box"><span class="spinner"></span>Transcribing and translating audio…</div>');

  const fd = new FormData();
  fd.append('audio', file);
  try {
    const trans = await fetch('/api/translate/audio', { method: 'POST', body: fd }).then(r => r.json());
    if (trans.error) throw new Error(trans.detail || trans.error);
    if (trans.is_invalid_input) {
      showError('⚠️ That recording does not seem to contain a valid crisis report. No card was created.');
      return;
    }
    const card = pushCard('translate', trans);
    if (card.coords) {
      const sector = nearestSectorForCoords(card.coords[0], card.coords[1]);
      if (sector) card.data.sector_id = sector.id;
    }
    renderBoard();
    showResult(`<div class="result-box"><h4>🗣️ Audio Translation</h4>
      <div>Language: <strong>${escapeHtml(trans.original_language)}</strong></div>
      <div>${escapeHtml(trans.english_translation)}</div>
      <div>Intent: <em>${escapeHtml(trans.key_intent)}</em></div></div>`);
  } catch (e) {
    showError(`Request failed: ${e.message}`);
  } finally {
    setLoading(btn, false);
  }
}

async function sendDrone() {
  const file = $('#droneImage').files[0];
  const url = $('#droneUrl').value.trim();
  if (!file && !url) return showError('Upload a drone image or provide an image URL.');
  const btn = $('#sendBtn');
  setLoading(btn, true);
  showResult('<div class="result-box"><span class="spinner"></span>Analyzing satellite/drone imagery…</div>');

  const fd = new FormData();
  if (file) fd.append('image', file);
  if (url) fd.append('image_url', url);
  try {
    const res = await fetch('/api/drone', { method: 'POST', body: fd }).then(r => r.json());
    if (res.error) throw new Error(res.detail || res.error);
    pushCard('drone', res);
    showResult(`<div class="result-box"><h4>🛰️ Drone Analysis</h4>
      <div>Damage: <strong>${escapeHtml(res.damage_type)}</strong></div>
      <div>Severity: <strong>${res.severity_score}/10</strong></div>
      <div>Survivors: <strong>${res.survivors_detected ? 'Detected 🆘' : 'None'}</strong></div>
      ${res.summary ? `<div style="margin-top:0.4rem">${escapeHtml(res.summary)}</div>` : ''}</div>`);
  } catch (e) {
    showError(`Request failed: ${e.message}`);
  } finally {
    setLoading(btn, false);
  }
}

async function sendMedical() {
  const file = $('#medicalImage').files[0];
  const text = $('#medicalText').value.trim();
  if (!file && !text) return showError('Upload a medical photo or describe injuries.');
  const btn = $('#sendBtn');
  setLoading(btn, true);
  showResult('<div class="result-box"><span class="spinner"></span>Evaluating clinical severity…</div>');

  const fd = new FormData();
  if (file) fd.append('image', file);
  if (text) fd.append('text', text);
  try {
    const res = await fetch('/api/triage', { method: 'POST', body: fd }).then(r => r.json());
    if (res.error) throw new Error(res.detail || res.error);
    const card = pushCard('triage', res);
    if (text) {
      try {
        const loc = await fetch('/api/locate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(r => r.json());
        if (loc.latitude && loc.longitude && loc.confidence > 0) {
          card.data.location = { latitude: loc.latitude, longitude: loc.longitude, address: loc.address, confidence: loc.confidence };
          card.coords = coordsFor(card);
          const sector = nearestSectorForCoords(card.coords[0], card.coords[1]);
          if (sector) card.data.sector_id = sector.id;
        }
      } catch (_) { /* location enrichment is best-effort */ }
    }
    renderBoard();
    showResult(`<div class="result-box"><h4>🏥 Triage Result</h4>
      <span class="badge ${res.triage_level === 'RED' ? 'red' : res.triage_level === 'YELLOW' ? 'yellow' : 'green'}">${res.triage_level}</span>
      <div style="margin-top:0.4rem">${escapeHtml(res.condition_summary)}</div>
      <div style="margin-top:0.4rem"><h4>First Aid Steps</h4>
      ${(res.recommended_first_aid_steps || []).map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join('<br/>')}</div></div>`);
  } catch (e) {
    showError(`Request failed: ${e.message}`);
  } finally {
    setLoading(btn, false);
  }
}

async function scamScan() {
  const texts = state.board.filter(c => c.type === 'translate').map(c => c.data.english_translation || '');
  if (texts.length === 0) {
    $('#scamResult').innerHTML = '<div class="result-box">No translator reports to verify yet.</div>';
    return;
  }
  const btn = $('#runScamScan');
  setLoading(btn, true);
  $('#scamResult').innerHTML = '<div class="result-box"><span class="spinner"></span>Cross-examining all reports…</div>';
  try {
    const res = await fetch('/api/scam', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reports: texts.map(t => ({ text: t })) }) }).then(r => r.json());
    if (res.error) throw new Error(res.detail || res.error);
    pushCard('scam', res);
    state.board.filter(c => c.type === 'translate').forEach(c => { c.scam = res; });
    renderBoard();
    $('#scamResult').innerHTML = '';
  } catch (e) {
    $('#scamResult').innerHTML = `<div class="error-box">Scan failed: ${escapeHtml(e.message)}</div>`;
  } finally {
    setLoading(btn, false);
  }
}

function seedDemoIncidents() {
  const floodTranslate = {
    original_language: 'Mandarin',
    english_translation: 'There is a flood, the water is rising fast, we are stuck on the roof of our building. Please send a boat to rescue us now.',
    key_intent: 'reporting flooding and requesting boat rescue',
    detected_urgency: 'critical',
    sector_id: 'C2',
    location: {
      latitude: 47.6040,
      longitude: -122.3400,
      address: 'Waterfront / Harbor Island, Seattle',
      confidence: 90,
    },
  };
  const floodScam = {
    confidence_score: 6,
    is_flagged_as_scam: false,
    reasoning: 'Short, urgent flood report with a concrete situation (rising water, roof, boat rescue) — no bulk quantities or template phrasing.',
    risk_factors: [],
  };

  const medicalTriage = {
    triage_level: 'RED',
    condition_summary: 'Elderly survivor with chest pain and labored breathing after swimming through floodwater — possible cardiac event.',
    recommended_first_aid_steps: ['Keep casualty sitting upright', 'Loosen tight clothing', 'Administer oxygen if available', 'Monitor pulse every 5 minutes', 'Priority evacuation to field hospital'],
    required_medical_supplies: ['Oxygen', 'IV fluids', 'Cardiac monitor', 'Nitroglycerin'],
  };

  const fakeScam = {
    confidence_score: 84,
    is_flagged_as_scam: true,
    reasoning: 'Generic bulk resource request (500 tents, 2000 blankets, 10 trucks, "unlimited") with zero named streets, landmarks, or casualty counts. Matches known bot resource-extraction templates.',
    risk_factors: [
      'Generic bulk resource request without any location detail',
      'Maximum-inventory wording ("unlimited")',
      'No casualty or situational details',
    ],
  };

  const card = pushCard('translate', floodTranslate);
  card.scam = floodScam;
  const triageCard = pushCard('triage', { ...medicalTriage, location: floodTranslate.location, sector_id: 'C2' });
  triageCard.coords = [floodTranslate.location.latitude, floodTranslate.location.longitude];
  pushCard('scam', fakeScam);
  renderBoard();
  renderSectorBoard();
  showResult('<div class="result-box"><h4>🧪 3 Demo Incidents Seeded</h4><div>1. 🌊 Critical flood rescue (RED)</div><div>2. 🏥 Medical triage case (RED)</div><div class="card-meta">3. 🕵️ Fake bulk-resource request — <span class="chip scam-chip">⚠️ FLAGGED SCAM 84%</span></div><div style="margin-top:0.4rem">The Sector Matrix Board now marks each zone by highest triage level; check the nearby report &amp; hazard watch below the grid.</div></div>');
}

function getAudioFile() {
  const input = $('#audioFile');
  if (input.files[0]) return input.files[0];
  const playback = $('#audioPlayback');
  if (playback.src && state.recorderChunks.length) {
    const blob = new Blob(state.recorderChunks, { type: 'audio/webm' });
    return new File([blob], 'recording.webm', { type: 'audio/webm' });
  }
  return null;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

$('#sendBtn').addEventListener('click', () => {
  if (state.activeTab === 'text') sendText();
  else if (state.activeTab === 'audio') sendAudio();
  else if (state.activeTab === 'drone') sendDrone();
  else if (state.activeTab === 'medical') sendMedical();
});
$('#runScamScan').addEventListener('click', scamScan);
$('#seedDemoBtn').addEventListener('click', seedDemoIncidents);
$('#refreshSectorsBtn')?.addEventListener('click', () => { loadSectorMatrix(); loadHazards(); });

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#themeToggle');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
}

function initTheme() {
  const saved = localStorage.getItem('disasterrelief-theme');
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('disasterrelief-theme', next);
  });
}

initTabs();
initRecorder();
initTheme();
getLocation();
checkApi();
loadSectorMatrix();
loadHazards();