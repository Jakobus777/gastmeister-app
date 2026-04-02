var GitHubSync = (function() {
  'use strict';

  function fetchWithTimeout(url, options, timeoutMs) {
    timeoutMs = timeoutMs || 15000;
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    options = options || {};
    options.signal = controller.signal;
    return fetch(url, options).finally(function() { clearTimeout(timer); });
  }

  var REPO_OWNER = 'Jakobus777';
  var REPO_NAME = 'gastmeister-app';
  var DATA_FILE = 'gastmeister_data.json';
  var API_BASE = 'https://api.github.com';
  var TOKEN_KEY = 'gastmeister_github_token';

  var _token = '';
  var _lastSHA = '';
  var _lastETag = '';
  var _saveDebounceTimer = null;
  var _saveQueue = null;
  var _isSaving = false;
  var _backoffUntil = 0; // Timestamp bis wann keine Requests gemacht werden sollen

  // Rate-Limit-Handling
  function _checkRateLimit(response) {
    var remaining = response.headers.get('X-RateLimit-Remaining');
    if (remaining !== null && parseInt(remaining) < 100) {
      console.warn('[GitHubSync] Rate-Limit niedrig:', remaining, 'verbleibend');
    }
    if (response.status === 429 || (response.status === 403 && remaining === '0')) {
      var resetAt = response.headers.get('X-RateLimit-Reset');
      _backoffUntil = resetAt ? parseInt(resetAt) * 1000 : Date.now() + 60000;
      console.warn('[GitHubSync] Rate-Limited! Pause bis', new Date(_backoffUntil).toLocaleTimeString());
      return true;
    }
    return false;
  }

  function _isBackedOff() {
    return Date.now() < _backoffUntil;
  }

  // Token-Verwaltung
  function getToken() {
    if (!_token) {
      _token = localStorage.getItem(TOKEN_KEY) || '';
    }
    return _token;
  }

  function setToken(token) {
    _token = token || '';
    if (_token) {
      localStorage.setItem(TOKEN_KEY, _token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }

  function hasToken() {
    return !!getToken();
  }

  // Headers für GitHub API
  function _headers(extra) {
    var h = {
      'Authorization': 'token ' + getToken(),
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
    if (extra) {
      for (var k in extra) {
        if (extra.hasOwnProperty(k)) {
          h[k] = extra[k];
        }
      }
    }
    return h;
  }

  // Auth prüfen — GET /user
  function checkAuth() {
    return fetchWithTimeout(API_BASE + '/user', { headers: _headers() })
      .then(function(r) { return r.ok; })
      .catch(function() { return false; });
  }

  // Daten laden — GET /repos/:owner/:repo/contents/:path
  // Returns: { data: {...parsed JSON...}, sha: "..." } oder null bei Fehler/304
  function loadData() {
    if (_isBackedOff()) return Promise.resolve(null);

    var url = API_BASE + '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + DATA_FILE;
    var hdrs = _headers();
    if (_lastETag) {
      hdrs['If-None-Match'] = _lastETag;
    }

    return fetchWithTimeout(url, { headers: hdrs })
      .then(function(r) {
        if (r.status === 304) return null;
        if (_checkRateLimit(r)) return null;
        if (!r.ok) throw new Error('GitHub API: ' + r.status);
        _lastETag = r.headers.get('ETag') || '';
        return r.json();
      })
      .then(function(fileInfo) {
        if (!fileInfo) return null; // 304
        _lastSHA = fileInfo.sha;
        // Content ist Base64-kodiert und kann Zeilenumbrüche enthalten
        try {
          var content = decodeURIComponent(escape(atob(fileInfo.content.replace(/\n/g, ''))));
          return { data: JSON.parse(content), sha: fileInfo.sha };
        } catch(e) {
          console.error('[GitHubSync] Daten-Dekodierung fehlgeschlagen:', e);
          return null;
        }
      });
  }

  // Prüfen ob sich die Datei geändert hat (conditional GET via ETag)
  // Returns: true wenn geändert, false wenn unverändert
  function hasChanged() {
    if (_isBackedOff()) return Promise.resolve(null);

    var url = API_BASE + '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + DATA_FILE;
    var hdrs = _headers();
    if (_lastETag) {
      hdrs['If-None-Match'] = _lastETag;
    }

    return fetchWithTimeout(url, { headers: hdrs })
      .then(function(r) {
        if (r.status === 304) return false;
        if (_checkRateLimit(r)) return null;
        if (r.ok) {
          _lastETag = r.headers.get('ETag') || '';
          return r.json().then(function(fileInfo) {
            var changed = fileInfo.sha !== _lastSHA;
            _lastSHA = fileInfo.sha;
            return changed;
          });
        }
        return false;
      })
      .catch(function() { return false; });
  }

  // Daten sofort speichern — PUT /repos/:owner/:repo/contents/:path
  // Nutzt SHA für Conflict Detection; gibt { success: true }, { conflict: true } oder { error: "..." } zurück
  function _doSave(data) {
    if (_isBackedOff()) { _isSaving = false; return Promise.resolve({ error: 'rate-limited' }); }
    if (_isSaving) {
      _saveQueue = data;
      return Promise.resolve(false);
    }
    _isSaving = true;
    var _savingTimeout = setTimeout(function() {
      if (_isSaving) { _isSaving = false; console.warn('[GitHubSync] _isSaving timeout reset'); }
    }, 30000);

    var url = API_BASE + '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + DATA_FILE;
    var jsonStr = JSON.stringify(data, null, 2);
    // UTF-8 zu Base64 — encodeURIComponent/unescape für Umlaut-Handling
    var encoded = btoa(unescape(encodeURIComponent(jsonStr)));

    var body = {
      message: 'Auto-Sync: Buchungsdaten aktualisiert',
      content: encoded,
      sha: _lastSHA
    };

    return fetchWithTimeout(url, {
      method: 'PUT',
      headers: _headers(),
      body: JSON.stringify(body)
    })
    .then(function(r) {
      clearTimeout(_savingTimeout);
      _isSaving = false;
      if (_checkRateLimit(r)) return { error: 'rate-limited' };
      if (r.status === 409) {
        // Conflict — SHA stimmt nicht mehr, extern wurde gespeichert
        console.warn('[GitHubSync] Conflict beim Speichern — lade aktuelle Version');
        return { conflict: true };
      }
      if (!r.ok) throw new Error('GitHub Save: ' + r.status);
      return r.json();
    })
    .then(function(result) {
      if (result && result.conflict) return result;
      if (result && result.content) {
        _lastSHA = result.content.sha;
        _lastETag = ''; // ETag nach Schreibvorgang invalidieren
      }
      // Ausstehenden Queue-Eintrag abarbeiten
      if (_saveQueue) {
        var queued = _saveQueue;
        _saveQueue = null;
        return _doSave(queued);
      }
      return { success: true };
    })
    .catch(function(e) {
      clearTimeout(_savingTimeout);
      _isSaving = false;
      console.error('[GitHubSync] Speichern fehlgeschlagen:', e);
      return { error: e.message };
    });
  }

  // Debounced Save — führt _doSave erst 3 Sekunden nach letztem Aufruf aus
  function saveData(data) {
    return new Promise(function(resolve) {
      if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
      _saveDebounceTimer = setTimeout(function() {
        _doSave(data).then(function(result) {
          resolve(result);
        }).catch(function(err) {
          resolve({ error: err });
        });
      }, 3000);
    });
  }

  function getLastSHA() { return _lastSHA; }
  function setLastSHA(sha) { _lastSHA = sha; }

  // Public API
  return {
    getToken: getToken,
    setToken: setToken,
    hasToken: hasToken,
    checkAuth: checkAuth,
    loadData: loadData,
    saveData: saveData,
    hasChanged: hasChanged,
    getLastSHA: getLastSHA,
    setLastSHA: setLastSHA,
    isBackedOff: _isBackedOff,
    TOKEN_KEY: TOKEN_KEY
  };
})();
