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

// ===== LOGIN =====
var _isLoggedIn = false;

function checkLogin() {
  var pwd = document.getElementById('loginPasswordInput').value;
  var errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  var PASSWORT_HASH = '1decd0eb4a29b74f4bf1a66290e8f78b61feb2b6212d86b6834a8a1924d94733';

  crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd)).then(function(buf) {
    var hash = Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    if (hash === PASSWORT_HASH) {
      sessionStorage.setItem('gastmeister_logged_in', '1');
      document.getElementById('loginScreen').style.display = 'none';
      _isLoggedIn = true;
      document.getElementById('loginPasswordInput').value = '';
    } else {
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('loginPasswordInput').select();
    }
  });
}

function showLoginIfNeeded() {
  // Wenn bereits in dieser Session eingeloggt, direkt weiter
  if (sessionStorage.getItem('gastmeister_logged_in') === '1') {
    document.getElementById('loginScreen').style.display = 'none';
    _isLoggedIn = true;
    return true;
  }
  // Login-Screen anzeigen
  var loginScreen = document.getElementById('loginScreen');
  if (loginScreen) {
    loginScreen.style.display = 'flex';
    setTimeout(function() {
      var inp = document.getElementById('loginPasswordInput');
      if (inp) inp.focus();
    }, 100);
  }
  return false;
}

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



// ========== Backup-Server Token Management ==========
var _serverToken = '';
const SERVER_TOKEN_KEY = 'gastmeister_server_token';

function getServerToken() {
  if (!_serverToken) {
    _serverToken = localStorage.getItem(SERVER_TOKEN_KEY) || '';
  }
  return _serverToken;
}

function setServerToken(token) {
  _serverToken = token || '';
  if (_serverToken) {
    localStorage.setItem(SERVER_TOKEN_KEY, _serverToken);
  } else {
    localStorage.removeItem(SERVER_TOKEN_KEY);
  }
  // UI aktualisieren
  var tokenDisplay = document.getElementById('serverTokenDisplay');
  if (tokenDisplay) {
    tokenDisplay.value = _serverToken ? (_serverToken.substring(0, 8) + '...' + _serverToken.substring(_serverToken.length - 4)) : '';
  }
}

function fetchServerToken() {
  return new Promise(function(resolve) {
    // Versuche Token von localhost zu holen
    fetch('http://localhost:9847/auth-token', { timeout: 3000 })
      .then(function(response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function(data) {
        if (data.token) {
          setServerToken(data.token);
          console.log('[ServerToken] Von localhost geholt');
          resolve(true);
        } else {
          throw new Error('Kein Token in Response');
        }
      })
      .catch(function(error) {
        console.log('[ServerToken] Fetch von localhost fehlgeschlagen:', error.message);
        // Fallback: Prüfe ob bereits ein Token in localStorage gespeichert ist
        var stored = localStorage.getItem(SERVER_TOKEN_KEY);
        if (stored) {
          _serverToken = stored;
          console.log('[ServerToken] Aus localStorage geholt');
          resolve(true);
        } else {
          // Fallback: Benutzer auffordern Token manuell einzugeben
          var manualToken = prompt('Bitte Server-Token eingeben:\n(zu finden auf dem Mac unter: Einstellungen → Backup → Token)');
          if (manualToken && manualToken.trim()) {
            setServerToken(manualToken.trim());
            console.log('[ServerToken] Manuell eingegeben');
            resolve(true);
          } else {
            console.log('[ServerToken] Benutzer hat Eingabe abgebrochen');
            resolve(false);
          }
        }
      });
  });
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
  // 3. GitHub Sync (async, debounced 3s)
  if (typeof GitHubSync !== 'undefined' && GitHubSync.hasToken()) {
    GitHubSync.saveData(data);
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
      // IDB ergänzt nur fehlende Keys, lokale Overrides haben Priorität
      for (var k in idbData.mealOverrides) {
        if (!mealOverrides[k]) {
          mealOverrides[k] = idbData.mealOverrides[k];
        }
      }
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

// ========== Sync-Polling ==========

