/* Inventaire des perches — Patro Sainte-Suzanne
 * Données locales (localStorage), export / import JSON, accès protégé par code PIN.
 *
 * Le code PIN est un garde-fou contre un regard indiscret, pas un chiffrement :
 * l'inventaire est stocké en clair et reste lisible depuis la console du navigateur.
 */
(function () {
  'use strict';

  const KEY = 'perches-scouts-inventory';
  const PIN_KEY = 'perches-scouts-pin-v1';
  const BACKUP_KEY = 'perches-scouts-inventory-backup';
  /* Copie du contenu illisible, mise de côté avant toute écriture. */
  const CORRUPT_KEY = 'perches-scouts-inventory-corrupt';

  const MAX_IMPORT_BYTES = 1024 * 1024;
  const MAX_POLES = 1000;
  const MAX_MOVEMENTS = 10000;
  /* L'historique grandit à chaque mouvement et n'est jamais purgé par l'usage :
   * sans plafond, localStorage finit par refuser d'enregistrer quoi que ce soit. */
  const MAX_MOVEMENTS_PER_KIND = 500;
  const TOAST_MS = 3200;
  const HISTORY_SHOWN = 20;

  const PALETTE = [
    '#E63946', '#F3722C', '#F9C74F', '#FFD60A', '#A3CE2D',
    '#43AA8B', '#06D6A0', '#2A9D8F', '#277DA1', '#3A86FF',
    '#3A0CA3', '#7209B7', '#B5179E', '#F72585', '#9C6644',
    '#6F4518', '#808080', '#4A4A4A', '#000000', '#FFFFFF'
  ];
  const NO_COLOR = '#C9C0AC';
  const HEX = /^#[0-9A-Fa-f]{6}$/;

  const state = {
    poles: [],
    movements: [],
    activeTab: 'inventaire',
    authenticated: false,
    /* Passe à true quand l'inventaire stocké est illisible : plus aucune
     * écriture, pour ne pas écraser des données encore récupérables. */
    readOnly: false,
    /* La taille choisie dans les onglets Sortie et Retour, conservée d'un
     * mouvement à l'autre : on sort rarement une seule perche d'une taille. */
    moveSelection: { sortie: null, retour: null }
  };

  const el = {
    security: document.getElementById('security-screen'),
    recovery: document.getElementById('recovery-screen'),
    main: document.getElementById('main-view'),
    content: document.getElementById('tab-content'),
    toast: document.getElementById('toast')
  };

  // ---- utilitaires ----

  function uid(prefix) {
    /* crypto.randomUUID n'existe qu'en contexte sécurisé (HTTPS ou localhost).
     * Date.now() seul produisait des identifiants identiques pour deux
     * mouvements enregistrés dans la même milliseconde. */
    const random = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
    return prefix + random;
  }

  function esc(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
    }[ch]));
  }

  function colorFor(pole) { return pole.color || NO_COLOR; }

  function hexToHue(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  function fmtSize(size) { return size.toFixed(2).replace('.', ',') + ' m'; }

  function fmtDate(iso) {
    const d = new Date(iso);
    /* L'année n'apparaît que lorsqu'elle diffère de l'année courante : sans
     * elle, un mouvement du camp précédent se lisait comme celui d'hier. */
    const options = { day: '2-digit', month: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
    return d.toLocaleDateString('fr-BE', options)
      + ' à ' + d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
  }

  function sortedPoles() { return [...state.poles].sort((a, b) => a.size - b.size); }
  function findPole(id) { return state.poles.find(p => p.id === id); }

  let toastTimer = null;
  /* La notification vit hors du cycle de rendu. Quand elle le traversait, sa
   * disparition au bout de 3,2 s reconstruisait toute la page et effaçait ce
   * que l'utilisateur était en train de saisir. */
  function showToast(kind, text) {
    el.toast.textContent = text;
    el.toast.className = 'toast ' + kind;
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, TOAST_MS);
  }

  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    el.toast.hidden = true;
  }

  // ---- validation ----

  function normalizePole(raw, index, seenIds) {
    if (!raw || typeof raw !== 'object') return null;
    const size = Number(raw.size);
    const total = Number(raw.total);
    const stock = Number(raw.stock);
    if (!Number.isFinite(size) || size <= 0) return null;
    if (!Number.isInteger(total) || total < 0) return null;
    if (!Number.isInteger(stock) || stock < 0) return null;
    let color = raw.color == null ? null : String(raw.color).toUpperCase();
    if (color !== null && !HEX.test(color)) return null;
    let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw.id)
      ? raw.id : uid('p');
    if (seenIds.has(id)) id = uid('p');
    seenIds.add(id);
    return { id, size, total, stock, color };
  }

  function normalizeMovement(raw, index, seenIds) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type !== 'sortie' && raw.type !== 'retour') return null;
    const size = Number(raw.size);
    const qty = Number(raw.qty);
    if (!Number.isFinite(size) || size <= 0) return null;
    if (!Number.isInteger(qty) || qty <= 0) return null;
    const date = new Date(raw.date);
    if (Number.isNaN(date.getTime())) return null;
    let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw.id)
      ? raw.id : uid('m');
    if (seenIds.has(id)) id = uid('m');
    seenIds.add(id);
    return { id, type: raw.type, size, qty, date: date.toISOString() };
  }

  /* Une entrée invalide est écartée, jamais le lot entier : auparavant, une
   * seule couleur mal formée suffisait à vider l'inventaire affiché, et la
   * première action de l'utilisateur écrasait alors le stock réel. */
  function normalizeData(data) {
    if (!data || typeof data !== 'object') throw new Error('format');
    if (!Array.isArray(data.poles) || !Array.isArray(data.movements)) throw new Error('format');
    if (data.version != null && data.version !== 1) throw new Error('version');
    if (data.poles.length > MAX_POLES || data.movements.length > MAX_MOVEMENTS) throw new Error('volume');

    let skipped = 0;
    const poleIds = new Set();
    const poles = [];
    data.poles.forEach((raw, index) => {
      const pole = normalizePole(raw, index, poleIds);
      if (pole) poles.push(pole); else skipped++;
    });

    const movementIds = new Set();
    const movements = [];
    data.movements.forEach((raw, index) => {
      const movement = normalizeMovement(raw, index, movementIds);
      if (movement) movements.push(movement); else skipped++;
    });

    return { poles, movements, skipped };
  }

  // ---- persistance ----

  function readStored() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { poles: [], movements: [], skipped: 0 };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('format');
    /* Un enregistrement encore vide est légitime : c'est le premier lancement. */
    if (!Array.isArray(parsed.poles) && !Array.isArray(parsed.movements)) {
      return { poles: [], movements: [], skipped: 0 };
    }
    return normalizeData({
      version: parsed.version,
      poles: parsed.poles || [],
      movements: parsed.movements || []
    });
  }

  /* Garde les mouvements les plus récents de chaque type — la liste est
   * ordonnée du plus récent au plus ancien. */
  function pruneMovements(movements) {
    const counts = { sortie: 0, retour: 0 };
    return movements.filter(m => {
      counts[m.type] += 1;
      return counts[m.type] <= MAX_MOVEMENTS_PER_KIND;
    });
  }

  function save() {
    if (state.readOnly) {
      showToast('err', 'Enregistrement bloqué : l’inventaire stocké est illisible.');
      return false;
    }
    const pruned = pruneMovements(state.movements);
    const dropped = state.movements.length - pruned.length;
    try {
      localStorage.setItem(KEY, JSON.stringify({
        version: 1,
        poles: state.poles,
        movements: pruned,
        updatedAt: new Date().toISOString()
      }));
    } catch (error) {
      showToast('err', 'La sauvegarde a échoué, réessaie.');
      return false;
    }
    if (dropped > 0) state.movements = pruned;
    return true;
  }

  function load() {
    let clean;
    try {
      clean = readStored();
    } catch (error) {
      enterRecoveryMode();
      return;
    }
    state.readOnly = false;
    state.poles = clean.poles;
    state.movements = clean.movements;
    if (state.poles.length === 0) state.activeTab = 'reglages';
    showMain();
    render();
    if (clean.skipped > 0) {
      showToast('err', clean.skipped + ' entrée(s) illisible(s) écartée(s). Vérifie l’inventaire.');
    }
  }

  // ---- récupération d'un stockage illisible ----

  function enterRecoveryMode() {
    const raw = localStorage.getItem(KEY);
    try {
      if (raw) localStorage.setItem(CORRUPT_KEY, raw);
    } catch (error) { /* le quota peut être plein : on continue sans la copie */ }
    state.readOnly = true;
    state.poles = [];
    state.movements = [];
    renderRecovery();
  }

  function downloadJson(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportRaw() {
    const raw = localStorage.getItem(CORRUPT_KEY) || localStorage.getItem(KEY);
    if (!raw) { showToast('err', 'Rien à exporter.'); return; }
    downloadJson('inventaire-perches-brut-' + new Date().toISOString().slice(0, 10) + '.json', raw);
    showToast('ok', 'Contenu brut exporté.');
  }

  function startFresh() {
    if (!confirm('Repartir d’un inventaire vide ? Le contenu illisible reste exportable depuis cet écran tant que tu ne l’as pas remplacé.')) return;
    if (!confirm('Dernière confirmation : vider l’inventaire enregistré ?')) return;
    try { localStorage.removeItem(KEY); } catch (error) { /* rien à faire */ }
    state.readOnly = false;
    load();
    showToast('ok', 'Inventaire réinitialisé.');
  }

  function renderRecovery() {
    const hasBackup = Boolean(localStorage.getItem(BACKUP_KEY));
    el.security.hidden = true;
    el.main.hidden = true;
    el.recovery.hidden = false;
    el.recovery.innerHTML = `<div class="security-card">
      <h1>Inventaire illisible</h1>
      <p>Le contenu enregistré sur cet appareil n’a pas pu être relu. Il a été mis de côté
      intact et <strong>aucune écriture n’est autorisée</strong> tant que tu n’as pas choisi
      quoi en faire.</p>
      <div class="data-actions">
        <button type="button" class="btn-primary" id="recovery-export">Exporter le contenu brut</button>
        ${hasBackup ? '<button type="button" class="btn-ghost" id="recovery-restore">Restaurer la copie de secours</button>' : ''}
        <button type="button" class="btn-danger" id="recovery-fresh">Repartir de zéro</button>
      </div>
    </div>`;
    document.getElementById('recovery-export').addEventListener('click', exportRaw);
    document.getElementById('recovery-fresh').addEventListener('click', startFresh);
    const restoreBtn = document.getElementById('recovery-restore');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', () => {
        state.readOnly = false;
        if (!restoreBackup()) state.readOnly = true;
      });
    }
  }

  // ---- code PIN ----

  async function hashPin(pin) {
    const bytes = new TextEncoder().encode(pin);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function validPin(pin) { return /^\d{4,8}$/.test(pin); }
  function hasPin() { return Boolean(localStorage.getItem(PIN_KEY)); }

  async function unlock(pin, confirmation) {
    if (!validPin(pin)) { renderSecurity('Le code PIN doit contenir entre 4 et 8 chiffres.'); return; }
    const hash = await hashPin(pin);
    if (!hasPin()) {
      if (pin !== confirmation) { renderSecurity('Les deux codes PIN ne correspondent pas.'); return; }
      localStorage.setItem(PIN_KEY, hash);
    } else if (hash !== localStorage.getItem(PIN_KEY)) {
      renderSecurity('Code PIN incorrect.');
      return;
    }
    state.authenticated = true;
    load();
  }

  function lock() {
    state.authenticated = false;
    hideToast();
    renderSecurity();
  }

  async function changePin() {
    const current = prompt('Code PIN actuel :');
    if (current === null) return;
    if (await hashPin(current) !== localStorage.getItem(PIN_KEY)) {
      showToast('err', 'Code PIN actuel incorrect.');
      return;
    }
    const next = prompt('Nouveau code PIN (4 à 8 chiffres) :');
    if (next === null) return;
    if (!validPin(next)) { showToast('err', 'Le nouveau PIN doit contenir entre 4 et 8 chiffres.'); return; }
    const confirmation = prompt('Confirmez le nouveau code PIN :');
    if (next !== confirmation) { showToast('err', 'Les deux nouveaux codes ne correspondent pas.'); return; }
    localStorage.setItem(PIN_KEY, await hashPin(next));
    showToast('ok', 'Code PIN modifié.');
  }

  function resetApplication() {
    if (localStorage.getItem(KEY)
      && confirm('Avant d’effacer : exporter une copie de l’inventaire ? Il est lisible sans le code PIN.')) {
      exportRaw();
    }
    if (!confirm('PIN oublié ? Cette opération effacera définitivement l’inventaire local et le code PIN. Continuer ?')) return;
    if (!confirm('Dernière confirmation : supprimer toutes les données locales ?')) return;
    localStorage.removeItem(KEY);
    localStorage.removeItem(BACKUP_KEY);
    localStorage.removeItem(CORRUPT_KEY);
    localStorage.removeItem(PIN_KEY);
    state.poles = [];
    state.movements = [];
    state.activeTab = 'inventaire';
    state.authenticated = false;
    state.readOnly = false;
    renderSecurity();
  }

  function renderSecurity(error) {
    const setup = !hasPin();
    el.main.hidden = true;
    el.recovery.hidden = true;
    el.security.hidden = false;
    el.security.innerHTML = `<form class="security-card" id="pin-form">
      <h1>${setup ? 'Créer votre code PIN' : 'Inventaire protégé'}</h1>
      <p>${setup
        ? 'Choisissez un code de 4 à 8 chiffres. Il sera demandé à chaque ouverture de la page.'
        : 'Saisissez votre code PIN pour accéder à l’inventaire.'}</p>
      <label for="pin">Code PIN</label>
      <input id="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8"
             autocomplete="${setup ? 'new-password' : 'current-password'}" required>
      ${setup ? `<label for="pin-confirm">Confirmer le code</label>
      <input id="pin-confirm" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8"
             autocomplete="new-password" required>` : ''}
      <div class="security-error" role="alert">${esc(error || '')}</div>
      <button class="btn-primary" type="submit">${setup ? 'Créer le PIN' : 'Déverrouiller'}</button>
      ${setup ? '' : '<button class="btn-danger btn-sm" id="reset-app" type="button">PIN oublié / réinitialiser</button>'}
    </form>`;

    document.getElementById('pin-form').addEventListener('submit', event => {
      event.preventDefault();
      unlock(
        document.getElementById('pin').value,
        setup ? document.getElementById('pin-confirm').value : ''
      );
    });
    const resetBtn = document.getElementById('reset-app');
    if (resetBtn) resetBtn.addEventListener('click', resetApplication);
    /* L'attribut autofocus n'est honoré qu'au premier parsing du document :
     * sur un fragment inséré par innerHTML, il ne fait rien. */
    document.getElementById('pin').focus();
  }

  // ---- import / export ----

  function exportJson() {
    downloadJson(
      'inventaire-perches-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        poles: state.poles,
        movements: state.movements
      }, null, 2)
    );
    showToast('ok', 'Sauvegarde JSON exportée.');
  }

  function importJson(file) {
    if (file.size > MAX_IMPORT_BYTES) {
      showToast('err', 'Le fichier dépasse la taille maximale de 1 Mo.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      let clean;
      try {
        clean = normalizeData(JSON.parse(reader.result));
      } catch (error) {
        showToast('err', 'Fichier JSON invalide ou incompatible.');
        return;
      }
      if (!confirm('Remplacer l’inventaire actuel par le contenu de ce fichier ?')) return;
      const previousStored = localStorage.getItem(KEY);
      const previousPoles = state.poles;
      const previousMovements = state.movements;
      state.poles = clean.poles;
      state.movements = clean.movements;
      if (save()) {
        if (previousStored) localStorage.setItem(BACKUP_KEY, previousStored);
        const skipped = clean.skipped > 0 ? ' ' + clean.skipped + ' entrée(s) illisible(s) écartée(s).' : '';
        showToast('ok', 'Inventaire importé. Une copie de secours a été conservée.' + skipped);
      } else {
        state.poles = previousPoles;
        state.movements = previousMovements;
      }
      render();
    };
    reader.onerror = () => showToast('err', 'Impossible de lire le fichier JSON.');
    reader.readAsText(file);
  }

  function restoreBackup() {
    const raw = localStorage.getItem(BACKUP_KEY);
    if (!raw) { showToast('err', 'Aucune copie de secours disponible.'); return false; }
    if (!confirm('Restaurer l’inventaire présent avant le dernier import ?')) return false;
    let clean;
    try {
      clean = normalizeData(JSON.parse(raw));
    } catch (error) {
      showToast('err', 'La copie de secours est invalide.');
      return false;
    }
    const current = localStorage.getItem(KEY);
    const previousPoles = state.poles;
    const previousMovements = state.movements;
    state.poles = clean.poles;
    state.movements = clean.movements;
    if (!save()) {
      state.poles = previousPoles;
      state.movements = previousMovements;
      render();
      return false;
    }
    if (current) localStorage.setItem(BACKUP_KEY, current);
    showMain();
    render();
    showToast('ok', 'Copie de secours restaurée.');
    return true;
  }

  // ---- actions ----

  function addSize(sizeStr, totalStr) {
    const size = parseFloat(String(sizeStr).replace(',', '.'));
    const total = parseInt(totalStr, 10);
    if (isNaN(size) || size <= 0) { showToast('err', 'Indique une taille valide, en mètres.'); return false; }
    if (isNaN(total) || total < 0) { showToast('err', 'Indique une quantité valide.'); return false; }
    if (state.poles.some(p => Math.abs(p.size - size) < 0.001)) {
      showToast('err', 'Cette taille existe déjà dans l’inventaire.');
      return false;
    }
    const pole = { id: uid('p'), size, total, stock: total, color: null };
    state.poles.push(pole);
    if (!save()) {
      state.poles = state.poles.filter(p => p !== pole);
      return false;
    }
    showToast('ok', `Taille ${fmtSize(size)} ajoutée à l’inventaire.`);
    return true;
  }

  function updateTotal(id, totalStr) {
    const total = parseInt(totalStr, 10);
    const pole = findPole(id);
    if (!pole) return;
    if (isNaN(total) || total < 0) {
      showToast('err', 'Indique une quantité valide.');
      render();
      return;
    }
    if (total === pole.total) return;
    const previous = pole.total;
    pole.total = total;
    if (!save()) pole.total = previous;
    /* Sans ce rendu, « x en stock actuellement » et le dépassement de stock
     * restaient affichés avec l'ancien total. */
    render();
  }

  function deletePole(id) {
    const previous = state.poles;
    state.poles = state.poles.filter(p => p.id !== id);
    if (!save()) state.poles = previous;
    render();
  }

  function resetOne(id) {
    const pole = findPole(id);
    if (!pole) return;
    const previous = pole.stock;
    pole.stock = pole.total;
    if (save()) showToast('ok', `Stock des perches ${fmtSize(pole.size)} remis à niveau.`);
    else pole.stock = previous;
    render();
  }

  function resetAll() {
    const previous = state.poles.map(p => p.stock);
    state.poles.forEach(p => { p.stock = p.total; });
    if (save()) showToast('ok', 'Tout le stock a été remis à niveau.');
    else state.poles.forEach((p, i) => { p.stock = previous[i]; });
    render();
  }

  function moveStock(kind, id, qtyStr) {
    const pole = findPole(id);
    const qty = parseInt(qtyStr, 10);
    if (!pole) { showToast('err', 'Choisis une taille.'); return; }
    if (isNaN(qty) || qty <= 0) { showToast('err', 'Indique une quantité valide.'); return; }

    const isSortie = kind === 'sortie';
    if (isSortie && qty > pole.stock) {
      showToast('err', `Stock insuffisant : ${pole.stock} perche(s) de ${fmtSize(pole.size)} disponible(s).`);
      return;
    }
    if (!isSortie && pole.stock + qty > pole.total
      && !confirm(`Le retour portera le stock à ${pole.stock + qty}, au-dessus du total déclaré (${pole.total}). Continuer ?`)) {
      return;
    }

    const delta = isSortie ? -qty : qty;
    pole.stock += delta;
    const movement = { id: uid('m'), type: kind, size: pole.size, qty, date: new Date().toISOString() };
    state.movements.unshift(movement);
    if (save()) {
      showToast('ok', isSortie
        ? `${qty} perche(s) de ${fmtSize(pole.size)} sortie(s) du stock.`
        : `${qty} perche(s) de ${fmtSize(pole.size)} remise(s) en stock.`);
    } else {
      pole.stock -= delta;
      state.movements = state.movements.filter(m => m !== movement);
    }
    render();
  }

  function clearHistory(kind) {
    const previous = state.movements;
    state.movements = state.movements.filter(m => m.type !== kind);
    if (!save()) state.movements = previous;
    render();
  }

  // ---- rendu ----

  function showMain() {
    el.security.hidden = true;
    el.recovery.hidden = true;
    el.main.hidden = false;
  }

  /* Le contenu de l'onglet est reconstruit à chaque rendu : on note quel champ
   * portait le focus pour l'y ramener, sinon toute saisie en cours est perdue. */
  function currentFocusKey() {
    const active = document.activeElement;
    return active && active.dataset ? active.dataset.focusKey || null : null;
  }

  function restoreFocus(key) {
    if (!key) return;
    const node = el.content.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    if (node) node.focus();
  }

  function render() {
    if (!state.authenticated) { renderSecurity(); return; }
    if (state.readOnly) { renderRecovery(); return; }
    showMain();

    for (const tab of document.querySelectorAll('.tab[data-tab]')) {
      const active = tab.dataset.tab === state.activeTab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }

    const focusKey = currentFocusKey();
    if (state.activeTab === 'inventaire') el.content.innerHTML = renderInventaire();
    else if (state.activeTab === 'sortie') el.content.innerHTML = renderMove('sortie');
    else if (state.activeTab === 'retour') el.content.innerHTML = renderMove('retour');
    else el.content.innerHTML = renderReglages();

    attachContentHandlers();
    restoreFocus(focusKey);
  }

  function renderInventaire() {
    if (state.poles.length === 0) {
      return `<div class="empty">Aucune taille enregistrée pour l’instant.<br>
        Ajoute tes perches depuis l’onglet Réglages pour démarrer l’inventaire.</div>`;
    }
    const groupsMap = new Map();
    for (const pole of state.poles) {
      const key = pole.color || 'none';
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key).push(pole);
    }
    const groups = [...groupsMap.entries()].map(([key, poles]) => ({
      color: key === 'none' ? null : key,
      poles: poles.sort((a, b) => a.size - b.size)
    }));
    groups.sort((a, b) => {
      if (!a.color) return 1;
      if (!b.color) return -1;
      return hexToHue(a.color) - hexToHue(b.color);
    });

    const sections = groups.map(group => {
      const cards = group.poles.map(pole => {
        const color = esc(colorFor(pole));
        const pct = pole.total > 0 ? Math.min(100, Math.round(100 * pole.stock / pole.total)) : 0;
        const over = pole.stock > pole.total;
        return `
          <div class="pole-card" style="border-left-color:${color}">
            <div class="size">${fmtSize(pole.size)}</div>
            <div class="stock ${over ? 'over' : ''}"><b>${pole.stock}</b> / ${pole.total} dispo</div>
            <div class="bar"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
          </div>`;
      }).join('');
      const swatch = `<span class="dot" style="background:${esc(group.color || NO_COLOR)}"></span>`;
      const label = group.color ? '' : '<span class="muted">Sans couleur assignée</span>';
      return `
        <div class="color-group">
          <div class="color-group-head">${swatch}${label}</div>
          <div class="grid">${cards}</div>
        </div>`;
    }).join('');

    return `<div class="legend">Les perches sont regroupées par couleur — assigne une couleur
      à chaque taille depuis Réglages.</div>${sections}`;
  }

  function renderMove(kind) {
    if (state.poles.length === 0) {
      return '<div class="empty">Ajoute d’abord des tailles de perches dans l’onglet Réglages.</div>';
    }
    const isSortie = kind === 'sortie';
    const poles = sortedPoles();
    /* La taille retenue au mouvement précédent reste sélectionnée ; si elle a
     * été supprimée entre-temps, on retombe sur la première. */
    const selected = poles.some(p => p.id === state.moveSelection[kind])
      ? state.moveSelection[kind] : poles[0].id;
    state.moveSelection[kind] = selected;

    const options = poles.map(p =>
      `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${fmtSize(p.size)} — ${p.stock} dispo</option>`
    ).join('');

    const entries = state.movements.filter(m => m.type === kind).slice(0, HISTORY_SHOWN);
    const histRows = entries.map(m => `
      <div class="hist-row">
        <span>${m.qty} perche(s) de ${fmtSize(m.size)}</span>
        <span class="hist-date">${fmtDate(m.date)}</span>
      </div>`).join('');

    return `
      <div class="card">
        <h2>${isSortie ? 'Sortir des perches du stock' : 'Remettre des perches en stock'}</h2>
        <form id="move-form" data-kind="${kind}">
          <div class="field">
            <label for="move-size">Taille</label>
            <select id="move-size" data-focus-key="move-size">${options}</select>
          </div>
          <div class="field">
            <label for="move-qty">Nombre de perches</label>
            <input type="number" id="move-qty" min="1" value="1" data-focus-key="move-qty">
          </div>
          <button type="submit" class="btn-primary">${isSortie ? 'Sortir du stock' : 'Remettre en stock'}</button>
        </form>
      </div>
      <div class="card history">
        <h2>${isSortie ? 'Historique des sorties' : 'Historique des retours'}</h2>
        ${entries.length ? histRows : '<div class="muted">Aucun mouvement enregistré pour l’instant.</div>'}
        ${entries.length ? `<div class="foot-actions"><span></span>
          <button class="btn-ghost btn-sm" data-clear-hist="${kind}">Effacer l’historique</button></div>` : ''}
      </div>`;
  }

  function renderReglages() {
    const rows = sortedPoles().map(pole => {
      const swatches = PALETTE.map(hex => `
        <button type="button" class="swatch ${pole.color === hex ? 'selected' : ''}"
                style="background:${hex}" data-color-id="${esc(pole.id)}" data-color-hex="${hex}"
                title="${hex}" aria-label="Couleur ${hex}"></button>`).join('');
      return `
      <div class="setting-row">
        <div class="setting-row-top">
          <div class="sz">${fmtSize(pole.size)}</div>
          <div>
            <label for="total-${esc(pole.id)}" style="margin:0 0 2px;font-size:11px;">Total</label>
            <input type="number" min="0" id="total-${esc(pole.id)}" value="${pole.total}"
                   data-total-id="${esc(pole.id)}" data-focus-key="total-${esc(pole.id)}">
          </div>
          <div class="spacer muted">${pole.stock} en stock actuellement</div>
          <button type="button" class="btn-ghost btn-sm" data-reset-id="${esc(pole.id)}">Remettre à niveau</button>
          <button type="button" class="btn-danger btn-sm" data-delete-id="${esc(pole.id)}">Supprimer</button>
        </div>
        <div class="swatches">
          <button type="button" class="swatch-auto ${!pole.color ? 'selected' : ''}"
                  data-color-id="${esc(pole.id)}" data-color-hex="">Auto</button>
          ${swatches}
          <input type="color" class="color-picker" data-color-picker-id="${esc(pole.id)}"
                 value="${esc(pole.color || NO_COLOR)}" title="Choisir une couleur libre"
                 aria-label="Couleur libre pour les perches de ${fmtSize(pole.size)}">
        </div>
      </div>`;
    }).join('');

    return `
      <div class="card">
        <h2>Tailles enregistrées</h2>
        ${state.poles.length ? rows : '<div class="muted">Aucune taille pour l’instant — ajoute la première ci-dessous.</div>'}
        ${state.poles.length ? `
          <div class="foot-actions">
            <span class="muted">« Remettre à niveau » restaure le stock au total défini.</span>
            <button type="button" class="btn-ghost btn-sm" id="reset-all">Tout remettre à niveau</button>
          </div>` : ''}
      </div>
      <div class="card">
        <h2>Ajouter une taille</h2>
        <form id="add-form">
          <div class="row-2">
            <div class="field">
              <label for="add-size">Taille (en mètres)</label>
              <input type="text" id="add-size" inputmode="decimal" placeholder="ex : 3,20" data-focus-key="add-size">
            </div>
            <div class="field">
              <label for="add-total">Quantité totale</label>
              <input type="number" id="add-total" min="0" placeholder="ex : 8" data-focus-key="add-total">
            </div>
          </div>
          <button type="submit" class="btn-primary">Ajouter cette taille</button>
        </form>
      </div>
      <div class="card">
        <h2>Sauvegarde des données</h2>
        <p class="muted">Les données restent sur cet appareil. Exportez régulièrement une copie
        JSON pour pouvoir les restaurer ou les transférer.</p>
        <div class="data-actions">
          <button type="button" class="btn-primary" id="export-json">Exporter en JSON</button>
          <label for="import-json" class="btn-ghost">Importer un JSON</label>
          <input type="file" id="import-json" class="visually-hidden" accept="application/json,.json">
          <button type="button" class="btn-ghost" id="restore-backup"
                  ${localStorage.getItem(BACKUP_KEY) ? '' : 'disabled'}>Restaurer avant import</button>
        </div>
      </div>
      <div class="card">
        <h2>Sécurité</h2>
        <p class="muted">Le code PIN empêche un regard indiscret d’ouvrir l’inventaire sur cet
        appareil. Il ne chiffre pas les données.</p>
        <div class="data-actions">
          <button type="button" class="btn-ghost" id="change-pin">Modifier le code PIN</button>
          <button type="button" class="btn-ghost" id="lock-settings">Verrouiller maintenant</button>
        </div>
      </div>`;
  }

  // ---- gestionnaires ----

  function attachContentHandlers() {
    const on = (id, event, handler) => {
      const node = document.getElementById(id);
      if (node) node.addEventListener(event, handler);
    };

    on('lock-settings', 'click', lock);
    on('change-pin', 'click', changePin);
    on('export-json', 'click', exportJson);
    on('restore-backup', 'click', restoreBackup);
    on('reset-all', 'click', () => {
      if (confirm('Remettre tout le stock à niveau ?')) resetAll();
    });

    const importInput = document.getElementById('import-json');
    if (importInput) {
      importInput.addEventListener('change', () => {
        if (importInput.files[0]) importJson(importInput.files[0]);
        importInput.value = '';
      });
    }

    const moveForm = document.getElementById('move-form');
    if (moveForm) {
      const sizeSelect = document.getElementById('move-size');
      sizeSelect.addEventListener('change', () => {
        state.moveSelection[moveForm.dataset.kind] = sizeSelect.value;
      });
      moveForm.addEventListener('submit', event => {
        event.preventDefault();
        moveStock(moveForm.dataset.kind, sizeSelect.value, document.getElementById('move-qty').value);
      });
    }

    const addForm = document.getElementById('add-form');
    if (addForm) {
      addForm.addEventListener('submit', event => {
        event.preventDefault();
        if (addSize(document.getElementById('add-size').value, document.getElementById('add-total').value)) {
          render();
        }
      });
    }

    for (const input of el.content.querySelectorAll('[data-total-id]')) {
      input.addEventListener('change', () => updateTotal(input.dataset.totalId, input.value));
    }
    for (const button of el.content.querySelectorAll('[data-reset-id]')) {
      button.addEventListener('click', () => resetOne(button.dataset.resetId));
    }
    for (const button of el.content.querySelectorAll('[data-delete-id]')) {
      button.addEventListener('click', () => {
        if (confirm('Supprimer cette taille de l’inventaire ?')) deletePole(button.dataset.deleteId);
      });
    }
    for (const button of el.content.querySelectorAll('[data-clear-hist]')) {
      button.addEventListener('click', () => {
        if (confirm('Effacer cet historique ?')) clearHistory(button.dataset.clearHist);
      });
    }
    for (const button of el.content.querySelectorAll('[data-color-id]')) {
      button.addEventListener('click', () => {
        const pole = findPole(button.dataset.colorId);
        if (!pole) return;
        const previous = pole.color;
        pole.color = button.dataset.colorHex || null;
        if (!save()) pole.color = previous;
        render();
      });
    }
    for (const input of el.content.querySelectorAll('[data-color-picker-id]')) {
      const apply = () => {
        const pole = findPole(input.dataset.colorPickerId);
        if (!pole || !HEX.test(input.value)) return;
        const previous = pole.color;
        pole.color = input.value.toUpperCase();
        if (!save()) pole.color = previous;
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', () => { apply(); render(); });
    }
  }

  function attachStaticHandlers() {
    /* Attachés une seule fois : l'en-tête et les onglets ne sont jamais reconstruits. */
    document.getElementById('lock-app').addEventListener('click', lock);
    for (const tab of document.querySelectorAll('.tab[data-tab]')) {
      tab.addEventListener('click', () => {
        state.activeTab = tab.dataset.tab;
        render();
      });
    }
    /* Un autre onglet du navigateur vient d'écrire : sans cette relecture, le
     * prochain enregistrement d'ici écrasait silencieusement son travail. */
    window.addEventListener('storage', event => {
      if (event.key !== KEY || !state.authenticated || state.readOnly) return;
      try {
        const clean = readStored();
        state.poles = clean.poles;
        state.movements = clean.movements;
        render();
        showToast('ok', 'Inventaire rechargé : modifié dans un autre onglet.');
      } catch (error) {
        enterRecoveryMode();
      }
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => { /* hors ligne au premier chargement */ });
    });
  }

  attachStaticHandlers();
  registerServiceWorker();
  renderSecurity();
})();
