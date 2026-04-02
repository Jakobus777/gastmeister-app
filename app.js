// ========== Error Handler ==========
window.onerror = function(msg, url, line, col, error) {
  console.error('Gastmeister Error:', msg, 'Line:', line);
  var errDiv = document.createElement('div');
  errDiv.style.cssText = 'background:#fdeeed;border:2px solid #dc3a3a;padding:12px 20px;margin:10px;border-radius:8px;font-size:14px;color:#c42828;z-index:9999;position:relative;';
  var strong = document.createElement('strong');
  strong.textContent = 'Fehler: ';
  errDiv.appendChild(strong);
  errDiv.appendChild(document.createTextNode(msg + ' (Zeile ' + line + ')'));
  errDiv.appendChild(document.createElement('br'));
  var btn = document.createElement('button');
  btn.textContent = 'Cache löschen & neu laden';
  btn.style.cssText = 'margin-top:8px;padding:6px 14px;background:#dc3a3a;color:white;border:none;border-radius:6px;cursor:pointer;';
  btn.onclick = function() { localStorage.removeItem('gastmeister_data'); location.reload(); };
  errDiv.appendChild(btn);
  document.body.insertBefore(errDiv, document.body.firstChild);
};

console.log('[Gastmeister] App wird geladen...');

// ========== jsPDF Workaround ==========
// text() setzt intern die PDF-Fill-Farbe auf die Textfarbe.
// setFillColor() überspringt die Ausgabe wenn jsPDF denkt die Farbe ist
// bereits gesetzt. Lösung: kurz eine andere Farbe setzen um den Reset zu erzwingen.
function _pdfFill(doc, r, g, b) {
  doc.setFillColor(r === 0 ? 1 : 0, g === 0 ? 1 : 0, b === 0 ? 1 : 0);
  doc.setFillColor(r, g, b);
}

// ========== HTML Escaping (XSS-Schutz) ==========
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function activeBookings() {
  return bookingsData.filter(function(b) { return b && !b.deletedAt; });
}

function safeCreateIcons() {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { safeCreateIcons(); } catch(e) {}
  }
}

// ========== Datum-Hilfsfunktionen ==========
function splitDateRange(dates) {
  if (!dates) return ['', ''];
  // Unterstützt em-dash, en-dash und normalen Bindestrich
  var parts = dates.split(/\s*[\u2013\u2014\-]\s*/);
  return parts.length >= 2 ? parts : [parts[0] || '', ''];
}

// ========== ID Generator ==========
function generateId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ========== Data Store with localStorage ==========
const STORAGE_KEY = 'gastmeister_data';

const defaultBookings = [];;

const defaultGuests = [];;

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {
    console.error('[Gastmeister] localStorage Daten korrupt:', e);
  }
  return null;
}

const DATA_VERSION = 12;

// ========== IndexedDB via Dexie.js ==========
var gastmeisterDB = null;
if (typeof Dexie !== 'undefined') {
  try {
    gastmeisterDB = new Dexie('GastmeisterDB');
    gastmeisterDB.version(1).stores({
      appData: 'key' // key-value Store: key='main' → alle Daten
    });
  } catch(e) {
    console.warn('[Gastmeister] IndexedDB nicht verfügbar:', e);
    gastmeisterDB = null;
  }
}

// IndexedDB laden (async, überschreibt localStorage-Daten falls vorhanden)
function loadFromIndexedDB(callback) {
  if (!gastmeisterDB) { callback(null); return; }
  gastmeisterDB.appData.get('main').then(function(record) {
    callback(record ? record.data : null);
  }).catch(function(err) { console.warn('[Gastmeister] IndexedDB laden fehlgeschlagen:', err); callback(null); });
}

// IndexedDB speichern (async, parallel zu localStorage)
var _idbTimer = null;
function saveToIndexedDB(data) {
  if (!gastmeisterDB) return;
  clearTimeout(_idbTimer);
  _idbTimer = setTimeout(function() {
    gastmeisterDB.appData.put({ key: 'main', data: data }).catch(function(e) {
      console.warn('IndexedDB Speichern fehlgeschlagen:', e);
    });
  }, 200);
}

// Helper: get guest name whether string or object
function guestName(g) {
  if (!g) return '';
  return typeof g === 'string' ? g : (g.name || '');
}

// Helper: ensure guest is an object
function guestObj(g) {
  if (!g) return { name: '', email: '', telefon: '', notizen: '' };
  if (typeof g === 'string') return { name: g, email: '', telefon: '', notizen: '' };
  return g;
}

var _backupTimer = null;
var _dataDirty = false; // Wird true sobald der User etwas ändert

// ========== GitHub Sync ==========
// GitHubSync wird aus github-sync.js geladen (muss vor app.js eingebunden sein)

function _initSync() {
  // Token aus URL-Parameter übernehmen (z.B. bei Ersteinrichtung)
  var urlToken = new URLSearchParams(window.location.search).get('ghtoken');
  if (urlToken) {
    GitHubSync.setToken(urlToken);
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }
  return Promise.resolve();
}


function saveData() {
  _dataDirty = true;
  invalidateBookingsDayCache();
  const data = { bookings: bookingsData, guests: guestsData, dayGuests: dayGuestsData, mealOverrides: mealOverrides, version: DATA_VERSION, _savedAt: new Date().toISOString() };
  // 1. localStorage (synchron, sofort)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch(e) {
    console.warn('localStorage Speichern fehlgeschlagen:', e);
    if (typeof showToast === 'function') showToast('Speichern fehlgeschlagen! Bitte Daten exportieren.');
  }
  // 2. IndexedDB (async, kein Limit)
  saveToIndexedDB(data);
  // 3. GitHub Sync (debounced, 3 Sekunden)
  if (GitHubSync.hasToken()) {
    GitHubSync.saveData(data).then(function(result) {
      if (result && result.conflict) {
        console.warn('[Sync] Konflikt beim Speichern — lade aktuelle Version');
        GitHubSync.loadData().then(function(loaded) {
          if (loaded && loaded.data && loaded.data.bookings) {
            mergeServerData(loaded.data);
          }
        });
      }
    }).catch(function(e) { console.warn('[Sync] Save fehlgeschlagen:', e); });
  }
}

// Load stored data — migrate from any older version, never discard user data
// Schritt 1: Synchron aus localStorage laden (sofort verfügbar)
const stored = loadData();
const hasStoredData = stored && Array.isArray(stored.bookings) && stored.bookings.length > 0;
const bookingsData = hasStoredData ? stored.bookings : [...defaultBookings];
const guestsData = hasStoredData ? (stored.guests || [...defaultGuests]) : [...defaultGuests];
// dayGuests: [{name, date:'DD.MM.YYYY', pers, bereich:'gaestetrakt'|'konvent', f:bool, m:bool, a:bool, veg:bool}]
const dayGuestsData = (hasStoredData && stored.dayGuests) ? stored.dayGuests : [];
// mealOverrides: { 'name|room|DD.MM.YYYY': {f:bool, m:bool, a:bool} }
const mealOverrides = (hasStoredData && stored.mealOverrides) ? stored.mealOverrides : {};
if (!stored || stored.version !== DATA_VERSION) {
  setTimeout(() => saveData(), 0);
}

// Schritt 2: Async aus IndexedDB laden — falls mehr Daten vorhanden, übernehmen
loadFromIndexedDB(function(idbData) {
  if (!idbData || !idbData.bookings) return;
  // Nicht überschreiben wenn der User bereits Änderungen gemacht hat
  if (_dataDirty) return;
  // IndexedDB hat Vorrang wenn sie neuer ist (Timestamp-Vergleich), Fallback auf Länge
  var localData = stored || {};
  var idbIsNewer = idbData._savedAt && (!localData._savedAt || idbData._savedAt > localData._savedAt);
  var idbHasMore = !idbData._savedAt && !localData._savedAt && idbData.bookings.length > bookingsData.length;
  if (idbIsNewer || idbHasMore) {
    bookingsData.length = 0;
    idbData.bookings.forEach(function(b) { bookingsData.push(b); });
    if (idbData.guests) {
      guestsData.length = 0;
      idbData.guests.forEach(function(g) { guestsData.push(guestObj(g)); });
    }
    if (idbData.dayGuests) {
      dayGuestsData.length = 0;
      idbData.dayGuests.forEach(function(d) { dayGuestsData.push(d); });
    }
    if (idbData.mealOverrides) {
      Object.keys(mealOverrides).forEach(function(k) { delete mealOverrides[k]; });
      Object.assign(mealOverrides, idbData.mealOverrides);
    }
    if (typeof refreshAll === 'function') refreshAll();
    console.log('IndexedDB-Daten geladen (' + bookingsData.length + ' Buchungen)');
  }
});

// Clean data: remove null/undefined entries
for (let i = bookingsData.length - 1; i >= 0; i--) {
  if (!bookingsData[i] || !bookingsData[i].name) bookingsData.splice(i, 1);
}

// Migrate bookings: add id and updatedAt if missing
(function() {
  var migrated = false;
  bookingsData.forEach(function(b) {
    if (!b.id) { b.id = generateId(); migrated = true; }
    if (!b.updatedAt) { b.updatedAt = new Date().toISOString(); migrated = true; }
  });
  if (migrated) setTimeout(function() { saveData(); }, 0);
})();
// Migrate guests: convert strings to objects and remove invalid entries
for (let i = guestsData.length - 1; i >= 0; i--) {
  if (!guestsData[i]) { guestsData.splice(i, 1); continue; }
  if (typeof guestsData[i] === 'string') {
    guestsData[i] = { name: guestsData[i], email: '', telefon: '', notizen: '' };
  }
}

// Migrate mealOverrides: alte Keys ohne Jahreszahl (DD.MM.) → mit Jahreszahl (DD.MM.YYYY)
Object.keys(mealOverrides).forEach(function(key) {
  var parts = key.split('|');
  if (parts.length === 3 && parts[2].match(/^\d{2}\.\d{2}\.$/)) {
    // Jahr aus zugehöriger Buchung ermitteln
    var year = new Date().getFullYear();
    var booking = bookingsData.find(function(b) {
      return !b.deletedAt && b.name === parts[0] && b.room === parts[1];
    });
    if (booking && booking.dates) {
      var match = booking.dates.match(/(\d{4})/);
      if (match) year = parseInt(match[1]);
    }
    var newKey = parts[0] + '|' + parts[1] + '|' + parts[2] + year;
    if (!mealOverrides[newKey]) mealOverrides[newKey] = mealOverrides[key];
    delete mealOverrides[key];
  }
});

// ========== Automatischer Backup-Abgleich (GitHub) ==========
_initSync().then(function syncFromGitHub() {
  if (!GitHubSync.hasToken()) {
    console.log('[Sync] Kein GitHub-Token — nur lokale Daten');
    return;
  }
  GitHubSync.loadData().then(function(result) {
    if (!result || !result.data) return;
    var backup = result.data;
    if (!backup.bookings) return;
    if (_dataDirty) return;

    // Wenn lokal keine Daten: komplettes Backup übernehmen
    if (bookingsData.length === 0 && backup.bookings.length > 0) {
      backup.bookings.forEach(function(b) { bookingsData.push(b); });
      if (backup.guests) { guestsData.length = 0; backup.guests.forEach(function(g) { guestsData.push(guestObj(g)); }); }
      if (backup.dayGuests) { backup.dayGuests.forEach(function(d) { dayGuestsData.push(d); }); }
      if (backup.mealOverrides) { Object.keys(backup.mealOverrides).forEach(function(k) { mealOverrides[k] = backup.mealOverrides[k]; }); }
      saveData();
      refreshAll();
      console.log('[Sync] GitHub-Backup komplett geladen: ' + backup.bookings.length + ' Buchungen');
      return;
    }

    // Merge mit bestehenden Daten
    mergeServerData(backup);
  }).catch(function(e) {
    console.warn('[Sync] GitHub-Abgleich fehlgeschlagen:', e);
    showToast('Sync fehlgeschlagen – lokale Daten werden verwendet', 'warning');
  });
});


// ========== Import JSON Backup ==========
function importBackupJSON(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      // Detect format: our internal format or the full backup format
      if (data.tables && data.tables.bookings) {
        // Full backup from the main system
        importFullBackup(data);
      } else if (data.bookings && Array.isArray(data.bookings)) {
        // Our internal format
        bookingsData.length = 0;
        data.bookings.forEach(b => bookingsData.push(b));
        if (data.guests) {
          guestsData.length = 0;
          data.guests.forEach(g => guestsData.push(guestObj(g)));
        }
        if (data.dayGuests) {
          dayGuestsData.length = 0;
          data.dayGuests.forEach(d => dayGuestsData.push(d));
        }
        if (data.mealOverrides) {
          Object.keys(mealOverrides).forEach(k => delete mealOverrides[k]);
          Object.assign(mealOverrides, data.mealOverrides);
        }
        saveData();
        refreshAll();
        var unknownRooms = [];
        bookingsData.forEach(function(b) {
          if (b.room && allRoomsList.indexOf(b.room) === -1 && unknownRooms.indexOf(b.room) === -1) {
            unknownRooms.push(b.room);
          }
        });
        if (unknownRooms.length > 0) {
          showToast('Warnung: Unbekannte Zimmer im Import: ' + unknownRooms.join(', '), 'warning');
        }
        showToast('Backup importiert (' + bookingsData.length + ' Buchungen)');
      } else {
        showToast('Unbekanntes Dateiformat');
      }
    } catch(err) {
      showToast('Fehler beim Importieren: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function importFullBackup(data) {
  const roomMap = {};
  if (data.tables.rooms) {
    data.tables.rooms.data.forEach(r => { roomMap[r.id] = r.name; });
  }

  // Import bookings (only active ones)
  const newBookings = [];
  if (data.tables.bookings) {
    data.tables.bookings.data.forEach(b => {
      if (b.status === 'storniert') return;
      const room = roomMap[b.roomId] || ('Zimmer ' + b.roomId);
      const checkIn = new Date(b.checkIn);
      const checkOut = new Date(b.checkOut);
      const dates = pad2(checkIn.getDate()) + '.' + pad2(checkIn.getMonth()+1) + '.' + checkIn.getFullYear()
        + ' – ' + pad2(checkOut.getDate()) + '.' + pad2(checkOut.getMonth()+1) + '.' + checkOut.getFullYear();
      newBookings.push({
        name: b.guestName,
        room: room,
        dates: dates,
        pers: (b.personCount || 1) + ' Pers.',
        status: b.status
      });
    });
  }

  // Import guests
  const newGuests = [];
  if (data.tables.guests) {
    data.tables.guests.data.forEach(g => {
      if (g.name && !g.name.includes('Test')) newGuests.push({ name: g.name, email: g.email || '', telefon: g.telefon || '', notizen: g.notizen || '' });
    });
  }

  bookingsData.length = 0;
  newBookings.forEach(b => bookingsData.push(b));
  guestsData.length = 0;
  newGuests.forEach(g => guestsData.push(g));
  // dayGuests und mealOverrides leeren (gehören zu den alten Daten)
  dayGuestsData.length = 0;
  Object.keys(mealOverrides).forEach(k => delete mealOverrides[k]);

  saveData();
  refreshAll();
  var unknownRooms = [];
  bookingsData.forEach(function(b) {
    if (b.room && allRoomsList.indexOf(b.room) === -1 && unknownRooms.indexOf(b.room) === -1) {
      unknownRooms.push(b.room);
    }
  });
  if (unknownRooms.length > 0) {
    showToast('Warnung: Unbekannte Zimmer im Import: ' + unknownRooms.join(', '), 'warning');
  }
  showToast('Backup importiert (' + newBookings.length + ' Buchungen, ' + newGuests.length + ' Gäste)');
}

function updateBackupStats() {
  const el = id => document.getElementById(id);
  if (el('backupStatZimmer')) el('backupStatZimmer').textContent = allRoomsList.length;
  if (el('backupStatGaeste')) el('backupStatGaeste').textContent = guestsData.length;
  if (el('backupStatBuchungen')) el('backupStatBuchungen').textContent = bookingsData.length;
  if (el('backupStatMahlzeiten')) el('backupStatMahlzeiten').textContent = Object.keys(mealOverrides).length;
  if (el('backupStatTagesgaeste')) el('backupStatTagesgaeste').textContent = dayGuestsData.length;
}

function refreshAll() {
  // Immer aktualisieren (günstige Stats):
  updateBuchungenCount();
  updateDashboardStats();
  updateGaesteCount();

  // Nur aktive Seite rendern:
  var activePage = document.querySelector('.page.active');
  var pageId = activePage ? activePage.id : '';

  if (pageId === 'page-uebersicht' || !pageId) renderDailyOverview();
  if (pageId === 'page-buchungen') renderBuchungen();
  if (pageId === 'page-kalender') { document.getElementById('zimmerGrid').innerHTML = ''; document.getElementById('konventGrid').innerHTML = ''; generateZimmer(); generateBelegung(); generateCalendar(); }
  if (pageId === 'page-gaeste') renderGaeste();
  if (pageId === 'page-kuechenliste') renderKuechenliste();
  if (pageId === 'page-statistik') { generateStatBars(); renderStatistikPage(); }
  if (pageId === 'page-spenden') renderSpendenPage();
  if (pageId === 'page-backup') updateBackupStats();
  if (pageId === 'page-exporte') renderExportTable();

  safeCreateIcons();
}

let currentBookingFilter = 'alle';
let currentBookingSearch = '';
let currentGuestSearch = '';
var _gaestePageSize = 50;

// ========== Confirm Dialog ==========
let confirmCallback = null;

function showConfirm(title, text, btnText, callback) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmText').textContent = text;
  document.getElementById('confirmBtn').textContent = btnText || 'Löschen';
  confirmCallback = callback;
  document.getElementById('confirmOverlay').classList.add('active');
}

function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('active');
  confirmCallback = null;
}

function executeConfirm() {
  if (confirmCallback) confirmCallback();
  closeConfirm();
}

// ========== Dynamic Stats ==========
const allRoomsList = [
  'Gunther','Zimmer 1','Zimmer 2','Zimmer 3','Zimmer 4','Zimmer 5','Zimmer 6',
  'Herberge','Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'
];

function parseDateDE(str) {
  if (!str || typeof str !== 'string') return null;
  const p = str.trim().split('.');
  if (p.length >= 3) return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
  return null;
}

function updateDashboardStats() {
  const today = new Date();
  today.setHours(0,0,0,0);

  const dateEl = document.getElementById('dashboard-date');
  if (dateEl) {
    dateEl.textContent = today.toLocaleDateString('de-AT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  }

  const in7 = new Date(today);
  in7.setDate(in7.getDate() + 7);

  // Find which rooms are currently occupied
  let belegtRooms = new Set();
  let anreisen7 = 0;

  bookingsData.forEach(b => {
    if (!b || !b.status) return;
    if (b.deletedAt) return;
    if (b.status === 'storniert' || b.status === 'abgeschlossen') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;

    // Currently occupied?
    if (von <= today && bis >= today) {
      belegtRooms.add(b.room);
    }
    // Arrival in next 7 days?
    if (von >= today && von <= in7) {
      anreisen7++;
    }
  });

  const belegt = belegtRooms.size;
  const frei = allRoomsList.length - belegt;
  const gesamt = allRoomsList.length;

  const cards = document.querySelectorAll('#page-uebersicht .stats-grid .stat-card');
  if (cards.length >= 4) {
    cards[0].querySelector('.stat-value').textContent = frei;
    cards[1].querySelector('.stat-value').textContent = belegt;
    cards[2].querySelector('.stat-value').textContent = gesamt;
    cards[3].querySelector('.stat-value').textContent = anreisen7;
  }
}

// ========== Export JSON to Daten folder ==========
function exportDataJSON() {
  const data = { bookings: bookingsData, guests: guestsData, dayGuests: dayGuestsData, mealOverrides: mealOverrides, exportDate: new Date().toISOString(), version: DATA_VERSION };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gastmeister_backup_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('JSON-Backup heruntergeladen');
}

// ========== Navigation ==========
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  const page = document.getElementById('page-' + pageId);
  if (page) page.classList.add('active');
  const item = document.querySelector('.sidebar-item[data-page="' + pageId + '"]');
  if (item) item.classList.add('active');
  // Render neue Seite beim Wechsel
  if (pageId === 'vorlagen') populateVorlageBuchungen();
  if (pageId === 'uebersicht') renderDailyOverview();
  if (pageId === 'buchungen') renderBuchungen();
  if (pageId === 'kalender') { document.getElementById('zimmerGrid').innerHTML = ''; document.getElementById('konventGrid').innerHTML = ''; generateZimmer(); generateBelegung(); generateCalendar(); }
  if (pageId === 'gaeste') { renderGaeste(); updateGaesteCount(); }
  if (pageId === 'kuechenliste') renderKuechenliste();
  if (pageId === 'statistik') { generateStatBars(); renderStatistikPage(); }
  if (pageId === 'spenden') renderSpendenPage();
  if (pageId === 'backup') updateBackupStats();
  if (pageId === 'exporte') renderExportTable();
  safeCreateIcons();
}

// ========== Sidebar Collapse ==========
var _sidebarCollapseBtn = document.querySelector('.sidebar-collapse-btn');
if (_sidebarCollapseBtn) _sidebarCollapseBtn.addEventListener('click', function() {
  var layout = document.querySelector('.layout');
  if (layout) layout.classList.toggle('sidebar-collapsed');
});

// Sidebar-Items: Enter-Taste unterstützen
document.querySelectorAll('.sidebar-item[role="button"]').forEach(function(item) {
  item.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      item.click();
    }
  });
});

// ========== Toast ==========
function showToast(message, opts) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  // Icon
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'check-circle');
  icon.style.cssText = 'width:16px;height:16px;';
  toast.appendChild(icon);
  // Text
  const textNode = document.createTextNode(' ' + message);
  toast.appendChild(textNode);
  // Undo-Button
  if (opts && opts.undo) {
    const undoSpan = document.createElement('span');
    undoSpan.className = 'toast-undo';
    undoSpan.textContent = 'Rückgängig';
    undoSpan.addEventListener('click', function() {
      opts.undo();
      toast.remove();
    });
    toast.appendChild(undoSpan);
  }
  container.appendChild(toast);
  lucide.createIcons({ nodes: [toast] });
  var duration = (opts && opts.duration) || 3000;
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ========== Undo ==========
var lastDeletedBooking = null;
var lastDeletedIndex = -1;

function undoDeleteBooking() {
  if (lastDeletedBooking && lastDeletedIndex >= 0) {
    var original = bookingsData.find(function(b) { return b.id === lastDeletedBooking.id; });
    if (original) {
      delete original.deletedAt;
      original.updatedAt = new Date().toISOString();
    } else {
      // Fallback: wenn Original nicht mehr im Array (unwahrscheinlich)
      delete lastDeletedBooking.deletedAt;
      lastDeletedBooking.updatedAt = new Date().toISOString();
      bookingsData.push(lastDeletedBooking);
    }
    lastDeletedBooking = null;
    lastDeletedIndex = -1;
    saveData();
    renderBuchungen();
    updateBuchungenCount();
    updateDashboardStats();
    showToast('Buchung wiederhergestellt');
  }
}

// ========== Backup-Status (GitHub) ==========
function checkBackupStatus() {
  if (!GitHubSync.hasToken()) {
    document.getElementById('backupDot').className = 'backup-dot offline';
    document.getElementById('backupLabel').textContent = 'GitHub nicht verbunden';
    return;
  }
  GitHubSync.checkAuth().then(function(ok) {
    document.getElementById('backupDot').className = 'backup-dot ' + (ok ? 'online' : 'offline');
    document.getElementById('backupLabel').textContent = ok ? 'GitHub Sync aktiv' : 'GitHub Fehler!';
  });
}
checkBackupStatus();
setInterval(checkBackupStatus, 60000);

// ========== Sync-Polling ==========
var _localSyncVersion = 0;
var _syncErrorCount = 0;

async function checkForUpdates() {
  if (!GitHubSync.hasToken()) return;
  try {
    var changed = await GitHubSync.hasChanged();
    if (changed) {
      console.log('[Sync] Neue Version auf GitHub erkannt');
      await pullFromServer();
    }
    _syncErrorCount = 0;
  } catch (e) {
    _syncErrorCount++;
    if (_syncErrorCount >= 3) {
      showToast('Sync nicht erreichbar – arbeite offline', 'warning');
      _syncErrorCount = 0;
    }
  }
}

async function pullFromServer() {
  try {
    var result = await GitHubSync.loadData();
    if (!result || !result.data || !result.data.bookings) return;
    mergeServerData(result.data);
  } catch (e) {
    console.warn('[Sync] Pull fehlgeschlagen:', e);
    showToast('Daten-Abgleich fehlgeschlagen', 'warning');
  }
}

var _isMerging = false;
function mergeServerData(serverData) {
  if (_isMerging) return; _isMerging = true;
  const serverBookings = serverData.bookings || [];

  // Index lokale Buchungen nach ID
  const localById = {};
  bookingsData.forEach(function(b) { if (b.id) localById[b.id] = b; });

  var changed = false;

  // Server-Buchungen durchgehen
  serverBookings.forEach(function(sb) {
    if (!sb.id) return;
    const lb = localById[sb.id];
    if (!lb) {
      // Neue Buchung vom Server
      bookingsData.push(sb);
      changed = true;
    } else if (sb.updatedAt && lb.updatedAt && sb.updatedAt > lb.updatedAt) {
      // Server-Version ist neuer — uebernehmen
      Object.assign(lb, sb);
      changed = true;
    } else if (sb.deletedAt && !lb.deletedAt) {
      // Server hat Buchung geloescht, lokal noch nicht — Delete uebernehmen
      lb.deletedAt = sb.deletedAt;
      lb.updatedAt = sb.updatedAt || lb.updatedAt;
      changed = true;
    }
    delete localById[sb.id]; // markieren als verarbeitet
  });

  // Nicht-gematchte Buchungen mit ID behalten (lokale Aenderungen die noch nicht am Server sind)

  // Andere Daten mergen (guests, dayGuests, mealOverrides)
  // Gäste mergen
  if (serverData.guests && serverData.guests.length > 0) {
    var localGuestById = {};
    guestsData.forEach(function(g) { if (g.id) localGuestById[g.id] = g; });

    serverData.guests.forEach(function(sg) {
      if (!sg.id) return;
      var lg = localGuestById[sg.id];
      if (!lg) {
        // Neuer Gast vom Server
        guestsData.push(sg);
        changed = true;
      } else if (sg.updatedAt && (!lg.updatedAt || sg.updatedAt > lg.updatedAt)) {
        // Server-Version ist neuer
        Object.assign(lg, sg);
        changed = true;
      }
    });
  }
  if (serverData.dayGuests && serverData.dayGuests.length > 0) {
    if (serverData.dayGuests.length !== dayGuestsData.length) {
      dayGuestsData.length = 0;
      serverData.dayGuests.forEach(function(d) { dayGuestsData.push(d); });
      changed = true;
    }
  }
  if (serverData.mealOverrides && JSON.stringify(serverData.mealOverrides) !== JSON.stringify(mealOverrides)) {
    Object.keys(mealOverrides).forEach(function(k) { delete mealOverrides[k]; });
    Object.assign(mealOverrides, serverData.mealOverrides);
    changed = true;
  }

  if (changed) {
    console.log('[Sync] Daten vom Server aktualisiert');
    saveData();
    if (typeof refreshAll === 'function') refreshAll();
  }
  _isMerging = false;
}

// Alle 45 Sekunden pruefen, nur wenn Tab sichtbar
var _syncInterval = setInterval(checkForUpdates, 45000);
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') {
    checkForUpdates();
    if (!_syncInterval) _syncInterval = setInterval(checkForUpdates, 45000);
  } else {
    if (_syncInterval) { clearInterval(_syncInterval); _syncInterval = null; }
  }
});

// KI-Analyse: nur Regex-Modus ohne Server
(function() {
  var el = document.getElementById('apiKeyStatus');
  if (el) { el.textContent = 'Regex-Modus'; el.style.cssText = 'font-size:13px;color:var(--text-muted)'; }
  var statusEl = document.getElementById('emailAnalyzeStatus');
  if (statusEl) { statusEl.textContent = 'Regex-Modus'; statusEl.style.cssText = 'font-size:12px;color:var(--text-muted)'; }
})();

// ========== Check-In / Check-Out ==========
function toggleCheckIn(bookingIdx) {
  var b = bookingsData[bookingIdx];
  if (!b) return;
  b.checkedIn = !b.checkedIn;
  b.updatedAt = new Date().toISOString();
  saveData();
  renderDailyOverview();
  renderBuchungen();
  generateZimmer();
  generateBelegung();
  showToast(b.checkedIn ? b.name + ' eingecheckt' : 'Check-In zurückgesetzt');
}

function toggleCheckOut(bookingIdx) {
  var b = bookingsData[bookingIdx];
  if (!b) return;
  b.checkedOut = !b.checkedOut;
  if (b.checkedOut) {
    b.status = 'abgeschlossen';
  } else {
    b.status = 'bestaetigt';
  }
  b.updatedAt = new Date().toISOString();
  saveData();
  renderDailyOverview();
  renderBuchungen();
  generateZimmer();
  generateBelegung();
  showToast(b.checkedOut ? b.name + ' ausgecheckt – Zimmer frei' : 'Check-Out zurückgesetzt');
}

// ========== Modal ==========
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('active');
  });
});

// Close modal on Escape
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }
});

// ========== Vorlagen ==========
// ========== E-Mail Vorlagen ==========
const vorlagenTemplates = {
  bestaetigung: {
    betreff: 'Buchungsbestätigung – Stift Kremsmünster',
    text: `Sehr geehrte(r) {anrede} {name},

herzlichen Dank für Ihre Anfrage. Wir freuen uns, Ihnen mitteilen zu können, dass wir Ihre Buchung bestätigen können.

Ihre Buchungsdetails:
– Anreise: {anreise}
– Abreise: {abreise}
– Zimmer: {zimmer}
– Personen: {personen}

Bitte beachten Sie:
– Anreise ab 14:00 Uhr
– Abreise bis 10:00 Uhr
– Frühstück ist im Aufenthalt inbegriffen

Für Rückfragen stehe ich Ihnen gerne zur Verfügung.

Mit freundlichen Grüßen und Gottes Segen,
P. Jakobus Sieberer-Kefer OSB
Gastmeister
Stift Kremsmünster`
  },
  absage: {
    betreff: 'Ihre Anfrage – Stift Kremsmünster',
    text: `Sehr geehrte(r) {anrede} {name},

herzlichen Dank für Ihre Anfrage. Leider müssen wir Ihnen mitteilen, dass wir für den gewünschten Zeitraum vom {anreise} bis {abreise} keine Verfügbarkeit in unserem Haus haben.

Gerne können wir Ihnen alternative Termine anbieten. Bitte kontaktieren Sie uns, damit wir gemeinsam eine passende Lösung finden.

Wir würden uns freuen, Sie zu einem anderen Zeitpunkt bei uns begrüßen zu dürfen.

Mit freundlichen Grüßen und Gottes Segen,
P. Jakobus Sieberer-Kefer OSB
Gastmeister
Stift Kremsmünster`
  },
  erinnerung: {
    betreff: 'Anreise-Erinnerung – Stift Kremsmünster',
    text: `Sehr geehrte(r) {anrede} {name},

wir freuen uns auf Ihren bevorstehenden Aufenthalt im Stift Kremsmünster.

Zur Erinnerung: Ihre Anreise ist am {anreise} geplant.

– Zimmer: {zimmer}
– Abreise: {abreise}
– Check-in ab 14:00 Uhr

Anfahrt: Das Stift Kremsmünster befindet sich in der Stiftstraße 1, 4550 Kremsmünster. Parkplätze stehen Ihnen kostenlos zur Verfügung.

Sollten sich Änderungen ergeben, bitten wir um rechtzeitige Benachrichtigung.

Wir wünschen Ihnen eine gute Anreise!

Mit freundlichen Grüßen und Gottes Segen,
P. Jakobus Sieberer-Kefer OSB
Gastmeister
Stift Kremsmünster`
  },
  stornierung: {
    betreff: 'Stornierungsbestätigung – Stift Kremsmünster',
    text: `Sehr geehrte(r) {anrede} {name},

hiermit bestätigen wir die Stornierung Ihrer Buchung im Stift Kremsmünster.

– Zimmer: {zimmer}
– Ursprünglicher Zeitraum: {anreise} – {abreise}

Die Stornierung wurde in unserem System vermerkt.

Wir würden uns freuen, Sie in Zukunft bei uns begrüßen zu dürfen.

Mit freundlichen Grüßen und Gottes Segen,
P. Jakobus Sieberer-Kefer OSB
Gastmeister
Stift Kremsmünster`
  }
};

function updateVorlagePreview() {
  const typ = document.getElementById('vorlageTyp').value;
  const tmpl = vorlagenTemplates[typ];
  if (!tmpl) return;

  const anrede = document.getElementById('vorlageAnrede').value || '';
  const name = document.getElementById('vorlageName').value || '___';
  const anreise = document.getElementById('vorlageAnreise').value || '___';
  const abreise = document.getElementById('vorlageAbreise').value || '___';
  const zimmer = document.getElementById('vorlageZimmer').value || '___';
  const personen = document.getElementById('vorlagePersonen').value || '1';

  const text = tmpl.text
    .replace(/\{anrede\}/g, anrede)
    .replace(/\{name\}/g, name)
    .replace(/\{anreise\}/g, anreise)
    .replace(/\{abreise\}/g, abreise)
    .replace(/\{zimmer\}/g, zimmer)
    .replace(/\{personen\}/g, personen);

  document.getElementById('vorlagePreview').textContent = text;
  document.getElementById('vorlageBetreff').textContent = tmpl.betreff;
}

function fillVorlageFromBooking() {
  const sel = document.getElementById('vorlageBuchung');
  const idx = parseInt(sel.value);
  if (isNaN(idx) || idx < 0 || idx >= bookingsData.length) return;

  const b = bookingsData[idx];
  const parts = splitDateRange(b.dates);
  document.getElementById('vorlageAnreise').value = parts[0] ? parts[0].trim() : '';
  document.getElementById('vorlageAbreise').value = parts[1] ? parts[1].trim() : '';

  document.getElementById('vorlageName').value = b.name;
  document.getElementById('vorlageZimmer').value = b.room;
  document.getElementById('vorlagePersonen').value = parseInt(b.pers) || 1;

  updateVorlagePreview();
}

function populateVorlageBuchungen() {
  const sel = document.getElementById('vorlageBuchung');
  sel.innerHTML = '<option value="">Buchung wählen...</option>';
  bookingsData.forEach((b, i) => {
    if (b.deletedAt) return;
    if (b.status === 'storniert' || b.status === 'abgeschlossen') return;
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = b.name + ' – ' + b.room + ' (' + b.dates + ')';
    sel.appendChild(opt);
  });
}

function copyVorlage() {
  const text = document.getElementById('vorlagePreview').textContent;
  navigator.clipboard.writeText(text).then(() => {
    showToast('E-Mail-Text in Zwischenablage kopiert');
  }).catch(() => {
    showToast('Kopieren fehlgeschlagen');
  });
}

function copyBetreff() {
  const text = document.getElementById('vorlageBetreff').textContent;
  navigator.clipboard.writeText(text).then(() => {
    showToast('Betreff kopiert');
  });
}

// ========== Day Detail Modal ==========
function showDayDetail(dateObj) {
  const dayBookings = findAllBookingsForDay(dateObj);
  const dayStr = pad2(dateObj.getDate()) + '.' + pad2(dateObj.getMonth() + 1) + '.' + dateObj.getFullYear();
  document.getElementById('dayDetailTitle').textContent = 'Belegung am ' + dayStr;

  let html = '';
  if (dayBookings.length === 0) {
    html = '<div style="text-align:center;padding:30px 20px;color:var(--text-muted);">Keine Buchungen an diesem Tag.</div>';
  } else {
    // Group by room
    const byRoom = {};
    dayBookings.forEach(b => {
      if (!byRoom[b.room]) byRoom[b.room] = [];
      byRoom[b.room].push(b);
    });
    Object.keys(byRoom).forEach(room => {
      html += '<div style="margin-bottom:14px;">';
      html += '<div style="font-weight:600;font-size:14px;margin-bottom:6px;display:flex;align-items:center;gap:6px;"><i data-lucide="bed-single" style="width:16px;height:16px;"></i> ' + escHtml(room) + '</div>';
      byRoom[room].forEach(b => {
        html += '<div class="guest-list-card" style="margin-bottom:6px;cursor:pointer;" onclick="closeModal(\'modalDayDetail\');openBookingEditByIndex(' + bookingsData.indexOf(b) + ')">';
        html += '<div class="guest-list-left"><div class="guest-avatar"><i data-lucide="user" style="width:16px;height:16px;"></i></div>';
        html += '<div><div style="font-weight:600;">' + escHtml(b.name) + '</div>';
        html += '<div style="font-size:12px;color:var(--text-secondary);">' + escHtml(b.dates) + ' · ' + escHtml(b.pers) + '</div>';
        html += '</div></div></div>';
      });
      html += '</div>';
    });
  }

  document.getElementById('dayDetailBody').innerHTML = html;
  openModal('modalDayDetail');
  safeCreateIcons();
}

// ========== Belegungsvorschau ==========
function generateBelegung() {
  const grid = document.getElementById('belegungGrid');
  grid.innerHTML = '';
  const wds = ['SO','MO','DI','MI','DO','FR','SA'];
  const today = new Date();
  today.setHours(0,0,0,0);

  // Pre-filter: only bookings that could overlap with the next 14 days
  const futureLimit = new Date(today);
  futureLimit.setDate(futureLimit.getDate() + 14);
  const relevantBookings = bookingsData.filter(b => {
    if (!b || !b.status) return false;
    if (b.deletedAt) return false;
    if (b.status === 'storniert' || b.status === 'abgeschlossen') return false;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return false;
    const bis = parseDateDE(parts[1]);
    if (!bis) return false;
    bis.setHours(0,0,0,0);
    if (bis < today) return false; // already ended
    const von = parseDateDE(parts[0]);
    if (!von) return false;
    von.setHours(0,0,0,0);
    if (von > futureLimit) return false; // starts after our window
    return true;
  });

  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    d.setHours(0,0,0,0);
    const wd = wds[d.getDay()];
    const day = d.getDate();
    const dayTime = d.getTime();

    // Count occupied rooms for this day
    const occupiedRooms = new Set();
    relevantBookings.forEach(b => {
      const parts = splitDateRange(b.dates);
      const von = parseDateDE(parts[0]);
      const bis = parseDateDE(parts[1]);
      von.setHours(0,0,0,0);
      bis.setHours(0,0,0,0);
      // Abreisetag nicht als belegt zählen (Checkout bis 10:00)
      if (dayTime >= von.getTime() && dayTime < bis.getTime()) {
        occupiedRooms.add(b.room);
      }
    });

    const o = occupiedRooms.size;
    const totalRooms = allRoomsList.length;
    const frei = totalRooms - o;

    let barClass = 'frei';
    if (o >= Math.ceil(totalRooms * 0.75)) barClass = 'voll';
    else if (o >= Math.ceil(totalRooms * 0.5)) barClass = 'halb';
    else if (o >= 1) barClass = 'wenig';

    const el = document.createElement('div');
    el.className = 'belegung-day';
    el.style.cursor = 'pointer';
    el.innerHTML = `
      <div class="belegung-weekday">${wd}</div>
      <div class="belegung-date">${day}</div>
      <div class="belegung-bars">
        <div class="belegung-bar frei">${frei}</div>
        <div class="belegung-bar ${o > 0 ? barClass : 'frei'}">${o > 0 ? o : ''}</div>
      </div>`;
    el.addEventListener('click', (function(dateObj) {
      return function() { showDayDetail(dateObj); };
    })(new Date(d)));
    grid.appendChild(el);
  }
}

// ========== Zimmer Cards ==========
// Zimmer-Stammdaten (statisch)
const zimmerStamm = {
  gaeste: [
    { name:'Gunther', type:'Einzelzimmer', cap:'1 Person', desc:'Einzelzimmer "Gunther" im Gästetrakt' },
    { name:'Zimmer 1', type:'Einzelzimmer', cap:'1 Person', desc:'Einzelzimmer im Gästetrakt' },
    { name:'Zimmer 2', type:'Einzelzimmer', cap:'1 Person', desc:'Einzelzimmer im Gästetrakt' },
    { name:'Zimmer 3', type:'Doppelzimmer', cap:'bis 3 Personen', desc:'Doppelzimmer im Gästetrakt' },
    { name:'Zimmer 4', type:'Doppelzimmer', cap:'bis 3 Personen', desc:'Doppelzimmer im Gästetrakt' },
    { name:'Zimmer 5', type:'Doppelzimmer', cap:'bis 3 Personen', desc:'Doppelzimmer im Gästetrakt' },
    { name:'Zimmer 6', type:'Doppelzimmer', cap:'bis 3 Personen', desc:'Doppelzimmer im Gästetrakt' },
    { name:'Herberge', type:'Mehrbettzimmer', cap:'bis 8 Personen', desc:'Mehrbettzimmer im Gästetrakt' },
  ],
  konvent: [
    { name:'Hospes I', type:'Konvent', cap:'1 Person', desc:'Nur für Männer' },
    { name:'Hospes II', type:'Konvent', cap:'1 Person', desc:'Nur für Männer' },
    { name:'Hospes III', type:'Konvent', cap:'1 Person', desc:'Nur für Männer' },
    { name:'Hospes VII', type:'Konvent', cap:'1 Person', desc:'Nur für Männer' },
    { name:'Hospes VIII', type:'Konvent', cap:'1 Person', desc:'Nur für Männer' },
    { name:'Hospes IX', type:'Konvent', cap:'1 Person', desc:'Nur für Männer' },
  ]
};

// Check-out: 10:00 am Abreisetag, Check-in: 14:00 am Anreisetag
const CHECKOUT_HOUR = 10;
const CHECKIN_HOUR = 14;

function findCurrentGuest(roomName) {
  const now = new Date();
  for (const b of bookingsData) {
    if (!b || !b.room) continue;
    if (b.deletedAt) continue;
    if (b.room !== roomName) continue;
    if (b.status === 'storniert' || b.status === 'abgeschlossen') continue;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) continue;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) continue;
    // Anreise ab 14:00
    von.setHours(CHECKIN_HOUR, 0, 0, 0);
    // Abreise bis 10:00
    bis.setHours(CHECKOUT_HOUR, 0, 0, 0);
    if (now >= von && now <= bis) {
      const abreiseStr = parts[1].trim();
      return { name: b.name, detail: 'Abreise ' + abreiseStr + ' (bis ' + CHECKOUT_HOUR + ':00)', pers: b.pers };
    }
  }
  return null;
}

function generateZimmer() {
  const grid = document.getElementById('zimmerGrid');
  const konventGrid = document.getElementById('konventGrid');
  grid.innerHTML = '';
  konventGrid.innerHTML = '';

  function renderCard(z, container) {
    // Dynamically determine occupancy
    const currentGuest = findCurrentGuest(z.name);
    const enriched = { ...z, status: currentGuest ? 'belegt' : 'frei' };
    if (currentGuest) {
      enriched.guest = currentGuest.name;
      enriched.guestDetail = currentGuest.detail;
      enriched.guestPers = currentGuest.pers;
    }

    const card = document.createElement('div');
    card.className = 'zimmer-card' + (enriched.status === 'belegt' ? ' belegt-card' : '');

    let guestHtml = '';
    if (enriched.guest) {
      const persInfo = enriched.guestPers ? ' · ' + enriched.guestPers : '';
      guestHtml = `<div class="guest-info">
        <div class="guest-name">${escHtml(enriched.guest)}</div>
        <div class="guest-detail">${escHtml(enriched.guestDetail || '')}${persInfo}</div>
      </div>`;
    }

    card.innerHTML = `
      <div class="zimmer-card-header">
        <div>
          <div class="zimmer-card-title-row">
            <span class="zimmer-name">${enriched.name}</span>
            <span class="badge badge-${enriched.status === 'frei' ? 'frei' : 'belegt'}">${enriched.status === 'frei' ? 'Frei' : 'Belegt'}</span>
          </div>
          <div class="zimmer-type">${enriched.type}</div>
        </div>
        <span class="chevron-link"><i data-lucide="chevron-right" style="width:16px;height:16px;"></i></span>
      </div>
      <div class="zimmer-info">
        <i data-lucide="bed-single" style="width:13px;height:13px;"></i>
        <span>${enriched.cap}</span>
      </div>
      ${!enriched.guest ? '<div class="zimmer-desc">' + escHtml(enriched.desc) + '</div>' : ''}
      ${guestHtml}`;

    card.addEventListener('click', () => showZimmerDetail(enriched));
    container.appendChild(card);
  }

  zimmerStamm.gaeste.forEach(z => renderCard(z, grid));
  zimmerStamm.konvent.forEach(z => renderCard(z, konventGrid));
}

// ========== Zimmer Detail ==========
function showZimmerDetail(zimmer) {
  document.getElementById('zimmerDetailTitle').textContent = zimmer.name;
  document.getElementById('zimmerDetailName').textContent = zimmer.name;
  document.getElementById('zimmerDetailType').textContent = zimmer.type + ' · ' + zimmer.cap;

  const badgeEl = document.getElementById('zimmerDetailBadge');
  badgeEl.innerHTML = zimmer.status === 'frei'
    ? '<span class="badge badge-frei">Frei</span>'
    : '<span class="badge badge-belegt">Belegt</span>';

  // Find all bookings for this room
  const roomBookings = bookingsData.filter(b => !b.deletedAt && b.room === zimmer.name);

  // Parse date string "DD.MM.YYYY" to Date
  function parseDate(str) {
    const parts = str.trim().split('.');
    return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  }

  // Sort by start date
  roomBookings.sort((a, b) => {
    const aStart = parseDate(splitDateRange(a.dates)[0]);
    const bStart = parseDate(splitDateRange(b.dates)[0]);
    return aStart - bStart;
  });

  const today = new Date();
  today.setHours(0,0,0,0);
  const body = document.getElementById('zimmerDetailBody');

  if (roomBookings.length === 0 && !zimmer.guest) {
    body.innerHTML = `
      <div class="zimmer-detail-empty">
        <div class="zimmer-detail-empty-icon"><i data-lucide="calendar-x" style="width:40px;height:40px;"></i></div>
        <div style="font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">Keine Buchungen</div>
        <div>Für dieses Zimmer sind aktuell keine Buchungen geplant.</div>
      </div>
      <div class="zimmer-detail-action-row">
        <button class="btn btn-primary" style="flex:1;justify-content:center;" onclick="closeModal('modalZimmerDetail');prefillBuchung('${zimmer.name}')">
          <i data-lucide="plus" style="width:16px;height:16px;"></i> Buchung für ${zimmer.name} erstellen
        </button>
      </div>`;
    openModal('modalZimmerDetail');
    lucide.createIcons({ nodes: [body, badgeEl] });
    return;
  }

  // Separate current guest (from zimmer data) and upcoming bookings
  let currentHtml = '';
  if (zimmer.guest) {
    currentHtml = `
      <div class="zimmer-detail-section-title">Aktueller Gast</div>
      <ul class="zimmer-detail-list">
        <li class="zimmer-detail-item">
          <div class="zimmer-detail-dot current"></div>
          <div>
            <div class="zimmer-detail-guest-name">${escHtml(zimmer.guest)}${renderStammgastBadge(zimmer.guest)}</div>
            <div class="zimmer-detail-dates">
              <i data-lucide="calendar" style="width:13px;height:13px;"></i>
              ${escHtml(zimmer.guestDetail || '')}
            </div>
          </div>
        </li>
      </ul>`;
  }

  let upcomingHtml = '';
  if (roomBookings.length > 0) {
    let items = '';
    roomBookings.forEach(b => {
      const badgeClass = b.status === 'anfrage' ? 'badge-anfrage' :
                         b.status === 'bestaetigt' ? 'badge-bestaetigt' :
                         b.status === 'storniert' ? 'badge-storniert' : 'badge-abgeschlossen';
      const badgeText = b.status === 'anfrage' ? 'Anfrage' :
                        b.status === 'bestaetigt' ? 'Bestätigt' :
                        b.status === 'storniert' ? 'Storniert' : 'Abgeschlossen';

      items += `
        <li class="zimmer-detail-item">
          <div class="zimmer-detail-dot upcoming"></div>
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:8px;">
              <div class="zimmer-detail-guest-name">${escHtml(b.name)}</div>
              <span class="badge ${badgeClass}" style="font-size:11px;padding:1px 8px;">${badgeText}</span>${renderStammgastBadge(b.name)}
            </div>
            <div class="zimmer-detail-dates">
              <i data-lucide="calendar" style="width:13px;height:13px;"></i>
              ${b.dates}
            </div>
            <div class="zimmer-detail-meta">${escHtml(b.pers)}</div>${b.notes ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:4px;"><i data-lucide="sticky-note" style="width:11px;height:11px;"></i> ${escHtml(b.notes)}</div>` : ''}${renderActivityTags(b.activities)}${(() => { const pa = getGuestPastActivities(b.name); return pa.length > 0 ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Letzte Aktivitäten: ' + pa.map(escHtml).join(', ') + '</div>' : ''; })()}
          </div>
        </li>`;
    });
    upcomingHtml = `
      <div class="zimmer-detail-section-title">Geplante Buchungen (${roomBookings.length})</div>
      <ul class="zimmer-detail-list">${items}</ul>`;
  }

  body.innerHTML = currentHtml + upcomingHtml + `
    <div class="zimmer-detail-action-row">
      <button class="btn btn-primary" style="flex:1;justify-content:center;" onclick="closeModal('modalZimmerDetail');prefillBuchung('${zimmer.name}')">
        <i data-lucide="plus" style="width:16px;height:16px;"></i> Neue Buchung für ${zimmer.name}
      </button>
    </div>`;

  openModal('modalZimmerDetail');
  lucide.createIcons({ nodes: [body, badgeEl] });
}

function prefillBuchung(roomName) {
  // Pre-set today as anreise so dropdown gets populated
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  document.getElementById('buchungAnreise').value = today.toISOString().slice(0,10);
  document.getElementById('buchungAbreise').value = tomorrow.toISOString().slice(0,10);
  updateZimmerDropdown();
  document.getElementById('buchungZimmer').value = roomName;
  openModal('modalBuchung');
}

// ========== Activity Tag Helpers ==========
const activityIcons = {
  'Stiftsführung': '\u{1F3DB}\uFE0F',
  'Sternwarte': '\u{1F52D}',
  'Bibliothek': '\u{1F4DA}',
  'Exerzitien': '\u{1F54A}\uFE0F',
  'Ausflug': '\u{1F6B6}',
  'Kunstsammlungen': '\u{1F3A8}',
  'Fischkalter': '\u{1F41F}',
  'Gottesdienst': '\u26EA'
};

function renderActivityTags(activities) {
  if (!activities || activities.length === 0) return '';
  return '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">' +
    activities.map(a => {
      const icon = activityIcons[a] || '\u{1F4CC}';
      return '<span class="activity-tag">' + icon + ' ' + escHtml(a) + '</span>';
    }).join('') +
    '</div>';
}

function getGuestPattern(guestName) {
  const lowerName = guestName.toLowerCase();
  const monthNamesDE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const checkinMonths = [];
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    const bName = b.name.toLowerCase();
    if (bName !== lowerName && !bName.includes(lowerName) && !lowerName.includes(bName)) return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 1) return;
    const von = parseDateDE(parts[0]);
    if (!von) return;
    checkinMonths.push(von.getMonth());
  });
  if (checkinMonths.length < 3) return null;
  // Count frequency of each month
  const freq = {};
  checkinMonths.forEach(m => { freq[m] = (freq[m] || 0) + 1; });
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const total = checkinMonths.length;
  // Check for single dominant month (60%+)
  if (sorted[0][1] / total >= 0.6) {
    return 'Kommt j\u00E4hrlich im ' + monthNamesDE[parseInt(sorted[0][0])];
  }
  // Check for two dominant months (together 60%+)
  if (sorted.length >= 2 && (sorted[0][1] + sorted[1][1]) / total >= 0.6) {
    const m1 = parseInt(sorted[0][0]);
    const m2 = parseInt(sorted[1][0]);
    const months = [m1, m2].sort((a, b) => a - b);
    return 'Kommt 2x j\u00E4hrlich (' + monthNamesDE[months[0]] + ' & ' + monthNamesDE[months[1]] + ')';
  }
  return null;
}

function getGuestPastBookingCount(guestName) {
  const lowerName = guestName.toLowerCase();
  let count = 0;
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status !== 'abgeschlossen') return;
    const bName = b.name.toLowerCase();
    if (bName === lowerName || bName.includes(lowerName) || lowerName.includes(bName)) count++;
  });
  return count;
}

function renderStammgastBadge(guestName) {
  const pastCount = getGuestPastBookingCount(guestName);
  if (pastCount < 2) return '';
  const visitNum = pastCount + 1;
  return ' <span style="font-size:10px;padding:1px 6px;border-radius:9999px;background:var(--accent-bg);color:var(--accent);border:1px solid #e8ddd4;">Stammgast \u00B7 ' + visitNum + '. Besuch</span>';
}

function getGuestPastActivities(guestName) {
  const lowerName = guestName.toLowerCase();
  const today = new Date();
  today.setHours(0,0,0,0);
  const allActivities = [];
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    const bName = b.name.toLowerCase();
    if (bName !== lowerName && !bName.includes(lowerName) && !lowerName.includes(bName)) return;
    if (!b.activities || b.activities.length === 0) return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const bis = parseDateDE(parts[1]);
    if (!bis) return;
    bis.setHours(0,0,0,0);
    if (bis < today) {
      b.activities.forEach(a => { if (!allActivities.includes(a)) allActivities.push(a); });
    }
  });
  return allActivities;
}

// ========== Buchungen ==========
function renderBuchungen() {
  const list = document.getElementById('buchungenList');
  list.innerHTML = '';
  const search = currentBookingSearch.toLowerCase();

  const showPast = document.querySelector('#page-buchungen .filter-tab.active[data-show-past]');
  const filtered = bookingsData.filter(b => {
    if (!b || !b.name) return false;
    if (b.deletedAt) return false;
    // Filter by status
    if (currentBookingFilter !== 'alle' && b.status !== currentBookingFilter) return false;
    // Abgeschlossene immer anzeigen (können bearbeitet werden)
    // Filter by search
    if (search) {
      const haystack = (b.name + ' ' + b.room + ' ' + b.dates + ' ' + (b.notes || '')).toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text-muted);">Keine Buchungen gefunden.</div>';
    return;
  }

  var PAGE_SIZE = 50;
  var showCount = list._showCount || PAGE_SIZE;
  if (list._lastFilterLen !== filtered.length) showCount = PAGE_SIZE; // Reset bei neuem Filter
  list._lastFilterLen = filtered.length;
  list._showCount = showCount;
  var showing = filtered.slice(0, showCount);
  if (filtered.length > showCount) {
    var infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'padding:8px 14px;font-size:13px;color:var(--text-secondary);margin-bottom:8px;';
    infoDiv.textContent = filtered.length + ' Buchungen gefunden – zeige ' + showCount + ' von ' + filtered.length + '.';
    list.appendChild(infoDiv);
  }

  showing.forEach(b => {
    const badgeClass = b.status === 'anfrage' ? 'badge-anfrage' :
                       b.status === 'bestaetigt' ? 'badge-bestaetigt' :
                       b.status === 'storniert' ? 'badge-storniert' : 'badge-abgeschlossen';
    const badgeText = b.status === 'anfrage' ? 'Anfrage' :
                      b.status === 'bestaetigt' ? 'Bestätigt' :
                      b.status === 'storniert' ? 'Storniert' : 'Abgeschlossen';

    // Check-In/Out Badges
    let checkinBadge = '';
    if (b.checkedIn && !b.checkedOut) checkinBadge = ' <span class="badge badge-checkedin" style="font-size:10px;padding:1px 8px;">Eingecheckt</span>';
    if (b.checkedOut) checkinBadge = ' <span class="badge badge-checkedout" style="font-size:10px;padding:1px 8px;">Ausgecheckt</span>';

    const card = document.createElement('div');
    card.className = 'booking-card';
    const notesHtml = b.notes ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:4px;"><i data-lucide="sticky-note" style="width:12px;height:12px;"></i> ${escHtml(b.notes)}</div>` : '';
    const activitiesHtml = renderActivityTags(b.activities);
    const spendeHtml = b.spende && b.spende > 0 ? `<div style="font-size:12px;color:var(--green);margin-top:3px;display:flex;align-items:center;gap:4px;font-weight:600;"><i data-lucide="heart" style="width:12px;height:12px;"></i> ${formatEUR(b.spende)}</div>` : '';
    card.innerHTML = `
      <div class="booking-info">
        <h3>${escHtml(b.name)} <span class="badge ${badgeClass}">${badgeText}</span>${checkinBadge}${renderStammgastBadge(b.name)}</h3>
        <div class="booking-room">${escHtml(b.room)}</div>
        <div class="booking-date">
          <i data-lucide="calendar" style="width:13px;height:13px;"></i>
          ${escHtml(b.dates)}&nbsp;&nbsp;${escHtml(b.pers)}
        </div>
        ${notesHtml}
        ${activitiesHtml}
        ${spendeHtml}
      </div>
      <div class="booking-actions">
        <button class="icon-btn edit-btn"><i data-lucide="pencil" style="width:16px;height:16px;"></i></button>
        <button class="icon-btn delete"><i data-lucide="trash-2" style="width:16px;height:16px;"></i></button>
      </div>`;

    // Edit button
    card.querySelector('.icon-btn.edit-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      const idx = bookingsData.indexOf(b);
      if (idx > -1) openBookingEditByIndex(idx);
    });

    // Delete button
    card.querySelector('.icon-btn.delete').addEventListener('click', function(e) {
      e.stopPropagation();
      showConfirm('Buchung löschen?', 'Die Buchung von "' + escHtml(b.name) + '" wird gelöscht. Sie können dies danach rückgängig machen.', 'Löschen', function() {
        const idx = bookingsData.indexOf(b);
        if (idx > -1) {
          lastDeletedBooking = JSON.parse(JSON.stringify(b));
          lastDeletedIndex = idx;
          b.deletedAt = new Date().toISOString();
          b.updatedAt = new Date().toISOString();
          saveData();
          renderBuchungen();
          updateBuchungenCount();
          updateDashboardStats();
          showToast('Buchung gelöscht', { duration: 6000, undo: undoDeleteBooking });
        }
      });
    });

    list.appendChild(card);
  });

  // "Mehr laden"-Button wenn noch weitere Buchungen vorhanden
  if (filtered.length > showCount) {
    var moreBtn = document.createElement('button');
    moreBtn.className = 'btn btn-full mt-16';
    moreBtn.textContent = 'Weitere ' + Math.min(PAGE_SIZE, filtered.length - showCount) + ' von ' + (filtered.length - showCount) + ' laden';
    moreBtn.addEventListener('click', function() {
      list._showCount = showCount + PAGE_SIZE;
      renderBuchungen();
    });
    list.appendChild(moreBtn);
  }

  lucide.createIcons({ nodes: [list] });
}

function updateBuchungenCount() {
  const sub = document.querySelector('#page-buchungen .page-subtitle');
  const activeCount = bookingsData.filter(b => b && !b.deletedAt && b.status && b.status !== 'abgeschlossen').length;
  if (sub) sub.textContent = activeCount + ' aktuelle/zukünftige Buchungen';
}

// ========== Buchungen Search ==========
function initBuchungenSearch() {
  const input = document.querySelector('#page-buchungen .search-bar input');
  input.addEventListener('input', function() {
    currentBookingSearch = this.value;
    renderBuchungen();
  });
}

// ========== Buchungen Filter ==========
function initBuchungenFilter() {
  const tabs = document.querySelectorAll('#page-buchungen .filter-tab');
  const statusMap = {
    'Alle': 'alle',
    'Anfrage': 'anfrage',
    'Bestätigt': 'bestaetigt',
    'Storniert': 'storniert',
    'Abgeschlossen': 'abgeschlossen',
  };

  tabs.forEach(tab => {
    if (tab.textContent === 'Vergangene anzeigen') {
      tab.addEventListener('click', function() {
        this.classList.toggle('active');
        showToast(this.classList.contains('active') ? 'Vergangene werden angezeigt' : 'Vergangene ausgeblendet');
      });
      return;
    }

    tab.addEventListener('click', function() {
      tabs.forEach(t => {
        if (t.textContent !== 'Vergangene anzeigen') t.classList.remove('active');
      });
      this.classList.add('active');
      currentBookingFilter = statusMap[this.textContent] || 'alle';
      renderBuchungen();
    });
  });
}

// ========== Save Buchung ==========
function saveBuchung() {
  const gast = document.getElementById('buchungGast').value.trim();
  const zimmer = document.getElementById('buchungZimmer').value;
  const anreise = document.getElementById('buchungAnreise').value;
  const abreise = document.getElementById('buchungAbreise').value;
  const personen = document.getElementById('buchungPersonen').value;
  const status = document.getElementById('buchungStatus').value;
  const notizen = document.getElementById('buchungNotizen').value.trim();

  if (!gast || !zimmer || !anreise || !abreise) {
    showToast('Bitte alle Pflichtfelder ausfüllen');
    return;
  }

  if (anreise >= abreise) {
    showToast('Abreisedatum muss nach dem Anreisedatum liegen');
    return;
  }

  // Conflict detection
  const newVon = new Date(anreise);
  const newBis = new Date(abreise);
  newVon.setHours(CHECKIN_HOUR, 0, 0, 0);
  newBis.setHours(CHECKOUT_HOUR, 0, 0, 0);

  for (let i = 0; i < bookingsData.length; i++) {
    const b = bookingsData[i];
    if (b.room !== zimmer) continue;
    if (b.status === 'storniert' || b.status === 'abgeschlossen' || b.deletedAt) continue;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) continue;
    const bVon = parseDateDE(parts[0]);
    const bBis = parseDateDE(parts[1]);
    if (!bVon || !bBis) continue;
    bVon.setHours(CHECKIN_HOUR, 0, 0, 0);
    bBis.setHours(CHECKOUT_HOUR, 0, 0, 0);
    if (bVon < newBis && bBis > newVon) {
      const conflictDates = parts[0].trim().replace(/\.\d{4}$/, '.') + ' – ' + parts[1].trim();
      showToast('Konflikt: ' + zimmer + ' ist belegt von ' + b.name + ' (' + conflictDates + ')');
      return;
    }
  }

  const formatDate = (d) => {
    const parts = d.split('-');
    return parts[2] + '.' + parts[1] + '.' + parts[0];
  };

  const validPersonen = Math.max(1, parseInt(personen) || 1);
  const newBooking = {
    id: generateId(),
    name: gast,
    room: zimmer,
    dates: formatDate(anreise) + ' – ' + formatDate(abreise),
    pers: validPersonen + ' Pers.',
    status: status,
    updatedAt: new Date().toISOString(),
  };
  if (notizen) newBooking.notes = notizen;
  bookingsData.unshift(newBooking);

  // Reset form
  document.getElementById('buchungGast').value = '';
  document.getElementById('buchungZimmer').value = '';
  document.getElementById('buchungAnreise').value = '';
  document.getElementById('buchungAbreise').value = '';
  document.getElementById('buchungPersonen').value = '1';
  document.getElementById('buchungStatus').value = 'anfrage';
  document.getElementById('buchungNotizen').value = '';

  closeModal('modalBuchung');
  saveData();
  syncGuestsFromBookings();
  renderBuchungen();
  updateBuchungenCount();
  updateDashboardStats();
  renderGaeste();
  updateGaesteCount();
  showToast('Buchung erstellt');
}

// ========== Kalender ==========
let editingBookingIdx = -1;
let calWeekStart = getMonday(new Date());

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0,0,0,0);
  return date;
}

const calRoomSections = [
  { section:'GÄSTETRAKT', rooms:[
    { name:'Gunther', type:'EZ' },{ name:'Zimmer 1', type:'EZ' },
    { name:'Zimmer 2', type:'EZ' },{ name:'Zimmer 3', type:'DZ' },
    { name:'Zimmer 4', type:'DZ' },{ name:'Zimmer 5', type:'DZ' },
    { name:'Zimmer 6', type:'DZ' },{ name:'Herberge', type:'MZ' },
  ]},
  { section:'KONVENT (HOSPES)', rooms:[
    { name:'Hospes I', type:'K' },{ name:'Hospes II', type:'K' },
    { name:'Hospes III', type:'K' },{ name:'Hospes VII', type:'K' },
    { name:'Hospes VIII', type:'K' },{ name:'Hospes IX', type:'K' },
  ]},
];

const monthNames = ['Jänner','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const wdShort = ['So.','Mo.','Di.','Mi.','Do.','Fr.','Sa.'];

function generateCalendar() {
  const grid = document.getElementById('calendarGrid');
  const today = new Date();
  today.setHours(0,0,0,0);

  // Build 7 days from calWeekStart
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(calWeekStart);
    d.setDate(calWeekStart.getDate() + i);
    days.push(d);
  }

  // Pre-filter bookings for this week
  getCalBookingCache(days[0], days[6]);

  // Update date range text
  const sunDate = days[6];
  const rangeText = `${pad2(days[0].getDate())}. ${monthNames[days[0].getMonth()]} – ${pad2(sunDate.getDate())}. ${monthNames[sunDate.getMonth()]} ${sunDate.getFullYear()}`;
  document.getElementById('calDateRangeText').textContent = rangeText;

  // Header
  let hdr = '<div class="cal-week-header"><div class="cal-week-header-cell">Zimmer</div>';
  days.forEach(d => {
    const isToday = d.getTime() === today.getTime();
    const cls = isToday ? ' today-header' : '';
    hdr += `<div class="cal-week-header-cell${cls}">${wdShort[d.getDay()]}<br><strong>${pad2(d.getDate())}.</strong></div>`;
  });
  hdr += '</div>';
  grid.innerHTML = hdr;

  // Render room rows
  calRoomSections.forEach(section => {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'cal-section-label';
    sectionEl.innerHTML = `<div class="cal-section-label-text">${section.section}</div>`;
    grid.appendChild(sectionEl);

    section.rooms.forEach(room => {
      const rowEl = document.createElement('div');
      rowEl.className = 'cal-room-row';
      rowEl.innerHTML = `<div class="cal-room-name">${room.name}<span class="cal-room-type">${room.type}</span></div>`;

      days.forEach(dayDate => {
        const isToday = dayDate.getTime() === today.getTime();
        const cell = document.createElement('div');
        cell.className = 'cal-day-cell' + (isToday ? ' today-col' : '');

        // Find matching booking from bookingsData
        const matchingBooking = findBookingForRoomAndDay(room.name, dayDate);
        if (matchingBooking) {
          const bar = document.createElement('div');
          bar.className = 'cal-booking-bar';
          const name = matchingBooking.name;
          bar.textContent = name.length > 16 ? name.substring(0, 14) + '...' : name;
          bar.title = name;
          bar.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = bookingsData.indexOf(matchingBooking);
            if (idx >= 0) openBookingEditByIndex(idx);
          });
          cell.appendChild(bar);
        }

        rowEl.appendChild(cell);
      });

      grid.appendChild(rowEl);
    });
  });
}

// Pre-filtered booking cache for calendar performance
let _calBookingCache = null;
let _calCacheKey = '';

function getCalBookingCache(weekStart, weekEnd) {
  const key = weekStart.getTime() + '-' + weekEnd.getTime();
  if (_calCacheKey === key && _calBookingCache) return _calBookingCache;
  _calBookingCache = bookingsData.filter(b => {
    if (b.deletedAt) return false;
    if (b.status === 'storniert') return false;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return false;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return false;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    return bis >= weekStart && von <= weekEnd;
  });
  _calCacheKey = key;
  return _calBookingCache;
}

function findBookingForRoomAndDay(roomName, dayDate) {
  const day = dayDate.getTime();
  const cache = _calBookingCache || bookingsData;
  for (const b of cache) {
    if (!b || !b.room) continue;
    if (b.room !== roomName) continue;
    if (b.status === 'storniert') continue;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) continue;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) continue;
    von.setHours(0,0,0,0);
    bis.setHours(0,0,0,0);
    if (day >= von.getTime() && day < bis.getTime()) return b;
  }
  return null;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

let calView = 'week'; // 'week' or 'month'
let calMonthDate = new Date(); // tracks which month is shown

function renderCalendar() {
  if (calView === 'week') {
    generateCalendar();
  } else {
    generateMonthCalendar();
  }
  safeCreateIcons();
}

function generateMonthCalendar() {
  const grid = document.getElementById('calendarGrid');
  const today = new Date();
  today.setHours(0,0,0,0);

  const year = calMonthDate.getFullYear();
  const month = calMonthDate.getMonth();

  // Update range text
  document.getElementById('calDateRangeText').textContent = monthNames[month] + ' ' + year;

  // First day of month and how many days
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();

  // Monday-based offset (0=Mon, 6=Sun)
  let startOffset = firstDay.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  // Build grid
  let html = '<div class="cal-month-grid">';
  html += '<div class="cal-month-header">';
  ['Mo','Di','Mi','Do','Fr','Sa','So'].forEach(d => {
    html += `<div class="cal-month-header-cell">${d}</div>`;
  });
  html += '</div><div class="cal-month-body">';

  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startOffset + 1;
    const isCurrentMonth = dayNum >= 1 && dayNum <= daysInMonth;
    const cellDate = new Date(year, month, dayNum);
    cellDate.setHours(0,0,0,0);
    const isToday = cellDate.getTime() === today.getTime();

    let classes = 'cal-month-cell';
    if (!isCurrentMonth) classes += ' other-month';
    if (isToday) classes += ' today-cell';

    let displayDay = isCurrentMonth ? dayNum : cellDate.getDate();

    html += `<div class="${classes}">`;
    html += `<div class="cal-month-day${isToday ? ' today-num' : ''}">${displayDay}</div>`;

    if (isCurrentMonth) {
      // Find bookings that include this day
      const dayBookings = findAllBookingsForDay(cellDate);
      const maxShow = 3;
      dayBookings.slice(0, maxShow).forEach(b => {
        const idx = bookingsData.indexOf(b);
        html += `<div class="cal-month-booking" data-booking-idx="${idx}" title="${escHtml(b.name)} – ${escHtml(b.room)}">${escHtml(b.name)}</div>`;
      });
      if (dayBookings.length > maxShow) {
        html += `<div class="cal-month-more" data-day-date="${cellDate.getFullYear()}-${pad2(cellDate.getMonth()+1)}-${pad2(cellDate.getDate())}" style="cursor:pointer;">+${dayBookings.length - maxShow} weitere</div>`;
      }
    }

    html += '</div>';
  }

  html += '</div></div>';
  grid.innerHTML = html;

  // Add click handlers to booking bars
  grid.querySelectorAll('.cal-month-booking').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(el.getAttribute('data-booking-idx'));
      if (idx >= 0) openBookingEditByIndex(idx);
    });
  });

  // Add click handlers to "+X weitere" links
  grid.querySelectorAll('.cal-month-more').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const dateStr = el.getAttribute('data-day-date');
      if (dateStr) {
        const parts = dateStr.split('-');
        const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        dateObj.setHours(0, 0, 0, 0);
        showDayDetail(dateObj);
      }
    });
  });
}

var _bookingsDayCache = {};
var _bookingsDayCacheVersion = 0;

function invalidateBookingsDayCache() {
  _bookingsDayCacheVersion++;
  _bookingsDayCache = {};
  _calCacheKey = '';
  _calBookingCache = null;
}

function findAllBookingsForDay(dayDate) {
  var key = dayDate.getTime() + '_' + _bookingsDayCacheVersion;
  if (_bookingsDayCache[key]) return _bookingsDayCache[key];

  const day = dayDate.getTime();
  const results = [];
  for (const b of bookingsData) {
    if (b.status === 'storniert') continue;
    if (b.deletedAt) continue;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) continue;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) continue;
    von.setHours(0,0,0,0);
    bis.setHours(0,0,0,0);
    if (day >= von.getTime() && day < bis.getTime()) results.push(b);
  }

  _bookingsDayCache[key] = results;
  return results;
}

function initCalendarNav() {
  document.getElementById('calPrev').addEventListener('click', () => {
    if (calView === 'week') {
      calWeekStart.setDate(calWeekStart.getDate() - 7);
    } else {
      calMonthDate.setMonth(calMonthDate.getMonth() - 1);
    }
    renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    if (calView === 'week') {
      calWeekStart.setDate(calWeekStart.getDate() + 7);
    } else {
      calMonthDate.setMonth(calMonthDate.getMonth() + 1);
    }
    renderCalendar();
  });
  document.getElementById('calToday').addEventListener('click', () => {
    calWeekStart = getMonday(new Date());
    calMonthDate = new Date();
    renderCalendar();
  });

  // View toggle
  document.getElementById('calViewWeek').addEventListener('click', () => {
    if (calView === 'week') return;
    calView = 'week';
    document.getElementById('calViewWeek').classList.add('active');
    document.getElementById('calViewMonth').classList.remove('active');
    renderCalendar();
  });
  document.getElementById('calViewMonth').addEventListener('click', () => {
    if (calView === 'month') return;
    calView = 'month';
    document.getElementById('calViewMonth').classList.add('active');
    document.getElementById('calViewWeek').classList.remove('active');
    renderCalendar();
  });
}

function openBookingEditByIndex(idx) {
  const b = bookingsData[idx];
  editingBookingIdx = idx;

  document.getElementById('editBuchungGast').value = b.name;
  // Zimmer-Dropdown dynamisch befüllen
  const zimmerSelect = document.getElementById('editBuchungZimmer');
  zimmerSelect.length = 1; // Nur "Zimmer wählen..." behalten
  allRoomsList.forEach(function(room) {
    const opt = document.createElement('option');
    opt.value = room;
    opt.textContent = room;
    zimmerSelect.appendChild(opt);
  });
  zimmerSelect.value = b.room;
  document.getElementById('editBuchungPersonen').value = parseInt(b.pers) || 1;
  document.getElementById('editBuchungStatus').value = b.status;
  document.getElementById('editBuchungNotizen').value = b.notes || '';

  // Populate activities checkboxes
  const predefinedActivities = ['Stiftsführung','Sternwarte','Bibliothek','Exerzitien','Ausflug','Kunstsammlungen','Fischkalter','Gottesdienst'];
  const bActivities = b.activities || [];
  const checksContainer = document.getElementById('editAktivitaetenChecks');
  checksContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = bActivities.includes(cb.value);
  });
  const sonstige = bActivities.filter(a => !predefinedActivities.includes(a));
  document.getElementById('editAktivitaetenSonstig').value = sonstige.join(', ');

  // Load spende
  document.getElementById('editBuchungSpende').value = b.spende ? b.spende : '';

  // Parse "DD.MM.YYYY – DD.MM.YYYY" to date inputs
  const parts = splitDateRange(b.dates);
  if (parts.length === 2) {
    document.getElementById('editBuchungAnreise').value = parseDEtoISO(parts[0].trim());
    document.getElementById('editBuchungAbreise').value = parseDEtoISO(parts[1].trim());
  }

  openModal('modalBuchungEdit');
  safeCreateIcons();
}

function parseDEtoISO(deDate) {
  const p = deDate.split('.');
  if (p.length >= 3) return p[2] + '-' + p[1].padStart(2,'0') + '-' + p[0].padStart(2,'0');
  return '';
}

function formatISOtoDE(iso) {
  const p = iso.split('-');
  return p[2] + '.' + p[1] + '.' + p[0];
}

function saveEditBuchung() {
  const gast = document.getElementById('editBuchungGast').value.trim();
  const zimmer = document.getElementById('editBuchungZimmer').value;
  const anreise = document.getElementById('editBuchungAnreise').value;
  const abreise = document.getElementById('editBuchungAbreise').value;
  const personen = document.getElementById('editBuchungPersonen').value;
  const status = document.getElementById('editBuchungStatus').value;
  const notizen = document.getElementById('editBuchungNotizen').value.trim();
  const spendeVal = Math.max(0, parseFloat(document.getElementById('editBuchungSpende').value) || 0);

  // Collect activities
  const activities = [];
  document.getElementById('editAktivitaetenChecks').querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (cb.checked) activities.push(cb.value);
  });
  const sonstig = document.getElementById('editAktivitaetenSonstig').value.trim();
  if (sonstig) {
    sonstig.split(',').forEach(s => {
      const trimmed = s.trim();
      if (trimmed && !activities.includes(trimmed)) activities.push(trimmed);
    });
  }

  if (!gast || !zimmer) {
    showToast('Bitte Gastname und Zimmer angeben');
    return;
  }
  if (!anreise || !abreise) {
    showToast('Bitte Anreise- und Abreisedatum angeben');
    return;
  }

  // Conflict detection
  if (anreise && abreise) {
    const newVon = new Date(anreise);
    const newBis = new Date(abreise);
    newVon.setHours(CHECKIN_HOUR, 0, 0, 0);
    newBis.setHours(CHECKOUT_HOUR, 0, 0, 0);

    for (let i = 0; i < bookingsData.length; i++) {
      if (i === editingBookingIdx) continue;
      const b = bookingsData[i];
      if (b.room !== zimmer) continue;
      if (b.status === 'storniert' || b.status === 'abgeschlossen' || b.deletedAt) continue;
      const parts = splitDateRange(b.dates);
      if (parts.length < 2) continue;
      const bVon = parseDateDE(parts[0]);
      const bBis = parseDateDE(parts[1]);
      if (!bVon || !bBis) continue;
      bVon.setHours(CHECKIN_HOUR, 0, 0, 0);
      bBis.setHours(CHECKOUT_HOUR, 0, 0, 0);
      if (bVon < newBis && bBis > newVon) {
        const conflictDates = parts[0].trim().replace(/\.\d{4}$/, '.') + ' – ' + parts[1].trim();
        showToast('Konflikt: ' + zimmer + ' ist belegt von ' + b.name + ' (' + conflictDates + ')');
        return;
      }
    }
  }

  const dates = (anreise && abreise)
    ? formatISOtoDE(anreise) + ' – ' + formatISOtoDE(abreise)
    : '';

  if (editingBookingIdx >= 0 && editingBookingIdx < bookingsData.length) {
    // Update existing — mealOverrides-Keys migrieren bei Namens-/Zimmeränderung
    var oldName = bookingsData[editingBookingIdx].name;
    var oldRoom = bookingsData[editingBookingIdx].room;
    if (oldName !== gast || oldRoom !== zimmer) {
      var prefix = oldName + '|' + oldRoom + '|';
      Object.keys(mealOverrides).forEach(function(key) {
        if (key.startsWith(prefix)) {
          mealOverrides[gast + '|' + zimmer + '|' + key.slice(prefix.length)] = mealOverrides[key];
          delete mealOverrides[key];
        }
      });
    }
    var validEditPersonen = Math.max(1, parseInt(personen) || 1);
    bookingsData[editingBookingIdx].name = gast;
    bookingsData[editingBookingIdx].room = zimmer;
    bookingsData[editingBookingIdx].dates = dates;
    bookingsData[editingBookingIdx].pers = validEditPersonen + ' Pers.';
    bookingsData[editingBookingIdx].status = status;
    bookingsData[editingBookingIdx].notes = notizen || undefined;
    bookingsData[editingBookingIdx].activities = activities.length > 0 ? activities : undefined;
    bookingsData[editingBookingIdx].spende = spendeVal > 0 ? spendeVal : undefined;
    bookingsData[editingBookingIdx].updatedAt = new Date().toISOString();
  } else {
    // Create new from calendar entry
    var validNewPersonen = Math.max(1, parseInt(personen) || 1);
    const newB = {
      id: generateId(),
      name: gast, room: zimmer, dates: dates,
      pers: validNewPersonen + ' Pers.', status: status,
      updatedAt: new Date().toISOString(),
    };
    if (notizen) newB.notes = notizen;
    if (activities.length > 0) newB.activities = activities;
    if (spendeVal > 0) newB.spende = spendeVal;
    bookingsData.unshift(newB);
  }

  closeModal('modalBuchungEdit');
  saveData();
  syncGuestsFromBookings();
  renderBuchungen();
  updateBuchungenCount();
  updateDashboardStats();
  renderGaeste();
  updateGaesteCount();
  showToast('Buchung gespeichert');
}

function deleteEditingBuchung() {
  const idx = editingBookingIdx;
  const booking = idx >= 0 && idx < bookingsData.length ? bookingsData[idx] : null;
  const name = booking ? booking.name : 'Eintrag';
  const bookingId = booking ? (booking.id || booking.name + '|' + booking.dates) : null;
  showConfirm('Buchung löschen?', 'Die Buchung von "' + escHtml(name) + '" wird gelöscht.', 'Löschen', function() {
    // Buchung per ID finden (Index kann sich zwischen Klick und Bestätigung ändern)
    let delIdx = -1;
    if (bookingId) {
      delIdx = bookingsData.findIndex(b => (b.id || b.name + '|' + b.dates) === bookingId);
    }
    if (delIdx === -1) delIdx = idx;
    if (delIdx >= 0 && delIdx < bookingsData.length) {
      lastDeletedBooking = JSON.parse(JSON.stringify(bookingsData[delIdx]));
      lastDeletedIndex = delIdx;
      bookingsData[delIdx].deletedAt = new Date().toISOString();
      bookingsData[delIdx].updatedAt = new Date().toISOString();
      saveData();
      renderBuchungen();
      updateBuchungenCount();
      updateDashboardStats();
    }
    closeModal('modalBuchungEdit');
    showToast('Buchung gelöscht', { duration: 6000, undo: undoDeleteBooking });
  });
}

// ========== Gäste ==========
function renderGaeste() {
  const list = document.getElementById('gaesteList');
  list.innerHTML = '';
  const search = currentGuestSearch.toLowerCase();

  const filtered = guestsData.filter(g => {
    if (search && !guestName(g).toLowerCase().includes(search)) return false;
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text-muted);">Keine Gäste gefunden.</div>';
    return;
  }

  const showingGuests = filtered.slice(0, _gaestePageSize);
  if (filtered.length > _gaestePageSize) {
    list.innerHTML = '<div style="padding:8px 14px;font-size:13px;color:var(--text-secondary);margin-bottom:8px;">' + filtered.length + ' Gäste – zeige die ersten ' + _gaestePageSize + '. Verwenden Sie die Suche zum Filtern.</div>';
  }

  showingGuests.forEach((g, idx) => {
    const card = document.createElement('div');
    card.className = 'guest-list-card';
    card.innerHTML = `
      <div class="guest-list-left">
        <div class="guest-avatar"><i data-lucide="user" style="width:18px;height:18px;"></i></div>
        <div class="guest-list-name">${escHtml(guestName(g))}</div>
      </div>
      <div class="guest-list-actions">
        <button class="icon-btn history-btn"><i data-lucide="history" style="width:16px;height:16px;"></i></button>
        <button class="icon-btn edit-btn"><i data-lucide="pencil" style="width:16px;height:16px;"></i></button>
        <button class="icon-btn delete"><i data-lucide="trash-2" style="width:16px;height:16px;"></i></button>
      </div>`;

    // History button
    card.querySelector('.icon-btn.history-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      showGuestHistory(guestName(g));
    });

    // Edit button
    card.querySelector('.icon-btn.edit-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      const realIdx = guestsData.indexOf(g);
      if (realIdx > -1) openGastModal(realIdx);
    });

    card.querySelector('.icon-btn.delete').addEventListener('click', function(e) {
      e.stopPropagation();
      showConfirm('Gast löschen?', '"' + guestName(g) + '" wird aus der Gästeliste entfernt.', 'Löschen', function() {
        const realIdx = guestsData.indexOf(g);
        if (realIdx > -1) {
          guestsData.splice(realIdx, 1);
          saveData();
          renderGaeste();
          updateGaesteCount();
          showToast('Gast gelöscht');
        }
      });
    });

    list.appendChild(card);
  });

  if (filtered.length > _gaestePageSize) {
    var moreBtn = document.createElement('button');
    moreBtn.className = 'btn btn-secondary';
    moreBtn.style.cssText = 'display:block;margin:16px auto;';
    moreBtn.textContent = 'Weitere ' + Math.min(50, filtered.length - _gaestePageSize) + ' Gäste anzeigen';
    moreBtn.onclick = function() { _gaestePageSize += 50; renderGaeste(); };
    list.appendChild(moreBtn);
  }

  lucide.createIcons({ nodes: [list] });
}

function updateGaesteCount() {
  const sub = document.querySelector('#page-gaeste .page-subtitle');
  if (sub) sub.textContent = guestsData.length + ' Gäste erfasst';
}

// ========== Gäste Search ==========
function initGaesteSearch() {
  const input = document.querySelector('#page-gaeste .search-bar input');
  input.addEventListener('input', function() {
    currentGuestSearch = this.value;
    _gaestePageSize = 50;
    renderGaeste();
  });
}

// ========== Save Gast ==========
let editingGuestIdx = -1;

function openGastModal(idx) {
  if (idx >= 0 && idx < guestsData.length) {
    // Edit mode
    editingGuestIdx = idx;
    const guest = guestsData[idx];
    document.getElementById('gastModalTitle').textContent = 'Gast bearbeiten';
    document.getElementById('gastName').value = guestName(guest);
    document.getElementById('gastEmail').value = guest.email || '';
    document.getElementById('gastTelefon').value = guest.telefon || '';
    document.getElementById('gastNotizen').value = guest.notizen || '';
  } else {
    // New mode
    editingGuestIdx = -1;
    document.getElementById('gastModalTitle').textContent = 'Neuer Gast';
    document.getElementById('gastName').value = '';
    document.getElementById('gastEmail').value = '';
    document.getElementById('gastTelefon').value = '';
    document.getElementById('gastNotizen').value = '';
  }
  document.getElementById('gastMergeSection').style.display = 'none';
  document.getElementById('gastMergeFrom').value = '';
  openModal('modalGast');
}

function saveGast() {
  const name = document.getElementById('gastName').value.trim();
  const email = document.getElementById('gastEmail').value.trim();
  const telefon = document.getElementById('gastTelefon').value.trim();
  const notizen = document.getElementById('gastNotizen').value.trim();

  if (!name) {
    showToast('Bitte Name eingeben');
    return;
  }

  if (editingGuestIdx >= 0) {
    // Update existing — also update bookings that reference old name
    const oldName = guestName(guestsData[editingGuestIdx]);
    if (oldName !== name) {
      bookingsData.forEach(b => {
        if (b.name === oldName) {
          // mealOverrides-Keys migrieren
          var prefix = oldName + '|' + b.room + '|';
          Object.keys(mealOverrides).forEach(function(key) {
            if (key.startsWith(prefix)) {
              mealOverrides[name + '|' + b.room + '|' + key.slice(prefix.length)] = mealOverrides[key];
              delete mealOverrides[key];
            }
          });
          b.name = name;
        }
      });
    }
    guestsData[editingGuestIdx].name = name;
    guestsData[editingGuestIdx].email = email;
    guestsData[editingGuestIdx].telefon = telefon;
    guestsData[editingGuestIdx].notizen = notizen;
    showToast('Gast aktualisiert');
  } else {
    guestsData.unshift({ name, email, telefon, notizen });
    showToast('Gast erstellt');
  }

  // Handle merge
  const mergeFrom = document.getElementById('gastMergeFrom').value.trim();
  if (mergeFrom && mergeFrom !== name) {
    let mergedCount = 0;
    bookingsData.forEach(b => {
      if (b.name === mergeFrom) {
        b.name = name;
        mergedCount++;
      }
    });
    // mealOverrides-Keys migrieren (name|room|date)
    Object.keys(mealOverrides).forEach(key => {
      if (key.startsWith(mergeFrom + '|')) {
        const newKey = name + key.substring(mergeFrom.length);
        if (!mealOverrides[newKey]) mealOverrides[newKey] = mealOverrides[key];
        delete mealOverrides[key];
      }
    });
    // Remove old guest from guestsData
    const oldIdx = guestsData.findIndex(g => guestName(g) === mergeFrom);
    if (oldIdx > -1 && oldIdx !== editingGuestIdx) guestsData.splice(oldIdx, 1);
    if (mergedCount > 0) {
      showToast(mergedCount + ' Buchung' + (mergedCount !== 1 ? 'en' : '') + ' von "' + mergeFrom + '" übertragen');
    } else {
      showToast('Gast "' + mergeFrom + '" entfernt (keine Buchungen gefunden)');
    }
  }

  document.getElementById('gastName').value = '';
  document.getElementById('gastEmail').value = '';
  document.getElementById('gastTelefon').value = '';
  document.getElementById('gastNotizen').value = '';

  closeModal('modalGast');
  saveData();
  renderGaeste();
  updateGaesteCount();
  renderBuchungen();
}

// Sync guests from bookings — add any booking guest not in the list
function syncGuestsFromBookings() {
  let added = 0;
  bookingsData.forEach(b => {
    if (!b || !b.name) return;
    if (b.deletedAt) return;
    const bName = String(b.name).toLowerCase();
    const exists = guestsData.some(g => g && guestName(g).toLowerCase() === bName);
    if (!exists) {
      guestsData.push({ name: b.name, email: '', telefon: '', notizen: '' });
      added++;
    }
  });
  if (added > 0) {
    saveData();
  }
  return added;
}


// ========== Zimmer Sort ==========
function initZimmerSort() {
  const btn = document.querySelector('.sort-btn');
  let sortAsc = true;

  function sortGrid(grid) {
    const cards = Array.from(grid.children);
    cards.sort((a, b) => {
      const aName = a.querySelector('.zimmer-name').textContent;
      const bName = b.querySelector('.zimmer-name').textContent;
      const aStatus = a.classList.contains('belegt-card') ? 1 : 0;
      const bStatus = b.classList.contains('belegt-card') ? 1 : 0;
      if (sortAsc) return aStatus - bStatus || aName.localeCompare(bName, 'de');
      return bStatus - aStatus || bName.localeCompare(aName, 'de');
    });
    cards.forEach(c => grid.appendChild(c));
  }

  btn.addEventListener('click', function() {
    sortGrid(document.getElementById('zimmerGrid'));
    sortGrid(document.getElementById('konventGrid'));
    sortAsc = !sortAsc;
    showToast(sortAsc ? 'Sortiert: A → Z' : 'Sortiert: Z → A');
  });

  // Add sort button to Konvent header if not present
  const konventHeader = document.querySelector('#konventGrid').parentElement.querySelector('.zimmer-header');
  if (konventHeader && !konventHeader.querySelector('.sort-btn')) {
    const konventSortBtn = document.createElement('button');
    konventSortBtn.className = 'sort-btn';
    konventSortBtn.innerHTML = '<i data-lucide="arrow-up-down" style="width:14px;height:14px;"></i> Sortieren';
    konventSortBtn.addEventListener('click', function() {
      sortGrid(document.getElementById('zimmerGrid'));
      sortGrid(document.getElementById('konventGrid'));
      sortAsc = !sortAsc;
      showToast(sortAsc ? 'Sortiert: A → Z' : 'Sortiert: Z → A');
    });
    konventHeader.appendChild(konventSortBtn);
    lucide.createIcons({ nodes: [konventSortBtn] });
  }
}

// ========== Statistik Bars ==========
function generateStatBars() { renderStatistikPage(); }

function renderStatistikPage() {
  // --- 1. Populate year dropdown from booking data ---
  const dropdown = document.getElementById('statistikJahr');
  const previousSelection = dropdown.value;
  const allYears = new Set();
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (von) allYears.add(von.getFullYear());
    if (bis) allYears.add(bis.getFullYear());
  });
  // Ensure current year is always included
  allYears.add(new Date().getFullYear());
  const sortedYears = Array.from(allYears).sort((a, b) => b - a);

  dropdown.innerHTML = sortedYears.map(y => `<option value="${y}">${y}</option>`).join('');
  // Restore previous selection or default to current year
  if (previousSelection && sortedYears.includes(Number(previousSelection))) {
    dropdown.value = previousSelection;
  } else {
    dropdown.value = new Date().getFullYear();
  }

  const selectedYear = Number(dropdown.value);
  const daysInYear = ((selectedYear % 4 === 0 && selectedYear % 100 !== 0) || selectedYear % 400 === 0) ? 366 : 365;
  const yearStart = new Date(selectedYear, 0, 1);
  const yearEnd = new Date(selectedYear, 11, 31);

  // --- 2. Calculate stats per room for selected year ---
  let totalBookedDays = 0;
  const container = document.getElementById('zimmerBars');
  container.innerHTML = '';

  const data = allRoomsList.map(room => {
    const bookedDates = new Set();
    bookingsData.forEach(b => {
      if (b.deletedAt) return;
      if (b.room !== room) return;
      if (b.status === 'storniert') return;
      const parts = splitDateRange(b.dates);
      if (parts.length < 2) return;
      const von = parseDateDE(parts[0]);
      const bis = parseDateDE(parts[1]);
      if (!von || !bis) return;
      const start = new Date(Math.max(von.getTime(), yearStart.getTime()));
      const end = new Date(Math.min(bis.getTime(), yearEnd.getTime()));
      start.setHours(0,0,0,0);
      end.setHours(0,0,0,0);
      if (start > end) return;
      // Checkout-Tag nicht mitzählen (Zimmer ist ab 10:00 frei)
      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        bookedDates.add(d.toDateString());
      }
    });
    const days = bookedDates.size;
    totalBookedDays += days;
    const pct = Math.round(days / daysInYear * 100);
    return { name: room, pct, days };
  });

  // --- 3. Render bar chart ---
  data.forEach(d => {
    container.innerHTML += `
      <div class="stat-bar-row">
        <div class="stat-bar-label">${d.name}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${d.pct}%;"></div></div>
        <div class="stat-bar-pct">${d.pct}%</div>
        <div class="stat-bar-days">${d.days}d</div>
      </div>`;
  });

  // --- 4. Update stat cards ---
  const totalAvailable = allRoomsList.length * daysInYear;
  const totalFree = totalAvailable - totalBookedDays;
  const gesamtPct = totalAvailable > 0 ? Math.round(totalBookedDays / totalAvailable * 100) : 0;

  const auslastung = document.getElementById('statAuslastung');
  const belegt = document.getElementById('statBelegt');
  const verfuegbar = document.getElementById('statVerfuegbar');
  const frei = document.getElementById('statFrei');
  if (auslastung) auslastung.querySelector('.stat-value').textContent = gesamtPct + '%';
  if (belegt) belegt.querySelector('.stat-value').textContent = totalBookedDays;
  if (verfuegbar) verfuegbar.querySelector('.stat-value').textContent = totalAvailable;
  if (frei) frei.querySelector('.stat-value').textContent = totalFree;

  // --- 5. Year comparison table ---
  const vergleichContainer = document.getElementById('jahresvergleichTabelle');
  if (vergleichContainer) {
    let tableHTML = `<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:13px;">
      <thead>
        <tr style="border-bottom:2px solid var(--border);text-align:left;">
          <th style="padding:8px 12px;">Jahr</th>
          <th style="padding:8px 12px;">Buchungen</th>
          <th style="padding:8px 12px;">Gastnächte</th>
          <th style="padding:8px 12px;">Auslastung</th>
        </tr>
      </thead><tbody>`;

    sortedYears.forEach(year => {
      const yStart = new Date(year, 0, 1);
      const yEnd = new Date(year, 11, 31);
      const yDays = ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 366 : 365;
      let bookingCount = 0;
      let guestNights = 0;
      let yearBookedDays = 0;
      const yearRoomDates = new Set();

      bookingsData.forEach(b => {
        if (b.deletedAt) return;
        if (b.status === 'storniert') return;
        const parts = splitDateRange(b.dates);
        if (parts.length < 2) return;
        const von = parseDateDE(parts[0]);
        const bis = parseDateDE(parts[1]);
        if (!von || !bis) return;
        const start = new Date(Math.max(von.getTime(), yStart.getTime()));
        const end = new Date(Math.min(bis.getTime(), yEnd.getTime()));
        start.setHours(0,0,0,0);
        end.setHours(0,0,0,0);
        if (start > end) return;
        // Count this booking if it overlaps this year
        bookingCount++;
        // Count guest-nights (Checkout-Tag nicht mitzählen)
        let nights = 0;
        for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
          nights++;
          yearRoomDates.add(b.room + '|' + d.toDateString());
        }
        guestNights += nights;
      });

      const yAvail = allRoomsList.length * yDays;
      const yPct = yAvail > 0 ? Math.round(yearRoomDates.size / yAvail * 100) : 0;
      const isSelected = year === selectedYear;
      const rowStyle = isSelected ? 'background:var(--primary-light);font-weight:600;' : '';

      tableHTML += `<tr style="border-bottom:1px solid var(--border);${rowStyle}">
        <td style="padding:8px 12px;">${year}</td>
        <td style="padding:8px 12px;">${bookingCount}</td>
        <td style="padding:8px 12px;">${guestNights}</td>
        <td style="padding:8px 12px;">${yPct}%</td>
      </tr>`;
    });

    tableHTML += '</tbody></table>';
    vergleichContainer.innerHTML = tableHTML;
  }

  safeCreateIcons();
}

// ========== E-Mail Analyse ==========
function analyzeEmail() {
  const text = document.getElementById('emailTextarea').value.trim();
  const resultDiv = document.getElementById('emailResult');

  if (!text) {
    showToast('Bitte E-Mail-Text einfügen');
    return;
  }

  // Show loading
  resultDiv.innerHTML = '<div class="email-spinner" style="margin-top:16px;"><div class="dot-loader"><span></span><span></span><span></span></div>E-Mail wird analysiert...</div>';

  // Bekannte Gäste sammeln
  const knownGuests = guestsData.map(g => guestName(g));

  // Lokaler Regex-Parser (kein Server nötig)
  const result = parseEmailText(text);
  result.source = 'regex';
  showEmailResult(result);
  showToast('E-Mail analysiert');
}

function parseEmailText(text) {
  const result = { name: '', anreise: '', abreise: '', personen: '1', zimmertyp: '', notizen: '' };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const monthMap = {
    'jänner':1,'januar':1,'februar':2,'märz':3,'april':4,'mai':5,'juni':6,
    'juli':7,'august':8,'september':9,'oktober':10,'november':11,'dezember':12,
    'jan':1,'feb':2,'mär':3,'apr':4,'jun':6,'jul':7,'aug':8,'sep':9,'okt':10,'nov':11,'dez':12
  };
  const monthRe = 'j[äa]nner|januar|februar|m[äa]rz|april|mai|juni|juli|august|september|oktober|november|dezember|jan|feb|m[äa]r|apr|jun|jul|aug|sep|okt|nov|dez';

  // Hilfsfunktion: Monat-Text zu Nummer
  function monthNum(s) { return monthMap[s.toLowerCase().trim()] || 0; }

  // Hilfsfunktion: DD.MM. oder DD.MM.YYYY normalisieren
  function normDate(d, m, y) {
    if (!y) y = new Date().getFullYear();
    return pad2(parseInt(d)) + '.' + pad2(parseInt(m)) + '.' + y;
  }

  // ===== 1. NAME ERKENNEN =====
  // Strategie: Absender-Name finden. Signatur (nach Grußformel) ist am zuverlässigsten,
  // weil die Anrede den Empfänger enthält, nicht den Absender.

  let nameCandidate = '';

  // 1a) "Von:" / "From:" Header — eindeutigster Hinweis auf den Absender
  const vonMatch = text.match(/^(?:von|from)\s*:\s*(.+)/im);
  if (vonMatch) {
    let n = vonMatch[1].trim().replace(/<[^>]+>/g, '').trim();
    n = n.replace(/["']/g, '').trim();
    if (n && !n.includes('@') && n.length > 2) nameCandidate = n;
  }

  // 1b) Signatur nach Grußformel (MfG, LG, etc.) — das ist der Absender
  if (!nameCandidate) {
    const grussRe = /(?:mit\s+(?:freundlichen|lieben|besten|herzlichen)\s+gr[üu][ßs]en|freundliche\s+gr[üu][ßs]e|herzlichst|herzlich|lg|mfg|viele\s+gr[üu][ßs]e|liebe\s+gr[üu][ßs]e)\b/i;
    const grussIdx = text.search(grussRe);
    if (grussIdx !== -1) {
      const afterGreeting = text.substring(grussIdx).split('\n').slice(1);
      for (const line of afterGreeting) {
        const cleaned = line.trim().replace(/^[-–—]+\s*/, '');
        if (!cleaned) continue;
        if (cleaned.includes('@') || /^[\d+(\s]/.test(cleaned) || cleaned.includes('www.') || cleaned.includes('http')) continue;
        if (cleaned.length >= 2 && /^[A-ZÄÖÜ]/.test(cleaned)) {
          nameCandidate = cleaned.split(/\s+/).slice(0, 4).join(' ').replace(/[,;.!]+$/, '');
          break;
        }
      }
    }
  }

  // 1c) Grußformel auf gleicher Zeile: "MfG Stefan Gruber" / "LG Anna"
  if (!nameCandidate) {
    const inlineGreet = text.match(/(?:mit\s+(?:freundlichen|lieben|besten|herzlichen)\s+gr[üu][ßs]en|freundliche\s+gr[üu][ßs]e|herzlichst|herzlich|lg|mfg|viele\s+gr[üu][ßs]e|liebe\s+gr[üu][ßs]e)[,\s]+((?:(?:Dr|Prof|P|Sr|Mag)[.\s]+)?[A-ZÄÖÜ][\wäöüß-]+(?:\s+[A-ZÄÖÜ][\wäöüß-]+)*)/im);
    if (inlineGreet) nameCandidate = inlineGreet[1].trim();
  }

  // 1d) "Mein Name ist X" / "Ich bin X" / "Ich heiße X"
  if (!nameCandidate) {
    const ichMatch = text.match(/(?:mein\s+name\s+ist|ich\s+bin|ich\s+hei[ßs]e)\s+((?:(?:Dr|Prof|P|Sr|Mag)[.\s]+)?[A-ZÄÖÜ][\wäöüß-]+(?:\s+[A-ZÄÖÜ][\wäöüß-]+)*)/im);
    if (ichMatch) nameCandidate = ichMatch[1].trim();
  }

  result.name = nameCandidate;

  // ===== 2. DATUM ERKENNEN =====

  // 2a) Explizite Labels: "Anreise: DD.MM.YYYY" / "Abreise: DD.MM.YYYY"
  const anreiseLabel = text.match(/(?:anreise|check[\s-]?in|ankunft|von|ab)[:\s]+(\d{1,2})[.\s/]+(\d{1,2})[.\s/]+(\d{4})/i);
  const abreiseLabel = text.match(/(?:abreise|check[\s-]?out|abfahrt|bis|departure)[:\s]+(\d{1,2})[.\s/]+(\d{1,2})[.\s/]+(\d{4})/i);
  if (anreiseLabel) result.anreise = normDate(anreiseLabel[1], anreiseLabel[2], anreiseLabel[3]);
  if (abreiseLabel) result.abreise = normDate(abreiseLabel[1], abreiseLabel[2], abreiseLabel[3]);

  // 2b) DD.MM.YYYY – DD.MM.YYYY (mit oder ohne Trennwort)
  if (!result.anreise || !result.abreise) {
    const fullMatch = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})\s*(?:bis|–|-|—)\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (fullMatch) {
      if (!result.anreise) result.anreise = fullMatch[1];
      if (!result.abreise) result.abreise = fullMatch[2];
    }
  }

  // 2c) DD.MM. – DD.MM.YYYY (Jahr nur beim zweiten) oder DD.MM. – DD.MM. (kein Jahr)
  if (!result.anreise || !result.abreise) {
    const partialMatch = text.match(/(\d{1,2})\.(\d{1,2})\.?\s*(?:bis|–|-|—)\s*(\d{1,2})\.(\d{1,2})\.(\d{4})?/i);
    if (partialMatch) {
      const y = partialMatch[5] || String(new Date().getFullYear());
      if (!result.anreise) result.anreise = normDate(partialMatch[1], partialMatch[2], y);
      if (!result.abreise) result.abreise = normDate(partialMatch[3], partialMatch[4], y);
    }
  }

  // 2d) "vom 15. bis 18. März 2026" (gleicher Monat)
  if (!result.anreise || !result.abreise) {
    const relRe = new RegExp('vom\\s+(\\d{1,2})\\.?\\s*(?:bis|–|-|—)\\s*(\\d{1,2})\\.?\\s*(' + monthRe + ')\\s*(\\d{4})?', 'i');
    const relMatch = text.match(relRe);
    if (relMatch) {
      const m = monthNum(relMatch[3]);
      const y = relMatch[4] || String(new Date().getFullYear());
      if (m) {
        if (!result.anreise) result.anreise = normDate(relMatch[1], m, y);
        if (!result.abreise) result.abreise = normDate(relMatch[2], m, y);
      }
    }
  }

  // 2e) "15. März bis 18. März 2026" (evtl. verschiedene Monate)
  if (!result.anreise || !result.abreise) {
    const crossRe = new RegExp('(\\d{1,2})\\.?\\s*(' + monthRe + ')\\s*(?:bis|–|-|—)\\s*(\\d{1,2})\\.?\\s*(' + monthRe + ')\\s*(\\d{4})?', 'i');
    const crossMatch = text.match(crossRe);
    if (crossMatch) {
      const m1 = monthNum(crossMatch[2]);
      const m2 = monthNum(crossMatch[4]);
      const y = crossMatch[5] || String(new Date().getFullYear());
      if (m1 && !result.anreise) result.anreise = normDate(crossMatch[1], m1, y);
      if (m2 && !result.abreise) result.abreise = normDate(crossMatch[3], m2, y);
    }
  }

  // 2f) "15. März 2026" (Einzeldatum — als Anreise interpretieren)
  if (!result.anreise) {
    const singleRe = new RegExp('(\\d{1,2})\\.?\\s*(' + monthRe + ')\\s*(\\d{4})?', 'i');
    const singleMatch = text.match(singleRe);
    if (singleMatch) {
      const m = monthNum(singleMatch[2]);
      const y = singleMatch[3] || String(new Date().getFullYear());
      if (m) result.anreise = normDate(singleMatch[1], m, y);
    }
  }

  // 2g) Einzelnes DD.MM.YYYY ohne Paar
  if (!result.anreise) {
    const singleFull = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    if (singleFull) result.anreise = singleFull[1];
  }

  // 2h) Nächte-Angabe: "3 Nächte" → Abreise berechnen
  if (result.anreise && !result.abreise) {
    var naechteMatch = text.match(/(\d+)\s*(?:nächte?|übernachtung(?:en)?)/i);
    var tageMatch = !naechteMatch ? text.match(/(\d+)\s*tage?/i) : null;
    var naechte = naechteMatch ? parseInt(naechteMatch[1]) : (tageMatch ? Math.max(1, parseInt(tageMatch[1]) - 1) : null);
    if (naechte) {
      const von = parseDateDE(result.anreise);
      if (von) {
        const bis = new Date(von);
        bis.setDate(bis.getDate() + naechte);
        result.abreise = pad2(bis.getDate()) + '.' + pad2(bis.getMonth() + 1) + '.' + bis.getFullYear();
      }
    }
  }

  // ===== 3. PERSONEN =====
  const persMatch = text.match(/(\d+)\s*(?:personen?|pers\.?|gäste|teilnehmer|erwachsene)/i);
  if (persMatch) result.personen = persMatch[1];
  // "zu zweit", "zu dritt"
  if (!persMatch) {
    if (/zu\s*zweit|wir\s+beide/i.test(text)) result.personen = '2';
    else if (/zu\s*dritt/i.test(text)) result.personen = '3';
    else if (/zu\s*viert/i.test(text)) result.personen = '4';
  }

  // ===== 4. ZIMMERTYP =====
  if (/einzelzimmer|\bEZ\b/i.test(text)) result.zimmertyp = 'Einzelzimmer';
  else if (/doppelzimmer|\bDZ\b/i.test(text)) result.zimmertyp = 'Doppelzimmer';
  else if (/mehrbett/i.test(text)) result.zimmertyp = 'Mehrbettzimmer';

  // ===== 5. NOTIZEN =====
  const notePatterns = [/vegetarisch/i, /vegan/i, /allergi\w*/i, /glutenfrei/i, /laktosefrei/i, /rollstuhl/i, /barrierefrei/i, /hund|haustier/i];
  const notes = [];
  notePatterns.forEach(p => { const m = text.match(p); if (m) notes.push(m[0]); });
  result.notizen = notes.join(', ');

  // ===== 6. BEKANNTER GAST? =====
  if (result.name) {
    const nameLower = result.name.toLowerCase();
    const knownGuest = guestsData.find(g => {
      const gLower = guestName(g).toLowerCase();
      // Exakter Match oder Nachname enthalten
      if (gLower === nameLower) return true;
      const nameParts = nameLower.split(/\s+/);
      const nachname = nameParts[nameParts.length - 1];
      return nachname.length >= 3 && gLower.includes(nachname);
    });
    result.knownGuest = knownGuest ? guestName(knownGuest) : null;
  } else {
    result.knownGuest = null;
  }

  return result;
}

function showEmailResult(result) {
  const resultDiv = document.getElementById('emailResult');

  const rows = [];
  if (result.name) rows.push({ label: 'Name', value: result.name + (result.knownGuest ? ' <span class="badge badge-bestaetigt" style="font-size:11px;padding:1px 8px;">Bekannter Gast</span>' : ' <span class="badge badge-anfrage" style="font-size:11px;padding:1px 8px;">Neuer Gast</span>') });
  if (result.anreise) rows.push({ label: 'Anreise', value: result.anreise });
  if (result.abreise) rows.push({ label: 'Abreise', value: result.abreise });
  rows.push({ label: 'Personen', value: result.personen });
  if (result.zimmertyp) rows.push({ label: 'Zimmertyp', value: result.zimmertyp });
  if (result.notizen) rows.push({ label: 'Hinweise', value: result.notizen });

  // Find free rooms
  let freeRooms = 'Alle Zimmer prüfen';
  if (result.anreise && result.abreise) {
    const von = parseDateDE(result.anreise);
    const bis = parseDateDE(result.abreise);
    if (von && bis) {
      const free = allRoomsList.filter(room => {
        return !bookingsData.some(b => {
          if (b.deletedAt) return false;
          if (b.room !== room || b.status === 'storniert') return false;
          const p = splitDateRange(b.dates);
          if (p.length < 2) return false;
          const bVon = parseDateDE(p[0]);
          const bBis = parseDateDE(p[1]);
          if (!bVon || !bBis) return false;
          return von <= bBis && bis >= bVon; // overlap check
        });
      });
      freeRooms = free.length > 0 ? free.join(', ') : '<span style="color:var(--red);">Keine Zimmer frei in diesem Zeitraum</span>';
    }
  }
  rows.push({ label: 'Freie Zimmer', value: freeRooms });

  // Editierbare Vorschau — Nutzer kann Felder korrigieren bevor Buchung erstellt wird
  var nameBadge = result.knownGuest
    ? ' <span class="badge badge-bestaetigt" style="font-size:11px;padding:1px 8px;">Bekannter Gast</span>'
    : (result.name ? ' <span class="badge badge-anfrage" style="font-size:11px;padding:1px 8px;">Neuer Gast</span>' : '');

  resultDiv.innerHTML = '<div class="email-result">' +
    '<div class="email-result-header"><i data-lucide="check-circle" style="width:16px;height:16px;"></i> Analyse — bitte prüfen und ggf. korrigieren</div>' +
    '<div class="email-result-body">' +
      '<div class="email-result-row"><div class="email-result-label">Name</div><div class="email-result-value"><input type="text" class="form-input" id="emailResName" value="' + escHtml(result.name || '') + '" />' + nameBadge + '</div></div>' +
      '<div class="email-result-row"><div class="email-result-label">Anreise</div><div class="email-result-value"><input type="date" class="form-input" id="emailResAnreise" value="' + (result.anreise ? parseDEtoISO(result.anreise) : '') + '" /></div></div>' +
      '<div class="email-result-row"><div class="email-result-label">Abreise</div><div class="email-result-value"><input type="date" class="form-input" id="emailResAbreise" value="' + (result.abreise ? parseDEtoISO(result.abreise) : '') + '" /></div></div>' +
      '<div class="email-result-row"><div class="email-result-label">Personen</div><div class="email-result-value"><input type="number" class="form-input" id="emailResPers" value="' + (result.personen || '1') + '" min="1" max="10" style="width:80px;" /></div></div>' +
      (result.zimmertyp ? '<div class="email-result-row"><div class="email-result-label">Zimmertyp</div><div class="email-result-value">' + escHtml(result.zimmertyp) + '</div></div>' : '') +
      (result.notizen ? '<div class="email-result-row"><div class="email-result-label">Hinweise</div><div class="email-result-value"><input type="text" class="form-input" id="emailResNotes" value="' + escHtml(result.notizen) + '" /></div></div>' : '<input type="hidden" id="emailResNotes" value="" />') +
      '<div class="email-result-row"><div class="email-result-label">Freie Zimmer</div><div class="email-result-value">' + freeRooms + '</div></div>' +
      '<div class="mt-16 flex-gap-8">' +
        '<button class="btn btn-primary" onclick="createBookingFromEmail()"><i data-lucide="plus" style="width:16px;height:16px;"></i> Buchung erstellen</button>' +
        (!result.knownGuest && result.name ? '<button class="btn" onclick="createGuestFromEmail()"><i data-lucide="user-plus" style="width:16px;height:16px;"></i> Gast anlegen</button>' : '') +
      '</div>' +
    '</div></div>';

  // Store result for follow-up actions
  window._lastEmailResult = result;
  lucide.createIcons({ nodes: [resultDiv] });
}

function createBookingFromEmail() {
  // Werte aus der editierbaren Vorschau lesen (nicht aus dem Original-Result)
  var nameEl = document.getElementById('emailResName');
  var anreiseEl = document.getElementById('emailResAnreise');
  var abreiseEl = document.getElementById('emailResAbreise');
  var persEl = document.getElementById('emailResPers');
  var notesEl = document.getElementById('emailResNotes');

  document.getElementById('buchungGast').value = nameEl ? nameEl.value : '';
  if (anreiseEl && anreiseEl.value) document.getElementById('buchungAnreise').value = anreiseEl.value;
  if (abreiseEl && abreiseEl.value) document.getElementById('buchungAbreise').value = abreiseEl.value;
  updateZimmerDropdown();
  document.getElementById('buchungPersonen').value = persEl ? persEl.value : '1';
  document.getElementById('buchungStatus').value = 'anfrage';
  if (notesEl && notesEl.value) document.getElementById('buchungNotizen').value = notesEl.value;
  openModal('modalBuchung');
}

function createGuestFromEmail() {
  var nameEl = document.getElementById('emailResName');
  var notesEl = document.getElementById('emailResNotes');
  var name = nameEl ? nameEl.value : '';
  if (!name) return;
  editingGuestIdx = -1;
  document.getElementById('gastModalTitle').textContent = 'Neuer Gast';
  document.getElementById('gastName').value = name;
  document.getElementById('gastEmail').value = '';
  document.getElementById('gastTelefon').value = '';
  document.getElementById('gastNotizen').value = notesEl && notesEl.value ? notesEl.value : '';
  openModal('modalGast');
}

// ========== Mobile Sidebar ==========
function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  sidebar.classList.toggle('mobile-open');
  backdrop.classList.toggle('active');
}

// Close mobile sidebar on navigation
function showPageMobile(pageId) {
  showPage(pageId);
  const sidebar = document.querySelector('.sidebar');
  if (sidebar.classList.contains('mobile-open')) {
    toggleMobileSidebar();
  }
}

// ========== Keyboard Navigation ==========
function initKeyboard() {
  document.addEventListener('keydown', function(e) {
    // Enter to submit in modals
    if (e.key === 'Enter' && !e.shiftKey) {
      const activeModal = document.querySelector('.modal-overlay.active');
      if (activeModal) {
        const target = e.target;
        if (target.tagName === 'TEXTAREA') return; // Allow Enter in textareas
        e.preventDefault();
        const submitBtn = activeModal.querySelector('.modal-footer .btn-primary');
        if (submitBtn) submitBtn.click();
      }
      // Enter in confirm dialog
      const confirmActive = document.querySelector('.confirm-overlay.active');
      if (confirmActive) {
        e.preventDefault();
        executeConfirm();
      }
    }
  });
}

// ========== Export / Print ==========
function initExportPrint() {
  // Küchenliste Drucken
  const printBtns = document.querySelectorAll('#page-kuechenliste .btn');
  printBtns.forEach(btn => {
    if (btn.textContent.includes('Drucken')) {
      btn.addEventListener('click', () => {
        showPage('kuechenliste');
        setTimeout(() => window.print(), 100);
      });
    }
  });

  // Excel-Backup (CSV fallback)
  const excelBtn = document.querySelector('#page-backup .backup-card:nth-child(2) .btn');
  if (excelBtn) {
    excelBtn.addEventListener('click', exportDataCSV);
  }

  // Küchenliste Export is handled by onclick on dynamically generated button
}

function exportDataCSV() {
  // CSV-Escape-Funktion
  function esc(s) { return '"' + String(s || '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"'; }

  // Export guests and bookings as CSV
  let csv = 'Typ,Name,Zimmer,Zeitraum,Personen,Status,Spende,Aktivitäten,Notizen,Check-In,Check-Out\n';
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    const acts = (b.activities || []).join('; ');
    csv += 'Buchung,' + esc(b.name) + ',' + esc(b.room) + ',' + esc(b.dates) + ',' + esc(b.pers) + ',' + esc(b.status) + ',' + esc(b.spende || '') + ',' + esc(acts) + ',' + esc(b.notes || '') + ',' + (b.checkedIn ? 'Ja' : 'Nein') + ',' + (b.checkedOut ? 'Ja' : 'Nein') + '\n';
  });
  csv += '\n';
  guestsData.forEach(g => {
    csv += 'Gast,' + esc(guestName(g)) + ',' + esc(g.email || '') + ',' + esc(g.telefon || '') + ',,,,,' + esc(g.notizen || '') + ',,\n';
  });

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gastmeister_backup_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV-Backup heruntergeladen');
}

function escXml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateWeekXLSXRows(weekStart) {
  const wdN = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }

  const allGuests = new Map();
  const konventTotals = [];

  days.forEach((day, di) => {
    day.setHours(0,0,0,0);
    const dayTime = day.getTime();
    const dateStr = pad2(day.getDate()) + '.' + pad2(day.getMonth()+1) + '.' + day.getFullYear();
    let kF=0, kM=0, kA=0;

    bookingsData.forEach(b => {
      if (b.deletedAt) return;
      if (b.status === 'storniert') return;
      const parts = splitDateRange(b.dates);
      if (parts.length < 2) return;
      const von = parseDateDE(parts[0]);
      const bis = parseDateDE(parts[1]);
      if (!von || !bis) return;
      von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
      if (dayTime >= von.getTime() && dayTime <= bis.getTime()) {
        const isArr = dayTime === von.getTime();
        const isDep = dayTime === bis.getTime();
        const isK = konventRooms.includes(b.room);
        const pers = parseInt(b.pers) || 1;
        let hasF = !isArr ? pers : 0;
        let hasM = pers;
        let hasA = !isDep ? pers : 0;

        // Apply meal overrides
        const overrideKey = b.name + '|' + (b.room || '') + '|' + dateStr;
        if (mealOverrides[overrideKey]) {
          hasF = mealOverrides[overrideKey].f ? pers : 0;
          hasM = mealOverrides[overrideKey].m ? pers : 0;
          hasA = mealOverrides[overrideKey].a ? pers : 0;
        }

        if (isK) {
          kF += hasF; kM += hasM; kA += hasA;
        } else {
          if (!allGuests.has(b.name)) {
            allGuests.set(b.name, { days: Array(7).fill(null).map(()=>({f:0,m:0,a:0})) });
          }
          const g = allGuests.get(b.name);
          g.days[di].f += hasF; g.days[di].m += hasM; g.days[di].a += hasA;
        }
      }
    });

    const dateKey = pad2(day.getDate()) + '.' + pad2(day.getMonth()+1) + '.' + day.getFullYear();
    dayGuestsData.forEach(dg => {
      if (dg.date !== dateKey) return;
      const pers = dg.pers || 1;
      const isK = dg.bereich === 'konvent';
      if (isK) {
        if (dg.f) kF += pers; if (dg.m) kM += pers; if (dg.a) kA += pers;
      } else {
        if (!allGuests.has(dg.name)) {
          allGuests.set(dg.name, { days: Array(7).fill(null).map(()=>({f:0,m:0,a:0})) });
        }
        const g = allGuests.get(dg.name);
        if (dg.f) g.days[di].f += pers; if (dg.m) g.days[di].m += pers; if (dg.a) g.days[di].a += pers;
      }
    });

    konventTotals.push({f:kF, m:kM, a:kA});
  });

  const d0 = days[0], d6 = days[6];
  const title = pad2(d0.getDate()) + '.' + pad2(d0.getMonth()+1) + '. – ' + pad2(d6.getDate()) + '.' + pad2(d6.getMonth()+1) + '.' + d6.getFullYear();

  let rows = '';

  // Title row
  rows += '<Row ss:Height="36"><Cell ss:MergeAcross="21" ss:StyleID="title"><Data ss:Type="String">' + escXml(title) + '</Data></Cell></Row>';

  // Weekday names
  rows += '<Row ss:Height="24"><Cell ss:StyleID="hdrSmL"/>';
  days.forEach((d, i) => {
    rows += '<Cell ss:MergeAcross="2" ss:StyleID="' + (i === 6 ? 'hdrSmR' : 'hdrSm') + '"><Data ss:Type="String">' + wdN[d.getDay()] + '</Data></Cell>';
  });
  rows += '</Row>';

  // Dates
  rows += '<Row ss:Height="24"><Cell ss:StyleID="hdrSmL"><Data ss:Type="String">' + monthNames[d0.getMonth()] + ' ' + d0.getFullYear() + '</Data></Cell>';
  days.forEach((d, i) => {
    rows += '<Cell ss:MergeAcross="2" ss:StyleID="' + (i === 6 ? 'hdrSmR' : 'hdrSm') + '"><Data ss:Type="String">' + pad2(d.getDate()) + '.' + pad2(d.getMonth()+1) + '.</Data></Cell>';
  });
  rows += '</Row>';

  // F/M/A headers
  rows += '<Row ss:Height="24"><Cell ss:StyleID="defaultL"/>';
  for (let i = 0; i < 7; i++) {
    rows += '<Cell ss:StyleID="hdrF"><Data ss:Type="String">F</Data></Cell>';
    rows += '<Cell ss:StyleID="hdrM"><Data ss:Type="String">M</Data></Cell>';
    rows += '<Cell ss:StyleID="' + (i === 6 ? 'hdrAR' : 'hdrA') + '"><Data ss:Type="String">A</Data></Cell>';
  }
  rows += '</Row>';

  // Guest rows (only guests with at least one meal)
  allGuests.forEach((g, name) => {
    const hasMeals = g.days.some(d => d.f > 0 || d.m > 0 || d.a > 0);
    if (!hasMeals) return;
    rows += '<Row ss:Height="24"><Cell ss:StyleID="gname"><Data ss:Type="String">' + escXml(name) + '</Data></Cell>';
    g.days.forEach((d, i) => {
      rows += '<Cell ss:StyleID="valF"><Data ss:Type="' + (d.f ? 'Number' : 'String') + '">' + (d.f || '') + '</Data></Cell>';
      rows += '<Cell ss:StyleID="valM"><Data ss:Type="' + (d.m ? 'Number' : 'String') + '">' + (d.m || '') + '</Data></Cell>';
      rows += '<Cell ss:StyleID="' + (i === 6 ? 'valAR' : 'valA') + '"><Data ss:Type="' + (d.a ? 'Number' : 'String') + '">' + (d.a || '') + '</Data></Cell>';
    });
    rows += '</Row>';
  });

  // Konvent row
  rows += '<Row ss:Height="24"><Cell ss:StyleID="konvent"><Data ss:Type="String">Konvent</Data></Cell>';
  konventTotals.forEach((k, i) => {
    rows += '<Cell ss:StyleID="konventVal"><Data ss:Type="' + (k.f ? 'Number' : 'String') + '">' + (k.f || '') + '</Data></Cell>';
    rows += '<Cell ss:StyleID="konventVal"><Data ss:Type="' + (k.m ? 'Number' : 'String') + '">' + (k.m || '') + '</Data></Cell>';
    rows += '<Cell ss:StyleID="' + (i === 6 ? 'konventValR' : 'konventVal') + '"><Data ss:Type="' + (k.a ? 'Number' : 'String') + '">' + (k.a || '') + '</Data></Cell>';
  });
  rows += '</Row>';

  return { rows, d0, d6 };
}

function exportKuecheXLSX() {
  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());

  // Week 1
  const week1 = generateWeekXLSXRows(weekStart);

  // Empty separator row
  const separator = '<Row ss:Height="12"><Cell/></Row>';

  // Week 2
  const week2Start = new Date(weekStart);
  week2Start.setDate(weekStart.getDate() + 7);
  const week2 = generateWeekXLSXRows(week2Start);

  const allRows = week1.rows + separator + week2.rows;

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    (function() {
      function bdr(t,b,l,r) {
        return '<Borders>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="'+t+'"/>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="'+b+'"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="'+l+'"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="'+r+'"/>' +
          '</Borders>';
      }
      var g=bdr(1,1,1,1), gL=bdr(1,1,2,1), gR=bdr(1,1,1,2), gTLR=bdr(2,1,2,2), gBL=bdr(1,2,2,1), gB=bdr(1,2,1,1), gBR=bdr(1,2,1,2);
      return '<Styles>\n' +
        '<Style ss:ID="Default"><Font ss:Size="14"/><Alignment ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="default"><Font ss:Size="14"/><Alignment ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="defaultL"><Font ss:Size="14"/><Alignment ss:Vertical="Center"/>'+gL+'</Style>\n' +
        '<Style ss:ID="title"><Font ss:Size="22" ss:Bold="1" ss:Color="#CC0000"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gTLR+'</Style>\n' +
        '<Style ss:ID="hdrSm"><Font ss:Size="13" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="hdrSmL"><Font ss:Size="13" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gL+'</Style>\n' +
        '<Style ss:ID="hdrSmR"><Font ss:Size="13" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gR+'</Style>\n' +
        '<Style ss:ID="hdrF"><Font ss:Size="14" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFFFCC" ss:Pattern="Solid"/>'+g+'</Style>\n' +
        '<Style ss:ID="hdrM"><Font ss:Size="14" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#CCFFCC" ss:Pattern="Solid"/>'+g+'</Style>\n' +
        '<Style ss:ID="hdrA"><Font ss:Size="14" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFCCFF" ss:Pattern="Solid"/>'+g+'</Style>\n' +
        '<Style ss:ID="hdrAR"><Font ss:Size="14" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFCCFF" ss:Pattern="Solid"/>'+gR+'</Style>\n' +
        '<Style ss:ID="gname"><Font ss:Size="14" ss:Bold="1"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>'+gL+'</Style>\n' +
        '<Style ss:ID="valF"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFFFCC" ss:Pattern="Solid"/>'+g+'</Style>\n' +
        '<Style ss:ID="valM"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#CCFFCC" ss:Pattern="Solid"/>'+g+'</Style>\n' +
        '<Style ss:ID="valA"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFCCFF" ss:Pattern="Solid"/>'+g+'</Style>\n' +
        '<Style ss:ID="valAR"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFCCFF" ss:Pattern="Solid"/>'+gR+'</Style>\n' +
        '<Style ss:ID="konvent"><Font ss:Size="14" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFFF00" ss:Pattern="Solid"/>'+gBL+'</Style>\n' +
        '<Style ss:ID="konventVal"><Font ss:Size="14" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFFF00" ss:Pattern="Solid"/>'+gB+'</Style>\n' +
        '<Style ss:ID="konventValR"><Font ss:Size="14" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFFF00" ss:Pattern="Solid"/>'+gBR+'</Style>\n' +
        '</Styles>\n';
    })() +
    '<Worksheet ss:Name="Küchenliste">\n' +
    '<Table ss:DefaultColumnWidth="40">\n' +
    '<Column ss:Width="200"/>\n' +
    allRows +
    '</Table>\n' +
    '</Worksheet>\n' +
    '</Workbook>';

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = pad2(week1.d0.getDate()) + pad2(week1.d0.getMonth()+1) + '-' + pad2(week2.d6.getDate()) + pad2(week2.d6.getMonth()+1) + '.xls';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Küchenliste exportiert (2 Wochen)');
}

// ========== Küchenliste PDF Export ==========
function exportKuechePDF() {
  if (!window.jspdf) { showToast('PDF-Export nicht verfügbar. Bitte Seite neu laden.', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 8;
  const usableW = pageW - 2 * margin;
  const usableH = pageH - 2 * margin;

  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const wdN = ['SO','MO','DI','MI','DO','FR','SA'];
  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  // Gather data for 2 weeks
  function gatherWeek(ws) {
    const days = [];
    for (let i = 0; i < 7; i++) { const d = new Date(ws); d.setDate(ws.getDate() + i); days.push(d); }
    const allGuests = new Map();
    const konventTotals = [];
    days.forEach((day, di) => {
      day.setHours(0,0,0,0);
      const dayTime = day.getTime();
      const dateStr = pad2(day.getDate()) + '.' + pad2(day.getMonth()+1) + '.' + day.getFullYear();
      let kF=0, kM=0, kA=0;
      bookingsData.forEach(b => {
        if (b.deletedAt) return;
        if (b.status === 'storniert') return;
        const parts = splitDateRange(b.dates); if (parts.length < 2) return;
        const von = parseDateDE(parts[0]); const bis = parseDateDE(parts[1]);
        if (!von || !bis) return;
        von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
        if (dayTime >= von.getTime() && dayTime <= bis.getTime()) {
          const isArr = dayTime === von.getTime();
          const isDep = dayTime === bis.getTime();
          const isK = konventRooms.includes(b.room);
          const pers = parseInt(b.pers) || 1;
          let hasF = !isArr ? pers : 0, hasM = pers, hasA = !isDep ? pers : 0;
          const overrideKey = b.name + '|' + (b.room || '') + '|' + dateStr;
          if (mealOverrides[overrideKey]) {
            hasF = mealOverrides[overrideKey].f ? pers : 0;
            hasM = mealOverrides[overrideKey].m ? pers : 0;
            hasA = mealOverrides[overrideKey].a ? pers : 0;
          }
          if (isK) { kF += hasF; kM += hasM; kA += hasA; }
          else {
            if (!allGuests.has(b.name)) allGuests.set(b.name, { days: Array(7).fill(null).map(()=>({f:0,m:0,a:0})) });
            const g = allGuests.get(b.name);
            g.days[di].f += hasF; g.days[di].m += hasM; g.days[di].a += hasA;
          }
        }
      });
      const dateKey = pad2(day.getDate()) + '.' + pad2(day.getMonth()+1) + '.' + day.getFullYear();
      dayGuestsData.forEach(dg => {
        if (dg.date !== dateKey) return;
        const pers = dg.pers || 1;
        const isK = dg.bereich === 'konvent';
        if (isK) { if (dg.f) kF += pers; if (dg.m) kM += pers; if (dg.a) kA += pers; }
        else {
          if (!allGuests.has(dg.name)) allGuests.set(dg.name, { days: Array(7).fill(null).map(()=>({f:0,m:0,a:0})) });
          const g = allGuests.get(dg.name);
          if (dg.f) g.days[di].f += pers; if (dg.m) g.days[di].m += pers; if (dg.a) g.days[di].a += pers;
        }
      });
      konventTotals.push({f:kF, m:kM, a:kA});
    });
    // Filter guests with at least one meal
    const guests = [];
    allGuests.forEach((g, name) => {
      if (g.days.some(d => d.f > 0 || d.m > 0 || d.a > 0)) guests.push({ name, days: g.days });
    });
    return { days, guests, konventTotals };
  }

  const w1 = gatherWeek(weekStart);
  const w2Start = new Date(weekStart); w2Start.setDate(weekStart.getDate() + 7);
  const w2 = gatherWeek(w2Start);

  // Calculate font size to fit everything on one page
  // Rows: per week = 3 header rows + guests + 1 konvent row, plus title + separator
  const totalRows = 1 + (3 + w1.guests.length + 1) + 1 + (3 + w2.guests.length + 1);
  const nameColW = usableW * 0.18;
  const dayColW = (usableW - nameColW) / 21; // 7 days * 3 (F/M/A)

  // Auto-scale: start at 8pt, reduce if needed
  let fontSize = 8;
  const rowPadding = 1.5;
  while (fontSize > 5) {
    const rowH = fontSize * 0.5 + rowPadding;
    const titleH = fontSize * 0.8 + 2;
    const needed = titleH + totalRows * rowH + 4;
    if (needed <= usableH) break;
    fontSize -= 0.5;
  }
  const rowH = fontSize * 0.5 + rowPadding;
  const titleH = fontSize * 0.8 + 2;

  // Colors
  const gold = [202, 155, 72]; // #CA9B48
  const colorF = [255, 255, 204]; // #FFFFCC
  const colorM = [204, 255, 204]; // #CCFFCC
  const colorA = [255, 204, 255]; // #FFCCFF
  const konventBg = [255, 255, 0]; // Yellow

  let y = margin;

  function drawWeek(week, weekLabel) {
    const d0 = week.days[0], d6 = week.days[6];
    const title = weekLabel + ': ' + pad2(d0.getDate()) + '.' + pad2(d0.getMonth()+1) + '. – ' + pad2(d6.getDate()) + '.' + pad2(d6.getMonth()+1) + '.' + d6.getFullYear();

    // Title row
    _pdfFill(doc, ...gold);
    doc.rect(margin, y, usableW, titleH, 'F');
    doc.setDrawColor(180);
    doc.rect(margin, y, usableW, titleH);
    doc.setFontSize(fontSize + 1);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255);
    doc.text(title, margin + usableW / 2, y + titleH / 2 + 0.5, { align: 'center', baseline: 'middle' });
    doc.setTextColor(0);
    y += titleH;

    // Weekday header row
    doc.setFontSize(fontSize);
    doc.setFont('helvetica', 'bold');
    doc.setDrawColor(180);
    _pdfFill(doc, 232, 213, 183);
    doc.rect(margin, y, nameColW, rowH, 'FD');
    let x = margin + nameColW;
    week.days.forEach(d => {
      const colW3 = dayColW * 3;
      _pdfFill(doc, 232, 213, 183);
      doc.rect(x, y, colW3, rowH, 'FD');
      doc.setTextColor(80, 60, 30);
      doc.text(wdN[d.getDay()] + ' ' + pad2(d.getDate()) + '.' + pad2(d.getMonth()+1), x + colW3 / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
      x += colW3;
    });
    doc.setTextColor(0);
    y += rowH;

    // F/M/A sub-header
    doc.setFontSize(fontSize - 0.5);
    _pdfFill(doc, 245, 245, 245);
    doc.rect(margin, y, nameColW, rowH, 'FD');
    doc.text('Name', margin + 1, y + rowH / 2, { baseline: 'middle' });
    x = margin + nameColW;
    for (let i = 0; i < 7; i++) {
      _pdfFill(doc, ...colorF);
      doc.rect(x, y, dayColW, rowH, 'FD');
      doc.text('F', x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
      x += dayColW;
      _pdfFill(doc, ...colorM);
      doc.rect(x, y, dayColW, rowH, 'FD');
      doc.text('M', x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
      x += dayColW;
      _pdfFill(doc, ...colorA);
      doc.rect(x, y, dayColW, rowH, 'FD');
      doc.text('A', x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
      x += dayColW;
    }
    y += rowH;

    // Guest rows
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(fontSize - 0.5);
    week.guests.forEach((guest, gi) => {
      const bgShade = gi % 2 === 0 ? 255 : 245;
      _pdfFill(doc, bgShade, bgShade, bgShade);
      doc.rect(margin, y, nameColW, rowH, 'FD');
      doc.setFont('helvetica', 'bold');
      const nameText = guest.name.length > 22 ? guest.name.substring(0, 21) + '...' : guest.name;
      doc.text(nameText, margin + 1, y + rowH / 2, { baseline: 'middle' });
      doc.setFont('helvetica', 'normal');
      x = margin + nameColW;
      guest.days.forEach(d => {
        if (bgShade < 255) _pdfFill(doc, 245, 245, 194); else _pdfFill(doc, ...colorF);
        doc.rect(x, y, dayColW, rowH, 'FD');
        if (d.f) doc.text(String(d.f), x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
        x += dayColW;
        if (bgShade < 255) _pdfFill(doc, 194, 245, 194); else _pdfFill(doc, ...colorM);
        doc.rect(x, y, dayColW, rowH, 'FD');
        if (d.m) doc.text(String(d.m), x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
        x += dayColW;
        if (bgShade < 255) _pdfFill(doc, 245, 194, 245); else _pdfFill(doc, ...colorA);
        doc.rect(x, y, dayColW, rowH, 'FD');
        if (d.a) doc.text(String(d.a), x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
        x += dayColW;
      });
      y += rowH;
    });

    // Konvent row
    _pdfFill(doc, ...konventBg);
    doc.rect(margin, y, nameColW, rowH, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.text('Konvent', margin + 1, y + rowH / 2, { baseline: 'middle' });
    x = margin + nameColW;
    week.konventTotals.forEach(k => {
      _pdfFill(doc, ...konventBg);
      doc.rect(x, y, dayColW, rowH, 'FD');
      if (k.f) doc.text(String(k.f), x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
      x += dayColW;
      _pdfFill(doc, ...konventBg);
      doc.rect(x, y, dayColW, rowH, 'FD');
      if (k.m) doc.text(String(k.m), x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
      x += dayColW;
      _pdfFill(doc, ...konventBg);
      doc.rect(x, y, dayColW, rowH, 'FD');
      if (k.a) doc.text(String(k.a), x + dayColW / 2, y + rowH / 2, { align: 'center', baseline: 'middle' });
      x += dayColW;
    });
    y += rowH;
  }

  drawWeek(w1, 'Woche 1');
  y += 3; // separator
  drawWeek(w2, 'Woche 2');

  const fileName = 'Kuechenliste-' + pad2(w1.days[0].getDate()) + pad2(w1.days[0].getMonth()+1) + '-' + pad2(w2.days[6].getDate()) + pad2(w2.days[6].getMonth()+1) + '.pdf';
  doc.save(fileName);
  showToast('Küchenliste PDF exportiert (2 Wochen)');
}

// ========== Küchenliste ==========
let kuecheWeekStart = getMonday(new Date());
const wdNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];

function getKW(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function renderKuechenliste() {
  const statsEl = document.getElementById('kuecheStats');
  const daysEl = document.getElementById('kuecheDays');
  const subtitle = document.getElementById('kuecheSubtitle');

  const kw = getKW(kuecheWeekStart);
  subtitle.textContent = 'Mahlzeitenplanung für die Küche – KW ' + kw + '/' + kuecheWeekStart.getFullYear();

  // Build 7 days
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(kuecheWeekStart);
    d.setDate(kuecheWeekStart.getDate() + i);
    days.push(d);
  }

  // For each day, find guests present (checkIn <= day && checkOut > day for meals logic)
  // Frühstück: guest is there if checkIn < day (arrived before) — not on arrival day
  // Mittagessen: guest is there if day is between checkIn and checkOut
  // Abendessen: guest is there if day < checkOut (not on departure day)
  let totalF = 0, totalM = 0, totalA = 0;
  let daysHtml = '';

  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  days.forEach(day => {
    day.setHours(0,0,0,0);
    const dayTime = day.getTime();

    // Find all bookings active on this day
    const dayGuests = [];
    bookingsData.forEach(b => {
      if (b.deletedAt) return;
      if (b.status === 'storniert') return;
      const parts = splitDateRange(b.dates);
      if (parts.length < 2) return;
      const von = parseDateDE(parts[0]);
      const bis = parseDateDE(parts[1]);
      if (!von || !bis) return;
      von.setHours(0,0,0,0);
      bis.setHours(0,0,0,0);
      if (dayTime >= von.getTime() && dayTime <= bis.getTime()) {
        const isArrival = dayTime === von.getTime();
        const isDeparture = dayTime === bis.getTime();
        const isKonvent = konventRooms.includes(b.room);
        const pers = parseInt(b.pers) || 1;
        // Frühstück: not on arrival day
        const hasF = !isArrival;
        // Mittagessen: always (arrival + during + departure)
        const hasM = true;
        // Abendessen: not on departure day
        const hasA = !isDeparture;
        // Check for dietary notes
        const dietaryKeywords = ['vegetarisch', 'vegan', 'allergi', 'glutenfrei', 'laktose'];
        const hasDietaryNote = b.notes && dietaryKeywords.some(kw => b.notes.toLowerCase().includes(kw));
        dayGuests.push({ name: b.name, room: b.room, pers, hasF, hasM, hasA, isKonvent, dietaryNote: hasDietaryNote ? b.notes : null });
      }
    });

    // Add day guests for this day
    const dateKey = pad2(day.getDate()) + '.' + pad2(day.getMonth()+1) + '.' + day.getFullYear();
    dayGuestsData.forEach((dg, dgIndex) => {
      if (dg.date === dateKey) {
        const isKonvent = dg.bereich === 'konvent';
        dayGuests.push({
          name: dg.name, room: '', pers: dg.pers || 1,
          hasF: dg.f || false, hasM: dg.m || false, hasA: dg.a || false,
          isKonvent, isDayGuest: true, veg: dg.veg || false, _dgIndex: dgIndex, _dgDate: dg.date
        });
      }
    });

    if (dayGuests.length === 0) return;

    // Split into Gästetrakt and Konvent
    const gaesteGruppe = dayGuests.filter(g => !g.isKonvent);
    const konventGruppe = dayGuests.filter(g => g.isKonvent);

    // Recalculate with overrides
    let dayF = 0, dayM = 0, dayA = 0;
    const dateStr = pad2(day.getDate()) + '.' + pad2(day.getMonth() + 1) + '.' + day.getFullYear();

    dayGuests.forEach(g => {
      const key = g.name + '|' + (g.room || '') + '|' + dateStr;
      if (mealOverrides[key]) {
        g.hasF = mealOverrides[key].f;
        g.hasM = mealOverrides[key].m;
        g.hasA = mealOverrides[key].a;
      }
      if (g.hasF) dayF += g.pers;
      if (g.hasM) dayM += g.pers;
      if (g.hasA) dayA += g.pers;
    });
    totalF += dayF;
    totalM += dayM;
    totalA += dayA;

    const dayName = wdNames[day.getDay()];

    function renderGuestRows(guests, dateStr) {
      // Deduplicate by name (group bookings show once with total pers)
      const seen = new Map();
      guests.forEach(g => {
        const key = g.isDayGuest ? (g.name + '_dg_' + (g._dgIndex != null ? g._dgIndex : '')) : g.name;
        if (seen.has(key)) {
          const existing = seen.get(key);
          existing.pers += g.pers;
          existing.hasF = existing.hasF || g.hasF;
          existing.hasM = existing.hasM || g.hasM;
          existing.hasA = existing.hasA || g.hasA;
          existing.dietaryNote = existing.dietaryNote || g.dietaryNote;
          existing.rooms.push(g.room);
        } else {
          seen.set(key, { ...g, rooms: [g.room] });
        }
      });

      // Overrides wurden bereits oben auf die Gast-Objekte angewendet (vor Deduplizierung)
      // Hier NICHT nochmal anwenden, da sonst bei Gästen mit mehreren Zimmern
      // nur der Override des ersten Zimmers zählt und die dedupizierten Werte überschrieben werden.

      let html = '';
      seen.forEach(g => {
        const fClass = g.hasF ? 'active' : 'inactive';
        const mClass = g.hasM ? 'active' : 'inactive';
        const aClass = g.hasA ? 'active' : 'inactive';
        const persLabel = g.pers > 1 ? ' <span style="font-size:11px;color:var(--text-muted);">(' + g.pers + ' Pers.)</span>' : '';
        const vegBadge = g.veg ? ' <span class="kueche-stat-veg" style="font-size:10px;padding:1px 6px;margin-left:4px;"><i data-lucide="leaf" style="width:10px;height:10px;"></i></span>' : '';
        const dietaryBadge = g.dietaryNote ? ' <span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:1px 6px;border-radius:9999px;background:var(--yellow-light);color:#92710d;margin-left:4px;" title="' + escHtml(g.dietaryNote) + '"><i data-lucide="alert-triangle" style="width:10px;height:10px;"></i> Diät</span>' : '';
        const dayGuestBadge = g.isDayGuest ? ' <span class="badge badge-storniert" style="font-size:10px;padding:1px 6px;">Tagesgast</span>' : '';
        const overrideKey = g.name + '|' + (g.rooms ? g.rooms[0] : '') + '|' + dateStr;
        // Find dayGuestsData index for delete button
        let deleteBtn = '';
        if (g.isDayGuest && g._dgIndex != null) {
          deleteBtn = ` <button class="icon-btn delete" style="width:22px;height:22px;flex-shrink:0;" onclick="removeDayGuest(${g._dgIndex})"><i data-lucide="x" style="width:12px;height:12px;"></i></button>`;
        }
        html += `
          <div class="kueche-guest-row">
            <span class="kueche-guest-name" style="display:flex;align-items:center;gap:4px;">${escHtml(g.name)}${persLabel}${dayGuestBadge}${vegBadge}${dietaryBadge}${deleteBtn}</span>
            <div class="meal-checks">
              <div class="meal-check ${fClass}" data-meal="f" data-key="${overrideKey}" style="cursor:pointer;" onclick="toggleMeal(this)">
                <i data-lucide="coffee" style="width:12px;height:12px;"></i>
              </div>
              <div class="meal-check ${mClass}" data-meal="m" data-key="${overrideKey}" style="cursor:pointer;" onclick="toggleMeal(this)">
                <i data-lucide="sun" style="width:12px;height:12px;"></i>
              </div>
              <div class="meal-check ${aClass}" data-meal="a" data-key="${overrideKey}" style="cursor:pointer;" onclick="toggleMeal(this)">
                <i data-lucide="moon" style="width:12px;height:12px;"></i>
              </div>
            </div>
          </div>`;
      });
      return html;
    }

    let cardHtml = `
      <div class="kueche-day-card">
        <div class="kueche-day-header">
          <div class="kueche-day-title">${dayName}, ${dateStr}</div>
          <div class="kueche-meal-icons">
            <span><i data-lucide="coffee" style="width:14px;height:14px;"></i> ${dayF}</span>
            <span><i data-lucide="sun" style="width:14px;height:14px;"></i> ${dayM}</span>
            <span><i data-lucide="moon" style="width:14px;height:14px;"></i> ${dayA}</span>
          </div>
        </div>`;

    if (gaesteGruppe.length > 0) {
      cardHtml += '<div class="kueche-sub-section">Gästetrakt</div>';
      cardHtml += renderGuestRows(gaesteGruppe, dateStr);
    }
    if (konventGruppe.length > 0) {
      cardHtml += '<div class="kueche-sub-section">Konvent</div>';
      cardHtml += renderGuestRows(konventGruppe, dateStr);
    }

    cardHtml += '</div>';
    daysHtml += cardHtml;
  });

  if (!daysHtml) {
    daysHtml = '<div style="text-align:center;padding:40px 20px;color:var(--text-muted);">Keine Gäste in dieser Woche.</div>';
  }

  // Stats
  statsEl.innerHTML = `
    <div class="kueche-stat">
      <div class="kueche-stat-icon" style="color:#e67717;"><i data-lucide="coffee" style="width:20px;height:20px;"></i></div>
      <div class="kueche-stat-value">${totalF}</div>
      <div class="kueche-stat-label">Frühstück</div>
    </div>
    <div class="kueche-stat">
      <div class="kueche-stat-icon" style="color:#e8a817;"><i data-lucide="sun" style="width:20px;height:20px;"></i></div>
      <div class="kueche-stat-value">${totalM}</div>
      <div class="kueche-stat-label">Mittagessen</div>
    </div>
    <div class="kueche-stat">
      <div class="kueche-stat-icon" style="color:#6366f1;"><i data-lucide="moon" style="width:20px;height:20px;"></i></div>
      <div class="kueche-stat-value">${totalA}</div>
      <div class="kueche-stat-label">Abendessen</div>
    </div>`;

  daysEl.innerHTML = daysHtml;
  lucide.createIcons({ nodes: [statsEl, daysEl] });
}

function initKuecheNav() {
  document.getElementById('kuechePrev').addEventListener('click', () => {
    kuecheWeekStart.setDate(kuecheWeekStart.getDate() - 7);
    exportWeekStart = new Date(kuecheWeekStart);
    renderKuechenliste();
  });
  document.getElementById('kuecheNext').addEventListener('click', () => {
    kuecheWeekStart.setDate(kuecheWeekStart.getDate() + 7);
    exportWeekStart = new Date(kuecheWeekStart);
    renderKuechenliste();
  });
  document.getElementById('kuecheToday').addEventListener('click', () => {
    kuecheWeekStart = getMonday(new Date());
    exportWeekStart = new Date(kuecheWeekStart);
    renderKuechenliste();
  });
  document.getElementById('kuechePrint').addEventListener('click', () => {
    window.print();
  });
}

// ========== Meal Toggle ==========
function toggleMeal(el) {
  const key = el.getAttribute('data-key');
  const meal = el.getAttribute('data-meal');
  const isActive = el.classList.contains('active');

  // Initialize override if not exists
  if (!mealOverrides[key]) {
    // Get current state from all three buttons in same row
    const row = el.closest('.meal-checks');
    const btns = row.querySelectorAll('.meal-check');
    mealOverrides[key] = {
      f: btns[0].classList.contains('active'),
      m: btns[1].classList.contains('active'),
      a: btns[2].classList.contains('active'),
    };
  }

  // Toggle
  mealOverrides[key][meal] = !isActive;
  el.classList.toggle('active');
  el.classList.toggle('inactive');
  saveData();

  // Update stats (recalculate totals)
  updateKuecheStats();
}

function updateKuecheStats() {
  // Quick recalculate by re-rendering
  renderKuechenliste();
  renderExportTable();
}

// ========== Tagesgast ==========
function openTagesgastModal() {
  // Populate day dropdown with current week
  const select = document.getElementById('tagesgastTag');
  select.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(kuecheWeekStart);
    d.setDate(kuecheWeekStart.getDate() + i);
    const dayName = wdNames[d.getDay()];
    const dateStr = pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.';
    const fullDate = pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
    const opt = document.createElement('option');
    opt.value = fullDate;
    opt.textContent = dayName + ', ' + dateStr;
    // Default to today if in range
    const today = new Date();
    if (d.toDateString() === today.toDateString()) opt.selected = true;
    select.appendChild(opt);
  }
  document.getElementById('tagesgastName').value = '';
  document.getElementById('tagesgastPers').value = '1';
  document.getElementById('tagesgastBereich').value = 'gaestetrakt';
  document.getElementById('tagesgastF').checked = false;
  document.getElementById('tagesgastM').checked = true;
  document.getElementById('tagesgastA').checked = false;
  document.getElementById('tagesgastVeg').value = 'normal';
  openModal('modalTagesgast');
}

function saveTagesgast() {
  const name = document.getElementById('tagesgastName').value.trim();
  const date = document.getElementById('tagesgastTag').value;
  const pers = parseInt(document.getElementById('tagesgastPers').value) || 1;
  const bereich = document.getElementById('tagesgastBereich').value;
  const f = document.getElementById('tagesgastF').checked;
  const m = document.getElementById('tagesgastM').checked;
  const a = document.getElementById('tagesgastA').checked;
  const veg = document.getElementById('tagesgastVeg').value === 'vegetarisch';

  if (!name) {
    showToast('Bitte Name eingeben');
    return;
  }
  if (!f && !m && !a) {
    showToast('Bitte mindestens eine Mahlzeit wählen');
    return;
  }

  dayGuestsData.push({ name, date, pers, bereich, f, m, a, veg });
  saveData();
  closeModal('modalTagesgast');
  renderKuechenliste();
  showToast('Tagesgast hinzugefügt');
}

// ========== Remove Day Guest ==========
function removeDayGuest(index) {
  if (index >= 0 && index < dayGuestsData.length) {
    dayGuestsData.splice(index, 1);
    saveData();
    renderKuechenliste();
    updateBackupStats();
    showToast('Tagesgast entfernt');
  }
}

// ========== Import File Handler ==========
function initImportHandler() {
  document.getElementById('importFileInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
      showConfirm(
        'Backup importieren?',
        'Alle aktuellen Buchungen und Gäste werden durch die importierten Daten ersetzt.',
        'Importieren',
        () => importBackupJSON(file)
      );
    }
    this.value = ''; // Reset for re-import
  });
}

// ========== Gast History ==========
function showGuestHistory(guestName) {
  document.getElementById('gastHistoryTitle').textContent = 'Buchungshistorie';
  document.getElementById('gastHistoryName').textContent = guestName;

  // Find all bookings for this guest (fuzzy match on name)
  const lowerName = guestName.toLowerCase();
  const guestBookings = bookingsData.filter(b => {
    if (b.deletedAt) return false;
    const bName = b.name.toLowerCase();
    return bName === lowerName || bName.includes(lowerName) || lowerName.includes(bName);
  });

  // Sort by date descending (newest first)
  guestBookings.sort((a, b) => {
    const aDate = parseDateDE(splitDateRange(a.dates)[0]);
    const bDate = parseDateDE(splitDateRange(b.dates)[0]);
    if (!aDate || !bDate) return 0;
    return bDate - aDate;
  });

  const today = new Date();
  today.setHours(0,0,0,0);

  // Split into past and upcoming
  const past = [];
  const upcoming = [];
  guestBookings.forEach(b => {
    const parts = splitDateRange(b.dates);
    const bis = parts.length >= 2 ? parseDateDE(parts[1]) : null;
    if (bis) bis.setHours(0,0,0,0);
    if (bis && bis < today) {
      past.push(b);
    } else {
      upcoming.push(b);
    }
  });

  // Stats
  const totalStays = guestBookings.length;
  let totalNights = 0;
  guestBookings.forEach(b => {
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (von && bis) {
      const diff = Math.round((bis - von) / (1000 * 60 * 60 * 24));
      if (diff > 0) totalNights += diff;
    }
  });

  let totalSpenden = 0;
  guestBookings.forEach(b => { if (b.spende && b.spende > 0) totalSpenden += b.spende; });
  const spendenStr = totalSpenden > 0 ? ' · ' + formatEUR(totalSpenden) + ' Spenden' : '';
  document.getElementById('gastHistoryStats').textContent =
    totalStays + ' Buchung' + (totalStays !== 1 ? 'en' : '') + ' · ' + totalNights + ' Nächte gesamt' + spendenStr;

  // Guest pattern detection
  const guestPattern = getGuestPattern(guestName);
  const patternEl = document.getElementById('gastHistoryPattern');
  if (patternEl) {
    if (guestPattern) {
      patternEl.style.display = 'flex';
      patternEl.innerHTML = '<i data-lucide="repeat" style="width:14px;height:14px;flex-shrink:0;"></i> ' + escHtml(guestPattern);
    } else {
      patternEl.style.display = 'none';
    }
  }

  const body = document.getElementById('gastHistoryBody');

  if (guestBookings.length === 0) {
    body.innerHTML = `
      <div class="zimmer-detail-empty">
        <div class="zimmer-detail-empty-icon"><i data-lucide="calendar-x" style="width:40px;height:40px;"></i></div>
        <div style="font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">Keine Buchungen</div>
        <div>Für diesen Gast sind keine Buchungen erfasst.</div>
      </div>`;
    openModal('modalGastHistory');
    lucide.createIcons({ nodes: [body] });
    return;
  }

  function renderBookingItem(b, isPast) {
    const badgeClass = b.status === 'anfrage' ? 'badge-anfrage' :
                       b.status === 'bestaetigt' ? 'badge-bestaetigt' :
                       b.status === 'storniert' ? 'badge-storniert' : 'badge-abgeschlossen';
    const badgeText = b.status === 'anfrage' ? 'Anfrage' :
                      b.status === 'bestaetigt' ? 'Bestätigt' :
                      b.status === 'storniert' ? 'Storniert' : 'Abgeschlossen';
    const dotClass = isPast ? 'style="background:var(--text-muted);"' : '';

    return `
      <li class="zimmer-detail-item" style="${isPast ? 'opacity:0.7;' : ''}">
        <div class="zimmer-detail-dot" ${dotClass} style="background:${isPast ? 'var(--text-muted)' : 'var(--accent)'};"></div>
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="zimmer-detail-guest-name">${escHtml(b.room)}</div>
            <span class="badge ${badgeClass}" style="font-size:11px;padding:1px 8px;">${badgeText}</span>
          </div>
          <div class="zimmer-detail-dates">
            <i data-lucide="calendar" style="width:13px;height:13px;"></i>
            ${escHtml(b.dates)}
          </div>
          <div class="zimmer-detail-meta">${escHtml(b.pers)}</div>${renderActivityTags(b.activities)}${b.spende && b.spende > 0 ? '<div style="font-size:12px;color:var(--green);margin-top:2px;font-weight:600;display:flex;align-items:center;gap:4px;"><i data-lucide="heart" style="width:12px;height:12px;"></i> ' + formatEUR(b.spende) + '</div>' : ''}
        </div>
      </li>`;
  }

  let html = '';

  if (upcoming.length > 0) {
    // Sort upcoming by date ascending
    upcoming.sort((a, b) => {
      const aDate = parseDateDE(splitDateRange(a.dates)[0]);
      const bDate = parseDateDE(splitDateRange(b.dates)[0]);
      return (aDate || 0) - (bDate || 0);
    });
    html += `<div class="zimmer-detail-section-title">Kommende Buchungen (${upcoming.length})</div>`;
    html += '<ul class="zimmer-detail-list">';
    upcoming.forEach(b => { html += renderBookingItem(b, false); });
    html += '</ul>';
  }

  if (past.length > 0) {
    html += `<div class="zimmer-detail-section-title" style="margin-top:${upcoming.length ? '8' : '0'}px;">Vergangene Buchungen (${past.length})</div>`;
    html += '<ul class="zimmer-detail-list">';
    past.forEach(b => { html += renderBookingItem(b, true); });
    html += '</ul>';
  }

  body.innerHTML = html;
  openModal('modalGastHistory');
  lucide.createIcons({ nodes: [body] });
}

// ========== Zimmer-Verfügbarkeit für Neue Buchung ==========
function updateZimmerDropdown() {
  const anreise = document.getElementById('buchungAnreise').value;
  const abreise = document.getElementById('buchungAbreise').value;
  const select = document.getElementById('buchungZimmer');
  const hint = document.getElementById('buchungZimmerHint');
  const currentVal = select.value;

  if (!anreise || !abreise) {
    select.innerHTML = '<option value="">Bitte zuerst Datum wählen...</option>';
    hint.textContent = '';
    return;
  }

  const von = new Date(anreise);
  const bis = new Date(abreise);
  von.setHours(0,0,0,0);
  bis.setHours(0,0,0,0);

  if (bis <= von) {
    select.innerHTML = '<option value="">Abreise muss nach Anreise liegen</option>';
    hint.textContent = '';
    return;
  }

  // Check each room for availability
  const freeRooms = [];
  const occupiedRooms = [];

  allRoomsList.forEach(room => {
    const conflict = bookingsData.some(b => {
      if (b.room !== room) return false;
      if (b.status === 'storniert' || b.status === 'abgeschlossen' || b.deletedAt) return false;
      const parts = splitDateRange(b.dates);
      if (parts.length < 2) return false;
      const bVon = parseDateDE(parts[0]);
      const bBis = parseDateDE(parts[1]);
      if (!bVon || !bBis) return false;
      // Bestehende Buchung: Check-in 14:00, Check-out 10:00
      bVon.setHours(CHECKIN_HOUR, 0, 0, 0);
      bBis.setHours(CHECKOUT_HOUR, 0, 0, 0);
      // Neue Buchung: Check-in 14:00, Check-out 10:00
      const newVon = new Date(von); newVon.setHours(CHECKIN_HOUR, 0, 0, 0);
      const newBis = new Date(bis); newBis.setHours(CHECKOUT_HOUR, 0, 0, 0);
      // Overlap check mit Check-in/out Zeiten
      return bVon < newBis && bBis > newVon;
    });

    if (conflict) {
      occupiedRooms.push(room);
    } else {
      freeRooms.push(room);
    }
  });

  select.innerHTML = '';

  if (freeRooms.length === 0) {
    select.innerHTML = '<option value="">Keine Zimmer frei in diesem Zeitraum</option>';
    hint.textContent = '0 von ' + allRoomsList.length + ' frei';
    hint.style.color = 'var(--red)';
    return;
  }

  hint.textContent = freeRooms.length + ' von ' + allRoomsList.length + ' frei';
  hint.style.color = 'var(--green)';

  // Add free rooms with green indicator
  const freeGroup = document.createElement('optgroup');
  freeGroup.label = 'Frei (' + freeRooms.length + ')';
  freeRooms.forEach(room => {
    const opt = document.createElement('option');
    opt.value = room;
    opt.textContent = '✓ ' + room;
    if (room === currentVal) opt.selected = true;
    freeGroup.appendChild(opt);
  });
  select.appendChild(freeGroup);

  // Add occupied rooms (disabled) so user can see what's taken
  if (occupiedRooms.length > 0) {
    const occGroup = document.createElement('optgroup');
    occGroup.label = 'Belegt (' + occupiedRooms.length + ')';
    occupiedRooms.forEach(room => {
      const opt = document.createElement('option');
      opt.value = room;
      opt.textContent = '✗ ' + room;
      opt.disabled = true;
      opt.style.color = '#ccc';
      occGroup.appendChild(opt);
    });
    select.appendChild(occGroup);
  }
}

function initZimmerDropdown() {
  document.getElementById('buchungAnreise').addEventListener('change', updateZimmerDropdown);
  document.getElementById('buchungAbreise').addEventListener('change', updateZimmerDropdown);
}

// ========== Autocomplete Gastname ==========
function initGastAutocomplete() {
  const input = document.getElementById('buchungGast');
  const wrapper = document.getElementById('buchungGastWrapper');
  let list = null;
  let highlightIdx = -1;

  function showList(filtered, query) {
    removeList();
    if (filtered.length === 0) return;
    list = document.createElement('div');
    list.className = 'autocomplete-list';
    highlightIdx = -1;

    filtered.forEach((name, i) => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';

      // Initials
      const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
      const icon = document.createElement('div');
      icon.className = 'autocomplete-item-icon';
      icon.textContent = initials;

      // Highlighted name
      const span = document.createElement('span');
      const lowerName = name.toLowerCase();
      const lowerQuery = query.toLowerCase();
      const matchIdx = lowerName.indexOf(lowerQuery);
      if (matchIdx >= 0 && query.length > 0) {
        span.innerHTML = escapeHtml(name.substring(0, matchIdx))
          + '<span class="autocomplete-match">' + escapeHtml(name.substring(matchIdx, matchIdx + query.length)) + '</span>'
          + escapeHtml(name.substring(matchIdx + query.length));
      } else {
        span.textContent = name;
      }

      item.appendChild(icon);
      item.appendChild(span);

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = name;
        removeList();
      });

      list.appendChild(item);
    });

    wrapper.appendChild(list);
  }

  function removeList() {
    if (list) { list.remove(); list = null; }
    highlightIdx = -1;
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  input.addEventListener('input', function() {
    const val = this.value.trim().toLowerCase();
    if (val.length === 0) { removeList(); return; }
    const filtered = guestsData.filter(g => guestName(g).toLowerCase().includes(val)).map(g => guestName(g));
    showList(filtered, this.value.trim());
  });

  input.addEventListener('focus', function() {
    const val = this.value.trim().toLowerCase();
    if (val.length > 0) {
      const filtered = guestsData.filter(g => guestName(g).toLowerCase().includes(val)).map(g => guestName(g));
      showList(filtered, this.value.trim());
    }
  });

  input.addEventListener('blur', function() {
    setTimeout(removeList, 150);
  });

  input.addEventListener('keydown', function(e) {
    if (!list) return;
    const items = list.querySelectorAll('.autocomplete-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
      updateHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightIdx = Math.max(highlightIdx - 1, 0);
      updateHighlight(items);
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault();
      e.stopPropagation();
      const selected = items[highlightIdx];
      if (selected) {
        input.value = selected.querySelector('span').textContent;
        removeList();
      }
    } else if (e.key === 'Escape') {
      removeList();
    }
  });

  function updateHighlight(items) {
    items.forEach((it, i) => {
      it.classList.toggle('highlighted', i === highlightIdx);
      if (i === highlightIdx) it.scrollIntoView({ block: 'nearest' });
    });
  }
}

// ========== Export Table ==========
let exportWeekStart = getMonday(new Date());
let exportMode = 'woche'; // 'woche' or 'monat'

function getExportDays() {
  if (exportMode === 'monat') {
    const ref = new Date(exportWeekStart);
    const year = ref.getFullYear();
    const month = ref.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const d = new Date(year, month, i);
      d.setHours(0,0,0,0);
      days.push(d);
    }
    return days;
  }
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(exportWeekStart);
    d.setDate(exportWeekStart.getDate() + i);
    d.setHours(0,0,0,0);
    days.push(d);
  }
  return days;
}

function initExportNav() {
  document.getElementById('exportPrev').addEventListener('click', () => {
    if (exportMode === 'monat') {
      exportWeekStart.setMonth(exportWeekStart.getMonth() - 1);
    } else {
      exportWeekStart.setDate(exportWeekStart.getDate() - 7);
      kuecheWeekStart = new Date(exportWeekStart);
    }
    renderExportTable();
  });
  document.getElementById('exportNext').addEventListener('click', () => {
    if (exportMode === 'monat') {
      exportWeekStart.setMonth(exportWeekStart.getMonth() + 1);
    } else {
      exportWeekStart.setDate(exportWeekStart.getDate() + 7);
      kuecheWeekStart = new Date(exportWeekStart);
    }
    renderExportTable();
  });
  document.getElementById('exportZeitraum').addEventListener('change', function() {
    exportMode = this.value;
    renderExportTable();
  });
}

function renderExportTable() {
  const container = document.getElementById('exportTableContainer');
  const dateRangeEl = document.getElementById('exportDateRange');

  const days = getExportDays();
  const lastDay = days[days.length - 1];

  // Update date range display
  if (exportMode === 'monat') {
    dateRangeEl.innerHTML = '<i data-lucide="calendar" style="width:14px;height:14px;"></i> ' + monthNames[days[0].getMonth()] + ' ' + days[0].getFullYear();
  } else {
    const startStr = pad2(days[0].getDate()) + '.' + pad2(days[0].getMonth()+1) + '.' + days[0].getFullYear();
    const endStr = pad2(lastDay.getDate()) + '.' + pad2(lastDay.getMonth()+1) + '.' + lastDay.getFullYear();
    dateRangeEl.innerHTML = '<i data-lucide="calendar" style="width:14px;height:14px;"></i> ' + startStr + ' – ' + endStr;
  }

  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];
  const dayNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];

  // Collect all guests with meals per day
  // guestMap: { guestName => { days: [ {f,m,a,pers} x7 ], isKonvent } }
  const guestMap = new Map();
  const konventTotals = days.map(() => ({ f:0, m:0, a:0 }));

  days.forEach((day, dayIdx) => {
    const dayTime = day.getTime();

    const dateStr = pad2(day.getDate()) + '.' + pad2(day.getMonth()+1) + '.' + day.getFullYear();

    // Regular bookings
    bookingsData.forEach(b => {
      if (b.deletedAt) return;
      if (b.status === 'storniert') return;
      const parts = splitDateRange(b.dates);
      if (parts.length < 2) return;
      const von = parseDateDE(parts[0]);
      const bis = parseDateDE(parts[1]);
      if (!von || !bis) return;
      von.setHours(0,0,0,0);
      bis.setHours(0,0,0,0);
      if (dayTime >= von.getTime() && dayTime <= bis.getTime()) {
        const isArrival = dayTime === von.getTime();
        const isDeparture = dayTime === bis.getTime();
        const isKonvent = konventRooms.includes(b.room);
        const pers = parseInt(b.pers) || 1;
        let hasF = !isArrival;
        let hasM = true;
        let hasA = !isDeparture;

        // Apply meal overrides
        const overrideKey = b.name + '|' + (b.room || '') + '|' + dateStr;
        if (mealOverrides[overrideKey]) {
          hasF = mealOverrides[overrideKey].f;
          hasM = mealOverrides[overrideKey].m;
          hasA = mealOverrides[overrideKey].a;
        }

        if (!guestMap.has(b.name)) {
          guestMap.set(b.name, { days: days.map(() => null), isKonvent });
        }
        const entry = guestMap.get(b.name);
        if (!entry.days[dayIdx]) {
          entry.days[dayIdx] = { f: 0, m: 0, a: 0 };
        }
        if (hasF) entry.days[dayIdx].f += pers;
        if (hasM) entry.days[dayIdx].m += pers;
        if (hasA) entry.days[dayIdx].a += pers;
      }
    });

    // Day guests
    const dateKey = pad2(day.getDate()) + '.' + pad2(day.getMonth()+1) + '.' + day.getFullYear();
    dayGuestsData.forEach(dg => {
      if (dg.date === dateKey) {
        const isKonvent = dg.bereich === 'konvent';
        const guestKey = dg.name + (isKonvent ? ' (Konvent)' : ' (Tagesgast)');
        if (!guestMap.has(guestKey)) {
          guestMap.set(guestKey, { days: days.map(() => null), isKonvent });
        }
        const entry = guestMap.get(guestKey);
        if (!entry.days[dayIdx]) {
          entry.days[dayIdx] = { f: 0, m: 0, a: 0 };
        }
        const pers = dg.pers || 1;
        if (dg.f) entry.days[dayIdx].f += pers;
        if (dg.m) entry.days[dayIdx].m += pers;
        if (dg.a) entry.days[dayIdx].a += pers;
      }
    });
  });

  // Calculate konvent totals
  guestMap.forEach((entry, name) => {
    if (entry.isKonvent) {
      entry.days.forEach((d, i) => {
        if (d) {
          konventTotals[i].f += d.f;
          konventTotals[i].m += d.m;
          konventTotals[i].a += d.a;
        }
      });
    }
  });

  // Filter to non-konvent guests with at least one meal
  const guestEntries = [];
  guestMap.forEach((entry, name) => {
    if (!entry.isKonvent) {
      const hasMeals = entry.days.some(d => d && (d.f > 0 || d.m > 0 || d.a > 0));
      if (hasMeals) guestEntries.push({ name, ...entry });
    }
  });

  const guestCount = guestEntries.length;
  const isMonat = exportMode === 'monat';

  let tableHtml = '';

  if (!isMonat) {
    // Wochenansicht: F/M/A Tabelle
    let headerRow1 = '<th rowspan="2" style="text-align:left;padding-left:10px;">Gast</th>';
    days.forEach(d => {
      const dayName = dayNames[d.getDay()];
      const dateStr = pad2(d.getDate()) + '.' + pad2(d.getMonth()+1) + '.';
      headerRow1 += `<th colspan="3">${dayName}<br><small>${dateStr}</small></th>`;
    });

    let headerRow2 = '';
    for (let i = 0; i < days.length; i++) {
      headerRow2 += '<th>F</th><th>M</th><th>A</th>';
    }

    let bodyRows = '';
    guestEntries.forEach(g => {
      bodyRows += '<tr><td style="text-align:left;padding-left:10px;">' + g.name + '</td>';
      g.days.forEach(d => {
        if (d) {
          bodyRows += '<td>' + (d.f || '') + '</td><td>' + (d.m || '') + '</td><td>' + (d.a || '') + '</td>';
        } else {
          bodyRows += '<td></td><td></td><td></td>';
        }
      });
      bodyRows += '</tr>';
    });

    bodyRows += '<tr class="konvent-row"><td style="text-align:left;padding-left:10px;">Konvent</td>';
    konventTotals.forEach(t => {
      bodyRows += '<td>' + (t.f || '') + '</td><td>' + (t.m || '') + '</td><td>' + (t.a || '') + '</td>';
    });
    bodyRows += '</tr>';

    tableHtml = `<div style="overflow-x:auto;">
      <table class="export-table">
        <thead><tr>${headerRow1}</tr><tr>${headerRow2}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table></div>`;
  } else {
    // Monatsansicht: Gästeliste mit Zimmer und Aufenthalt
    const wdK = ['SO','MO','DI','MI','DO','FR','SA'];
    const allMonthGuests = [];
    const firstDay = days[0], lastDayM = days[days.length-1];

    bookingsData.forEach(b => {
      if (b.deletedAt) return;
      if (b.status === 'storniert') return;
      const parts = splitDateRange(b.dates);
      if (parts.length < 2) return;
      const von = parseDateDE(parts[0]);
      const bis = parseDateDE(parts[1]);
      if (!von || !bis) return;
      von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
      if (von <= lastDayM && bis >= firstDay) {
        const aufenthalt = wdK[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + wdK[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
        const key = b.name + '|' + b.room + '|' + aufenthalt;
        if (!allMonthGuests.find(g => g.key === key)) {
          allMonthGuests.push({ name: b.name, room: b.room, aufenthalt, pers: b.pers, key, von, isKonvent: konventRooms.includes(b.room) });
        }
      }
    });

    allMonthGuests.sort((a,b) => (a.von||0) - (b.von||0));
    const gaestetrakt = allMonthGuests.filter(g => !g.isKonvent);
    const konvent = allMonthGuests.filter(g => g.isKonvent);

    function renderSection(title, list) {
      let html = '<tr><th colspan="4" style="text-align:left;padding:10px;background:var(--accent-bg);font-size:14px;">' + title + '</th></tr>';
      html += '<tr><th style="text-align:left;padding-left:10px;">Name</th><th>Zimmer</th><th>Aufenthalt</th><th>Pers.</th></tr>';
      if (list.length === 0) {
        html += '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:12px;">Keine Gäste</td></tr>';
      }
      list.forEach(g => {
        html += '<tr><td style="text-align:left;padding-left:10px;">' + g.name + '</td>';
        html += '<td>' + g.room + '</td><td>' + g.aufenthalt + '</td><td>' + g.pers + '</td></tr>';
      });
      return html;
    }

    tableHtml = `<div style="overflow-x:auto;">
      <table class="export-table">
        <tbody>
          ${renderSection('Gästetrakt – ' + monthNames[firstDay.getMonth()] + ' ' + firstDay.getFullYear(), gaestetrakt)}
          ${renderSection('Konvent – ' + monthNames[firstDay.getMonth()] + ' ' + firstDay.getFullYear(), konvent)}
        </tbody>
      </table></div>`;
  }

  container.innerHTML = `
    <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;margin-bottom:20px;">
      <h3 style="font-size:16px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
        <i data-lucide="${isMonat ? 'calendar' : 'utensils-crossed'}" style="width:18px;height:18px;"></i> ${isMonat ? 'Gästeübersicht' : 'Küchenliste'}
      </h3>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">${isMonat ? 'Alle Buchungen im ' + monthNames[days[0].getMonth()] + ' ' + days[0].getFullYear() : guestCount + ' Gäste/Gruppen im Zeitraum (ohne Konvent)'}</p>
      ${tableHtml}
      <button class="export-btn-full" onclick="exportKuecheXLSX()">
        <i data-lucide="download" style="width:18px;height:18px;"></i>
        Küchenliste exportieren (XLSX)
      </button>
      <button class="export-btn-full" style="margin-top:4px;background:#8B7355;" onclick="exportKuechePDF()">
        <i data-lucide="file-text" style="width:18px;height:18px;"></i>
        Küchenliste (PDF)
      </button>
      <button class="export-btn-full" style="margin-top:8px;background:var(--accent);" onclick="exportGaestelisteXLSX()">
        <i data-lucide="download" style="width:18px;height:18px;"></i>
        Gästeliste Woche (XLSX)
      </button>
      <button class="export-btn-full" style="margin-top:4px;background:#8B7355;" onclick="exportGaestelistePDF()">
        <i data-lucide="file-text" style="width:18px;height:18px;"></i>
        Gästeliste Woche (PDF)
      </button>
      <button class="export-btn-full" style="margin-top:8px;background:var(--accent);" onclick="exportGaestelisteMonatXLSX()">
        <i data-lucide="download" style="width:18px;height:18px;"></i>
        Gästeliste Monat (XLSX)
      </button>
      <button class="export-btn-full" style="margin-top:4px;background:#8B7355;" onclick="exportGaestelisteMonatPDF()">
        <i data-lucide="file-text" style="width:18px;height:18px;"></i>
        Gästeliste Monat (PDF)
      </button>
      <button class="export-btn-full" style="margin-top:8px;background:var(--accent-dark);" onclick="exportNamensliste()">
        <i data-lucide="download" style="width:18px;height:18px;"></i>
        Namensliste (XLSX)
      </button>
      <button class="export-btn-full" style="margin-top:4px;background:#8B7355;" onclick="exportNamenslistePDF()">
        <i data-lucide="file-text" style="width:18px;height:18px;"></i>
        Namensliste (PDF)
      </button>
      <button class="export-btn-full" style="margin-top:8px;background:#b8963e;" onclick="exportTuerschilder()">
        <i data-lucide="download" style="width:18px;height:18px;"></i>
        T\u00FCrschilder (PDF)
      </button>
    </div>`;

  lucide.createIcons({ nodes: [container, dateRangeEl] });
}

// ========== Gästeliste Export ==========
function exportGaestelisteXLSX() {
  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const wdK = ['SO','MO','DI','MI','DO','FR','SA'];
  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  const d0 = days[0], d6 = days[6];
  const rangeStr = pad2(d0.getDate()) + '.' + pad2(d0.getMonth()+1) + '.' + d0.getFullYear() + ' – ' + pad2(d6.getDate()) + '.' + pad2(d6.getMonth()+1) + '.' + d6.getFullYear();

  // Find all guests present during this week
  const gaestetrakt = [];
  const konvent = [];

  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    const wStart = new Date(d0); wStart.setHours(0,0,0,0);
    const wEnd = new Date(d6); wEnd.setHours(23,59,59,0);
    // Overlap with week
    if (von <= wEnd && bis >= wStart) {
      const vonWd = wdK[von.getDay()];
      const bisWd = wdK[bis.getDay()];
      const aufenthalt = vonWd + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + bisWd + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const entry = { name: b.name, room: b.room, aufenthalt };
      if (konventRooms.includes(b.room)) {
        konvent.push(entry);
      } else {
        gaestetrakt.push(entry);
      }
    }
  });

  // Sort by check-in
  const sortByDate = (a, b) => {
    const aB = bookingsData.find(x => x.name === a.name && x.room === a.room);
    const bB = bookingsData.find(x => x.name === b.name && x.room === b.room);
    if (!aB || !bB) return 0;
    const aD = parseDateDE(splitDateRange(aB.dates)[0]);
    const bD = parseDateDE(bB.dates.split('–')[0]);
    return (aD||0) - (bD||0);
  };
  gaestetrakt.sort(sortByDate);
  konvent.sort(sortByDate);

  // Deduplicate (same guest, same room)
  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter(e => {
      const key = e.name + '|' + e.room;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const gList = dedup(gaestetrakt);
  const kList = dedup(konvent);

  function renderSection(title, list) {
    let rows = '';
    rows += '<Row ss:Height="40"><Cell ss:MergeAcross="2" ss:StyleID="glTitle"><Data ss:Type="String">' + escXml(title) + '</Data></Cell></Row>';
    rows += '<Row ss:Height="30">';
    rows += '<Cell ss:StyleID="glHeaderL"><Data ss:Type="String">Name</Data></Cell>';
    rows += '<Cell ss:StyleID="glHeader"><Data ss:Type="String">Zimmer</Data></Cell>';
    rows += '<Cell ss:StyleID="glHeaderR"><Data ss:Type="String">Aufenthalt</Data></Cell>';
    rows += '</Row>';
    if (list.length === 0) {
      rows += '<Row ss:Height="27"><Cell ss:StyleID="glDataBL"><Data ss:Type="String">Keine Gäste</Data></Cell><Cell ss:StyleID="glDataBC"/><Cell ss:StyleID="glDataBCR"/></Row>';
    } else {
      list.forEach((g, i) => {
        const isLast = i === list.length - 1;
        rows += '<Row ss:Height="27">';
        rows += '<Cell ss:StyleID="' + (isLast ? 'glDataBL' : 'glDataL') + '"><Data ss:Type="String">' + escXml(g.name) + '</Data></Cell>';
        rows += '<Cell ss:StyleID="' + (isLast ? 'glDataBC' : 'glDataC') + '"><Data ss:Type="String">' + escXml(g.room) + '</Data></Cell>';
        rows += '<Cell ss:StyleID="' + (isLast ? 'glDataBCR' : 'glDataCR') + '"><Data ss:Type="String">' + escXml(g.aufenthalt) + '</Data></Cell>';
        rows += '</Row>';
      });
    }
    rows += '<Row ss:Height="21"><Cell/></Row>';
    return rows;
  }

  const allRows = renderSection('Gäste im Gästetrakt ' + rangeStr, gList)
                + renderSection('Gäste im Konvent ' + rangeStr, kList);

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    (function() {
      function bdr(t,b,l,r) {
        return '<Borders>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="'+t+'"/>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="'+b+'"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="'+l+'"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="'+r+'"/>' +
          '</Borders>';
      }
      var g=bdr(1,1,1,1), gL=bdr(1,1,2,1), gR=bdr(1,1,1,2), gTLR=bdr(2,1,2,2), gBL=bdr(1,2,2,1), gB=bdr(1,2,1,1), gBR=bdr(1,2,1,2);
      return '<Styles>\n' +
        '<Style ss:ID="Default"><Font ss:Size="14"/><Alignment ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="glTitle"><Font ss:Size="20" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gTLR+'</Style>\n' +
        '<Style ss:ID="glHeaderL"><Font ss:Size="18" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E8D5B7" ss:Pattern="Solid"/>'+gL+'</Style>\n' +
        '<Style ss:ID="glHeader"><Font ss:Size="18" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E8D5B7" ss:Pattern="Solid"/>'+g+'</Style>\n' +
        '<Style ss:ID="glHeaderR"><Font ss:Size="18" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E8D5B7" ss:Pattern="Solid"/>'+gR+'</Style>\n' +
        '<Style ss:ID="glDataL"><Font ss:Size="14"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>'+gL+'</Style>\n' +
        '<Style ss:ID="glDataC"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="glDataCR"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gR+'</Style>\n' +
        '<Style ss:ID="glDataBL"><Font ss:Size="14"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>'+gBL+'</Style>\n' +
        '<Style ss:ID="glDataBC"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gB+'</Style>\n' +
        '<Style ss:ID="glDataBCR"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gBR+'</Style>\n' +
        '</Styles>\n';
    })() +
    '<Worksheet ss:Name="Namensliste">\n' +
    '<Table>\n' +
    '<Column ss:Width="250"/>\n' +
    '<Column ss:Width="130"/>\n' +
    '<Column ss:Width="260"/>\n' +
    allRows +
    '</Table>\n' +
    '</Worksheet>\n' +
    '</Workbook>';

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Gaesteliste-' + pad2(d0.getDate()) + pad2(d0.getMonth()+1) + '-' + pad2(d6.getDate()) + pad2(d6.getMonth()+1) + '.xls';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Gästeliste exportiert');
}

// ========== Gästeliste Woche PDF Export ==========
function exportGaestelistePDF() {
  if (!window.jspdf) { showToast('PDF-Export nicht verfügbar. Bitte Seite neu laden.', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  const usableW = pageW - 2 * margin;
  const usableH = pageH - 2 * margin;

  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const wdK = ['SO','MO','DI','MI','DO','FR','SA'];
  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  const days = [];
  for (let i = 0; i < 7; i++) { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); days.push(d); }
  const d0 = days[0], d6 = days[6];
  const rangeStr = pad2(d0.getDate()) + '.' + pad2(d0.getMonth()+1) + '.' + d0.getFullYear() + ' – ' + pad2(d6.getDate()) + '.' + pad2(d6.getMonth()+1) + '.' + d6.getFullYear();

  const gaestetrakt = [];
  const konvent = [];

  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates); if (parts.length < 2) return;
    const von = parseDateDE(parts[0]); const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    const wStart = new Date(d0); wStart.setHours(0,0,0,0);
    const wEnd = new Date(d6); wEnd.setHours(23,59,59,0);
    if (von <= wEnd && bis >= wStart) {
      const aufenthalt = wdK[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + wdK[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const entry = { name: b.name, room: b.room, aufenthalt };
      if (konventRooms.includes(b.room)) konvent.push(entry);
      else gaestetrakt.push(entry);
    }
  });

  const sortByDate = (a, b) => {
    const aB = bookingsData.find(x => x.name === a.name && x.room === a.room);
    const bB = bookingsData.find(x => x.name === b.name && x.room === b.room);
    if (!aB || !bB) return 0;
    const aD = parseDateDE(splitDateRange(aB.dates)[0]); const bD = parseDateDE(bB.dates.split('–')[0]);
    return (aD||0) - (bD||0);
  };
  gaestetrakt.sort(sortByDate); konvent.sort(sortByDate);

  const dedup = (arr) => { const seen = new Set(); return arr.filter(e => { const key = e.name + '|' + e.room; if (seen.has(key)) return false; seen.add(key); return true; }); };
  const gList = dedup(gaestetrakt);
  const kList = dedup(konvent);

  _drawGaestelistePDF(doc, margin, usableW, usableH, gList, kList, rangeStr);

  const fileName = 'Gaesteliste-' + pad2(d0.getDate()) + pad2(d0.getMonth()+1) + '-' + pad2(d6.getDate()) + pad2(d6.getMonth()+1) + '.pdf';
  doc.save(fileName);
  showToast('Gästeliste PDF exportiert');
}

// Shared PDF table drawing for Gästeliste-style exports
function _drawGaestelistePDF(doc, margin, usableW, usableH, gList, kList, rangeStr) {
  const gold = [202, 155, 72];
  const headerBg = [232, 213, 183]; // #E8D5B7
  const colWidths = [usableW * 0.38, usableW * 0.22, usableW * 0.40];

  // Calculate rows needed: 2 sections, each with title + header + data rows + spacer
  const totalRows = 2 + gList.length + (gList.length === 0 ? 1 : 0) + 2 + kList.length + (kList.length === 0 ? 1 : 0);

  // Auto-scale font size
  let fontSize = 11;
  const titlePad = 3;
  while (fontSize > 6) {
    const rowH = fontSize * 0.55 + 2;
    const titleH = fontSize * 0.7 + titlePad;
    const needed = 2 * titleH + totalRows * rowH + 10;
    if (needed <= usableH) break;
    fontSize -= 0.5;
  }
  const rowH = fontSize * 0.55 + 2;
  const titleH = fontSize * 0.7 + titlePad;

  let y = margin;

  function drawSection(title, list) {
    const sectionY = y;

    // ---- Pass 1: Alle Rechtecke zeichnen (ohne Text) ----
    doc.setDrawColor(150);

    // Section title background
    doc.setFillColor(...gold);
    doc.rect(margin, y, usableW, titleH, 'FD');
    y += titleH;

    // Column header backgrounds
    let x = margin;
    for (let i = 0; i < colWidths.length; i++) {
      doc.setFillColor(...headerBg);
      doc.rect(x, y, colWidths[i], rowH, 'FD');
      x += colWidths[i];
    }
    y += rowH;

    // Data row backgrounds
    const items = list.length === 0 ? [{ name: 'Keine Gäste', room: '', aufenthalt: '' }] : list;
    items.forEach((g, gi) => {
      const bgShade = gi % 2 === 0 ? 255 : 248;
      x = margin;
      for (let ci = 0; ci < colWidths.length; ci++) {
        doc.setFillColor(bgShade, bgShade, bgShade);
        doc.rect(x, y, colWidths[ci], rowH, 'FD');
        x += colWidths[ci];
      }
      y += rowH;
    });

    // ---- Pass 2: Alle Texte zeichnen ----
    let ty = sectionY;

    // Section title text
    doc.setFontSize(fontSize + 1);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255);
    doc.text(title, margin + usableW / 2, ty + titleH / 2 + 0.3, { align: 'center', baseline: 'middle' });
    ty += titleH;

    // Column header text
    doc.setTextColor(0);
    doc.setFontSize(fontSize);
    doc.setFont('helvetica', 'bold');
    const headers = ['Name', 'Zimmer', 'Aufenthalt'];
    x = margin;
    headers.forEach((h, i) => {
      doc.text(h, x + colWidths[i] / 2, ty + rowH / 2, { align: 'center', baseline: 'middle' });
      x += colWidths[i];
    });
    ty += rowH;

    // Data row text
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(fontSize - 0.5);
    items.forEach((g) => {
      x = margin;
      colWidths.forEach((cw, ci) => {
        const val = ci === 0 ? g.name : ci === 1 ? g.room : g.aufenthalt;
        const align = ci === 0 ? 'left' : 'center';
        const tx = ci === 0 ? x + 2 : x + cw / 2;
        doc.text(val || '', tx, ty + rowH / 2, { align, baseline: 'middle' });
        x += cw;
      });
      ty += rowH;
    });

    y += 4; // spacer between sections
  }

  drawSection('Gäste im Gästetrakt ' + rangeStr, gList);
  drawSection('Gäste im Konvent ' + rangeStr, kList);
}

// ========== Gästeliste Monat Export ==========
function exportGaestelisteMonatXLSX() {
  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const refDate = new Date(weekStart);
  const year = refDate.getFullYear();
  const month = refDate.getMonth();
  const wdK = ['SO','MO','DI','MI','DO','FR','SA'];
  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  firstDay.setHours(0,0,0,0);
  lastDay.setHours(23,59,59,0);

  const rangeStr = monthNames[month] + ' ' + year;

  const gaestetrakt = [];
  const konvent = [];

  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    if (von <= lastDay && bis >= firstDay) {
      const vonWd = wdK[von.getDay()];
      const bisWd = wdK[bis.getDay()];
      const aufenthalt = vonWd + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + bisWd + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const entry = { name: b.name, room: b.room, aufenthalt, von };
      if (konventRooms.includes(b.room)) {
        konvent.push(entry);
      } else {
        gaestetrakt.push(entry);
      }
    }
  });

  gaestetrakt.sort((a,b) => (a.von||0) - (b.von||0));
  konvent.sort((a,b) => (a.von||0) - (b.von||0));

  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter(e => {
      const key = e.name + '|' + e.room + '|' + e.aufenthalt;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const gList = dedup(gaestetrakt);
  const kList = dedup(konvent);

  function renderSection(title, list) {
    let rows = '';
    rows += '<Row ss:Height="40"><Cell ss:MergeAcross="2" ss:StyleID="glTitle"><Data ss:Type="String">' + escXml(title) + '</Data></Cell></Row>';
    rows += '<Row ss:Height="30">';
    rows += '<Cell ss:StyleID="glHeaderL"><Data ss:Type="String">Name</Data></Cell>';
    rows += '<Cell ss:StyleID="glHeader"><Data ss:Type="String">Zimmer</Data></Cell>';
    rows += '<Cell ss:StyleID="glHeaderR"><Data ss:Type="String">Aufenthalt</Data></Cell>';
    rows += '</Row>';
    if (list.length === 0) {
      rows += '<Row ss:Height="27"><Cell ss:StyleID="glDataBL"><Data ss:Type="String">Keine Gäste</Data></Cell><Cell ss:StyleID="glDataBC"/><Cell ss:StyleID="glDataBCR"/></Row>';
    } else {
      list.forEach((g, i) => {
        const isLast = i === list.length - 1;
        rows += '<Row ss:Height="27">';
        rows += '<Cell ss:StyleID="' + (isLast ? 'glDataBL' : 'glDataL') + '"><Data ss:Type="String">' + escXml(g.name) + '</Data></Cell>';
        rows += '<Cell ss:StyleID="' + (isLast ? 'glDataBC' : 'glDataC') + '"><Data ss:Type="String">' + escXml(g.room) + '</Data></Cell>';
        rows += '<Cell ss:StyleID="' + (isLast ? 'glDataBCR' : 'glDataCR') + '"><Data ss:Type="String">' + escXml(g.aufenthalt) + '</Data></Cell>';
        rows += '</Row>';
      });
    }
    rows += '<Row ss:Height="21"><Cell/></Row>';
    return rows;
  }

  const allRows = renderSection('Gäste im Gästetrakt – ' + rangeStr, gList)
                + renderSection('Gäste im Konvent – ' + rangeStr, kList);

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    (function() {
      function bdr(t,b,l,r) {
        return '<Borders>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="'+t+'"/>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="'+b+'"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="'+l+'"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="'+r+'"/>' +
          '</Borders>';
      }
      var g=bdr(1,1,1,1), gL=bdr(1,1,2,1), gR=bdr(1,1,1,2), gTLR=bdr(2,1,2,2), gBL=bdr(1,2,2,1), gB=bdr(1,2,1,1), gBR=bdr(1,2,1,2);
      return '<Styles>\n' +
        '<Style ss:ID="Default"><Font ss:Size="14"/><Alignment ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="glTitle"><Font ss:Size="20" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gTLR+'</Style>\n' +
        '<Style ss:ID="glHeaderL"><Font ss:Size="18" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E8D5B7" ss:Pattern="Solid"/>'+gL+'</Style>\n' +
        '<Style ss:ID="glHeader"><Font ss:Size="18" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E8D5B7" ss:Pattern="Solid"/>'+g+'</Style>\n' +
        '<Style ss:ID="glHeaderR"><Font ss:Size="18" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E8D5B7" ss:Pattern="Solid"/>'+gR+'</Style>\n' +
        '<Style ss:ID="glDataL"><Font ss:Size="14"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>'+gL+'</Style>\n' +
        '<Style ss:ID="glDataC"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="glDataCR"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gR+'</Style>\n' +
        '<Style ss:ID="glDataBL"><Font ss:Size="14"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>'+gBL+'</Style>\n' +
        '<Style ss:ID="glDataBC"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gB+'</Style>\n' +
        '<Style ss:ID="glDataBCR"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>'+gBR+'</Style>\n' +
        '</Styles>\n';
    })() +
    '<Worksheet ss:Name="Namensliste">\n' +
    '<Table>\n' +
    '<Column ss:Width="250"/>\n' +
    '<Column ss:Width="130"/>\n' +
    '<Column ss:Width="260"/>\n' +
    allRows +
    '</Table>\n' +
    '</Worksheet>\n' +
    '</Workbook>';

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Gaesteliste-' + monthNames[month] + '-' + year + '.xls';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Gästeliste Monat exportiert');
}

// ========== Gästeliste Monat PDF Export ==========
function exportGaestelisteMonatPDF() {
  if (!window.jspdf) { showToast('PDF-Export nicht verfügbar. Bitte Seite neu laden.', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  const usableW = pageW - 2 * margin;
  const usableH = pageH - 2 * margin;

  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const refDate = new Date(weekStart);
  const year = refDate.getFullYear();
  const month = refDate.getMonth();
  const wdK = ['SO','MO','DI','MI','DO','FR','SA'];
  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  firstDay.setHours(0,0,0,0); lastDay.setHours(23,59,59,0);
  const rangeStr = monthNames[month] + ' ' + year;

  const gaestetrakt = [];
  const konvent = [];

  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates); if (parts.length < 2) return;
    const von = parseDateDE(parts[0]); const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    if (von <= lastDay && bis >= firstDay) {
      const aufenthalt = wdK[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + wdK[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const entry = { name: b.name, room: b.room, aufenthalt, von };
      if (konventRooms.includes(b.room)) konvent.push(entry);
      else gaestetrakt.push(entry);
    }
  });

  gaestetrakt.sort((a,b) => (a.von||0) - (b.von||0));
  konvent.sort((a,b) => (a.von||0) - (b.von||0));

  const dedup = (arr) => { const seen = new Set(); return arr.filter(e => { const key = e.name + '|' + e.room + '|' + e.aufenthalt; if (seen.has(key)) return false; seen.add(key); return true; }); };
  const gList = dedup(gaestetrakt);
  const kList = dedup(konvent);

  _drawGaestelistePDF(doc, margin, usableW, usableH, gList, kList, rangeStr);

  const fileName = 'Gaesteliste-' + monthNames[month] + '-' + year + '.pdf';
  doc.save(fileName);
  showToast('Gästeliste Monat PDF exportiert');
}

// ========== Türschilder Export ==========
function exportTuerschilderDocx() {
  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  const d0 = days[0], d6 = days[6];

  const guests = [];
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    const wStart = new Date(d0); wStart.setHours(0,0,0,0);
    const wEnd = new Date(d6); wEnd.setHours(23,59,59,0);
    if (von <= wEnd && bis >= wStart) {
      const WT = ['SO','MO','DI','MI','DO','FR','SA'];
      const dateStr = WT[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + WT[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const key = b.name + '|' + b.room;
      if (!guests.find(g => g.key === key)) {
        guests.push({ name: b.name, dates: dateStr, key, von });
      }
    }
  });
  guests.sort((a,b) => (a.von||0) - (b.von||0));

  if (guests.length === 0) {
    showToast('Keine Gäste in dieser Woche');
    return;
  }

  const args = guests.map(g => "'" + g.name + '|' + g.dates + "'").join(' ');
  const filename = 'Tuerschilder-' + pad2(d0.getDate()) + pad2(d0.getMonth()+1) + '-' + pad2(d6.getDate()) + pad2(d6.getMonth()+1);
  const scriptDir = '/Users/jakobussieberer-kefer/Documents/Coding/test\\ 2/Daten';
  const cmd = 'python3 ' + scriptDir + '/generate_tuerschilder.py ' + scriptDir + '/' + filename + '.docx ' + args + ' && open ' + scriptDir + '/' + filename + '.docx';

  navigator.clipboard.writeText(cmd).then(() => {
    showToast('Befehl in Zwischenablage – im Terminal einfügen (⌘V)');
  }).catch(() => {
    prompt('Im Terminal ausführen:', cmd);
  });
}

function exportTuerschilderWord() {
  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  const d0 = days[0], d6 = days[6];

  // Collect guests
  const guests = [];
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    const wStart = new Date(d0); wStart.setHours(0,0,0,0);
    const wEnd = new Date(d6); wEnd.setHours(23,59,59,0);
    if (von <= wEnd && bis >= wStart) {
      const WT = ['SO','MO','DI','MI','DO','FR','SA'];
      const dateStr = WT[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + WT[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const key = b.name + '|' + b.room;
      if (!guests.find(g => g.key === key)) {
        guests.push({ name: b.name, room: b.room, dates: dateStr, key, von });
      }
    }
  });
  guests.sort((a,b) => (a.von||0) - (b.von||0));

  // Generate Word XML (Office Open XML) - landscape A4
  // sz values in Word: sz="64" = 32pt, sz="34" = 17pt, sz="32" = 16pt
  function makeSign(name, dateStr) {
    return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
      `<w:r><w:rPr><w:b/><w:sz w:val="64"/><w:szCs w:val="64"/></w:rPr>` +
      `<w:t>${escXml(name)}</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
      `<w:r><w:rPr><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>` +
      `<w:t>${escXml(dateStr)}</w:t></w:r></w:p>`;
  }

  // Build table rows: 2 columns, each row has 2 signs
  let tableRows = '';
  for (let i = 0; i < guests.length; i += 2) {
    const g1 = guests[i];
    const g2 = i + 1 < guests.length ? guests[i + 1] : null;

    tableRows += '<w:tr>';
    // Cell 1
    tableRows += '<w:tc><w:tcPr><w:tcW w:w="5240" w:type="dxa"/>' +
      '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/></w:tcBorders>' +
      '<w:vAlign w:val="center"/></w:tcPr>' +
      `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120"/></w:pPr></w:p>` +
      makeSign(g1.name, g1.dates) +
      `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>` +
      '</w:tc>';
    // Cell 2
    tableRows += '<w:tc><w:tcPr><w:tcW w:w="5240" w:type="dxa"/>' +
      '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/></w:tcBorders>' +
      '<w:vAlign w:val="center"/></w:tcPr>';
    if (g2) {
      tableRows += `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120"/></w:pPr></w:p>` +
        makeSign(g2.name, g2.dates) +
        `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`;
    } else {
      tableRows += '<w:p/>';
    }
    tableRows += '</w:tc>';
    tableRows += '</w:tr>';
  }

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  mc:Ignorable="w14">
<w:body>
  <w:tbl>
    <w:tblPr>
      <w:tblW w:w="10480" w:type="dxa"/>
      <w:jc w:val="center"/>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>
      <w:gridCol w:w="5240"/>
      <w:gridCol w:w="5240"/>
    </w:tblGrid>
    ${tableRows}
  </w:tbl>
  <w:sectPr>
    <w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/>
    <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>
  </w:sectPr>
</w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  // Build ZIP (docx) using JSZip-like manual approach
  // We'll use the simple Blob approach with the XML format instead
  // Actually, create a proper .docx using a minimal ZIP

  // Use the simpler Word XML format (single file, .doc compatible)
  const wordXml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Word.Document"?>
<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:wx="http://schemas.microsoft.com/office/word/2003/auxHint"
  xmlns:o="urn:schemas-microsoft-com:office:office">
<w:body>
  <w:tbl>
    <w:tblPr>
      <w:tblW w:w="10480" w:type="dxa"/>
      <w:jc w:val="center"/>
    </w:tblPr>
    <w:tblGrid>
      <w:gridCol w:w="5240"/>
      <w:gridCol w:w="5240"/>
    </w:tblGrid>
    ${tableRows}
  </w:tbl>
  <w:sectPr>
    <w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/>
    <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>
  </w:sectPr>
</w:body>
</w:wordDocument>`;

  const blob = new Blob([wordXml], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Tuerschilder-' + pad2(d0.getDate()) + pad2(d0.getMonth()+1) + '-' + pad2(d6.getDate()) + pad2(d6.getMonth()+1) + '.doc';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Türschilder exportiert (' + guests.length + ' Schilder)');
}

function exportTuerschilderCSV() {
  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  const d0 = days[0], d6 = days[6];

  // Also check month mode
  let startDate, endDate;
  if (exportMode === 'monat') {
    const year = weekStart.getFullYear();
    const month = weekStart.getMonth();
    startDate = new Date(year, month, 1);
    endDate = new Date(year, month + 1, 0);
  } else {
    startDate = new Date(d0);
    endDate = new Date(d6);
  }
  startDate.setHours(0,0,0,0);
  endDate.setHours(23,59,59,0);

  const guests = [];
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    if (von <= endDate && bis >= startDate) {
      const WT = ['SO','MO','DI','MI','DO','FR','SA'];
      const dateStr = WT[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + WT[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const key = b.name + '|' + b.room;
      if (!guests.find(g => g.key === key)) {
        guests.push({ name: b.name, room: b.room, dates: dateStr, key, von });
      }
    }
  });
  guests.sort((a,b) => (a.von||0) - (b.von||0));

  if (guests.length === 0) {
    showToast('Keine Gäste im Zeitraum');
    return;
  }

  // Generate CSV with columns: Name1-Name8, Datum1-Datum8 per row (one row = one page of 8 signs)
  let csv = '';
  // Header
  const headers = [];
  for (let i = 1; i <= 8; i++) {
    headers.push('Name' + i, 'Datum' + i);
  }
  csv += headers.join(';') + '\n';

  // Data rows (8 guests per row = 1 page)
  for (let i = 0; i < guests.length; i += 8) {
    const pageGuests = guests.slice(i, i + 8);
    const row = [];
    for (let j = 0; j < 8; j++) {
      if (j < pageGuests.length) {
        row.push('"' + pageGuests[j].name + '"', '"' + pageGuests[j].dates + '"');
      } else {
        row.push('""', '""');
      }
    }
    csv += row.join(';') + '\n';
  }

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateLabel = exportMode === 'monat'
    ? monthNames[startDate.getMonth()] + '-' + startDate.getFullYear()
    : pad2(d0.getDate()) + pad2(d0.getMonth()+1) + '-' + pad2(d6.getDate()) + pad2(d6.getMonth()+1);
  a.download = 'Tuerschilder-' + dateLabel + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exportiert (' + guests.length + ' Gäste) – In Word unter Sendungen → Empfänger auswählen → Vorhandene Liste verwenden');
}

function exportTuerschilder() {
  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const wdK = ['SO','MO','DI','MI','DO','FR','SA'];
  const konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  const d0 = days[0], d6 = days[6];

  // Collect guests for this week
  const guests = [];
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    const wStart = new Date(d0); wStart.setHours(0,0,0,0);
    const wEnd = new Date(d6); wEnd.setHours(23,59,59,0);
    if (von <= wEnd && bis >= wStart) {
      const dateStr = wdK[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. \u2013 ' + wdK[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const key = b.name + '|' + b.room;
      if (!guests.find(g => g.key === key)) {
        guests.push({ name: b.name, room: b.room, dates: dateStr, key, isKonvent: konventRooms.includes(b.room), von });
      }
    }
  });

  guests.sort((a,b) => (a.von||0) - (b.von||0));

  // Generate PDF directly with jsPDF
  if (!window.jspdf) { showToast('PDF-Export nicht verfügbar. Bitte Seite neu laden.', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  // A4 landscape: 297mm x 210mm, card: 148.5mm x 52.5mm

  // Load template image
  const templateDataUrl = (typeof TUERSCHILD_TEMPLATE !== 'undefined') ? TUERSCHILD_TEMPLATE : '';

  const totalPages = Math.ceil(guests.length / 8);
  for (let p = 0; p < totalPages; p++) {
    if (p > 0) doc.addPage();

    // Draw template background on full page
    if (templateDataUrl) {
      doc.addImage(templateDataUrl, 'JPEG', 0, 0, 297, 210);
    }

    const pageGuests = guests.slice(p * 8, p * 8 + 8);
    pageGuests.forEach((g, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const x = col * 148.5;
      const y = row * 52.5;

      // Datum: oben links zwischen Kelch und Banner
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(107, 102, 96);
      doc.text(g.dates, x + 30, y + 15);

      // Name: zentriert im unteren Bereich
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(45, 42, 38);
      const nameLen = g.name.length;
      const fontSize = nameLen > 28 ? 20 : (nameLen > 20 ? 24 : 30);
      doc.setFontSize(fontSize);
      doc.text(g.name, x + 74.25, y + 38, { align: 'center', maxWidth: 130 });
    });
  }

  const filename = 'Tuerschilder-' + pad2(d0.getDate()) + pad2(d0.getMonth()+1) + '-' + pad2(d6.getDate()) + pad2(d6.getMonth()+1) + '.pdf';
  doc.save(filename);
  showToast('T\u00FCrschilder heruntergeladen (' + guests.length + ' Schilder)');
}

// ========== API-Key Verwaltung ==========
// KI-Analyse nicht verfügbar ohne Server — Regex-Modus aktiv
function checkApiKeyStatus() {}
function saveApiKey() {
  showToast('KI-Analyse benötigt den lokalen Server');
}


// ========== Serviettenbeschriftungen Export ==========
function exportServietten() {
  var today = new Date();
  var monat = today.getMonth();
  var jahr = today.getFullYear();
  var monthNames = ['Jänner','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

  // Gäste dieses Monats sammeln
  var namen = [];
  var monatsStart = new Date(jahr, monat, 1);
  var monatsEnde = new Date(jahr, monat + 1, 0, 23, 59, 59);

  var konventRooms = ['Hospes I','Hospes II','Hospes III','Hospes VII','Hospes VIII','Hospes IX'];
  bookingsData.forEach(function(b) {
    if (b.deletedAt) return;
    if (b.status === 'storniert' || b.status === 'abgeschlossen') return;
    if (!konventRooms.includes(b.room)) return; // Nur Konvent-Gäste
    var parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    var von = parseDateDE(parts[0]);
    var bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    if (von <= monatsEnde && bis >= monatsStart) {
      if (!namen.includes(b.name)) namen.push(b.name);
    }
  });

  namen.sort(function(a, b) { return a.localeCompare(b, 'de'); });

  if (namen.length === 0) {
    showToast('Keine Buchungen im ' + monthNames[monat]);
    return;
  }

  // Kelch-Bild aus kelch_serviette.js (goldenes Wasserzeichen)
  var kelchImg = (typeof KELCH_SERVIETTE !== 'undefined') ? KELCH_SERVIETTE : null;

  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Exakte Maße wie Original-PDF (serviettenbeschriftungen.pdf)
  var pageW = 210, pageH = 297;
  var marginLeft = 15, marginTop = 18;
  var cols = 2, rows = 10;
  var gridW = pageW - 2 * marginLeft;
  var cellW = gridW / cols;
  var cellH = 26.7;
  var kelchW = 14, kelchH = 21;

  var totalSlots = cols * rows;
  var totalPages = Math.ceil(namen.length / totalSlots);

  for (var p = 0; p < totalPages; p++) {
    if (p > 0) doc.addPage();
    var pageNames = namen.slice(p * totalSlots, (p + 1) * totalSlots);

    // Raster zeichnen (dünne graue Linien wie Original)
    doc.setDrawColor(190, 190, 190);
    doc.setLineWidth(0.3);
    for (var r = 0; r <= rows; r++) {
      var y = marginTop + r * cellH;
      doc.line(marginLeft, y, marginLeft + gridW, y);
    }
    for (var c = 0; c <= cols; c++) {
      var x = marginLeft + c * cellW;
      doc.line(x, marginTop, x, marginTop + rows * cellH);
    }

    // Kelch in JEDE Zelle (auch leere) — rechts oben wie im Original
    if (kelchImg) {
      for (var slot = 0; slot < totalSlots; slot++) {
        var col = slot % cols;
        var row = Math.floor(slot / cols);
        var cx = marginLeft + col * cellW;
        var cy = marginTop + row * cellH;
        doc.addImage(kelchImg, 'JPEG', cx + cellW - kelchW - 5, cy + (cellH - kelchH) / 2, kelchW, kelchH);
      }
    }

    // Namen einfügen (Serifenschrift, unten im Feld wie Original)
    pageNames.forEach(function(name, idx) {
      var col = idx % cols;
      var row = Math.floor(idx / cols);
      var x = marginLeft + col * cellW;
      var y = marginTop + row * cellH;

      doc.setFont('times', 'normal');
      doc.setTextColor(30, 30, 30);
      var fontSize = name.length > 26 ? 14 : (name.length > 20 ? 16 : 20);
      doc.setFontSize(fontSize);
      doc.text(name, x + 5, y + cellH / 2 + fontSize / 6);
    });
  }

  var filename = 'Servietten-' + monthNames[monat] + '-' + jahr + '.pdf';
  doc.save(filename);
  showToast('Serviettenbeschriftungen: ' + namen.length + ' Namen (' + monthNames[monat] + ' ' + jahr + ')');
}

// ========== Namensliste Export ==========
function exportNamensliste() {
  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const wdK = ['SO','MO','DI','MI','DO','FR','SA'];

  let startDate, endDate, titleRange;
  if (exportMode === 'monat') {
    const year = weekStart.getFullYear();
    const month = weekStart.getMonth();
    startDate = new Date(year, month, 1);
    endDate = new Date(year, month + 1, 0);
    titleRange = monthNames[month] + ' ' + year;
  } else {
    startDate = new Date(weekStart);
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    endDate = end;
    titleRange = pad2(startDate.getDate()) + '.' + pad2(startDate.getMonth()+1) + '.' + startDate.getFullYear() + ' – ' + pad2(endDate.getDate()) + '.' + pad2(endDate.getMonth()+1) + '.' + endDate.getFullYear();
  }
  startDate.setHours(0,0,0,0);
  endDate.setHours(23,59,59,0);

  const guests = [];
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    if (von <= endDate && bis >= startDate) {
      const aufenthalt = wdK[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + wdK[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const key = b.name + '|' + b.room + '|' + aufenthalt;
      if (!guests.find(g => g.key === key)) {
        guests.push({ name: b.name, room: b.room, aufenthalt, key, von });
      }
    }
  });
  guests.sort((a,b) => (a.von||0) - (b.von||0));

  // Deduplicate by name+room
  const seen = new Set();
  const unique = guests.filter(g => {
    const k = g.name + '|' + g.room;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const title = 'Namensliste ' + titleRange;

  let rows = '';
  rows += '<Row ss:Height="40"><Cell ss:MergeAcross="2" ss:StyleID="glTitle"><Data ss:Type="String">' + escXml(title) + '</Data></Cell></Row>';
  rows += '<Row ss:Height="30">';
  rows += '<Cell ss:StyleID="glHeader"><Data ss:Type="String">Name</Data></Cell>';
  rows += '<Cell ss:StyleID="glHeader"><Data ss:Type="String">Zimmer</Data></Cell>';
  rows += '<Cell ss:StyleID="glHeader"><Data ss:Type="String">Aufenthalt</Data></Cell>';
  rows += '</Row>';

  if (unique.length === 0) {
    rows += '<Row ss:Height="27"><Cell ss:StyleID="glData"><Data ss:Type="String">Keine Gäste</Data></Cell><Cell ss:StyleID="glDataC"/><Cell ss:StyleID="glDataC"/></Row>';
  } else {
    unique.forEach(g => {
      rows += '<Row ss:Height="27">';
      rows += '<Cell ss:StyleID="glData"><Data ss:Type="String">' + escXml(g.name) + '</Data></Cell>';
      rows += '<Cell ss:StyleID="glDataC"><Data ss:Type="String">' + escXml(g.room) + '</Data></Cell>';
      rows += '<Cell ss:StyleID="glDataC"><Data ss:Type="String">' + escXml(g.aufenthalt) + '</Data></Cell>';
      rows += '</Row>';
    });
  }

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    '<Styles>\n' +
    ' <Style ss:ID="Default"><Font ss:Size="14"/><Alignment ss:Vertical="Center"/></Style>\n' +
    ' <Style ss:ID="glTitle"><Font ss:Size="20" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>\n' +
    ' <Style ss:ID="glHeader"><Font ss:Size="18" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E8D5B7" ss:Pattern="Solid"/></Style>\n' +
    ' <Style ss:ID="glData"><Font ss:Size="14"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/></Style>\n' +
    ' <Style ss:ID="glDataC"><Font ss:Size="14"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>\n' +
    '</Styles>\n' +
    '<Worksheet ss:Name="Namensliste">\n' +
    '<Table>\n' +
    '<Column ss:Width="250"/>\n' +
    '<Column ss:Width="130"/>\n' +
    '<Column ss:Width="260"/>\n' +
    rows +
    '</Table>\n' +
    '</Worksheet>\n' +
    '</Workbook>';

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const fileLabel = exportMode === 'monat'
    ? 'Namensliste-' + monthNames[startDate.getMonth()] + '-' + startDate.getFullYear()
    : 'Namensliste-' + pad2(startDate.getDate()) + pad2(startDate.getMonth()+1) + '-' + pad2(endDate.getDate()) + pad2(endDate.getMonth()+1);
  a.download = fileLabel + '.xls';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Namensliste exportiert (' + unique.length + ' Gäste)');
}

// ========== Namensliste PDF Export ==========
function exportNamenslistePDF() {
  if (!window.jspdf) { showToast('PDF-Export nicht verfügbar. Bitte Seite neu laden.', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  const usableW = pageW - 2 * margin;
  const usableH = pageH - 2 * margin;

  const weekStart = typeof exportWeekStart !== 'undefined' ? exportWeekStart : getMonday(new Date());
  const wdK = ['SO','MO','DI','MI','DO','FR','SA'];

  let startDate, endDate, titleRange;
  if (exportMode === 'monat') {
    const year = weekStart.getFullYear();
    const month = weekStart.getMonth();
    startDate = new Date(year, month, 1);
    endDate = new Date(year, month + 1, 0);
    titleRange = monthNames[month] + ' ' + year;
  } else {
    startDate = new Date(weekStart);
    const end = new Date(weekStart); end.setDate(end.getDate() + 6);
    endDate = end;
    titleRange = pad2(startDate.getDate()) + '.' + pad2(startDate.getMonth()+1) + '.' + startDate.getFullYear() + ' – ' + pad2(endDate.getDate()) + '.' + pad2(endDate.getMonth()+1) + '.' + endDate.getFullYear();
  }
  startDate.setHours(0,0,0,0); endDate.setHours(23,59,59,0);

  const guests = [];
  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert') return;
    const parts = splitDateRange(b.dates); if (parts.length < 2) return;
    const von = parseDateDE(parts[0]); const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0); bis.setHours(0,0,0,0);
    if (von <= endDate && bis >= startDate) {
      const aufenthalt = wdK[von.getDay()] + ' ' + pad2(von.getDate()) + '.' + pad2(von.getMonth()+1) + '. – ' + wdK[bis.getDay()] + ' ' + pad2(bis.getDate()) + '.' + pad2(bis.getMonth()+1) + '.' + bis.getFullYear();
      const key = b.name + '|' + b.room + '|' + aufenthalt;
      if (!guests.find(g => g.key === key)) guests.push({ name: b.name, room: b.room, aufenthalt, key, von });
    }
  });
  guests.sort((a,b) => (a.von||0) - (b.von||0));

  const seen = new Set();
  const unique = guests.filter(g => { const k = g.name + '|' + g.room; if (seen.has(k)) return false; seen.add(k); return true; });

  const title = 'Namensliste ' + titleRange;
  const gold = [202, 155, 72];
  const headerBg = [232, 213, 183];
  const colWidths = [usableW * 0.38, usableW * 0.22, usableW * 0.40];

  // Auto-scale
  const totalRows = unique.length + (unique.length === 0 ? 1 : 0);
  let fontSize = 11;
  while (fontSize > 6) {
    const rowH = fontSize * 0.55 + 2;
    const titleH = fontSize * 0.7 + 3;
    const needed = titleH + rowH + totalRows * rowH + 6;
    if (needed <= usableH) break;
    fontSize -= 0.5;
  }
  const rowH = fontSize * 0.55 + 2;
  const titleH = fontSize * 0.7 + 3;

  let y = margin;

  const items = unique.length === 0 ? [{ name: 'Keine Gäste', room: '', aufenthalt: '' }] : unique;

  // ---- Pass 1: Alle Rechtecke zeichnen ----
  doc.setDrawColor(150);

  // Title background
  doc.setFillColor(...gold);
  doc.rect(margin, y, usableW, titleH, 'FD');
  y += titleH;

  // Column header backgrounds
  let x = margin;
  for (let i = 0; i < colWidths.length; i++) {
    doc.setFillColor(...headerBg);
    doc.rect(x, y, colWidths[i], rowH, 'FD');
    x += colWidths[i];
  }
  y += rowH;

  // Data row backgrounds
  items.forEach((g, gi) => {
    const bgShade = gi % 2 === 0 ? 255 : 248;
    x = margin;
    for (let ci = 0; ci < colWidths.length; ci++) {
      doc.setFillColor(bgShade, bgShade, bgShade);
      doc.rect(x, y, colWidths[ci], rowH, 'FD');
      x += colWidths[ci];
    }
    y += rowH;
  });

  // ---- Pass 2: Alle Texte zeichnen ----
  let ty = margin;

  // Title text
  doc.setFontSize(fontSize + 2);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255);
  doc.text(title, margin + usableW / 2, ty + titleH / 2 + 0.3, { align: 'center', baseline: 'middle' });
  ty += titleH;

  // Column header text
  doc.setTextColor(0);
  doc.setFontSize(fontSize);
  doc.setFont('helvetica', 'bold');
  const headers = ['Name', 'Zimmer', 'Aufenthalt'];
  x = margin;
  headers.forEach((h, i) => {
    doc.text(h, x + colWidths[i] / 2, ty + rowH / 2, { align: 'center', baseline: 'middle' });
    x += colWidths[i];
  });
  ty += rowH;

  // Data row text
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(fontSize - 0.5);
  items.forEach((g) => {
    x = margin;
    colWidths.forEach((cw, ci) => {
      const val = ci === 0 ? g.name : ci === 1 ? g.room : g.aufenthalt;
      const align = ci === 0 ? 'left' : 'center';
      const tx = ci === 0 ? x + 2 : x + cw / 2;
      doc.text(val || '', tx, ty + rowH / 2, { align, baseline: 'middle' });
      x += cw;
    });
    ty += rowH;
  });

  const fileLabel = exportMode === 'monat'
    ? 'Namensliste-' + monthNames[startDate.getMonth()] + '-' + startDate.getFullYear()
    : 'Namensliste-' + pad2(startDate.getDate()) + pad2(startDate.getMonth()+1) + '-' + pad2(endDate.getDate()) + pad2(endDate.getMonth()+1);
  doc.save(fileLabel + '.pdf');
  showToast('Namensliste PDF exportiert (' + unique.length + ' Gäste)');
}

// ========== Daily Overview (Anreise-Checkliste) ==========
function renderDailyOverview() {
  const container = document.getElementById('dailyOverview');
  if (!container) return;

  const today = new Date();
  today.setHours(0,0,0,0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const wdNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const todayStr = wdNames[today.getDay()] + ', ' + pad2(today.getDate()) + '. ' + monthNames[today.getMonth()] + ' ' + today.getFullYear();

  const abreisen = [];
  const anreisen = [];
  const checkoutRooms = new Set();
  const checkinRoomsToday = new Set();
  const checkinRoomsTomorrow = new Set();

  bookingsData.forEach(b => {
    if (b.deletedAt) return;
    if (b.status === 'storniert' || b.status === 'abgeschlossen') return;
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0);
    bis.setHours(0,0,0,0);

    if (bis.getTime() === today.getTime()) {
      abreisen.push(b);
      checkoutRooms.add(b.room);
    }
    if (von.getTime() === today.getTime()) {
      anreisen.push(b);
      checkinRoomsToday.add(b.room);
    }
    if (von.getTime() === tomorrow.getTime()) {
      checkinRoomsTomorrow.add(b.room);
    }
  });

  // Rooms that need preparation: checkout today AND checkin today or tomorrow
  const prepRooms = [];
  checkoutRooms.forEach(room => {
    if (checkinRoomsToday.has(room) || checkinRoomsTomorrow.has(room)) {
      const nextCheckin = checkinRoomsToday.has(room) ? 'heute' : 'morgen';
      prepRooms.push({ room, nextCheckin });
    }
  });

  let abreisenHtml = '';
  if (abreisen.length === 0) {
    abreisenHtml = '<div style="color:var(--text-muted);font-size:13px;padding:4px 0;">Keine Abreisen heute</div>';
  } else {
    abreisen.forEach(b => {
      const bidx = bookingsData.indexOf(b);
      const coClass = b.checkedOut ? 'checkout-btn done' : 'checkout-btn';
      const coText = b.checkedOut ? '✓ Ausgecheckt' : 'Check-Out';
      abreisenHtml += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:13px;">
        <span style="font-weight:500;">${escHtml(b.name)}</span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="badge badge-belegt" style="font-size:11px;padding:1px 8px;">${escHtml(b.room)}</span>
          <button class="${coClass}" onclick="toggleCheckOut(${bidx})">${coText}</button>
        </span>
      </div>`;
    });
  }

  let anreisenHtml = '';
  if (anreisen.length === 0) {
    anreisenHtml = '<div style="color:var(--text-muted);font-size:13px;padding:4px 0;">Keine Anreisen heute</div>';
  } else {
    anreisen.forEach(b => {
      const bidx = bookingsData.indexOf(b);
      const ciClass = b.checkedIn ? 'checkin-btn done' : 'checkin-btn';
      const ciText = b.checkedIn ? '✓ Eingecheckt' : 'Check-In';
      const pastActs = getGuestPastActivities(b.name);
      const pastActsHtml = pastActs.length > 0 ? `<div style="font-size:11px;color:var(--text-muted);padding:0 0 2px 0;">Zuletzt: ${pastActs.map(escHtml).join(', ')}</div>` : '';
      anreisenHtml += `<div style="padding:4px 0;font-size:13px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-weight:500;">${escHtml(b.name)}${renderStammgastBadge(b.name)}</span>
          <span style="display:flex;align-items:center;gap:6px;">
            <span class="badge badge-bestaetigt" style="font-size:11px;padding:1px 8px;">${escHtml(b.room)}</span>
            <button class="${ciClass}" onclick="toggleCheckIn(${bidx})">${ciText}</button>
          </span>
        </div>
        ${pastActsHtml}
      </div>`;
    });
  }

  let prepHtml = '';
  if (prepRooms.length === 0) {
    prepHtml = '<div style="color:var(--text-muted);font-size:13px;padding:4px 0;">Keine Zimmer vorzubereiten</div>';
  } else {
    prepRooms.forEach(p => {
      prepHtml += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:13px;">
        <span style="font-weight:500;">${escHtml(p.room)}</span>
        <span class="badge badge-anfrage" style="font-size:11px;padding:1px 8px;">Nächste Anreise: ${escHtml(p.nextCheckin)}</span>
      </div>`;
    });
  }

  container.innerHTML = `
    <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
        <i data-lucide="calendar-check" style="width:20px;height:20px;color:var(--accent);"></i>
        <span style="font-size:16px;font-weight:700;">Heute</span>
        <span style="font-size:13px;color:var(--text-secondary);margin-left:4px;">${todayStr}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;">
        <div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:13px;font-weight:600;color:var(--red);">
            <i data-lucide="log-out" style="width:14px;height:14px;"></i> Abreisen (${abreisen.length})
          </div>
          ${abreisenHtml}
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:13px;font-weight:600;color:var(--green);">
            <i data-lucide="log-in" style="width:14px;height:14px;"></i> Anreisen (${anreisen.length})
          </div>
          ${anreisenHtml}
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:13px;font-weight:600;color:var(--orange);">
            <i data-lucide="spray-can" style="width:14px;height:14px;"></i> Zimmer vorbereiten (${prepRooms.length})
          </div>
          ${prepHtml}
        </div>
      </div>
    </div>`;

  // Konflikt-Erkennung
  var konflikte = findBookingConflicts();
  if (konflikte.length > 0) {
    var konfliktHtml = '';
    konflikte.forEach(function(k) {
      konfliktHtml += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:13px;">' +
        '<span style="font-weight:500;">' + escHtml(k.room) + '</span>' +
        '<span style="font-size:12px;color:var(--text-secondary);">' + escHtml(k.a.name) + ' &amp; ' + escHtml(k.b.name) + '</span>' +
        '<span class="badge badge-belegt" style="font-size:11px;padding:1px 8px;">' + k.overlap + '</span>' +
        '</div>';
    });
    container.innerHTML += '<div style="background:var(--red-light);border:1px solid #f0c0c0;border-radius:var(--radius-lg);padding:20px;margin-top:16px;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
        '<i data-lucide="alert-triangle" style="width:20px;height:20px;color:var(--red);"></i>' +
        '<span style="font-size:16px;font-weight:700;color:var(--red);">Buchungskonflikte (' + konflikte.length + ')</span>' +
      '</div>' +
      konfliktHtml +
    '</div>';
  }

  lucide.createIcons({ nodes: [container] });
}

// ========== Buchungskonflikte finden ==========
function findBookingConflicts() {
  var active = bookingsData.filter(function(b) {
    return !b.deletedAt && b.status !== 'storniert' && b.status !== 'abgeschlossen';
  });
  var parsed = [];
  active.forEach(function(b) {
    var parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    var von = parseDateDE(parts[0]);
    var bis = parseDateDE(parts[1]);
    if (!von || !bis) return;
    von.setHours(0,0,0,0);
    bis.setHours(0,0,0,0);
    parsed.push({ booking: b, von: von, bis: bis });
  });

  var konflikte = [];
  for (var i = 0; i < parsed.length; i++) {
    for (var j = i + 1; j < parsed.length; j++) {
      var a = parsed[i], b = parsed[j];
      if (a.booking.room !== b.booking.room) continue;
      // Überlappung: Übergabetag (Abreise = Anreise) ist kein Konflikt
      if (a.von.getTime() < b.bis.getTime() && a.bis.getTime() > b.von.getTime() &&
          a.von.getTime() !== b.bis.getTime() && a.bis.getTime() !== b.von.getTime()) {
        var overlapStart = a.von > b.von ? a.von : b.von;
        var overlapEnd = a.bis < b.bis ? a.bis : b.bis;
        var overlap = pad2(overlapStart.getDate()) + '.' + pad2(overlapStart.getMonth()+1) + '. – ' +
                      pad2(overlapEnd.getDate()) + '.' + pad2(overlapEnd.getMonth()+1) + '.';
        konflikte.push({ room: a.booking.room, a: a.booking, b: b.booking, overlap: overlap });
      }
    }
  }
  return konflikte;
}

// ========== ICS Calendar Export ==========
function exportICS() {
  const bookings = bookingsData.filter(b => b.status === 'bestaetigt' || b.status === 'anfrage');
  if (bookings.length === 0) {
    showToast('Keine Buchungen zum Exportieren');
    return;
  }

  function escICS(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }

  let events = '';
  bookings.forEach(b => {
    const parts = splitDateRange(b.dates);
    if (parts.length < 2) return;
    const von = parseDateDE(parts[0]);
    const bis = parseDateDE(parts[1]);
    if (!von || !bis) return;

    const dtstart = von.getFullYear() + pad2(von.getMonth() + 1) + pad2(von.getDate());
    // DTEND ist bei VALUE=DATE exklusiv (RFC 5545) → +1 Tag
    const bisExklusiv = new Date(bis);
    bisExklusiv.setDate(bisExklusiv.getDate() + 1);
    const dtend = bisExklusiv.getFullYear() + pad2(bisExklusiv.getMonth() + 1) + pad2(bisExklusiv.getDate());
    const summary = escICS(b.name + ' - ' + b.room);
    const description = escICS('Zimmer: ' + b.room + '\nPersonen: ' + (parseInt(b.pers) || 1) + (b.notes ? '\nNotizen: ' + b.notes : ''));

    const uid = dtstart + '-' + encodeURIComponent(b.name) + '-' + encodeURIComponent(b.room) + '@gastmeister.stift-kremsmuenster';
    events += 'BEGIN:VEVENT\r\n';
    events += 'UID:' + uid + '\r\n';
    events += 'DTSTART;VALUE=DATE:' + dtstart + '\r\n';
    events += 'DTEND;VALUE=DATE:' + dtend + '\r\n';
    events += 'SUMMARY:' + summary + '\r\n';
    events += 'DESCRIPTION:' + description + '\r\n';
    events += 'END:VEVENT\r\n';
  });

  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Gastmeister//Stift Kremsmuenster//DE\r\n' + events + 'END:VCALENDAR\r\n';

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gastmeister-kalender.ics';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Kalender exportiert (' + bookings.length + ' Buchungen)');
}

// ========== Spenden Helpers ==========
function formatEUR(amount) {
  return '\u20AC ' + amount.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function getSpendenBookings() {
  return bookingsData.filter(b => b.spende && b.spende > 0);
}

function getCheckoutDate(b) {
  const parts = splitDateRange(b.dates);
  if (parts.length >= 2) return parseDateDE(parts[1]);
  if (parts.length >= 1) return parseDateDE(parts[0]);
  return null;
}

function renderSpendenPage() {
  // Populate year dropdown
  const yearSelect = document.getElementById('spendenFilterYear');
  const currentYearVal = yearSelect.value;
  const years = new Set();
  bookingsData.forEach(b => {
    if (!b.spende || b.spende <= 0) return;
    const d = getCheckoutDate(b);
    if (d) years.add(d.getFullYear());
  });
  const sortedYears = Array.from(years).sort((a, b) => b - a);
  yearSelect.innerHTML = '<option value="alle">Alle Jahre</option>';
  sortedYears.forEach(y => {
    yearSelect.innerHTML += '<option value="' + y + '"' + (currentYearVal == y ? ' selected' : '') + '>' + y + '</option>';
  });

  const filterYear = yearSelect.value;
  const filterMonth = document.getElementById('spendenFilterMonth').value;

  // Filter bookings with spende
  const spendenBookings = getSpendenBookings().filter(b => {
    const d = getCheckoutDate(b);
    if (!d) return false;
    if (filterYear !== 'alle' && d.getFullYear() !== parseInt(filterYear)) return false;
    if (filterMonth !== 'alle' && d.getMonth() !== parseInt(filterMonth)) return false;
    return true;
  });

  // Sort by checkout date descending
  spendenBookings.sort((a, b) => {
    const da = getCheckoutDate(a);
    const db = getCheckoutDate(b);
    return (db || 0) - (da || 0);
  });

  // Stats
  let total = 0;
  spendenBookings.forEach(b => total += b.spende);
  const count = spendenBookings.length;
  const avg = count > 0 ? total / count : 0;

  document.getElementById('spendenTotal').textContent = formatEUR(total);
  document.getElementById('spendenAnzahl').textContent = count;
  document.getElementById('spendenDurchschnitt').textContent = formatEUR(avg);
  document.getElementById('spendenSubtitle').textContent = 'Gesamte Spenden: ' + formatEUR(total);

  // Render list
  const container = document.getElementById('spendenListContainer');
  if (spendenBookings.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text-muted);">Keine Spenden im ausgew\u00E4hlten Zeitraum gefunden.</div>';
  } else {
    let html = '<table class="export-table" style="font-size:14px;">';
    html += '<thead><tr><th style="text-align:left;padding:10px 12px;">Datum</th><th style="text-align:left;padding:10px 12px;">Gast</th><th style="text-align:left;padding:10px 12px;">Zimmer</th><th style="text-align:right;padding:10px 12px;">Betrag</th></tr></thead>';
    html += '<tbody>';
    spendenBookings.forEach(b => {
      const d = getCheckoutDate(b);
      const dateStr = d ? (pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear()) : '-';
      const idx = bookingsData.indexOf(b);
      html += '<tr style="cursor:pointer;" onclick="openBookingEditByIndex(' + idx + ')">';
      html += '<td style="text-align:left;padding:8px 12px;">' + dateStr + '</td>';
      html += '<td style="text-align:left;padding:8px 12px;">' + escHtml(b.name) + '</td>';
      html += '<td style="text-align:left;padding:8px 12px;">' + escHtml(b.room) + '</td>';
      html += '<td style="text-align:right;padding:8px 12px;font-weight:600;color:var(--green);">' + formatEUR(b.spende) + '</td>';
      html += '</tr>';
    });
    html += '</tbody>';
    html += '<tfoot><tr style="font-weight:700;background:#faf9f7;"><td colspan="3" style="text-align:right;padding:10px 12px;">Gesamt</td><td style="text-align:right;padding:10px 12px;color:var(--green);">' + formatEUR(total) + '</td></tr></tfoot>';
    html += '</table>';
    container.innerHTML = html;
  }

  // Monthly chart
  renderSpendenMonthlyChart(filterYear);

  safeCreateIcons();
}

function renderSpendenMonthlyChart(filterYear) {
  const chartContainer = document.getElementById('spendenMonthlyChart');
  const monthNames = ['J\u00E4nner','Februar','M\u00E4rz','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const monthTotals = new Array(12).fill(0);

  const year = filterYear !== 'alle' ? parseInt(filterYear) : new Date().getFullYear();

  bookingsData.forEach(b => {
    if (!b.spende || b.spende <= 0) return;
    const d = getCheckoutDate(b);
    if (!d) return;
    if (d.getFullYear() !== year) return;
    monthTotals[d.getMonth()] += b.spende;
  });

  const maxVal = Math.max(...monthTotals, 1);

  let html = '<div style="background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;">';
  html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">Spenden pro Monat (' + year + ')</div>';
  monthTotals.forEach((val, i) => {
    const pct = (val / maxVal) * 100;
    html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">';
    html += '<div style="width:80px;font-size:12px;color:var(--text-secondary);text-align:right;">' + monthNames[i].substring(0, 3) + '</div>';
    html += '<div style="flex:1;height:20px;background:var(--border-light);border-radius:4px;overflow:hidden;">';
    if (val > 0) {
      html += '<div style="height:100%;width:' + pct + '%;background:var(--green);border-radius:4px;min-width:2px;"></div>';
    }
    html += '</div>';
    html += '<div style="width:90px;font-size:12px;font-weight:' + (val > 0 ? '600' : '400') + ';color:' + (val > 0 ? 'var(--green)' : 'var(--text-muted)') + ';text-align:right;">' + formatEUR(val) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  chartContainer.innerHTML = html;
}

function exportSpendenXLSX() {
  const spendenBookings = getSpendenBookings();
  spendenBookings.sort((a, b) => {
    const da = getCheckoutDate(a);
    const db = getCheckoutDate(b);
    return (da || 0) - (db || 0);
  });

  if (spendenBookings.length === 0) {
    showToast('Keine Spenden zum Exportieren vorhanden');
    return;
  }

  let rows = '';
  // Title row
  rows += '<Row ss:Height="30"><Cell ss:StyleID="spTitle"><Data ss:Type="String">Spendenliste</Data></Cell></Row>';
  rows += '<Row ss:Height="12"><Cell/></Row>';
  // Header
  rows += '<Row ss:Height="24">';
  rows += '<Cell ss:StyleID="hdrTL"><Data ss:Type="String">Datum</Data></Cell>';
  rows += '<Cell ss:StyleID="hdrT"><Data ss:Type="String">Gast</Data></Cell>';
  rows += '<Cell ss:StyleID="hdrT"><Data ss:Type="String">Zimmer</Data></Cell>';
  rows += '<Cell ss:StyleID="hdrT"><Data ss:Type="String">Aufenthalt</Data></Cell>';
  rows += '<Cell ss:StyleID="hdrTR"><Data ss:Type="String">Betrag (\u20AC)</Data></Cell>';
  rows += '</Row>';

  let total = 0;
  spendenBookings.forEach(b => {
    const d = getCheckoutDate(b);
    const dateStr = d ? (pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear()) : '-';
    total += b.spende;
    rows += '<Row>';
    rows += '<Cell ss:StyleID="dataL"><Data ss:Type="String">' + escXml(dateStr) + '</Data></Cell>';
    rows += '<Cell ss:StyleID="data"><Data ss:Type="String">' + escXml(b.name) + '</Data></Cell>';
    rows += '<Cell ss:StyleID="data"><Data ss:Type="String">' + escXml(b.room) + '</Data></Cell>';
    rows += '<Cell ss:StyleID="data"><Data ss:Type="String">' + escXml(b.dates) + '</Data></Cell>';
    rows += '<Cell ss:StyleID="dataR"><Data ss:Type="Number">' + b.spende.toFixed(2) + '</Data></Cell>';
    rows += '</Row>';
  });

  // Total row
  rows += '<Row>';
  rows += '<Cell ss:MergeAcross="3" ss:StyleID="hdrBL"><Data ss:Type="String">Gesamt</Data></Cell>';
  rows += '<Cell ss:StyleID="hdrBR"><Data ss:Type="Number">' + total.toFixed(2) + '</Data></Cell>';
  rows += '</Row>';

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    (function() {
      function bdr(t,b,l,r) {
        return '<Borders>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="'+t+'"/>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="'+b+'"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="'+l+'"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="'+r+'"/>' +
          '</Borders>';
      }
      var g=bdr(1,1,1,1), gL=bdr(1,1,2,1), gR=bdr(1,1,1,2), gTL=bdr(2,1,2,1), gT=bdr(2,1,1,1), gTR=bdr(2,1,1,2), gBL=bdr(1,2,2,1), gBR=bdr(1,2,1,2);
      return '<Styles>\n' +
        '<Style ss:ID="Default"><Font ss:Size="12"/><Alignment ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="spTitle"><Font ss:Size="18" ss:Bold="1" ss:Color="#22a352"/><Alignment ss:Vertical="Center"/></Style>\n' +
        '<Style ss:ID="hdrTL"><Font ss:Size="12" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E6F7ED" ss:Pattern="Solid"/>'+gTL+'</Style>\n' +
        '<Style ss:ID="hdrT"><Font ss:Size="12" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E6F7ED" ss:Pattern="Solid"/>'+gT+'</Style>\n' +
        '<Style ss:ID="hdrTR"><Font ss:Size="12" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E6F7ED" ss:Pattern="Solid"/>'+gTR+'</Style>\n' +
        '<Style ss:ID="dataL"><Font ss:Size="12"/><Alignment ss:Vertical="Center"/>'+gL+'</Style>\n' +
        '<Style ss:ID="data"><Font ss:Size="12"/><Alignment ss:Vertical="Center"/>'+g+'</Style>\n' +
        '<Style ss:ID="dataR"><Font ss:Size="12"/><Alignment ss:Vertical="Center"/>'+gR+'</Style>\n' +
        '<Style ss:ID="hdrBL"><Font ss:Size="12" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E6F7ED" ss:Pattern="Solid"/>'+gBL+'</Style>\n' +
        '<Style ss:ID="hdrBR"><Font ss:Size="12" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E6F7ED" ss:Pattern="Solid"/>'+gBR+'</Style>\n' +
        '</Styles>\n';
    })() +
    '<Worksheet ss:Name="Spendenliste">\n' +
    '<Table ss:DefaultColumnWidth="100">\n' +
    '<Column ss:Width="100"/>\n' +
    '<Column ss:Width="200"/>\n' +
    '<Column ss:Width="120"/>\n' +
    '<Column ss:Width="200"/>\n' +
    '<Column ss:Width="100"/>\n' +
    rows +
    '</Table>\n' +
    '</Worksheet>\n' +
    '</Workbook>';

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Spendenliste_' + new Date().getFullYear() + '.xls';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Spendenliste exportiert');
}

// ========== Init ==========
syncGuestsFromBookings();
generateBelegung();
generateZimmer();
renderDailyOverview();
renderBuchungen();
updateBuchungenCount();
generateCalendar();
renderGaeste();
updateGaesteCount();
generateStatBars();
updateDashboardStats();
updateBackupStats();
initBuchungenSearch();
initBuchungenFilter();
initGaesteSearch();
initZimmerSort();
initCalendarNav();
initKuecheNav();
renderKuechenliste();
initKeyboard();
initExportPrint();
initGastAutocomplete();
initZimmerDropdown();
initImportHandler();
initExportNav();
renderExportTable();
populateVorlageBuchungen();
updateVorlagePreview();
renderSpendenPage();

// Make sidebar links work on mobile
document.querySelectorAll('.sidebar-item').forEach(item => {
  const origClick = item.getAttribute('onclick');
  if (origClick) {
    item.removeAttribute('onclick');
    const pageId = item.getAttribute('data-page');
    item.addEventListener('click', () => {
      showPage(pageId);
      const sidebar = document.querySelector('.sidebar');
      if (sidebar.classList.contains('mobile-open')) toggleMobileSidebar();
    });
  }
});

function saveGitHubTokenNew() {
  console.log('[Gastmeister] Token speichern geklickt');
  var token = document.getElementById('githubTokenInput').value.trim();
  if (!token) { showToast('Bitte Token eingeben'); return; }
  GitHubSync.setToken(token);
  GitHubSync.checkAuth().then(function(ok) {
    if (ok) {
      showToast('GitHub verbunden!');
      document.getElementById('githubTokenInput').value = '';
      checkBackupStatus();
      // Sofort Daten synchronisieren
      GitHubSync.loadData().then(function(result) {
        if (result && result.data && result.data.bookings) {
          if (bookingsData.length === 0) {
            result.data.bookings.forEach(function(b) { bookingsData.push(b); });
            if (result.data.guests) { guestsData.length = 0; result.data.guests.forEach(function(g) { guestsData.push(guestObj(g)); }); }
            if (result.data.dayGuests) { result.data.dayGuests.forEach(function(d) { dayGuestsData.push(d); }); }
            if (result.data.mealOverrides) { Object.assign(mealOverrides, result.data.mealOverrides); }
            saveData();
          } else {
            mergeServerData(result.data);
          }
          refreshAll();
          showToast('Daten synchronisiert: ' + result.data.bookings.length + ' Buchungen');
        }
      });
    } else {
      showToast('Token ungültig!');
      GitHubSync.setToken('');
    }
  });
}

safeCreateIcons();

// ========== Multi-Tab Sync ==========
window.addEventListener('storage', function(e) {
  if (e.key === STORAGE_KEY && e.newValue) {
    try {
      var externalData = JSON.parse(e.newValue);
      if (externalData && externalData.bookings) {
        bookingsData.length = 0;
        externalData.bookings.forEach(function(b) { bookingsData.push(b); });
        if (externalData.guests) {
          guestsData.length = 0;
          externalData.guests.forEach(function(g) { guestsData.push(g); });
        }
        showToast('Daten wurden in einem anderen Tab geändert – Ansicht aktualisiert', 'info');
        if (typeof renderCurrentPage === 'function') renderCurrentPage();
        else if (typeof showPage === 'function') showPage(currentPage);
      }
    } catch(err) {
      console.warn('[MultiTab] Daten-Sync fehlgeschlagen:', err);
    }
  }
});

// ========== beforeunload: Daten sofort sichern ==========
window.addEventListener('beforeunload', function() {
  // Sofort in localStorage speichern (synchron, kein Debounce)
  try {
    var data = { bookings: bookingsData, guests: guestsData, _savedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch(e) {}
});
