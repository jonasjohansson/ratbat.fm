// Ratbat web player. Plain HTML/JS, no framework.

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

var $list = document.getElementById('station-list');
var $audio = document.getElementById('audio');
var $title = document.getElementById('track-title');
var $artist = document.getElementById('track-artist');
var $album = document.getElementById('track-album');
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
      renderStations();
      syncTrack();
    })
    .catch(function () {
      stations = [];
      activeId = null;
      $list.innerHTML = '<li><i>Broadcaster offline.</i></li>';
      $title.textContent = '—';
      $artist.textContent = '—';
      $album.textContent = '';
      $stationName.textContent = '—';
    });
}

function renderStations() {
  if (!stations.length) {
    $list.innerHTML = '<li><i>No stations broadcasting.</i></li>';
    return;
  }
  $list.innerHTML = stations.map(function (s) {
    var active = activeId === s.id ? ' class="active"' : '';
    return '<li' + active + '><a href="#" data-id="' + escapeHtml(s.id) +
      '" data-url="' + escapeHtml(s.streamURL || '') +
      '" data-name="' + escapeHtml(s.name) + '">' +
      escapeHtml(s.name) + '</a></li>';
  }).join('');
  var links = $list.querySelectorAll('a');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function (e) {
      e.preventDefault();
      select(this.dataset.id, this.dataset.url, this.dataset.name);
    });
  }
}

function select(id, url, name) {
  activeId = id;
  $stationName.textContent = name;
  $audio.src = url;
  $audio.play().catch(function () { /* user will hit play */ });
  renderStations();
  syncTrack();
}

function syncTrack() {
  if (!activeId) return;
  var s = stations.find(function (x) { return x.id === activeId; });
  if (!s) {
    $title.textContent = '—';
    $artist.textContent = 'Station went offline';
    $album.textContent = '';
    return;
  }
  var t = s.currentTrack;
  if (t) {
    $title.textContent = t.title;
    $artist.textContent = t.artist;
    $album.textContent = t.album || '';
  } else {
    $title.textContent = 'Live';
    $artist.textContent = s.name;
    $album.textContent = '';
  }
}

refresh();
setInterval(refresh, 3000);
