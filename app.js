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

// Saved comps state
const STORAGE_KEY = 'lol_saved_comps';
let savedComps = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  setupTabs();
  setupControls();
  setupPointerDrag();
  setupSaveModal();
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
    loadTeamData();         // pre-load from team-data.js
    renderTeamSuggesterUI();
    renderCompPicker();
  } catch (e) {
    console.error(e);
    document.getElementById('champion-grid').innerHTML =
      `<div class="loading" style="color:#e74c3c">Failed to load champions — check your internet connection.</div>`;
  }
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
function loadTeamData() {
  if (typeof TEAM_DATA === 'undefined') return;
  teamRoster = Object.fromEntries(ROLES.map(r => [r, { players: [], active: 0 }]));
  TEAM_DATA.forEach(entry => {
    const slot = teamRoster[entry.role];
    if (!slot) { console.warn('Team data: unknown role:', entry.role); return; }
    const player = { name: entry.name, champions: [] };
    entry.rawChamps.forEach(raw => {
      const champ = findChamp(raw);
      if (champ && !player.champions.some(c => c.id === champ.id))
        player.champions.push(champ);
      else if (!champ)
        console.warn('Team data: could not resolve champion:', raw);
    });
    slot.players.push(player);
  });
  syncTeamPlayersFromRoster();
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

    // Roster mode: role label + one chip per player of this role (click to switch)
    const headerLeft = role
      ? `<div class="player-role-head">
           <span class="player-role-label">${roleIcons[role]} ${role[0].toUpperCase()+role.slice(1)}</span>
           <div class="player-chips">
             ${teamRoster[role].players.map((p, k) => `
               <button class="player-chip ${k === teamRoster[role].active ? 'active' : ''}" data-role="${role}" data-k="${k}">${p.name}</button>
             `).join('')}
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
      chip.addEventListener('click', () => {
        teamRoster[chip.dataset.role].active = Number(chip.dataset.k);
        syncTeamPlayersFromRoster();
        renderTeamSuggesterUI();
      });
    });
    card.querySelector('.player-name-input')?.addEventListener('change', e => {
      teamPlayers[idx].name = e.target.value;
    });
    card.querySelector('.champ-add-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const input = e.currentTarget;
        addChampToPlayer(idx, input.value);
        input.value = '';
      }
    });
    card.querySelector('.clear-player-btn').addEventListener('click', () => {
      teamPlayers[idx].champions = [];
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

  player.champions.forEach((champ, ci) => {
    const tag = el('div', 'pool-champ-tag');
    tag.style.borderColor = champ.color;
    tag.style.background  = champ.bg;
    tag.innerHTML = `
      <img src="${champ.img}" alt="${champ.name}" />
      <span style="color:${champ.color}">${champ.name}</span>
      <button class="remove-pool-champ" data-idx="${idx}" data-ci="${ci}">×</button>
    `;
    tag.querySelector('.remove-pool-champ').addEventListener('click', () => {
      teamPlayers[idx].champions.splice(ci, 1);
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
  if (teamPlayers[idx].champions.some(c => c.id === champ.id)) return;
  teamPlayers[idx].champions.push(champ);
  renderPlayerPool(idx);
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

function persistSaved() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedComps));
  updateSavedBadge();
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

function setupSaveModal() {
  const saveBtn    = document.getElementById('save-comp-btn');
  const modal      = document.getElementById('save-modal');
  const cancelBtn  = document.getElementById('modal-cancel');
  const confirmBtn = document.getElementById('modal-confirm');
  const nameInput  = document.getElementById('save-name-input');

  saveBtn?.addEventListener('click', () => {
    const filled = ROLES.map(r => comp[r].main).filter(Boolean);
    if (!filled.length) { showNotification('Add at least one champion first', 'error'); return; }
    renderModalPreview();
    const subCounts = {};
    filled.forEach(c => { subCounts[c.sub] = (subCounts[c.sub] || 0) + 1; });
    const dominant = Object.entries(subCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'Comp';
    nameInput.value = `${dominant} Comp`;
    nameInput.select();
    modal.classList.remove('hidden');
    setTimeout(() => nameInput.focus(), 50);
  });

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
    savedComps.unshift({ id: Date.now(), name, notes, slots, date: new Date().toLocaleDateString() });
    persistSaved();
    renderSavedComps();
    modal.classList.add('hidden');
    document.getElementById('save-notes-input').value = '';
    showNotification(`"${name}" saved ✓`, 'success');
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
});
