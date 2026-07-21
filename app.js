'use strict';
// ── DDragon ───────────────────────────────────────────────────────────────────
const DD = {
  versionsURL: 'https://ddragon.leagueoflegends.com/api/versions.json',
  champURL: v => `https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`,
  imgURL:  (v, id) => `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${id}.png`,
};

// ── App State ─────────────────────────────────────────────────────────────────
let allChamps = [];    // enriched champion objects
let version   = '';
let nameIndex = {};   // normalised-name → champion object

// Manual builder state – each role: { main: champ|null, backups: [champ|null, ...x5] }
const ROLES = ['top', 'jungle', 'mid', 'bot', 'support'];
function blankComp() {
  return Object.fromEntries(ROLES.map(r => [r, { main: null, backups: Array(5).fill(null) }]));
}
let comp = blankComp();
let activeFilter = 'all';
let activeSubFilter = 'all';

// ── Pointer drag state ────────────────────────────────────────────────────────
const drag = { active: false, champ: null, clone: null, overEl: null, sourceCard: null };

// Team suggester state
// Roster mode (from team-data.js): players are grouped by role and one player
// per role is "active". teamPlayers[i] then points at the active player of
// ROLES[i]. Excel/manual mode: teamRoster is null and teamPlayers is flexible.
let teamRoster = null; // { top: { players: [{name, champions}], active: 0 }, ... }
let teamPlayers = [
  { name: 'Player 1', champions: [] },
  { name: 'Player 2', champions: [] },
  { name: 'Player 3', champions: [] },
  { name: 'Player 4', champions: [] },
  { name: 'Player 5', champions: [] },
];
let selectedCompId = null;

function syncTeamPlayersFromRoster() {
  if (!teamRoster) return;
  teamPlayers = ROLES.map(role => {
    const slot = teamRoster[role];
    return slot?.players[slot.active] || { name: '—', champions: [] };
  });
}

const ROSTER_KEY = 'lol_team_roster_v1';
const AUTH_KEY   = 'lol_auth';

// ── Auth state ────────────────────────────────────────────────────────────────
let auth = null;   // { token, username, role } when logged in
function loadAuth() { try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { auth = null; } }
function isLoggedIn() { return !!auth?.token; }
function isCoach()    { return auth?.role === 'coach'; }

function syncEnabled() { return typeof SYNC !== 'undefined' && !!SYNC.url && !!SYNC.anonKey; }

// Calls a Supabase RPC with the public anon key; throws with the server message.
async function rpc(fn, body) {
  const res = await fetch(`${SYNC.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SYNC.anonKey, Authorization: `Bearer ${SYNC.anonKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text; try { msg = JSON.parse(text).message; } catch {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return text ? JSON.parse(text) : null;
}

function setSyncStatus(state) {
  const s = document.getElementById('sync-status');
  if (!s) return;
  const map = { saving: ['Saving…', 'var(--text-dim)'], saved: ['✓ Synced', 'var(--green)'], error: ['⚠ Save failed', 'var(--red)'] };
  const [t, c] = map[state] || ['', ''];
  s.textContent = t; s.style.color = c;
  if (state === 'saved') setTimeout(() => { if (s.textContent === '✓ Synced') s.textContent = ''; }, 1500);
}

// ── Roster serialization + save ───────────────────────────────────────────────
function rosterToJSON() {
  return Object.fromEntries(ROLES.map(r => [r, {
    active: teamRoster[r].active,
    players: teamRoster[r].players.map(p => ({
      name: p.name,
      champs: p.champions.map(c => ({ id: c.id, m: (p.mastery && p.mastery[c.id]) || 3 })),
    })),
  }]));
}

let rosterSaveTimer = null;
function saveRoster() {
  if (!teamRoster) return;
  const json = rosterToJSON();
  localStorage.setItem(ROSTER_KEY, JSON.stringify(json));   // remembered per browser
  if (!syncEnabled() || !isLoggedIn()) return;              // logged-in users push to the shared cloud roster
  setSyncStatus('saving');
  clearTimeout(rosterSaveTimer);
  rosterSaveTimer = setTimeout(async () => {
    try { await rpc('save_roster_auth', { new_data: json, token: auth.token }); setSyncStatus('saved'); }
    catch (e) { console.error('roster save failed', e); setSyncStatus('error'); }
  }, 700);
}

async function loadCloudRoster() {
  if (!syncEnabled() || !isLoggedIn()) return null;
  try {
    const data = await rpc('get_roster', { token: auth.token });
    return data && Object.keys(data).length ? data : null;
  } catch (e) { console.warn('Cloud roster unavailable:', e); return null; }
}

// ── Shared saved comps (cloud) ────────────────────────────────────────────────
let savedComps = [];
async function loadCloudComps() {
  if (!syncEnabled() || !isLoggedIn()) { savedComps = []; return; }
  try { savedComps = (await rpc('get_comps', { token: auth.token })) || []; }
  catch (e) { console.warn('Cloud comps unavailable:', e); savedComps = []; }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  setupTabs();
  setupControls();
  setupPointerDrag();
  setupSaveModal();
  setupLoginOverlay();
  setupBuilderModes();
  setupCalendar();
  renderSavedComps();

  try {
    const versions = await fetch(DD.versionsURL).then(r => r.json());
    version = versions[0];
    const data = await fetch(DD.champURL(version)).then(r => r.json());

    allChamps = Object.values(data.data).map(c => {
      const classData = CHAMPION_CLASSES[c.id] || null;
      const sub  = classData ? classData.sub  : (c.tags[0] || 'Specialist');
      const cfg  = CLASS_CONFIG[sub] || CLASS_CONFIG['Specialist'];
      return {
        id:     c.id,
        name:   c.name,
        title:  c.title,
        tags:   c.tags,
        sub,
        group:  cfg.group,
        color:  cfg.color,
        bg:     cfg.bg,
        img:    DD.imgURL(version, c.id),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Build name lookup (normalised → champion)
    allChamps.forEach(c => {
      nameIndex[norm(c.id)]   = c;
      nameIndex[norm(c.name)] = c;
    });
    // Apply aliases
    Object.entries(ALIASES).forEach(([alias, id]) => {
      const c = allChamps.find(x => x.id === id);
      if (c) nameIndex[norm(alias)] = c;
    });

    renderPills();
    renderGrid();
    loadTeamData();               // defaults + local edits (shown behind the login gate)
    renderTeamSuggesterUI();
    renderCompPicker();
    await initAuth();             // then log in and pull the shared cloud data
  } catch (e) {
    console.error(e);
    document.getElementById('champion-grid').innerHTML =
      `<div class="loading" style="color:#e74c3c">Failed to load champions — check your internet connection.</div>`;
  }
}

// ── AUTH FLOW ─────────────────────────────────────────────────────────────────
async function initAuth() {
  if (!syncEnabled()) { hideLoginOverlay(); updateAuthUI(); return; }  // sync off → open app
  loadAuth();
  if (auth?.token) {
    try {
      const info = await rpc('me', { token: auth.token });
      if (info?.username) {
        auth = { token: auth.token, username: info.username, role: info.role };
        localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
        await afterLogin();
        return;
      }
    } catch (e) { /* token no longer valid */ }
    auth = null; localStorage.removeItem(AUTH_KEY);
  }
  showLoginOverlay();
}

async function afterLogin() {
  hideLoginOverlay();
  updateAuthUI();
  const cloud = await loadCloudRoster();
  loadTeamData(cloud);
  renderTeamSuggesterUI();
  await loadCloudComps();
  renderSavedComps();
  if (isCoach()) { await loadCoaching(); renderCoaching(); }
}

function logout() {
  auth = null;
  localStorage.removeItem(AUTH_KEY);
  location.reload();
}

// Reflect login state in the UI: header box, coaching tab visibility
function updateAuthUI() {
  const box = document.getElementById('auth-box');
  if (box) {
    box.innerHTML = isLoggedIn()
      ? `<span class="auth-user">${auth.username}</span>
         <span class="auth-role auth-role-${auth.role}">${auth.role === 'coach' ? '★ Coach' : 'Player'}</span>
         <button id="logout-btn" class="auth-logout" title="Log out">Logout</button>`
      : '';
    document.getElementById('logout-btn')?.addEventListener('click', logout);
  }
  const coachTab = document.querySelector('.tab-btn[data-tab="tab-coaching"]');
  if (coachTab) coachTab.style.display = isCoach() ? '' : 'none';
  const calTab = document.querySelector('.tab-btn[data-tab="tab-calendar"]');
  if (calTab) calTab.style.display = isLoggedIn() && syncEnabled() ? '' : 'none';
}

function showLoginOverlay() { document.getElementById('login-overlay')?.classList.remove('hidden'); }
function hideLoginOverlay() { document.getElementById('login-overlay')?.classList.add('hidden'); }

function setupLoginOverlay() {
  const form   = document.getElementById('login-form');
  if (!form) return;
  const err    = document.getElementById('login-error');
  const toggle = document.getElementById('login-toggle');
  const invite = document.getElementById('login-invite-row');
  const submit = document.getElementById('login-submit');
  const title  = document.getElementById('login-title');
  let mode = 'login';   // or 'register'

  toggle.addEventListener('click', e => {
    e.preventDefault();
    mode = mode === 'login' ? 'register' : 'login';
    invite.style.display = mode === 'register' ? '' : 'none';
    submit.textContent   = mode === 'register' ? 'Create account' : 'Log in';
    title.textContent    = mode === 'register' ? 'Create your account' : 'Team login';
    toggle.textContent   = mode === 'register' ? 'I already have an account' : 'Create a new account';
    err.textContent = '';
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const u = document.getElementById('login-username').value.trim();
    const p = document.getElementById('login-password').value;
    if (!u || !p) { err.textContent = 'Enter username and password.'; return; }
    submit.disabled = true;
    try {
      const info = mode === 'register'
        ? await rpc('register', { u, p, invite: document.getElementById('login-invite').value.trim() })
        : await rpc('login', { u, p });
      auth = { token: info.token, username: info.username, role: info.role };
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      await afterLogin();
    } catch (ex) {
      err.textContent = ex.message || 'Login failed.';
    } finally {
      submit.disabled = false;
    }
  });
}

// ── Normalise champion names ───────────────────────────────────────────────────
function norm(s) {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

function findChamp(raw) {
  const key = norm(raw.trim());
  return nameIndex[key] || null;
}

// ── TABS ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === target));
      if (target === 'tab-coaching' && isCoach()) renderCoaching();
      if (target === 'tab-calendar' && isLoggedIn()) refreshCalendar();
    });
  });
}

// ── POINTER DRAG ──────────────────────────────────────────────────────────────
function setupPointerDrag() {
  document.addEventListener('pointermove', onDragMove, { passive: true });
  document.addEventListener('pointerup',   onDragEnd);
  document.addEventListener('pointercancel', cancelDrag);
}

function startDrag(e, card, champ) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();

  const rect  = card.getBoundingClientRect();
  drag.active     = true;
  drag.champ      = champ;
  drag.sourceCard = card;
  drag.ox = e.clientX - rect.left;
  drag.oy = e.clientY - rect.top;

  // Floating clone that follows the cursor
  const clone = card.cloneNode(true);
  Object.assign(clone.style, {
    position:      'fixed',
    width:         rect.width  + 'px',
    height:        rect.height + 'px',
    left:          (e.clientX - drag.ox) + 'px',
    top:           (e.clientY - drag.oy) + 'px',
    pointerEvents: 'none',
    zIndex:        '9999',
    opacity:       '.88',
    transform:     'scale(1.08) rotate(2deg)',
    boxShadow:     '0 12px 36px rgba(0,0,0,.7)',
    borderRadius:  '8px',
    transition:    'none',
    cursor:        'grabbing',
  });
  document.body.appendChild(clone);
  drag.clone = clone;
  card.style.opacity = '.25';
  document.body.style.userSelect = 'none';
}

function onDragMove(e) {
  if (!drag.active) return;
  drag.clone.style.left = (e.clientX - drag.ox) + 'px';
  drag.clone.style.top  = (e.clientY - drag.oy) + 'px';

  // Find drop target under cursor (hide clone so it doesn't block hit-test)
  drag.clone.style.display = 'none';
  const under  = document.elementFromPoint(e.clientX, e.clientY);
  drag.clone.style.display = '';
  const target = under?.closest('.slot[data-slot], .backup-slot[data-slot]');

  if (drag.overEl !== target) {
    drag.overEl?.classList.remove('drag-over');
    target?.classList.add('drag-over');
    drag.overEl = target || null;
  }
}

function onDragEnd(e) {
  if (!drag.active) return;

  drag.clone.style.display = 'none';
  const under  = document.elementFromPoint(e.clientX, e.clientY);
  drag.clone.style.display = '';
  const target = under?.closest('.slot[data-slot], .backup-slot[data-slot]');

  if (target) {
    const slotKey   = target.dataset.slot;
    const backupIdx = target.dataset.backup !== undefined ? +target.dataset.backup : null;
    if (slotKey) placeChamp(slotKey, drag.champ, backupIdx);
  }

  cancelDrag();
}

function cancelDrag() {
  drag.overEl?.classList.remove('drag-over');
  drag.clone?.remove();
  if (drag.sourceCard) drag.sourceCard.style.opacity = '';
  document.body.style.userSelect = '';
  drag.active = drag.champ = drag.clone = drag.overEl = drag.sourceCard = null;
  drag.active = false;
}

// slots no longer need HTML5 drag listeners – kept as no-op for compat
function setupSlots() {}

// backupIdx: null = main slot, 0/1/2 = backup
function placeChamp(slotKey, champ, backupIdx) {
  if (backupIdx === null || backupIdx === undefined) {
    comp[slotKey].main = champ;
  } else {
    comp[slotKey].backups[backupIdx] = champ;
  }
  renderSlot(slotKey);
  updateCompStats();
  syncCards();
}

function renderSlot(slotKey) {
  // ── Main slot ──
  const mainEl = document.querySelector(`.slot[data-slot="${slotKey}"]`);
  const champ  = comp[slotKey].main;
  mainEl.querySelectorAll('img, .remove-btn, .slot-name').forEach(n => n.remove());
  mainEl.classList.toggle('filled', !!champ);
  if (champ) {
    const img = Object.assign(document.createElement('img'), { src: champ.img, alt: champ.name });
    const lbl = el('div', 'slot-name', champ.name);
    const btn = el('button', 'remove-btn', '×');
    btn.title = `Remove ${champ.name}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      comp[slotKey].main = null;
      renderSlot(slotKey); updateCompStats(); syncCards();
    });
    mainEl.append(img, lbl, btn);
    mainEl.style.setProperty('--slot-glow', champ.color);
  } else {
    mainEl.style.removeProperty('--slot-glow');
  }

  // ── Backup slots ──
  comp[slotKey].backups.forEach((bChamp, bi) => {
    const bEl = document.querySelector(`.backup-slot[data-slot="${slotKey}"][data-backup="${bi}"]`);
    if (!bEl) return;
    bEl.querySelectorAll('img, .b-remove, .backup-name').forEach(n => n.remove());
    // Always keep the B-label
    let numEl = bEl.querySelector('.backup-num');
    if (!numEl) { numEl = el('span', 'backup-num', `B${bi+1}`); bEl.prepend(numEl); }

    bEl.classList.toggle('b-filled', !!bChamp);
    if (bChamp) {
      numEl.style.display = 'none';
      const img = Object.assign(document.createElement('img'), { src: bChamp.img, alt: bChamp.name });
      const lbl = el('div', 'backup-name', bChamp.name);
      const btn = el('button', 'b-remove', '×');
      btn.title = `Remove ${bChamp.name}`;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        comp[slotKey].backups[bi] = null;
        renderSlot(slotKey); syncCards();
      });
      bEl.append(img, lbl, btn);
      bEl.style.setProperty('--b-glow', bChamp.color);
    } else {
      numEl.style.display = '';
      bEl.style.removeProperty('--b-glow');
    }
  });
}

function updateCompStats() {
  const filled = ROLES.map(r => comp[r].main).filter(Boolean);
  const stats  = document.getElementById('comp-stats');
  stats.innerHTML = '';
  if (!filled.length) return;
  const counts = {};
  filled.forEach(c => { counts[c.sub] = (counts[c.sub] || 0) + 1; });
  Object.entries(counts).forEach(([sub, n]) => {
    const cfg = CLASS_CONFIG[sub] || CLASS_CONFIG['Specialist'];
    const tag = el('span', 'stat-tag');
    tag.textContent = `${n}× ${sub}`;
    tag.style.background = cfg.color;
    tag.style.color = '#fff';
    stats.appendChild(tag);
  });
}

function addToFirstEmpty(champ) {
  if (isInComp(champ.id)) return;
  // Try main slots first, then backups
  const emptyMain = ROLES.find(k => !comp[k].main);
  if (emptyMain) { placeChamp(emptyMain, champ, null); return; }
  // Find first empty backup
  for (const role of ROLES) {
    const bi = comp[role].backups.findIndex(b => !b);
    if (bi !== -1) { placeChamp(role, champ, bi); return; }
  }
}

function isInComp(id) {
  return ROLES.some(r =>
    (comp[r].main?.id === id) || comp[r].backups.some(b => b?.id === id)
  );
}

function syncCards() {
  document.querySelectorAll('#champion-grid .champ-card').forEach(card => {
    card.classList.toggle('in-comp', isInComp(card.dataset.id));
  });
}

// ── CHAMPION GRID ─────────────────────────────────────────────────────────────
const SUBCLASS_ORDER = [
  'Vanguard','Warden','Juggernaut','Diver',
  'Assassin','Skirmisher',
  'Burst Mage','Battle Mage','Artillery',
  'Enchanter','Catcher',
  'Marksman','Specialist',
];

function renderPills() {
  const cont = document.getElementById('archetype-pills');
  cont.innerHTML = '';

  const allPill = el('button', 'pill active', 'All');
  allPill.dataset.sub = 'all';
  allPill.addEventListener('click', () => setSubFilter('all'));
  cont.appendChild(allPill);

  SUBCLASS_ORDER.forEach(sub => {
    const cfg = CLASS_CONFIG[sub];
    const cnt = allChamps.filter(c => c.sub === sub).length;
    const p = el('button', 'pill');
    p.dataset.sub = sub;
    p.innerHTML = `${sub} <span class="pill-count">${cnt}</span>`;
    p.style.background = cfg.bg;
    p.style.borderColor = cfg.color;
    p.style.color = cfg.color;
    p.addEventListener('click', () => setSubFilter(sub));
    cont.appendChild(p);
  });
}

function setSubFilter(sub) {
  activeSubFilter = sub;
  document.querySelectorAll('#archetype-pills .pill').forEach(p =>
    p.classList.toggle('active', p.dataset.sub === sub));
  renderGrid();
}

function renderGrid() {
  const query = (document.getElementById('search')?.value || '').trim().toLowerCase();
  const roleF = activeFilter;
  const subF  = activeSubFilter;

  const list = allChamps.filter(c => {
    if (roleF !== 'all' && c.group.toLowerCase() !== roleF.toLowerCase() && c.tags[0]?.toLowerCase() !== roleF.toLowerCase()) {
      if (!c.tags.map(t => t.toLowerCase()).includes(roleF.toLowerCase())) return false;
    }
    if (subF !== 'all' && c.sub !== subF) return false;
    if (query && !c.name.toLowerCase().includes(query)) return false;
    return true;
  });

  const grid = document.getElementById('champion-grid');
  grid.innerHTML = '';

  list.forEach(champ => {
    const card = el('div', 'champ-card');
    card.dataset.id = champ.id;
    card.style.setProperty('--card-color', champ.color);

    const img = Object.assign(document.createElement('img'), {
      src: champ.img, alt: champ.name, loading: 'lazy', draggable: false,
    });
    const nameLbl = el('div', 'champ-name', champ.name);
    const badge   = el('span', 'sub-badge');
    badge.textContent = champ.sub;
    badge.style.background = CLASS_CONFIG[champ.sub]?.bg || '#111';
    badge.style.color = champ.color;
    badge.style.borderColor = champ.color;

    card.append(img, nameLbl, badge);

    card.addEventListener('mouseenter', e => showTooltip(e, champ));
    card.addEventListener('mousemove',  moveTooltip);
    card.addEventListener('mouseleave', hideTooltip);
    card.addEventListener('pointerdown', e => startDrag(e, card, champ));

    if (isInComp(champ.id)) card.classList.add('in-comp');
    grid.appendChild(card);
  });

  const cnt = document.getElementById('champ-count');
  if (cnt) cnt.textContent = `(${list.length})`;
}

// ── CONTROLS ─────────────────────────────────────────────────────────────────
function setupControls() {
  const search = document.getElementById('search');
  const roleF  = document.getElementById('role-filter');
  const clearBtn = document.getElementById('clear-comp');
  if (search)  search.addEventListener('input', renderGrid);
  if (roleF)   roleF.addEventListener('change', e => { activeFilter = e.target.value; renderGrid(); });
  if (clearBtn) clearBtn.addEventListener('click', () => {
    comp = blankComp();
    ROLES.forEach(r => renderSlot(r));
    updateCompStats();
    syncCards();
  });
}

// ── LOAD HARDCODED TEAM DATA ──────────────────────────────────────────────────
// Priority: published cloud roster > local edits (localStorage) > team-data.js
function loadTeamData(cloudData = null) {
  if (typeof TEAM_DATA === 'undefined') return;
  teamRoster = Object.fromEntries(ROLES.map(r => [r, { players: [], active: 0 }]));
  TEAM_DATA.forEach(entry => {
    const slot = teamRoster[entry.role];
    if (!slot) { console.warn('Team data: unknown role:', entry.role); return; }
    const player = { name: entry.name, champions: [], mastery: {} };
    entry.rawChamps.forEach(raw => {
      const champ = findChamp(raw);
      if (champ && !player.champions.some(c => c.id === champ.id))
        player.champions.push(champ);
      else if (!champ)
        console.warn('Team data: could not resolve champion:', raw);
    });
    slot.players.push(player);
  });

  try {
    const overlay = cloudData
      || JSON.parse(localStorage.getItem(ROSTER_KEY) || 'null');
    applyRosterOverlay(overlay);
  } catch (e) { console.warn('Could not restore saved roster edits:', e); }

  syncTeamPlayersFromRoster();
}

function applyRosterOverlay(saved) {
  if (!saved) return;
  ROLES.forEach(role => {
    const s = saved[role];
    if (!s || !Array.isArray(s.players) || !s.players.length) return;
    teamRoster[role].players = s.players.map(p => {
      // Champs are stored as plain ids (legacy) or { id, m } with a mastery rating
      const champions = [];
      const mastery = {};
      (p.champs || []).forEach(entry => {
        const id = typeof entry === 'string' ? entry : entry?.id;
        const champ = findChamp(id);
        if (!champ || champions.some(c => c.id === champ.id)) return;
        champions.push(champ);
        if (entry && typeof entry === 'object' && entry.m) mastery[champ.id] = entry.m;
      });
      return { name: String(p.name || '—'), champions, mastery };
    });
    teamRoster[role].active = Math.min(s.active || 0, teamRoster[role].players.length - 1);
  });
}

// ── TEAM SUGGESTER UI ─────────────────────────────────────────────────────────
function renderTeamSuggesterUI() {
  const container = document.getElementById('player-cards');
  if (!container) return;
  container.innerHTML = '';

  const roleIcons = { top: '🗡', jungle: '🌲', mid: '🔮', bot: '🏹', support: '🛡' };

  teamPlayers.forEach((player, idx) => {
    const card = el('div', 'player-card');
    const role = teamRoster ? ROLES[idx] : null;

    // Roster mode: role label + one chip per player of this role.
    // Click = select · double-click = rename · × = remove · + = add player
    const headerLeft = role
      ? `<div class="player-role-head">
           <span class="player-role-label">${roleIcons[role]} ${role[0].toUpperCase()+role.slice(1)}</span>
           <div class="player-chips">
             ${teamRoster[role].players.map((p, k) => `
               <button class="player-chip ${k === teamRoster[role].active ? 'active' : ''}" data-role="${role}" data-k="${k}"
                       title="Click: select · Double-click: rename">${p.name}${
                 teamRoster[role].players.length > 1 ? '<span class="chip-x" title="Remove player">×</span>' : ''
               }</button>
             `).join('')}
             <button class="player-chip chip-add" data-role="${role}" title="Add player to this role">+</button>
           </div>
         </div>`
      : `<input class="player-name-input" type="text" placeholder="Player ${idx+1}" value="${player.name}" />`;

    card.innerHTML = `
      <div class="player-header">
        ${headerLeft}
        <span class="player-champ-count">${player.champions.length} champs</span>
      </div>
      <div class="player-pool" id="pool-${idx}"></div>
      <div class="player-add-area">
        <input class="champ-add-input" type="text" placeholder="Add champion (press Enter)…" />
        <button class="clear-player-btn" title="Clear pool">✕</button>
      </div>
    `;

    card.querySelectorAll('.player-chip').forEach(chip => {
      const chipRole = chip.dataset.role;
      const rerender = () => { saveRoster(); syncTeamPlayersFromRoster(); renderTeamSuggesterUI(); };

      if (chip.classList.contains('chip-add')) {
        chip.addEventListener('click', () => {
          const name = prompt('Name of the new player:');
          if (!name?.trim()) return;
          teamRoster[chipRole].players.push({ name: name.trim(), champions: [] });
          teamRoster[chipRole].active = teamRoster[chipRole].players.length - 1;
          rerender();
        });
        return;
      }

      const k = Number(chip.dataset.k);
      chip.addEventListener('click', e => {
        if (e.target.classList.contains('chip-x')) {
          const p = teamRoster[chipRole].players[k];
          if (!confirm(`Remove ${p.name} (${chipRole})? Their pool will be deleted.`)) return;
          const act = teamRoster[chipRole].active;
          teamRoster[chipRole].players.splice(k, 1);
          teamRoster[chipRole].active = act > k ? act - 1 : Math.min(act, teamRoster[chipRole].players.length - 1);
          rerender();
          return;
        }
        teamRoster[chipRole].active = k;
        rerender();
      });
      chip.addEventListener('dblclick', e => {
        if (e.target.classList.contains('chip-x')) return;
        const p = teamRoster[chipRole].players[k];
        const name = prompt('Rename player:', p.name);
        if (!name?.trim()) return;
        p.name = name.trim();
        rerender();
      });
    });
    card.querySelector('.player-name-input')?.addEventListener('change', e => {
      teamPlayers[idx].name = e.target.value;
    });
    attachChampAutocomplete(card.querySelector('.champ-add-input'), {
      onPick: champ => addChampToPlayer(idx, champ.id),
      getOwned: () => teamPlayers[idx].champions.map(c => c.id),
    });
    card.querySelector('.clear-player-btn').addEventListener('click', () => {
      teamPlayers[idx].champions = [];
      saveRoster();
      renderPlayerPool(idx);
    });

    container.appendChild(card);
    renderPlayerPool(idx);
  });
}

function renderPlayerPool(idx) {
  const pool = document.getElementById(`pool-${idx}`);
  if (!pool) return;
  pool.innerHTML = '';
  const player = teamPlayers[idx];

  // Update count badge
  const countEl = pool.closest('.player-card')?.querySelector('.player-champ-count');
  if (countEl) countEl.textContent = `${player.champions.length} champs`;

  player.mastery = player.mastery || {};
  const masteryTitles = { 1: 'learning', 2: 'solid', 3: 'main / comfort pick' };

  player.champions.forEach((champ, ci) => {
    const m = player.mastery[champ.id] || 3;
    const tag = el('div', 'pool-champ-tag');
    tag.style.borderColor = champ.color;
    tag.style.background  = champ.bg;
    tag.innerHTML = `
      <img src="${champ.img}" alt="${champ.name}" />
      <span class="pool-champ-name" style="color:${champ.color}">${champ.name}</span>
      <span class="mastery-pips" title="Mastery: ${masteryTitles[m]} — click to rate how well ${player.name} plays ${champ.name}">
        ${[1, 2, 3].map(n => `<span class="pip ${n <= m ? 'on' : ''}" data-m="${n}"></span>`).join('')}
      </span>
      <button class="remove-pool-champ" data-idx="${idx}" data-ci="${ci}">×</button>
    `;
    tag.querySelectorAll('.pip').forEach(pip => {
      pip.addEventListener('click', () => {
        player.mastery[champ.id] = Number(pip.dataset.m);
        saveRoster();
        renderPlayerPool(idx);
      });
    });
    tag.querySelector('.remove-pool-champ').addEventListener('click', () => {
      teamPlayers[idx].champions.splice(ci, 1);
      delete player.mastery[champ.id];
      saveRoster();
      renderPlayerPool(idx);
    });
    pool.appendChild(tag);
  });

  if (!player.champions.length) {
    pool.innerHTML = '<span class="pool-empty">No champions added yet</span>';
  }
}

function addChampToPlayer(idx, raw) {
  if (!raw.trim()) return;
  const champ = findChamp(raw);
  if (!champ) {
    showNotification(`"${raw}" not found`, 'error');
    return;
  }
  const player = teamPlayers[idx];
  player.mastery = player.mastery || {};
  if (player.champions.some(c => c.id === champ.id)) return;
  player.champions.push(champ);
  saveRoster();
  renderPlayerPool(idx);
}

// ── Champion autocomplete (simple substring search, prefix matches first) ──────
// opts: { onPick(champ), getOwned() -> [ids] }
function attachChampAutocomplete(input, opts) {
  const box = el('div', 'champ-suggest hidden');
  input.parentElement.appendChild(box);
  let items = [];   // current [{champ}] shown
  let active = -1;   // highlighted index

  const hide = () => { box.classList.add('hidden'); active = -1; };

  const pick = champ => {
    if (!champ) return;
    opts.onPick(champ);
    input.value = '';
    hide();
    input.focus();
  };

  const build = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { hide(); return; }
    const nq = norm(q);
    const owned = new Set(opts.getOwned ? opts.getOwned() : []);
    const rank = c => {
      const n = c.name.toLowerCase();
      if (n.startsWith(q)) return 0;
      if (n.split(/[\s']/).some(w => w.startsWith(q))) return 1;
      return 2;
    };
    items = allChamps
      .filter(c => !owned.has(c.id) &&
        (c.name.toLowerCase().includes(q) || norm(c.name).includes(nq) || c.id.toLowerCase().includes(q)))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, 8);

    if (!items.length) { hide(); return; }
    active = 0;
    box.innerHTML = items.map((c, i) => `
      <div class="champ-suggest-item ${i === 0 ? 'active' : ''}" data-i="${i}">
        <img src="${c.img}" alt="" />
        <span class="cs-name">${c.name}</span>
        <span class="cs-sub" style="color:${c.color}">${c.sub}</span>
      </div>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('.champ-suggest-item').forEach(row => {
      row.addEventListener('mousedown', e => { e.preventDefault(); pick(items[Number(row.dataset.i)]); });
    });
  };

  const highlight = () => box.querySelectorAll('.champ-suggest-item')
    .forEach((row, i) => row.classList.toggle('active', i === active));

  input.addEventListener('input', build);
  input.addEventListener('focus', () => { if (input.value.trim()) build(); });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', e => {
    if (box.classList.contains('hidden')) {
      if (e.key === 'Enter' && input.value.trim()) {
        const c = findChamp(input.value);
        if (c) { opts.onPick(c); input.value = ''; } else showNotification(`"${input.value}" not found`, 'error');
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[active]); }
    else if (e.key === 'Escape') { hide(); }
  });
}

// ── ROSTER ACTIONS (reset / export) ───────────────────────────────────────────
function setupRosterActions() {
  document.getElementById('reset-roster-btn')?.addEventListener('click', async () => {
    if (!confirm('Reload the shared team from the cloud? Any unsynced local changes in this browser will be discarded.')) return;
    localStorage.removeItem(ROSTER_KEY);
    loadTeamData(await loadCloudRoster());
    renderTeamSuggesterUI();
    showNotification('Reloaded shared team', 'success');
  });
  document.getElementById('export-team-btn')?.addEventListener('click', exportTeamData);
}

// Downloads the current roster as a ready-to-use team-data.js so edits can be
// published for everyone (replace the file in the repo and push).
function exportTeamData() {
  if (!teamRoster) { showNotification('No team roster loaded', 'error'); return; }
  let out = `'use strict';\n// ── Team champion pools ── exported from the app on ${new Date().toISOString().slice(0, 10)} ──\n`;
  out += '// Replace team-data.js in the repo with this file to publish for everyone.\n\nconst TEAM_DATA = [\n';
  ROLES.forEach(role => {
    teamRoster[role].players.forEach(p => {
      const champs = p.champions.map(c => `'${c.id}'`).join(', ');
      out += `  {\n    name: '${p.name.replace(/'/g, "\\'")}',\n    role: '${role}',\n    rawChamps: [${champs}],\n  },\n`;
    });
  });
  out += '];\n';
  const blob = new Blob([out], { type: 'text/javascript' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: 'team-data.js',
  });
  a.click();
  URL.revokeObjectURL(a.href);
  showNotification('team-data.js downloaded ✓', 'success');
}

// ── COMP PICKER ───────────────────────────────────────────────────────────────
function renderCompPicker() {
  const cont = document.getElementById('comp-picker');
  if (!cont) return;
  cont.innerHTML = '';

  COMP_TEMPLATES.forEach(tpl => {
    const card = el('div', 'comp-card');
    card.dataset.id = tpl.id;
    card.style.setProperty('--cc', tpl.color);
    card.innerHTML = `
      <div class="comp-card-header">
        <span class="comp-emoji">${tpl.emoji}</span>
        <span class="comp-name">${tpl.name}</span>
      </div>
      <div class="comp-desc">${tpl.description}</div>
      <div class="comp-strengths">
        ${tpl.strengths.map(s => `<span class="tag-green">✔ ${s}</span>`).join('')}
      </div>
      <div class="comp-role-req">
        ${Object.entries(tpl.roles).map(([role, archs]) =>
          `<div class="role-req-row"><span class="role-label">${role[0].toUpperCase()+role.slice(1)}</span>
           <span class="arch-list">${archs.slice(0,2).join(' / ')}</span></div>`
        ).join('')}
      </div>
    `;
    card.addEventListener('click', () => {
      selectedCompId = tpl.id;
      document.querySelectorAll('.comp-card').forEach(c => c.classList.toggle('selected', c.dataset.id === tpl.id));
    });
    cont.appendChild(card);
  });
}

// ── EXCEL UPLOAD ──────────────────────────────────────────────────────────────
function setupExcel() {
  const uploadBtn  = document.getElementById('upload-excel-btn');
  const fileInput  = document.getElementById('excel-file-input');
  const dlTemplate = document.getElementById('dl-template-btn');

  uploadBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', e => parseExcel(e.target.files[0]));
  dlTemplate?.addEventListener('click', downloadTemplate);

  // Drag & drop on upload zone
  const zone = document.getElementById('upload-zone');
  zone?.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone?.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone?.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) parseExcel(file);
  });
}

function parseExcel(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(e.target.result, { type: 'binary' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // Excel upload replaces the roster with a flexible 5-player team
      teamRoster = null;
      teamPlayers = Array.from({ length: 5 }, (_, i) => ({ name: `Player ${i+1}`, champions: [] }));

      // Skip header row if first cell looks like a header
      const start = /player|name/i.test(String(rows[0]?.[0])) ? 1 : 0;

      rows.slice(start).forEach((row, i) => {
        if (!row.length || !row[0]) return;
        const playerIdx = i;
        if (playerIdx >= 5) return;

        const playerName = String(row[0]).trim() || `Player ${playerIdx+1}`;
        teamPlayers[playerIdx].name = playerName;
        teamPlayers[playerIdx].champions = [];

        // Columns B+ are champion names; also support comma-separated in one column
        const champStrings = row.slice(1)
          .flatMap(cell => String(cell).split(/[,;/\n]+/))
          .map(s => s.trim())
          .filter(Boolean);

        champStrings.forEach(raw => {
          const champ = findChamp(raw);
          if (champ && !teamPlayers[playerIdx].champions.some(c => c.id === champ.id))
            teamPlayers[playerIdx].champions.push(champ);
        });
      });

      renderTeamSuggesterUI();
      showNotification('Excel loaded ✓', 'success');
    } catch (err) {
      console.error(err);
      showNotification('Failed to parse file', 'error');
    }
  };
  reader.readAsBinaryString(file);
}

function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['PlayerName', 'Champion1', 'Champion2', 'Champion3', 'Champion4', 'Champion5', '... (add more columns)'],
    ['Alice',  'Lux', 'Syndra', 'Orianna', 'Veigar', 'Zoe', 'Viktor'],
    ['Bob',    'Lee Sin', 'Vi', 'Amumu', 'Jarvan IV', 'Hecarim'],
    ['Charlie','Jinx', 'Caitlyn', 'Jhin', 'Miss Fortune', 'Vayne'],
    ['Diana',  'Thresh', 'Leona', 'Nautilus', 'Blitzcrank', 'Nami'],
    ['Eve',    'Darius', 'Garen', 'Malphite', 'Camille', 'Fiora'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Team');
  XLSX.writeFile(wb, 'team_template.xlsx');
}

// ── COMP SUGGESTION ALGORITHM ─────────────────────────────────────────────────
function generateSuggestions() {
  if (!selectedCompId) { showNotification('Select a comp type first', 'error'); return; }
  const template = COMP_TEMPLATES.find(t => t.id === selectedCompId);
  if (!template) return;

  const roles = ['top', 'jungle', 'mid', 'bot', 'support'];

  // Roster mode (team-data.js): roles are fixed, player i plays role i.
  if (teamRoster) {
    const assignment = {};
    let totalScore = 0;
    roles.forEach((role, i) => {
      const player = teamPlayers[i];
      const { champ, score } = bestForRole(player, template, role);
      totalScore += score;
      assignment[role] = { player: player.name, champ, score };
    });
    renderSuggestions([{ assignment, totalScore }], template);
    return;
  }

  // Flexible: try all 5! = 120 player→role permutations
  const grid = teamPlayers.map(player =>
    roles.map(role => bestForRole(player, template, role))
  );
  const perms = permutations(teamPlayers.map((_, i) => i));
  let results = [];

  for (const perm of perms) {
    let totalScore = 0;
    const assignment = {};
    roles.forEach((role, ri) => {
      const pi = perm[ri];
      const { champ, score } = grid[pi][ri];
      totalScore += score;
      assignment[role] = { player: teamPlayers[pi].name, champ, score };
    });
    results.push({ assignment, totalScore, perm: [...perm] });
  }

  results.sort((a, b) => b.totalScore - a.totalScore);
  const seen = new Set();
  results = results.filter(r => {
    const key = r.perm.join(',');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  renderSuggestions(results.slice(0, 3), template);
}

// Max points a single slot can contribute (used for % match display)
const SLOT_MAX = 15;
// How much a player's mastery of a champion scales its comp-fit score.
// Default (unrated) is 3 = full score, so ratings only ever pull a pick DOWN.
const MASTERY_FACTOR = { 1: 0.55, 2: 0.8, 3: 1 };

function bestForRole(player, template, role) {
  return scoredForRole(player, template, role)[0] || { champ: null, score: 0 };
}

// Returns [{ champ, score }] from a player's pool sorted by comp fit.
// Score = subclass fit (how well the class matches the slot's archetype list)
// + trait fit (does the champion actually execute this comp's game plan —
// see CHAMP_TRAITS / TEMPLATE_TRAITS in data.js). A champ qualifies via either
// route, so e.g. Nidalee (Assassin subclass) still counts as poke jungle.
function scoredForRole(player, template, role) {
  const archetypes = template.roles[role];
  const tcfg = typeof TEMPLATE_TRAITS !== 'undefined' ? TEMPLATE_TRAITS[template.id] : null;
  return player.champions
    .map(champ => {
      const idx = archetypes.indexOf(champ.sub);
      let score = idx === -1 ? 0 : [8, 6, 3, 1, 1][idx];
      const traits = (typeof CHAMP_TRAITS !== 'undefined' && CHAMP_TRAITS[champ.id]) || [];
      if (tcfg && traits.length) {
        const core = tcfg.core.filter(t => traits.includes(t)).length;
        const good = tcfg.good.filter(t => traits.includes(t)).length;
        const bad  = tcfg.bad.filter(t => traits.includes(t)).length;
        score += core * 7 + good * 2 - bad * 5;
      }
      score = Math.min(SLOT_MAX, Math.max(0, score));
      const m = (player.mastery && player.mastery[champ.id]) || 3;
      score = Math.round(score * MASTERY_FACTOR[m]);
      return score > 0 ? { champ, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// Returns the top N champions from a player's pool sorted by comp fit
function topNForRole(player, template, role, n) {
  return scoredForRole(player, template, role).slice(0, n).map(s => s.champ);
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  arr.forEach((val, i) => {
    const rest = arr.filter((_, j) => j !== i);
    permutations(rest).forEach(perm => result.push([val, ...perm]));
  });
  return result;
}

function renderSuggestions(results, template) {
  const cont = document.getElementById('suggestions-output');
  if (!cont) return;
  cont.innerHTML = '';

  if (!results.length || results[0].totalScore === 0) {
    cont.innerHTML = '<div class="no-suggestions">No viable suggestions — add more champions to player pools.</div>';
    return;
  }

  const roles = ['top', 'jungle', 'mid', 'bot', 'support'];
  const roleIcons = { top: '🗡', jungle: '🌲', mid: '🔮', bot: '🏹', support: '🛡' };

  results.forEach((res, ri) => {
    const card = el('div', `suggestion-card ${ri === 0 ? 'suggestion-best' : ''}`);
    card.style.setProperty('--tpl-color', template.color);

    const maxScore = roles.length * SLOT_MAX;
    const pct = Math.round((res.totalScore / maxScore) * 100);
    const grade = pct >= 75 ? 'S' : pct >= 55 ? 'A' : pct >= 35 ? 'B' : 'C';

    card.innerHTML = `
      <div class="sug-header">
        <span class="sug-rank">${ri === 0 ? '★ BEST' : `Option ${ri+1}`}</span>
        <span class="sug-grade grade-${grade}">${grade}</span>
        <span class="sug-score">${pct}% match</span>
        <button class="load-to-builder-btn" data-ri="${ri}">Load to Builder →</button>
      </div>
      <div class="sug-slots">
        ${roles.map(role => {
          const { player, champ, score } = res.assignment[role];
          const tier = score >= 12 ? 'tier-ideal' : score >= 8 ? 'tier-good' : score >= 4 ? 'tier-ok' : 'tier-off';
          return `
            <div class="sug-slot ${tier}">
              <div class="sug-role-label">${roleIcons[role]} ${role[0].toUpperCase()+role.slice(1)}</div>
              <div class="sug-champ-block">
                ${champ
                  ? `<img src="${champ.img}" alt="${champ.name}" /><div class="sug-champ-info">
                       <span class="sug-champ-name">${champ.name}</span>
                       <span class="sug-champ-sub" style="color:${champ.color}">${champ.sub}</span>
                     </div>`
                  : `<div class="sug-no-champ">No ${template.roles[role][0]}</div>`
                }
              </div>
              <div class="sug-player-name">${player}</div>
            </div>`;
        }).join('')}
      </div>
    `;

    card.querySelector('.load-to-builder-btn').addEventListener('click', () => {
      comp = blankComp();
      roles.forEach(role => {
        const { champ } = res.assignment[role];
        if (champ) comp[role].main = champ;
        // Fill backups with next-best 3 champs from same player's pool
        const pi = res.perm ? res.perm[roles.indexOf(role)] : roles.indexOf(role);
        const player = teamPlayers[pi];
        if (player) {
          const backups = topNForRole(player, template, role, 6)
            .filter(c => c.id !== champ?.id)
            .slice(0, 3);
          backups.forEach((bc, bi) => { comp[role].backups[bi] = bc; });
        }
      });
      roles.forEach(r => renderSlot(r));
      updateCompStats();
      document.querySelector('.tab-btn[data-tab="tab-builder"]')?.click();
      syncCards();
    });

    addSaveToSuggestion(card, res, template);
    cont.appendChild(card);
  });
}

// ── TOOLTIP ───────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');

function showTooltip(e, champ) {
  const cfg = CLASS_CONFIG[champ.sub] || {};
  tooltip.innerHTML = `
    <div class="tt-name">${champ.name}</div>
    <div class="tt-title">${champ.title}</div>
    <div class="tt-sub" style="color:${cfg.color}">${champ.sub}</div>
    <div class="tt-tags">${champ.tags.join(' · ')}</div>
  `;
  tooltip.classList.remove('hidden');
  moveTooltip(e);
}
function moveTooltip(e) {
  const pad = 14, tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + tw > window.innerWidth)  x = e.clientX - tw - pad;
  if (y + th > window.innerHeight) y = e.clientY - th - pad;
  tooltip.style.cssText += `;left:${x}px;top:${y}px`;
}
function hideTooltip() { tooltip.classList.add('hidden'); }

// ── SAVED COMPS ──────────────────────────────────────────────────────────────

async function persistSaved() {
  updateSavedBadge();
  if (!syncEnabled() || !isLoggedIn()) return;
  setSyncStatus('saving');
  try { await rpc('save_comps', { new_data: savedComps, token: auth.token }); setSyncStatus('saved'); }
  catch (e) { console.error('comps save failed', e); setSyncStatus('error'); showNotification('Could not sync comps', 'error'); }
}

function updateSavedBadge() {
  const badge = document.getElementById('saved-count-badge');
  const total = document.getElementById('saved-total');
  if (!badge) return;
  if (savedComps.length > 0) {
    badge.textContent = savedComps.length;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
  if (total) total.textContent = `${savedComps.length} comp${savedComps.length !== 1 ? 's' : ''}`;
}

let saveWithPlayers = false;   // set by the "Save for team" flow

function openSaveModal(includePlayers) {
  const modal     = document.getElementById('save-modal');
  const nameInput = document.getElementById('save-name-input');
  const filled = ROLES.map(r => comp[r].main).filter(Boolean);
  if (!filled.length) { showNotification('Add at least one champion first', 'error'); return; }
  saveWithPlayers = !!includePlayers;
  renderModalPreview();
  const subCounts = {};
  filled.forEach(c => { subCounts[c.sub] = (subCounts[c.sub] || 0) + 1; });
  const dominant = Object.entries(subCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Comp';
  nameInput.value = `${dominant} Comp`;
  nameInput.select();
  modal.classList.remove('hidden');
  setTimeout(() => nameInput.focus(), 50);
}

function setupSaveModal() {
  const saveBtn    = document.getElementById('save-comp-btn');
  const modal      = document.getElementById('save-modal');
  const cancelBtn  = document.getElementById('modal-cancel');
  const confirmBtn = document.getElementById('modal-confirm');
  const nameInput  = document.getElementById('save-name-input');

  saveBtn?.addEventListener('click', () => openSaveModal(builderMode === 'team'));

  cancelBtn?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });

  confirmBtn?.addEventListener('click', () => {
    const name  = document.getElementById('save-name-input').value.trim() || 'My Comp';
    const notes = document.getElementById('save-notes-input').value.trim();
    const slots = {};
    ROLES.forEach(role => {
      const slim = c => c ? { id: c.id, name: c.name, img: c.img, sub: c.sub, color: c.color } : null;
      slots[role] = {
        main:    slim(comp[role].main),
        backups: comp[role].backups.map(slim),
      };
    });
    const entry = { id: Date.now(), name, notes, slots, date: new Date().toLocaleDateString() };
    if (saveWithPlayers) entry.players = { ...teamCompPlayers };
    savedComps.unshift(entry);
    persistSaved();
    renderSavedComps();
    modal.classList.add('hidden');
    document.getElementById('save-notes-input').value = '';
    showNotification(`"${name}" saved for the team ✓`, 'success');
  });

  nameInput?.addEventListener('keydown', e => { if (e.key === 'Enter') confirmBtn?.click(); });

  // Saved tab search
  document.getElementById('saved-search')?.addEventListener('input', renderSavedComps);
  document.getElementById('clear-all-saved')?.addEventListener('click', () => {
    if (!savedComps.length) return;
    if (!confirm(`Delete all ${savedComps.length} saved comp(s)?`)) return;
    savedComps = [];
    persistSaved();
    renderSavedComps();
  });
}

function renderModalPreview() {
  const preview = document.getElementById('modal-preview');
  if (!preview) return;
  preview.innerHTML = ROLES.map(role => {
    const c = comp[role].main;
    return c
      ? `<div class="modal-champ" style="border-color:${c.color}">
           <img src="${c.img}" alt="${c.name}" />
           <span>${c.name}</span>
         </div>`
      : `<div class="modal-champ empty"><span>${role[0].toUpperCase()+role.slice(1)}</span></div>`;
  }).join('');
}

function renderSavedComps() {
  updateSavedBadge();
  const grid  = document.getElementById('saved-comps-grid');
  if (!grid) return;

  const query = (document.getElementById('saved-search')?.value || '').toLowerCase().trim();
  const list  = query
    ? savedComps.filter(s => s.name.toLowerCase().includes(query) || s.notes?.toLowerCase().includes(query))
    : savedComps;

  if (!list.length) {
    grid.innerHTML = `
      <div class="saved-empty">
        <div class="saved-empty-icon">📋</div>
        <div>${query ? 'No comps match your search.' : 'No saved comps yet.'}</div>
        ${!query ? '<div class="saved-empty-sub">Build a comp and hit <strong>Save Comp</strong> to save it here.</div>' : ''}
      </div>`;
    return;
  }

  const roles = ['top','jungle','mid','bot','support'];
  const roleIcons = { top:'🗡', jungle:'🌲', mid:'🔮', bot:'🏹', support:'🛡' };

  grid.innerHTML = '';
  list.forEach(saved => {
    const card = el('div', 'saved-card');

    // Support old (flat) and new (main+backups) slot format
    const getMain    = s => s?.main ?? s;
    const getBackups = s => s?.backups ?? [];

    // Compute subclass tags from main picks
    const subs = {};
    roles.forEach(r => {
      const m = getMain(saved.slots[r]);
      if (m?.sub) subs[m.sub] = (subs[m.sub]||0)+1;
    });
    const subTags = Object.entries(subs)
      .map(([sub, n]) => {
        const cfg = CLASS_CONFIG[sub] || { color:'#888', bg:'#111' };
        return `<span class="sc-sub-tag" style="color:${cfg.color};background:${cfg.bg};border-color:${cfg.color}">${n > 1 ? n+'× ' : ''}${sub}</span>`;
      }).join('');

    card.innerHTML = `
      <div class="sc-header">
        <div class="sc-name-wrap">
          <span class="sc-name" contenteditable="true" spellcheck="false">${saved.name}</span>
          <span class="sc-date">${saved.date}</span>
        </div>
        <div class="sc-header-actions">
          <button class="sc-load-btn" title="Load into builder">Load →</button>
          <button class="sc-del-btn"  title="Delete">🗑</button>
        </div>
      </div>
      <div class="sc-champions">
        ${roles.map(role => {
          const m = getMain(saved.slots[role]);
          const backups = getBackups(saved.slots[role]).filter(Boolean);
          return `<div class="sc-champ-slot">
            <span class="sc-role-icon">${roleIcons[role]}</span>
            ${m
              ? `<img class="sc-main-img" src="${m.img}" alt="${m.name}" style="border-color:${m.color}" title="${m.name}" />`
              : `<div class="sc-empty-slot">—</div>`
            }
            ${backups.length ? `<div class="sc-backups-mini">
              ${backups.map(b => `<img src="${b.img}" alt="${b.name}" style="border-color:${b.color}" title="Backup: ${b.name}" />`).join('')}
            </div>` : ''}
            <span class="sc-champ-name">${m?.name ?? '—'}</span>
            ${saved.players?.[role] ? `<span class="sc-player">${saved.players[role]}</span>` : ''}
          </div>`;
        }).join('')}
      </div>
      ${subTags ? `<div class="sc-sub-tags">${subTags}</div>` : ''}
      ${saved.notes ? `<div class="sc-notes">${saved.notes}</div>` : ''}
    `;

    // Inline rename
    card.querySelector('.sc-name').addEventListener('blur', e => {
      const idx = savedComps.findIndex(s => s.id === saved.id);
      if (idx !== -1) { savedComps[idx].name = e.target.textContent.trim() || saved.name; persistSaved(); }
    });
    card.querySelector('.sc-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });

    // Load (restore main + backups)
    card.querySelector('.sc-load-btn').addEventListener('click', () => {
      comp = blankComp();
      roles.forEach(role => {
        const s = saved.slots[role];
        if (!s) return;
        // Support both old format (flat) and new format (with backups)
        const mainData = s.main ?? s;
        if (mainData?.id) {
          comp[role].main = allChamps.find(c => c.id === mainData.id) || mainData;
        }
        if (s.backups) {
          s.backups.forEach((b, bi) => {
            if (b?.id) comp[role].backups[bi] = allChamps.find(c => c.id === b.id) || b;
          });
        }
      });
      roles.forEach(r => renderSlot(r));
      updateCompStats();
      syncCards();
      document.querySelector('.tab-btn[data-tab="tab-builder"]')?.click();
      showNotification(`"${saved.name}" loaded ✓`, 'success');
    });

    // Delete
    card.querySelector('.sc-del-btn').addEventListener('click', () => {
      savedComps = savedComps.filter(s => s.id !== saved.id);
      persistSaved();
      renderSavedComps();
    });

    grid.appendChild(card);
  });
}

// Also allow saving directly from a suggestion card
function addSaveToSuggestion(card, res, template) {
  const btn = el('button', 'sug-save-btn', '💾 Save');
  btn.title = 'Save this comp';
  btn.addEventListener('click', () => {
    const roles = ['top','jungle','mid','bot','support'];
    const slots = {};
    const slim = c => c ? { id: c.id, name: c.name, img: c.img, sub: c.sub, color: c.color } : null;
    roles.forEach((role, ri) => {
      const main = res.assignment[role]?.champ;
      // Populate backups from player's pool
      const pi   = res.perm ? res.perm[ri] : ri;
      const player = teamPlayers[pi];
      const backupChamps = player
        ? topNForRole(player, template, role, 4).filter(c => c.id !== main?.id).slice(0, 5)
        : [];
      slots[role] = {
        main:    slim(main),
        backups: [0,1,2,3,4].map(i => slim(backupChamps[i])),
      };
    });
    const name = `${template.name} – ${new Date().toLocaleDateString()}`;
    savedComps.unshift({ id: Date.now(), name, notes: template.winCondition, slots, date: new Date().toLocaleDateString() });
    persistSaved();
    renderSavedComps();
    showNotification(`"${name}" saved ✓`, 'success');
  });
  card.querySelector('.sug-header')?.appendChild(btn);
}

// ── COACHING PROFILES (coach-only) ────────────────────────────────────────────
let coachingData = {};
let coachingSaveTimer = null;

async function loadCoaching() {
  try { coachingData = (await rpc('get_coaching', { token: auth.token })) || {}; }
  catch (e) { console.warn('coaching load failed', e); coachingData = {}; }
}
function saveCoaching() {
  if (!isCoach()) return;
  setSyncStatus('saving');
  clearTimeout(coachingSaveTimer);
  coachingSaveTimer = setTimeout(async () => {
    try { await rpc('save_coaching', { new_data: coachingData, token: auth.token }); setSyncStatus('saved'); }
    catch (e) { console.error('coaching save failed', e); setSyncStatus('error'); }
  }, 700);
}

const ROLE_ICONS = { top: '🗡', jungle: '🌲', mid: '🔮', bot: '🏹', support: '🛡' };

function renderCoaching() {
  const cont = document.getElementById('coaching-cards');
  if (!cont || !teamRoster) return;
  cont.innerHTML = '';

  ROLES.forEach(role => {
    teamRoster[role].players.forEach(p => {
      const key  = `${role}|${p.name}`;
      const prof = coachingData[key] || (coachingData[key] = { notes: '', ratings: {} });
      const card = el('div', 'coach-card');
      card.innerHTML = `
        <div class="coach-card-head">
          <span class="coach-role">${ROLE_ICONS[role]} ${role[0].toUpperCase()+role.slice(1)}</span>
          <span class="coach-name">${p.name}</span>
        </div>
        <textarea class="coach-notes" placeholder="Coaching notes for ${p.name} — focus areas, matchups, goals…"></textarea>
        <div class="coach-ratings-label">Champion ratings <span>(1–10)</span></div>
        <div class="coach-ratings"></div>
        <div class="coach-add-area"><input class="champ-add-input coach-add-input" type="text" placeholder="Add champion to rate…" /></div>
      `;
      const ta = card.querySelector('.coach-notes');
      ta.value = prof.notes || '';
      ta.addEventListener('input', () => { prof.notes = ta.value; saveCoaching(); });

      const rlist = card.querySelector('.coach-ratings');
      const renderRatings = () => {
        rlist.innerHTML = '';
        const ids = Object.keys(prof.ratings);
        if (!ids.length) { rlist.innerHTML = '<span class="pool-empty">No champions rated yet</span>'; return; }
        ids.forEach(id => {
          const champ = findChamp(id); if (!champ) return;
          const row = el('div', 'coach-rating-row');
          row.innerHTML = `
            <img src="${champ.img}" alt="" />
            <span class="cr-name" style="color:${champ.color}">${champ.name}</span>
            <select class="cr-score">${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${n === prof.ratings[id] ? 'selected' : ''}>${n}</option>`).join('')}</select>
            <button class="cr-del" title="Remove">×</button>
          `;
          row.querySelector('.cr-score').addEventListener('change', e => { prof.ratings[id] = Number(e.target.value); saveCoaching(); });
          row.querySelector('.cr-del').addEventListener('click', () => { delete prof.ratings[id]; saveCoaching(); renderRatings(); });
          rlist.appendChild(row);
        });
      };
      renderRatings();

      attachChampAutocomplete(card.querySelector('.coach-add-input'), {
        onPick: champ => { if (!prof.ratings[champ.id]) prof.ratings[champ.id] = 5; saveCoaching(); renderRatings(); },
        getOwned: () => Object.keys(prof.ratings),
      });
      cont.appendChild(card);
    });
  });
}

// ── MANUAL BUILDER MODES (solo / team comp) ───────────────────────────────────
let builderMode = 'solo';
let teamCompPlayers = {};   // role → chosen player name (team-comp mode)

function setupBuilderModes() {
  document.querySelectorAll('.builder-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setBuilderMode(btn.dataset.mode));
  });
}
function setBuilderMode(mode) {
  builderMode = mode;
  document.querySelectorAll('.builder-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const bar = document.getElementById('team-comp-bar');
  if (bar) bar.style.display = mode === 'team' ? '' : 'none';
  if (mode === 'team') renderTeamCompBar();
}
function renderTeamCompBar() {
  const bar = document.getElementById('team-comp-bar');
  if (!bar || !teamRoster) return;
  bar.innerHTML = `<span class="tcb-label">Who plays this comp?</span>` + ROLES.map(role => {
    const players = teamRoster[role].players;
    if (!teamCompPlayers[role] || !players.some(p => p.name === teamCompPlayers[role]))
      teamCompPlayers[role] = players[teamRoster[role].active]?.name || players[0]?.name || '';
    return `<label class="tcb-role">${ROLE_ICONS[role]}
      <select data-role="${role}">${players.map(p => `<option ${p.name === teamCompPlayers[role] ? 'selected' : ''}>${p.name}</option>`).join('')}</select>
    </label>`;
  }).join('') + `<button id="save-team-comp-btn" class="save-btn">💾 Save for team</button>`;
  bar.querySelectorAll('select').forEach(sel =>
    sel.addEventListener('change', () => { teamCompPlayers[sel.dataset.role] = sel.value; }));
  bar.querySelector('#save-team-comp-btn').addEventListener('click', () => openSaveModal(true));
}

// ── COACHING CALENDAR (Schedule tab) ──────────────────────────────────────────
// Every coach has their own week calendar. Players click a free slot to request
// a session; the coach confirms/declines and can block slots on their own
// calendar. Data lives in Supabase (see supabase-calendar.sql).
const CAL_START_HOUR = 12;   // first bookable hour of the day
const CAL_END_HOUR   = 23;   // grid ends here (last slot starts one hour before)

let calCoaches    = [];      // coach usernames
let calBookings   = [];      // bookings for all coaches
let calCoach      = null;    // currently shown coach calendar
let calWeekOffset = 0;       // weeks relative to the current one
let bookingDraft  = null;    // { coach, start: Date } while the modal is open

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function loadCalendarData() {
  const [coaches, bookings] = await Promise.all([
    rpc('get_coaches',  { token: auth.token }),
    rpc('get_bookings', { token: auth.token }),
  ]);
  calCoaches  = coaches  || [];
  calBookings = bookings || [];
  if (!calCoach || !calCoaches.includes(calCoach))
    calCoach = (isCoach() && calCoaches.includes(auth.username)) ? auth.username : (calCoaches[0] || null);
}

async function refreshCalendar() {
  try { await loadCalendarData(); }
  catch (e) {
    console.warn('calendar unavailable:', e);
    const grid = document.getElementById('cal-grid');
    if (grid) grid.innerHTML =
      '<div class="no-suggestions">Calendar is not set up yet — a coach needs to run <strong>supabase-calendar.sql</strong> in the Supabase SQL editor once.</div>';
    return;
  }
  renderCalendar();
}

// Monday 00:00 of the shown week
function calWeekStart() {
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + calWeekOffset * 7);
  return monday;
}

function viewingOwnCalendar() { return isCoach() && calCoach === auth.username; }

function renderCalendar() {
  renderCalCoaches();
  renderCalGrid();
  renderCalRequests();
}

function renderCalCoaches() {
  const cont = document.getElementById('cal-coaches');
  if (!cont) return;
  cont.innerHTML = calCoaches.map(c => `
    <button class="player-chip cal-coach-chip ${c === calCoach ? 'active' : ''}" data-coach="${esc(c)}">
      ★ ${esc(c)}${c === auth.username ? ' (you)' : ''}
    </button>`).join('') || '<span class="pool-empty">No coach accounts yet</span>';
  cont.querySelectorAll('.cal-coach-chip').forEach(chip =>
    chip.addEventListener('click', () => { calCoach = chip.dataset.coach; renderCalendar(); }));

  const hint = document.getElementById('cal-hint');
  if (hint) hint.textContent = !calCoach ? ''
    : viewingOwnCalendar()
      ? 'Your calendar — click an empty slot to block it, use ✓ / ✕ on a request to confirm or decline.'
      : `Click an empty slot to request a coaching session with ${calCoach}.`;
}

function renderCalGrid() {
  const grid = document.getElementById('cal-grid');
  if (!grid) return;
  const start = calWeekStart();
  const days  = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i); return d;
  });

  const fmtD  = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const label = document.getElementById('cal-week-label');
  if (label) label.textContent = `${fmtD(days[0])} – ${fmtD(days[6])} ${days[6].getFullYear()}`;

  // Which grid cell is covered by which booking ("dayIndex|hour" → {b, isStart})
  const cells = {};
  calBookings
    .filter(b => b.coach === calCoach && b.status !== 'declined')
    .forEach(b => {
      const s = new Date(b.starts_at);
      const span = Math.max(1, Math.ceil(b.minutes / 60));
      for (let h = 0; h < span; h++) {
        const t  = new Date(s.getTime() + h * 3600e3);
        const di = days.findIndex(d => d.toDateString() === t.toDateString());
        if (di !== -1) cells[`${di}|${t.getHours()}`] = { b, isStart: h === 0 };
      }
    });

  const now   = new Date();
  const fmtT  = d => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  let html = `<div class="cal-cell cal-corner"></div>` + days.map(d => `
    <div class="cal-cell cal-day-head ${d.toDateString() === now.toDateString() ? 'cal-today-col' : ''}">
      ${d.toLocaleDateString(undefined, { weekday: 'short' })} <span>${d.getDate()}</span>
    </div>`).join('');

  for (let hour = CAL_START_HOUR; hour < CAL_END_HOUR; hour++) {
    html += `<div class="cal-cell cal-hour">${String(hour).padStart(2, '0')}:00</div>`;
    days.forEach((d, di) => {
      const cell = cells[`${di}|${hour}`];
      const slotStart = new Date(d); slotStart.setHours(hour, 0, 0, 0);
      if (!cell) {
        const past = slotStart < now;
        html += `<div class="cal-cell cal-slot ${past ? 'cal-past' : 'cal-free'}" data-di="${di}" data-hour="${hour}"></div>`;
      } else if (!cell.isStart) {
        html += `<div class="cal-cell cal-slot cal-cont cal-${cell.b.status}"></div>`;
      } else {
        const b    = cell.b;
        const mine = b.player === auth.username && b.status !== 'blocked';
        const own  = viewingOwnCalendar();
        const end  = new Date(new Date(b.starts_at).getTime() + b.minutes * 60000);
        html += `<div class="cal-cell cal-slot cal-entry cal-${b.status}" data-id="${b.id}" title="${esc(b.topic)}">
          <span class="cal-entry-time">${fmtT(new Date(b.starts_at))}–${fmtT(end)}</span>
          <span class="cal-entry-name">${b.status === 'blocked' ? '⛔ blocked' : esc(b.player)}</span>
          ${b.topic && b.status !== 'blocked' ? `<span class="cal-entry-topic">${esc(b.topic)}</span>` : ''}
          <span class="cal-entry-actions">
            ${own && b.status === 'requested'
              ? `<button class="cal-act cal-ok" data-act="confirm" title="Confirm">✓</button>
                 <button class="cal-act cal-no" data-act="decline" title="Decline">✕</button>` : ''}
            ${own || mine
              ? `<button class="cal-act" data-act="delete" title="${mine && !own ? 'Cancel my request' : 'Remove'}">×</button>` : ''}
          </span>
        </div>`;
      }
    });
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.cal-free').forEach(cellEl =>
    cellEl.addEventListener('click', () => {
      const d = new Date(days[Number(cellEl.dataset.di)]);
      d.setHours(Number(cellEl.dataset.hour), 0, 0, 0);
      onFreeSlotClick(d);
    }));
  grid.querySelectorAll('.cal-act').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      onBookingAction(btn.closest('.cal-entry').dataset.id, btn.dataset.act);
    }));
}

function renderCalRequests() {
  const title = document.getElementById('cal-requests-title');
  const list  = document.getElementById('cal-requests-list');
  if (!title || !list) return;
  const now = Date.now();
  const fmt = b => {
    const d = new Date(b.starts_at);
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
  const bySoonest = (a, b) => new Date(a.starts_at) - new Date(b.starts_at);

  if (isCoach()) {
    title.textContent = 'Open requests for you';
    const rows = calBookings
      .filter(b => b.coach === auth.username && b.status === 'requested' && new Date(b.starts_at).getTime() > now)
      .sort(bySoonest);
    list.innerHTML = rows.length ? rows.map(b => `
      <div class="cal-req-row">
        <span class="cal-req-when">${fmt(b)}</span>
        <span class="cal-req-who">${esc(b.player)}</span>
        <span class="cal-req-topic">${esc(b.topic)}</span>
        <span class="cal-req-actions">
          <button class="cal-act cal-ok" data-id="${b.id}" data-act="confirm">✓ Confirm</button>
          <button class="cal-act cal-no" data-id="${b.id}" data-act="decline">✕ Decline</button>
        </span>
      </div>`).join('') : '<div class="pool-empty">No open requests.</div>';
  } else {
    title.textContent = 'My requests';
    const rows = calBookings
      .filter(b => b.player === auth.username && new Date(b.starts_at).getTime() > now)
      .sort(bySoonest);
    list.innerHTML = rows.length ? rows.map(b => `
      <div class="cal-req-row">
        <span class="cal-req-when">${fmt(b)}</span>
        <span class="cal-req-who">★ ${esc(b.coach)}</span>
        <span class="cal-req-topic">${esc(b.topic)}</span>
        <span class="cal-status cal-status-${b.status}">${b.status}</span>
        <span class="cal-req-actions"><button class="cal-act" data-id="${b.id}" data-act="delete">× Cancel</button></span>
      </div>`).join('') : '<div class="pool-empty">No requests yet — click a free slot in the calendar above.</div>';
  }
  list.querySelectorAll('.cal-act').forEach(btn =>
    btn.addEventListener('click', () => onBookingAction(btn.dataset.id, btn.dataset.act)));
}

function onFreeSlotClick(startDate) {
  if (!calCoach) return;
  if (viewingOwnCalendar()) {
    const note = prompt('Block this slot (players cannot book it). Optional note:', '');
    if (note === null) return;
    calAction('block_slot',
      { starts_at: startDate.toISOString(), minutes: 60, note: note.trim() }, 'Slot blocked');
    return;
  }
  bookingDraft = { coach: calCoach, start: startDate };
  document.getElementById('booking-when').textContent =
    `★ ${calCoach} · ` +
    startDate.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) +
    ' · ' + startDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  document.getElementById('booking-topic').value = '';
  document.getElementById('booking-minutes').value = '60';
  document.getElementById('booking-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('booking-topic')?.focus(), 50);
}

function onBookingAction(id, act) {
  const b = calBookings.find(x => x.id === id);
  if (act === 'delete') {
    const msg = b?.status === 'blocked' ? 'Unblock this slot?'
      : (b?.player === auth.username && b?.coach !== auth.username) ? 'Cancel this coaching request?'
      : 'Remove this entry?';
    if (!confirm(msg)) return;
    calAction('delete_booking', { booking: id }, 'Removed');
  } else {
    calAction('set_booking_status',
      { booking: id, new_status: act === 'confirm' ? 'confirmed' : 'declined' },
      act === 'confirm' ? 'Session confirmed ✓' : 'Request declined');
  }
}

async function calAction(fn, body, okMsg) {
  try {
    await rpc(fn, { ...body, token: auth.token });
    if (okMsg) showNotification(okMsg, 'success');
    await loadCalendarData();
    renderCalendar();
  } catch (e) {
    showNotification(e.message || 'Action failed', 'error');
  }
}

function setupCalendar() {
  document.getElementById('cal-prev')?.addEventListener('click',  () => { calWeekOffset--;   renderCalGrid(); });
  document.getElementById('cal-next')?.addEventListener('click',  () => { calWeekOffset++;   renderCalGrid(); });
  document.getElementById('cal-today')?.addEventListener('click', () => { calWeekOffset = 0; renderCalGrid(); });

  const modal = document.getElementById('booking-modal');
  const close = () => { modal?.classList.add('hidden'); bookingDraft = null; };
  document.getElementById('booking-cancel')?.addEventListener('click', close);
  modal?.addEventListener('click', e => { if (e.target === modal) close(); });

  document.getElementById('booking-confirm')?.addEventListener('click', async () => {
    if (!bookingDraft) return;
    const btn = document.getElementById('booking-confirm');
    btn.disabled = true;
    try {
      await rpc('request_booking', {
        token:     auth.token,
        coach:     bookingDraft.coach,
        starts_at: bookingDraft.start.toISOString(),
        minutes:   Number(document.getElementById('booking-minutes').value),
        topic:     document.getElementById('booking-topic').value.trim(),
      });
      close();
      showNotification('Coaching request sent ✓', 'success');
      await loadCalendarData();
      renderCalendar();
    } catch (e) {
      showNotification(e.message || 'Request failed', 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
function showNotification(msg, type = 'info') {
  const n = el('div', `notif notif-${type}`, msg);
  document.body.appendChild(n);
  setTimeout(() => n.classList.add('notif-show'), 10);
  setTimeout(() => { n.classList.remove('notif-show'); setTimeout(() => n.remove(), 300); }, 2800);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function el(tag, cls, html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  init().then(() => setupExcel());
});

// Wire up generate button (may be called before DOMContentLoaded resolves init)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('generate-btn')?.addEventListener('click', generateSuggestions);
  setupRosterActions();
});
