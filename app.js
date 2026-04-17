// Ratbat web player — responsive card grid.
// Each live station is one card. Click a card to play it. The sticky
// footer shows what's playing + native <audio> controls.

function resolveAPIBase() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('api')) return params.get('api').replace(/\/+$/, '');
  if (typeof window.RATBAT_API === 'string' && window.RATBAT_API) {
    return window.RATBAT_API.replace(/\/+$/, '');
  }
  const host = window.location.hostname;
  if (host.startsWith('ratbat.')) {
    return window.location.protocol + '//radio.' + host.slice('ratbat.'.length);
  }
  return window.location.origin;
}

var API_BASE = resolveAPIBase();
var stations = [];
var activeId = null;

var $stations = document.getElementById('stations');
var $player = document.getElementById('player');
var $audio = document.getElementById('audio');
var $title = document.getElementById('track-title');
var $artist = document.getElementById('track-artist');
var $stationName = document.getElementById('active-station-name');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function refresh() {
  fetch(API_BASE + '/now.json', { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      stations = (data.stations || []).map(function (s) {
        if (s.streamURL && s.streamURL.charAt(0) === '/') s.streamURL = API_BASE + s.streamURL;
        return s;
      });
      render();
      syncPlayer();
    })
    .catch(function () {
      stations = [];
      activeId = null;
      $stations.innerHTML = '<p class="empty">Broadcaster offline.</p>';
      $player.hidden = true;
    });
}

function render() {
  if (!stations.length) {
    $stations.innerHTML = '<p class="empty">No stations broadcasting right now.</p>';
    return;
  }
  $stations.innerHTML = stations.map(function (s) {
    var activeCls = activeId === s.id ? ' active' : '';
    var t = s.currentTrack;
    var np = t
      ? '<b>' + escapeHtml(t.title) + '</b> — ' + escapeHtml(t.artist)
      : 'Live';
    return (
      '<button type="button" class="station' + activeCls + '" ' +
      'data-id="' + escapeHtml(s.id) + '" ' +
      'data-url="' + escapeHtml(s.streamURL || '') + '" ' +
      'data-name="' + escapeHtml(s.name) + '" ' +
      'aria-pressed="' + (activeId === s.id ? 'true' : 'false') + '">' +
        '<div class="row">' +
          '<span class="dot" aria-hidden="true"></span>' +
          '<span class="name">' + escapeHtml(s.name) + '</span>' +
        '</div>' +
        '<div class="np">' + np + '</div>' +
      '</button>'
    );
  }).join('');

  var cards = $stations.querySelectorAll('.station');
  for (var i = 0; i < cards.length; i++) {
    cards[i].addEventListener('click', function () {
      select(this.dataset.id, this.dataset.url, this.dataset.name);
    });
  }
}

function select(id, url, name) {
  activeId = id;
  $stationName.textContent = name;
  $audio.src = url;
  $audio.play().catch(function () { /* autoplay policy — user can hit play */ });
  $player.hidden = false;
  syncPlayer();
  render();
}

function syncPlayer() {
  if (!activeId) return;
  var s = stations.find(function (x) { return x.id === activeId; });
  if (!s) {
    $title.textContent = '—';
    $artist.textContent = 'Station went offline';
    return;
  }
  var t = s.currentTrack;
  if (t) {
    $title.textContent = t.title;
    $artist.textContent = t.artist;
  } else {
    $title.textContent = 'Live';
    $artist.textContent = s.name;
  }
}

// Poll faster when nothing is live so new broadcasts appear quickly;
// back off once stations are up (keeps now-playing fresh without hammering).
var POLL_FAST = 1500;
var POLL_SLOW = 3000;
var pollTimer = null;

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  var delay = stations.length ? POLL_SLOW : POLL_FAST;
  pollTimer = setTimeout(function () { refresh().then(schedulePoll); }, delay);
}

// Wrap refresh so schedulePoll can chain off it cleanly.
var _refresh = refresh;
refresh = function () {
  return new Promise(function (resolve) {
    _refresh();
    // _refresh is fire-and-forget; give it a tick before scheduling next.
    setTimeout(resolve, 0);
  });
};

// Also refetch when the tab regains focus (user flipped back from Ratbat app).
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) refresh();
});

refresh().then(schedulePoll);
