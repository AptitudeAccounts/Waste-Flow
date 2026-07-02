/**
 * Thin client for the WasteFlow Apps Script backend.
 * Uses `text/plain` content type on POST so the browser sends a "simple
 * request" and skips the CORS preflight — Apps Script Web Apps don't
 * support handling OPTIONS preflight requests, so this avoids that entirely.
 */
const WasteFlowAPI = (() => {
  const URL = WASTEFLOW_CONFIG.API_URL;

  async function call(action, payload) {
    const body = Object.assign({ action }, payload || {});
    if (!URL || URL.indexOf('PASTE_YOUR') === 0) {
      throw new Error('CONFIG_MISSING');
    }
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('Network error (' + res.status + ')');
    return res.json();
  }

  return { call };
})();

/* ---------- Session helpers (shared localStorage keys) ---------- */
const Session = {
  get() {
    try { return JSON.parse(localStorage.getItem('wasteflow_session') || 'null'); }
    catch (e) { return null; }
  },
  set(session) { localStorage.setItem('wasteflow_session', JSON.stringify(session)); },
  clear() { localStorage.removeItem('wasteflow_session'); }
};

/* ---------- Toast ---------- */
function showToast(message, type) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

/* ---------- Theme (persisted, shared across pages) ---------- */
function initTheme() {
  const saved = localStorage.getItem('wasteflow_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = saved === 'dark' ? '☀️' : '🌙';
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('wasteflow_theme', next);
      btn.textContent = next === 'dark' ? '☀️' : '🌙';
    });
  }
}

/* ---------- Offline queue (used by the staff form) ---------- */
const OfflineQueue = {
  KEY: 'wasteflow_offline_queue',
  all() { try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch (e) { return []; } },
  push(entry) { const q = this.all(); q.push(entry); localStorage.setItem(this.KEY, JSON.stringify(q)); },
  clearAll() { localStorage.removeItem(this.KEY); },
  set(q) { localStorage.setItem(this.KEY, JSON.stringify(q)); }
};

async function flushOfflineQueue() {
  const q = OfflineQueue.all();
  if (q.length === 0) return { flushed: 0, remaining: 0 };
  const remaining = [];
  let flushed = 0;
  for (const entry of q) {
    try {
      const res = await WasteFlowAPI.call('submitEntry', entry);
      if (res.ok) flushed++; else remaining.push(entry);
    } catch (e) {
      remaining.push(entry); // still offline / backend unreachable — keep for later
    }
  }
  OfflineQueue.set(remaining);
  return { flushed, remaining: remaining.length };
}

document.addEventListener('DOMContentLoaded', initTheme);
