// Lyrics from free, documented public APIs, asked at once; the best answer wins.
//
//   LRCLIB (lrclib.net): time-synced or plain lyrics, an open database with a public API.
//   lyrics.ovh (api.lyrics.ovh): plain lyrics.
// Time-synced lyrics always beat plain ones. When nobody has timings, the plain lyrics are spread over
// the song by line length, so something still shows, roughly in time.
//
// Only the song title, artist and length are sent.
const MAX_CACHE = 100;
const TIMEOUT_MS = 9000;
// Both APIs ask clients to name themselves.
const UA_APP = 'lyricord (https://github.com/getirfinanz/lyricord)';

const cache = new Map(); // song key -> { lines, synced, source } | null (nothing found) | Promise while loading

const keyOf = (np) => `${np.artist}\u0000${np.title}`.toLowerCase();
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const sameLength = (a, b, slack = 5) => !a || !b || Math.abs(a - b) <= slack;

// SoundCloud and YouTube titles often carry extras that break the lookup.
function cleanTitle(title) {
  return String(title)
    .replace(/_/g, ' ')                                   // "qimp_-_kusursuz_"
    .replace(/\.(?:mp3|wav|m4a|flac|ogg)\s*$/i, '')       // "song.mp3"
    .replace(/\s*[([](?:official|lyric|audio|video|visuali[sz]er|prod|free|out now|clip)[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([]?\b(?:ft|feat)(?:\.\s*|\s+)[^)\]]*[)\]]?/gi, '') // "ft. X", "ft.X", "(feat X)"
    .replace(/\s+/g, ' ')
    .trim();
}

// Version tags that keep both the words and the timing: "(demo)", "[8D]", "- remastered".
// Not sped up / slowed / nightcore / live / remix: the original's synced lyrics would run at the wrong pace.
const VERSION_WORDS = 'demo|edit|version|versiyon|remaster(?:ed)?|8d(?: audio)?|bass ?boost(?:ed)?|unreleased|snippet|clean|explicit';
const VERSION_GROUP = new RegExp(`\\s*[([][^)\\]]*\\b(?:${VERSION_WORDS})\\b[^)\\]]*[)\\]]`, 'giu');
const VERSION_TAIL = new RegExp(`\\s*[-–—|]\\s*(?:${VERSION_WORDS})(?:\\s*[+&]\\s*(?:${VERSION_WORDS}))*\\s*$`, 'iu');
const stripVersion = (title) => title.replace(VERSION_GROUP, '').replace(VERSION_TAIL, '').trim();

// Search terms to try, best guess first. SoundCloud uploads are often "Artist - Song" posted from
// another account, and carry version tags the lyric sites don't have.
function queries(np) {
  const out = [];
  const add = (title, artist) => {
    title = title.trim();
    if (!norm(title) || out.some(q => norm(q.title) === norm(title) && norm(q.artist) === norm(artist))) return;
    out.push({ title, artist });
  };
  const artist = mainArtist(np.artist);
  const full = cleanTitle(np.title);
  const bare = stripVersion(full);
  // "Artist - Song" first: on SoundCloud that's usually what the title is, and every source can use it.
  // Split the tag-free title only, so "Song - demo" doesn't become artist "Song".
  const parts = bare.split(/\s+[-–—]\s+/);
  // YouTube Music and Apple Music titles come from the label's catalog, so a dash there is part of the name.
  if (parts.length >= 2 && np.source !== 'youtube' && np.source !== 'apple') add(parts.slice(1).join(' - '), mainArtist(parts[0]));
  add(full, artist);
  add(bare, artist);
  return out;
}

// YouTube Music joins several artists into one string ("A ve B", "A & B", "A, B", "A x B").
function mainArtist(artist) {
  return String(artist || '').split(/\s+(?:ve|and|&|x|feat\.?|ft\.?|with|vs\.?)\s+|\s*,\s*/i)[0].trim();
}

// Does a search hit look like the song we want?
// An empty wanted title ("...", "???", emoji only) would match anything, so it never matches.
function matches(hitTitle, hitArtist, title, artist) {
  const t = norm(hitTitle), a = norm(hitArtist), want = norm(title);
  if (!want) return false;
  return t.startsWith(want) && (!artist || a.includes(norm(artist)) || norm(artist).includes(a));
}

async function request(url, options = {}, as = 'json') {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': UA_APP, ...(options.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return as === 'json' ? res.json() : res.text();
}

// "[01:23.45] line" -> { t: 83.45, text: 'line' }, sorted by time.
function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

const plainLines = (text) => String(text || '').split(/\r?\n/).map(s => s.trim());

const synced = (source, rank, lines) => (lines.filter(l => l.text).length >= 3 ? [{ source, rank, synced: true, lines }] : []);
const plain = (source, rank, text) => (text ? [{ source, rank, synced: false, plain: Array.isArray(text) ? text : plainLines(text) }] : []);

// ---------- LRCLIB ----------
const lrclib = (params) => request(`https://lrclib.net/api/search?${new URLSearchParams(params)}`);

async function fromLrclib(np, title, artist) {
  let results = await lrclib({ track_name: title, artist_name: artist });
  if (!results.length && title.includes(' - ')) {
    // SoundCloud uploads are often "Artist - Song" posted by someone else.
    const [a, ...rest] = title.split(' - ');
    results = await lrclib({ track_name: rest.join(' - '), artist_name: a });
  }
  if (!results.length) {
    // Free-text search returns anything close, often another song by the same artist; keep title matches only.
    results = (await lrclib({ q: `${artist} ${title}` })).filter(r => norm(r.trackName).includes(norm(title)));
  }
  if (!results.length && np.duration) {
    // Same title and length, whoever LRCLIB lists as the artist.
    results = (await lrclib({ track_name: title }))
      .filter(r => norm(r.trackName) === norm(title) && sameLength(r.duration, np.duration, 2));
  }
  const usable = results
    .filter(r => !r.instrumental && sameLength(r.duration, np.duration))
    .sort((a, b) => Math.abs((a.duration || 0) - np.duration) - Math.abs((b.duration || 0) - np.duration));
  const withTimes = usable.find(r => r.syncedLyrics);
  return [
    ...(withTimes ? synced('LRCLIB', 3, parseLrc(withTimes.syncedLyrics)) : []),
    ...plain('LRCLIB', 1, usable.find(r => r.plainLyrics)?.plainLyrics),
  ];
}

// ---------- lyrics.ovh (plain only) ----------
async function fromLyricsOvh(np, title, artist) {
  const res = await request(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
  return plain('lyrics.ovh', 3, res.lyrics);
}

// ---------- pick the best ----------
const SOURCES = [fromLrclib, fromLyricsOvh];

// Not lyrics: uploader notes (links, social handles) and credit lines ("作词 : …", "Lyrics by …").
const JUNK = /https?:|www\.|\.(?:com|net|design|ly)\b|\binsta(?:gram)?\b|\btiktok\b|@\w|^(?:作词|作曲|编曲|制作人|词|曲|lyrics?|composer|written by|produced by)\s*[:：]/i;

function tidy(lines, np) {
  // Some lyrics open with an "Artist - Title" line; drop it along with junk.
  const header = norm(`${np.artist}${np.title}`);
  return lines.filter(l => !JUNK.test(l.text) && !(l.t < 1 && norm(l.text) === header));
}

// Plain lyrics -> estimated timings: skip a short intro and outro, give longer lines more time,
// and treat empty lines (verse breaks) as a short pause.
function spread(texts, duration) {
  texts = texts.filter(t => !JUNK.test(t));
  while (texts.length && !texts[0]) texts.shift();
  while (texts.length && !texts[texts.length - 1]) texts.pop();
  if (texts.filter(Boolean).length < 4) return null;
  const total = duration > 0 ? duration : texts.length * 3.5 + 20;
  const pad = Math.min(10, total * 0.08);
  const weights = texts.map(s => (s ? 8 + s.length : 6));
  const sum = weights.reduce((a, b) => a + b, 0);
  let t = pad;
  return texts.map((text, i) => {
    const line = { t, text };
    t += ((total - 2 * pad) * weights[i]) / sum;
    return line;
  });
}

// Try each search term in turn; the first one any source has lyrics for wins.
// Titles with no letters or digits ("...", "???", "🖤") give no terms, so no lyrics.
async function load(np) {
  for (const { title, artist } of queries(np)) {
    const result = await search(np, title, artist);
    if (result) return { ...result, query: { title, artist } };
  }
  return null;
}

async function search(np, title, artist) {
  // Ask everyone at once; a source that fails or times out just counts as "nothing found".
  const found = (await Promise.all(SOURCES.map(src => src(np, title, artist).catch(() => [])))).flat();
  const best = (list) => list.sort((a, b) => a.rank - b.rank);

  for (const r of best(found.filter(r => r.synced))) {
    const lines = tidy(r.lines, np);
    if (lines.filter(l => l.text).length >= 3) return { source: r.source, synced: true, lines };
  }
  for (const r of best(found.filter(r => !r.synced))) {
    const lines = spread(r.plain, np.duration);
    if (lines) return { source: r.source, synced: false, lines };
  }
  return null;
}

// Lyrics for the song ({ lines, synced, source }), undefined while loading, null when none exist.
// Starts the download the first time a song is asked for; onReady runs when lyrics arrive.
function get(np, onReady) {
  const key = keyOf(np);
  const entry = cache.get(key);
  if (entry === null || (entry && !(entry instanceof Promise))) return entry;
  if (!entry) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    const p = load(np).then(
      (result) => {
        cache.set(key, result); // null = no source has lyrics; don't ask again
        if (result) onReady?.();
      },
      () => {
        // Unexpected failure: no lyrics for now, try again in a minute.
        cache.set(key, null);
        setTimeout(() => { if (cache.get(key) === null) cache.delete(key); }, 60_000);
      },
    );
    cache.set(key, p);
  }
  return undefined;
}

// Line playing at `pos` seconds, and when the next one starts (seconds), or null text before the first line.
function lineAt(lines, pos) {
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const next = lines[idx + 1]?.t ?? null;
  return { text: idx >= 0 ? lines[idx].text : null, next };
}

module.exports = { get, lineAt, _sources: { fromLrclib, fromLyricsOvh }, _clean: { cleanTitle, mainArtist, stripVersion, queries } };
