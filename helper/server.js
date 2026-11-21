// Receives "now playing" data from the browser extension over localhost
// and mirrors it to Discord Rich Presence via the local Discord IPC pipe.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('@xhayper/discord-rpc');
const lyrics = require('./lyrics');

const PORT = 48231;
const STALE_MS = 20_000;      // no update from the browser for this long => clear status
const RETRY_MS = 15_000;      // Discord reconnect interval
const DRIFT_MS = 3_000;       // re-send only when the progress bar drifts more than this

const LOG_FILE = path.join(__dirname, 'helper.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// The helper runs hidden, so write crashes to the log instead of losing them.
process.on('uncaughtException', (err) => { log('Beklenmeyen hata:', err.stack || err.message); process.exit(1); });
process.on('unhandledRejection', (err) => { log('Yakalanmamış hata:', err?.stack || err); });

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
if (!config.clientId || !/^\d{17,20}$/.test(config.clientId)) {
  log('config.json içinde geçerli bir clientId yok. Discord Developer Portal\'dan Application ID gir.');
  process.exit(1);
}

// Tunable in config.json: the shortest gap between two updates sent to Discord, and how early
// each lyric line is sent so that it is up by the time it is sung.
// Measured: Discord takes a new status within a few ms, and 1 s spacing raised no errors.
const MIN_GAP_MS = Number(config.minGapMs ?? 1_000);
const LYRIC_LEAD_S = Number(config.lyricLeadSeconds ?? 0.3);
const DEBUG_LYRICS = Boolean(config.debugLyrics);

// Keep in sync with SITES in extension/settings.js. Logos can be overridden in config.json ("logos").
const SOURCES = {
  youtube:    { name: 'YouTube Music', home: 'https://music.youtube.com', logo: 'https://music.youtube.com/img/favicon_144.png' },
  soundcloud: { name: 'SoundCloud',    home: 'https://soundcloud.com',    logo: 'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-a62dfc8fe7.png' },
  spotify:    { name: 'Spotify',       home: 'https://open.spotify.com',  logo: 'https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://open.spotify.com&size=128' },
  apple:      { name: 'Apple Music',   home: 'https://music.apple.com',   logo: 'https://music.apple.com/assets/favicon/favicon-180.png' },
};
for (const [key, url] of Object.entries(config.logos || {})) if (SOURCES[key]) SOURCES[key].logo = url;

// Texts Discord shows, per popup language (prefs.lang). Keep in sync with extension/i18n.js.
const TEXT = {
  tr: { paused: 'Duraklatıldı', listenOn: { youtube: 'YouTube Music\'te dinle', soundcloud: 'SoundCloud\'da dinle', spotify: 'Spotify\'da dinle', apple: 'Apple Music\'te dinle' } },
  en: { paused: 'Paused',       listenOn: { youtube: 'Listen on YouTube Music', soundcloud: 'Listen on SoundCloud', spotify: 'Listen on Spotify', apple: 'Listen on Apple Music' } },
};

const STATUS_DISPLAY = { name: 0, state: 1, details: 2 };
const DEFAULT_PREFS = {
  statusDisplay: 'details', showArt: true, showSiteLogo: true, showTimestamps: true, showButton: true, showLyrics: true, onPause: 'clear',
};

let client = null;
let ready = false;
let lastSent = null;      // { key, sig } | { cleared: true }
let lastUpdateAt = 0;
let nowPlaying = null;    // what the popup shows
let current = null;       // { np, prefs, sig, start, clock } for the song on Discord right now
let lastPushAt = 0;
let pushTimer = null;     // pending throttled update
let lineTimer = null;     // fires when the next lyric line starts

// One Discord connection at a time. The library can report the same drop more than once
// ('disconnected' fires twice, and login() rejects too), and a timed-out attempt leaves its pipe
// open. So: ignore events from old clients, close every failed one, and keep a single retry timer.
let retryTimer = null;

function retry(c, why, err) {
  if (c !== client) return; // an old client still talking
  ready = false;
  client = null;
  log(why, err?.message ?? '');
  c.removeAllListeners();
  c.destroy().catch(() => {});
  if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; connect(); }, RETRY_MS);
}

function connect() {
  const c = new Client({ clientId: config.clientId, transport: { type: 'ipc' } });
  client = c;
  c.on('ready', () => {
    if (c !== client) return;
    ready = true;
    lastSent = null; // force a fresh push after (re)connect
    log('Discord bağlandı:', c.user?.username ?? '?');
  });
  c.on('disconnected', () => retry(c, 'Discord bağlantısı koptu, tekrar denenecek.'));
  c.login().catch(err => retry(c, 'Discord\'a bağlanılamadı (açık mı?):', err));
}

function trim(s, max = 128) {
  if (!s) return undefined;
  s = String(s);
  if (s.length < 2) s = s + ' '; // Discord rejects 1-char strings
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Discord only accepts http(s) links up to 256 characters for clickable text and images.
function link(u) {
  return typeof u === 'string' && /^https:\/\//.test(u) && u.length <= 256 ? u : undefined;
}

// Profile picture for the popup. Users without one get Discord's default avatar for their id.
function avatarOf(user) {
  if (!user?.id) return null;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  try {
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
  } catch {
    return null;
  }
}

function buildActivity(np, prefs, start, lyric) {
  const src = SOURCES[np.source] || SOURCES.youtube;
  const text = TEXT[prefs.lang] || TEXT.tr;
  const activity = {
    name: `${src.name} · Made By Fare`, // header reads "<name> dinliyor" / "Listening to <name>"
    type: 2,                       // Listening
    statusDisplayType: STATUS_DISPLAY[prefs.statusDisplay] ?? 2,
    details: trim(np.title),
    detailsUrl: link(np.url),            // clicking the song title opens the song
    state: trim(np.paused ? `${text.paused} · ${np.artist || src.name}` : np.artist),
    stateUrl: link(np.artistUrl),        // clicking the artist opens the artist page
    instance: false,
  };
  // Discord prints largeImageText as a third line under the artist. It is only used for the
  // line being sung ("♪" between lines); album names are left out on purpose, since sites often
  // report the wrong thing there (YouTube Music gives singles the song title, or a playlist name).
  const third = lyric !== undefined ? `♪ ${lyric || '♪'}` : undefined;

  // Cover art big, site logo small in its corner. Without cover art (or with it turned off)
  // the site logo becomes the big image, since Discord only draws the small one on top of a big one.
  if (prefs.showArt && np.art) {
    activity.largeImageKey = np.art;
    activity.largeImageText = trim(third);
    activity.largeImageUrl = link(np.url);           // clicking the cover opens the song
    if (prefs.showSiteLogo) {
      activity.smallImageKey = src.logo;
      activity.smallImageText = `${src.name} · Made By Fare`; // hover text on the small logo
      activity.smallImageUrl = src.home;               // clicking the small logo opens the site
    }
  } else if (prefs.showSiteLogo) {
    activity.largeImageKey = src.logo;
    activity.largeImageText = trim(third);
    activity.largeImageUrl = link(np.url) || src.home;
  }
  if (prefs.showTimestamps && !np.paused) {
    activity.startTimestamp = start;
    if (np.duration > 0) activity.endTimestamp = start + Math.round(np.duration * 1000);
  }
  if (prefs.showButton && np.url) activity.buttons = [{ label: text.listenOn[np.source] || text.listenOn.youtube, url: np.url }];
  return activity;
}

async function clearStatus(reason) {
  current = null;
  clearTimeout(lineTimer);
  clearTimeout(pushTimer);
  pushTimer = null;
  if (lastSent && !lastSent.cleared) {
    await client?.user?.clearActivity().catch(() => {});
    log('Durum temizlendi:', reason);
  }
  lastSent = { cleared: true };
}

// Lyric line for the current song right now: string ('' between lines), or undefined when off/unavailable.
function lyricNow() {
  if (!current || !current.prefs.showLyrics || current.np.paused) return undefined;
  const found = lyrics.get(current.np, schedule);
  if (!found) return undefined;
  return lyrics.lineAt(found.lines, (Date.now() - current.clock) / 1000 + LYRIC_LEAD_S);
}

// For the popup: the line being sung, '' between lines, null when there are no lyrics.
function lyricLine() {
  const line = lyricNow();
  return line ? (line.text ?? '') : null;
}

// Push to Discord if what it should show changed, and wake up again when the next lyric line starts.
function schedule() {
  clearTimeout(lineTimer);
  if (!current || !ready) return;
  const line = lyricNow();
  const key = JSON.stringify([current.sig, current.start, line?.text]);
  if (!lastSent || lastSent.cleared || lastSent.key !== key) requestPush();
  if (line?.next != null) {
    lineTimer = setTimeout(schedule, Math.max(50, current.clock + (line.next - LYRIC_LEAD_S) * 1000 - Date.now()));
  }
}

// Don't flood Discord with updates; space them out. A line that ends before its
// turn is skipped; the update always shows whatever is current when it goes out.
function requestPush() {
  if (pushTimer) return;
  pushTimer = setTimeout(push, Math.max(0, lastPushAt + MIN_GAP_MS - Date.now()));
}

async function push() {
  pushTimer = null;
  if (!current || !ready) return;
  const line = lyricNow();
  const text = line ? (line.text ?? '') : undefined;
  const key = JSON.stringify([current.sig, current.start, line?.text]);
  if (lastSent && !lastSent.cleared && lastSent.key === key) return;
  const { np, prefs, sig, start } = current;
  lastPushAt = Date.now();
  try {
    await client?.user?.setActivity(buildActivity(np, prefs, start, text));
    if (DEBUG_LYRICS && text !== undefined) log('Söz:', `@${((lastPushAt - current.clock) / 1000).toFixed(1)}s +${Date.now() - lastPushAt}ms`, text);
    if (lastSent?.sig !== sig) log('Durum:', `${np.source}|${np.title}|${np.artist}${np.paused ? ' (duraklatıldı)' : ''}`);
    lastSent = { key, sig };
  } catch (err) {
    log('setActivity hatası:', err.message);
  }
}

async function handleNowPlaying(np) {
  lastUpdateAt = Date.now();
  const prefs = { ...DEFAULT_PREFS, ...(np?.prefs || {}) };
  const show = np && np.title && (!np.paused || prefs.onPause === 'show');
  nowPlaying = show ? { source: np.source, title: np.title, artist: np.artist, art: np.art, paused: !!np.paused,
    position: np.position, duration: np.duration, at: Date.now() } : null;
  if (!ready) return;
  if (!show) return clearStatus('duraklatıldı / şarkı yok');

  const sig = JSON.stringify([np.source, np.title, np.artist, np.url, np.artistUrl, !!np.paused, prefs]);
  const start = Date.now() - Math.round((np.position || 0) * 1000);
  // The progress bar keeps its old start time unless the song changed or the user seeked, so it
  // doesn't jump around. Lyrics always follow the latest exact position from the browser (clock).
  const same = current && current.sig === sig && !np.paused && Math.abs(current.start - start) <= DRIFT_MS;
  current = { np, prefs, sig, start: same ? current.start : start, clock: start };
  schedule();
}

// Clear the status when the browser stops reporting (tab closed, browser quit).
setInterval(() => {
  if (Date.now() - lastUpdateAt > STALE_MS) {
    nowPlaying = null;
    if (ready && lastSent && !lastSent.cleared) clearStatus('tarayıcıdan veri gelmiyor');
  }
}, 5_000);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      helper: true, discord: ready,
      user: ready ? client?.user?.username : null,
      avatar: ready ? avatarOf(client?.user) : null,
      nowPlaying: nowPlaying && { ...nowPlaying, lyric: lyricLine() },
    }));
  }
  if (req.method !== 'POST' || req.url !== '/np') {
    res.writeHead(404);
    return res.end();
  }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 16_384) req.destroy(); });
  req.on('end', () => {
    let np;
    try { np = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    handleNowPlaying(np);
    // The extension warns the user when Discord isn't connected.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ discord: ready }));
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') { log(`Port ${PORT} dolu (yardımcı zaten çalışıyor olabilir), çıkılıyor.`); process.exit(0); }
  log('Sunucu hatası:', err.message);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Yardımcı http://127.0.0.1:${PORT} üzerinde dinliyor.`);
  connect();
});
