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
  /* Une perche de plus de 100 m n'existe pas : au-delà, c'est une faute de
   * frappe (une taille en centimètres, par exemple) qui fausse les jauges. */
  const MAX_SIZE_M = 100;
  const TOAST_MS = 3200;
  const HISTORY_SHOWN = 20;

  /* Chaque teinte porte son nom : un rond coloré ne dit rien à un lecteur
   * d'écran, et « les perches vertes » est la façon dont on en parle sur le
   * terrain — pas « les perches #43AA8B ». */
  const PALETTE = [
    { hex: '#E63946', name: 'rouge' },
    { hex: '#F3722C', name: 'orange' },
    { hex: '#F9C74F', name: 'jaune paille' },
    { hex: '#FFD60A', name: 'jaune vif' },
    { hex: '#A3CE2D', name: 'vert anis' },
    { hex: '#43AA8B', name: 'vert d’eau' },
    { hex: '#06D6A0', name: 'vert menthe' },
    { hex: '#2A9D8F', name: 'vert canard' },
    { hex: '#277DA1', name: 'bleu pétrole' },
    { hex: '#3A86FF', name: 'bleu vif' },
    { hex: '#3A0CA3', name: 'bleu nuit' },
    { hex: '#7209B7', name: 'violet' },
    { hex: '#B5179E', name: 'magenta' },
    { hex: '#F72585', name: 'rose vif' },
    { hex: '#9C6644', name: 'brun clair' },
    { hex: '#6F4518', name: 'brun foncé' },
    { hex: '#808080', name: 'gris' },
    { hex: '#4A4A4A', name: 'gris foncé' },
    { hex: '#000000', name: 'noir' },
    { hex: '#FFFFFF', name: 'blanc' }
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
    toast: document.getElementById('toast'),
    toastLive: document.getElementById('toast-live')
  };

  /* localStorage lève une exception dès la lecture quand le stockage est refusé
   * (navigation privée sur iOS, cookies du site bloqués). L'application
   * s'arrêtait alors sur une page blanche, sans rien expliquer. */
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch (error) { return null; }
    },
    trySet(key, value) {
      try { localStorage.setItem(key, value); return true; } catch (error) { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (error) { /* rien à faire */ }
    }
  };

  function storageAvailable() {
    try {
      localStorage.setItem('perches-probe', '1');
      localStorage.removeItem('perches-probe');
      return true;
    } catch (error) {
      return false;
    }
  }

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

  function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return { h: h < 0 ? h + 360 : h, s, l };
  }

  /* Un gris n'a pas de teinte : hexToHsl lui en rendait une de zéro, et il se
   * rangeait donc avec les rouges dans l'inventaire. */
  function isAchromatic(hsl) { return hsl.s <= 0.12; }

  function colorName(hex) {
    const known = PALETTE.find(entry => entry.hex === hex);
    if (known) return known.name;
    const hsl = hexToHsl(hex);
    if (hsl.l <= 0.1) return 'noir';
    if (isAchromatic(hsl)) {
      if (hsl.l >= 0.92) return 'blanc';
      return hsl.l < 0.45 ? 'gris foncé' : 'gris';
    }
    const h = hsl.h;
    let base;
    if (h < 15 || h >= 345) base = 'rouge';
    else if (h < 40) base = 'orange';
    else if (h < 65) base = 'jaune';
    else if (h < 160) base = 'vert';
    else if (h < 200) base = 'turquoise';
    else if (h < 255) base = 'bleu';
    else if (h < 290) base = 'violet';
    else if (h < 330) base = 'magenta';
    else base = 'rose';
    if (hsl.l < 0.3) return base + ' foncé';
    if (hsl.l > 0.78) return base + ' clair';
    return base;
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
    /* La notification visuelle porte l'attribut hidden : un lecteur d'écran
     * n'annonce pas le contenu d'une région masquée puis révélée. Le texte est
     * donc aussi écrit dans une région live permanente, placée hors écran. */
    el.toastLive.textContent = text;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
      el.toastLive.textContent = '';
    }, TOAST_MS);
  }

  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    el.toast.hidden = true;
    el.toastLive.textContent = '';
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

    /* Le plafond d'historique conserve les premiers de la liste. Sans ce tri,
     * un fichier rangé du plus ancien au plus récent perdait à l'import ses
     * mouvements récents au lieu de ses vieux. Les dates sont normalisées en
     * ISO/UTC : l'ordre alphabétique y est l'ordre chronologique. */
    movements.sort((a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0)));

    return { poles, movements, skipped };
  }

  // ---- persistance ----

  function readStored() {
    const raw = store.get(KEY);
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
    const raw = store.get(KEY);
    /* Le quota peut être plein : on continue sans la copie. */
    if (raw) store.trySet(CORRUPT_KEY, raw);
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
    const raw = store.get(CORRUPT_KEY) || store.get(KEY);
    if (!raw) { showToast('err', 'Rien à exporter.'); return; }
    downloadJson('inventaire-perches-brut-' + new Date().toISOString().slice(0, 10) + '.json', raw);
    showToast('ok', 'Contenu brut exporté.');
  }

  function startFresh() {
    if (!confirm('Repartir d’un inventaire vide ? Le contenu illisible reste exportable depuis cet écran tant que tu ne l’as pas remplacé.')) return;
    if (!confirm('Dernière confirmation : vider l’inventaire enregistré ?')) return;
    store.remove(KEY);
    state.readOnly = false;
    load();
    showToast('ok', 'Inventaire réinitialisé.');
  }

  function renderRecovery() {
    const hasBackup = Boolean(store.get(BACKUP_KEY));
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
        /* Une restauration qui échoue à l'enregistrement rendait la vue
         * principale, vide et non enregistrable : on revient explicitement à
         * l'écran de récupération. */
        if (!restoreBackup()) { state.readOnly = true; renderRecovery(); }
      });
    }
  }

  function renderStorageError() {
    el.main.hidden = true;
    el.recovery.hidden = true;
    el.security.hidden = false;
    el.security.innerHTML = `<div class="security-card">
      <h1>Stockage indisponible</h1>
      <p>Ce navigateur refuse d’enregistrer quoi que ce soit sur cet appareil :
      l’inventaire ne peut être ni relu ni conservé.</p>
      <p>C’est le cas en navigation privée sur iPhone, ou lorsque le stockage du site est
      bloqué dans les réglages du navigateur. Ouvre la page dans une fenêtre normale, ou
      autorise le stockage pour ce site, puis recharge.</p>
      <button type="button" class="btn-primary" id="storage-retry">Recharger la page</button>
    </div>`;
    document.getElementById('storage-retry').addEventListener('click', () => location.reload());
  }

  // ---- code PIN ----

  /* crypto.subtle n'existe qu'en contexte sécurisé. Servir l'application en
   * http sur une adresse du réseau local — ce qu'on fait pour l'installer sur
   * les téléphones — laissait le formulaire muet, sans le moindre message. */
  const CRYPTO_ERROR = 'Le code PIN ne peut pas être vérifié ici : la page doit être servie '
    + 'en HTTPS ou depuis localhost.';

  async function hashPin(pin) {
    if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('crypto');
    const bytes = new TextEncoder().encode(pin);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function validPin(pin) { return /^\d{4,8}$/.test(pin); }
  function hasPin() { return Boolean(store.get(PIN_KEY)); }

  async function unlock(pin, confirmation) {
    if (!validPin(pin)) { renderSecurity('Le code PIN doit contenir entre 4 et 8 chiffres.'); return; }
    const setup = !hasPin();
    if (setup && pin !== confirmation) {
      renderSecurity('Les deux codes PIN ne correspondent pas.');
      return;
    }
    let hash;
    try {
      hash = await hashPin(pin);
    } catch (error) {
      renderSecurity(CRYPTO_ERROR);
      return;
    }
    if (setup) {
      if (!store.trySet(PIN_KEY, hash)) {
        renderSecurity('Le code PIN n’a pas pu être enregistré sur cet appareil.');
        return;
      }
    } else if (hash !== store.get(PIN_KEY)) {
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
    const next = prompt('Nouveau code PIN (4 à 8 chiffres) :');
    if (next === null) return;
    if (!validPin(next)) { showToast('err', 'Le nouveau PIN doit contenir entre 4 et 8 chiffres.'); return; }
    const confirmation = prompt('Confirmez le nouveau code PIN :');
    if (next !== confirmation) { showToast('err', 'Les deux nouveaux codes ne correspondent pas.'); return; }
    let currentHash, nextHash;
    try {
      currentHash = await hashPin(current);
      nextHash = await hashPin(next);
    } catch (error) {
      showToast('err', CRYPTO_ERROR);
      return;
    }
    if (currentHash !== store.get(PIN_KEY)) {
      showToast('err', 'Code PIN actuel incorrect.');
      return;
    }
    if (!store.trySet(PIN_KEY, nextHash)) {
      showToast('err', 'Le nouveau code PIN n’a pas pu être enregistré.');
      return;
    }
    showToast('ok', 'Code PIN modifié.');
  }

  function resetApplication() {
    if (store.get(KEY)
      && confirm('Avant d’effacer : exporter une copie de l’inventaire ? Il est lisible sans le code PIN.')) {
      exportRaw();
    }
    if (!confirm('PIN oublié ? Cette opération effacera définitivement l’inventaire local et le code PIN. Continuer ?')) return;
    if (!confirm('Dernière confirmation : supprimer toutes les données locales ?')) return;
    store.remove(KEY);
    store.remove(BACKUP_KEY);
    store.remove(CORRUPT_KEY);
    store.remove(PIN_KEY);
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
      const previousStored = store.get(KEY);
      const previousPoles = state.poles;
      const previousMovements = state.movements;
      state.poles = clean.poles;
      state.movements = clean.movements;
      if (save()) {
        if (previousStored) store.trySet(BACKUP_KEY, previousStored);
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
    const raw = store.get(BACKUP_KEY);
    if (!raw) { showToast('err', 'Aucune copie de secours disponible.'); return false; }
    if (!confirm('Restaurer l’inventaire présent avant le dernier import ?')) return false;
    let clean;
    try {
      clean = normalizeData(JSON.parse(raw));
    } catch (error) {
      showToast('err', 'La copie de secours est invalide.');
      return false;
    }
    const current = store.get(KEY);
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
    if (current) store.trySet(BACKUP_KEY, current);
    showMain();
    render();
    showToast('ok', 'Copie de secours restaurée.');
    return true;
  }

  // ---- actions ----

  function addSize(sizeStr, totalStr) {
    let size = parseFloat(String(sizeStr).replace(',', '.'));
    const total = parseInt(totalStr, 10);
    if (isNaN(size) || size <= 0) { showToast('err', 'Indique une taille valide, en mètres.'); return false; }
    if (size > MAX_SIZE_M) { showToast('err', `Taille improbable : ${MAX_SIZE_M} m au maximum.`); return false; }
    if (isNaN(total) || total < 0) { showToast('err', 'Indique une quantité valide.'); return false; }
    if (state.poles.length >= MAX_POLES) {
      showToast('err', `Limite atteinte : ${MAX_POLES} tailles au maximum.`);
      return false;
    }
    /* L'affichage arrondit à deux décimales : on enregistre la valeur affichée,
     * sans quoi 3,204 et 3,199 deviennent deux lignes « 3,20 m » distinctes. */
    size = Math.round(size * 100) / 100;
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
    const previousTotal = pole.total;
    const previousStock = pole.stock;
    pole.total = total;
    /* Baisser le total sous le stock — perches cassées, prêtées pour de bon —
     * laissait un stock supérieur au total : signalé à l'écran, mais jamais
     * corrigé, et la jauge restait pleine. */
    if (pole.stock > total
      && confirm(`Le stock enregistré (${previousStock}) dépasse le nouveau total (${total}). `
        + 'Aligner le stock sur le total ?')) {
      pole.stock = total;
    }
    if (!save()) {
      pole.total = previousTotal;
      pole.stock = previousStock;
    }
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
      /* Motif « roving tabindex » : un tablist occupe une seule tabulation,
       * on circule ensuite entre les onglets aux flèches. */
      tab.tabIndex = active ? 0 : -1;
      if (active) el.content.setAttribute('aria-labelledby', tab.id);
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
      const left = hexToHsl(a.color);
      const right = hexToHsl(b.color);
      /* Gris, noir et blanc n'ont pas de teinte : regroupés à la fin et classés
       * du plus clair au plus foncé, ils ne se glissent plus parmi les rouges. */
      if (isAchromatic(left) !== isAchromatic(right)) return isAchromatic(left) ? 1 : -1;
      if (isAchromatic(left)) return right.l - left.l;
      return left.h - right.h;
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
            <div class="bar" aria-hidden="true"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
          </div>`;
      }).join('');
      /* L'en-tête de groupe n'était qu'une pastille de couleur : rien à lire
       * pour un lecteur d'écran, et rien à dire à voix haute non plus. */
      const label = group.color
        ? `<span class="color-name">Marquage ${esc(colorName(group.color))}</span>`
        : '<span class="muted">Sans couleur assignée</span>';
      const swatch = `<span class="dot" style="background:${esc(group.color || NO_COLOR)}" aria-hidden="true"></span>`;
      return `
        <div class="color-group">
          <h2 class="color-group-head">${swatch}${label}</h2>
          <div class="grid">${cards}</div>
        </div>`;
    }).join('');

    const inStock = state.poles.reduce((sum, p) => sum + p.stock, 0);
    const declared = state.poles.reduce((sum, p) => sum + p.total, 0);
    const out = Math.max(0, declared - inStock);
    const summary = `<div class="summary">
      <span class="summary-main"><b>${inStock}</b> perche(s) en stock sur ${declared}</span>
      <span class="muted">${out} sortie(s)</span>
    </div>`;

    return `${summary}<div class="legend">Les perches sont regroupées par couleur — assigne une
      couleur à chaque taille depuis Réglages.</div>${sections}`;
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

    const all = state.movements.filter(m => m.type === kind);
    const entries = all.slice(0, HISTORY_SHOWN);
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
        ${all.length > HISTORY_SHOWN
          ? `<div class="muted hist-more">${HISTORY_SHOWN} mouvements les plus récents affichés sur ${all.length}.</div>`
          : ''}
        ${entries.length ? `<div class="foot-actions"><span></span>
          <button class="btn-ghost btn-sm" data-clear-hist="${kind}">Effacer l’historique</button></div>` : ''}
      </div>`;
  }

  function renderReglages() {
    const rows = sortedPoles().map(pole => {
      /* Dix lignes de réglages répètent les mêmes libellés : sans la taille,
       * « Supprimer » et « rouge » ne désignent rien à l'oreille. */
      const sz = esc(fmtSize(pole.size));
      const swatches = PALETTE.map(entry => `
        <button type="button" class="swatch ${pole.color === entry.hex ? 'selected' : ''}"
                style="background:${entry.hex}" data-color-id="${esc(pole.id)}" data-color-hex="${entry.hex}"
                aria-pressed="${pole.color === entry.hex}"
                title="${esc(entry.name)}" aria-label="${esc(entry.name)}"></button>`).join('');
      return `
      <div class="setting-row">
        <div class="setting-row-top">
          <div class="sz">${sz}</div>
          <div>
            <label class="mini-label" for="total-${esc(pole.id)}">Total</label>
            <input type="number" min="0" id="total-${esc(pole.id)}" value="${pole.total}"
                   data-total-id="${esc(pole.id)}" data-focus-key="total-${esc(pole.id)}">
          </div>
          <div class="spacer muted">${pole.stock} en stock actuellement</div>
          <button type="button" class="btn-ghost btn-sm" data-reset-id="${esc(pole.id)}"
                  aria-label="Remettre à niveau le stock des perches de ${sz}">Remettre à niveau</button>
          <button type="button" class="btn-danger btn-sm" data-delete-id="${esc(pole.id)}"
                  aria-label="Supprimer les perches de ${sz}">Supprimer</button>
        </div>
        <div class="swatches" role="group" aria-label="Couleur de marquage des perches de ${sz}">
          <button type="button" class="swatch-auto ${!pole.color ? 'selected' : ''}"
                  data-color-id="${esc(pole.id)}" data-color-hex=""
                  aria-pressed="${!pole.color}">Auto</button>
          ${swatches}
          <input type="color" class="color-picker" data-color-picker-id="${esc(pole.id)}"
                 value="${esc(pole.color || NO_COLOR)}" title="Choisir une couleur libre"
                 aria-label="Couleur libre pour les perches de ${sz}">
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
                  ${store.get(BACKUP_KEY) ? '' : 'disabled'}>Restaurer avant import</button>
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
    const tabs = [...document.querySelectorAll('.tab[data-tab]')];
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        state.activeTab = tab.dataset.tab;
        render();
      });
      /* Un tablist se parcourt aux flèches, Origine et Fin : c'est ce qu'un
       * lecteur d'écran annonce, et ce que la tabulation seule ne permet pas. */
      tab.addEventListener('keydown', event => {
        const step = event.key === 'ArrowRight' ? 1 : (event.key === 'ArrowLeft' ? -1 : 0);
        let next = null;
        if (step !== 0) next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
        else if (event.key === 'Home') next = tabs[0];
        else if (event.key === 'End') next = tabs[tabs.length - 1];
        if (!next) return;
        event.preventDefault();
        state.activeTab = next.dataset.tab;
        render();
        next.focus();
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
    /* Le contrôleur change quand une version déployée depuis prend la main. La
     * page ouverte exécute alors encore l'ancien code. Le test préalable écarte
     * la toute première installation, qui déclenche le même événement sans
     * qu'il y ait de version précédente à remplacer. */
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        showToast('ok', 'Nouvelle version installée — recharge la page pour l’utiliser.');
      });
    }
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => { /* hors ligne au premier chargement */ });
    });
  }

  if (storageAvailable()) {
    attachStaticHandlers();
    registerServiceWorker();
    renderSecurity();
  } else {
    renderStorageError();
  }
})();
