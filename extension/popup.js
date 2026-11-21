import { HELPER, SITES, CONTACT, loadSettings, saveSettings, resolveLang } from './settings.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const form = $('form');

const TOGGLES = ['showArt', 'showSiteLogo', 'showLyrics', 'showTimestamps', 'showButton'];
const SITE_DESC_KEY = { youtube: 'descYoutube', soundcloud: 'descSoundcloud', spotify: 'descSpotify', apple: 'descApple' };

let settings = null;
let lang = 'en';
let status; // last /status from the helper: undefined before the first poll, null when unreachable

const fmt = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

// ---------- static texts ----------
function applyLang() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(lang, el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(lang, el.dataset.i18nLabel));
  for (const btn of document.querySelectorAll('.lang button')) btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  const version = chrome.runtime.getManifest().version;
  $('version').textContent = t(lang, 'version', { v: version });

  // Contact buttons; WhatsApp opens with a first line already typed.
  const contact = {
    discord: CONTACT.discord,
    whatsapp: CONTACT.whatsapp && `https://wa.me/${CONTACT.whatsapp}?text=${encodeURIComponent(t(lang, 'feedbackMessage', { v: version }))}`,
    instagram: CONTACT.instagram && `https://www.instagram.com/${CONTACT.instagram}/`,
  };
  for (const [key, url] of Object.entries(contact)) {
    const a = $(`fb-${key}`);
    a.hidden = !url;
    if (url) a.href = url;
  }
}

// ---------- form <-> settings ----------
function fillForm() {
  for (const key of Object.keys(SITES)) form.elements[`site-${key}`].checked = settings.sites[key] !== false;
  form.elements.statusDisplay.value = settings.statusDisplay;
  form.elements.keepOnPause.checked = settings.onPause === 'show';
  for (const key of TOGGLES) form.elements[key].checked = settings[key];
}

function readForm() {
  const sites = {};
  for (const key of Object.keys(SITES)) sites[key] = form.elements[`site-${key}`].checked;
  return {
    lang: settings.lang,
    sites,
    statusDisplay: form.elements.statusDisplay.value,
    onPause: form.elements.keepOnPause.checked ? 'show' : 'clear',
    ...Object.fromEntries(TOGGLES.map(key => [key, form.elements[key].checked])),
  };
}

// ---------- preview ----------
function renderPreview() {
  const live = status?.nowPlaying;
  const np = live || {
    source: 'youtube', title: t(lang, 'sampleTitle'), artist: t(lang, 'sampleArtist'),
    art: null, position: 72, duration: 210, paused: false,
  };
  const meta = SITES[np.source] || SITES.youtube;
  const site = meta.name;
  const brand = `${site} · Made By Fare`;

  $('pv-head').textContent = t(lang, 'listening', { site });
  $('pv-sample').hidden = Boolean(live);
  $('pv-title').textContent = np.title;
  $('pv-artist').textContent = np.paused ? `${t(lang, 'paused')} · ${np.artist || site}` : (np.artist || '');

  // Mirrors the helper: cover art with the site logo in its corner; without cover art
  // (or with it turned off) the site logo becomes the big image.
  const useArt = settings.showArt && np.art;
  const big = useArt ? np.art : (settings.showSiteLogo ? meta.logo : null);
  $('pv-artwrap').hidden = !big && !settings.showArt;
  const art = $('pv-art');
  art.classList.toggle('has-img', Boolean(big));
  art.style.backgroundImage = big ? `url("${big}")` : '';
  const badge = $('pv-badge');
  badge.hidden = !(useArt && settings.showSiteLogo);
  if (!badge.hidden) badge.src = meta.logo;

  // Third line: the line being sung (helper sends '' between lines, null when there are no lyrics).
  const lyric = !settings.showLyrics || !big || np.paused ? null
    : live ? (live.lyric == null ? null : live.lyric || '♪')
    : t(lang, 'sampleLyric');
  $('pv-lyric').hidden = lyric == null;
  $('pv-lyric').textContent = lyric == null ? '' : `♪ ${lyric}`;

  // Estimate the live position from when the helper last heard from the browser.
  const elapsed = live && !np.paused ? (Date.now() - np.at) / 1000 : 0;
  const pos = Math.min((np.position || 0) + elapsed, np.duration || Infinity);
  $('pv-bar').hidden = !settings.showTimestamps || np.paused;
  $('pv-pos').textContent = fmt(pos);
  $('pv-dur').textContent = fmt(np.duration);
  $('pv-fill').style.width = np.duration ? `${(pos / np.duration) * 100}%` : '0%';

  $('pv-button').hidden = !settings.showButton;
  $('pv-button').textContent = t(lang, 'listenOn')[np.source] || t(lang, 'listenOn').youtube;

  $('pv-user').textContent = status?.user || t(lang, 'you');
  const avatar = $('pv-avatar');
  if (status?.avatar && avatar.getAttribute('src') !== status.avatar) avatar.src = status.avatar;
  avatar.hidden = !status?.avatar;
  $('presence').dataset.on = String(Boolean(status?.discord));
  const line = { details: np.title, state: np.artist || site, name: brand }[settings.statusDisplay];
  $('pv-line').textContent = `♫ ${line}`;
  $('pv-line').title = line;

  // General tab: mark the site that is playing right now.
  for (const key of Object.keys(SITES)) {
    const desc = $(`desc-${key}`);
    const playing = live && live.source === key && !live.paused;
    desc.textContent = t(lang, playing ? 'playingNow' : SITE_DESC_KEY[key]);
    desc.classList.toggle('playing', Boolean(playing));
  }
}

// ---------- connection ----------
function renderConnection() {
  const pill = $('conn');
  const hint = $('hint');
  const show = (level, titleKey, bodyKey) => {
    hint.hidden = false;
    hint.dataset.level = level;
    $('hint-title').textContent = t(lang, titleKey);
    $('hint-body').textContent = t(lang, bodyKey);
  };

  // Without a connection the fix matters more than the preview, so the notice takes the card's place.
  document.querySelector('.activity').hidden = Boolean(status === null || (status && !status.discord));
  if (!status) {
    pill.dataset.state = 'bad';
    pill.textContent = t(lang, 'statusNoHelper');
    show('bad', 'noHelperTitle', 'noHelperBody');
  } else if (!status.discord) {
    pill.dataset.state = 'warn';
    pill.textContent = t(lang, 'statusNoDiscord');
    show('warn', 'noDiscordTitle', 'noDiscordBody');
  } else {
    pill.dataset.state = 'ok';
    pill.textContent = t(lang, 'statusOk');
    hint.hidden = true;
  }
}

function render() {
  if (status !== undefined) renderConnection();
  renderPreview();
}

async function poll() {
  try {
    const res = await fetch(`${HELPER}/status`, { cache: 'no-store' });
    status = await res.json();
  } catch {
    status = null;
  }
  render();
}

// ---------- tabs ----------
function selectTab(name) {
  for (const btn of document.querySelectorAll('[role="tab"]')) {
    const on = btn.id === `tab-${name}`;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    $(btn.getAttribute('aria-controls')).hidden = !on;
  }
  document.querySelector('.tabs').dataset.tab = name; // moves the pill
  try { localStorage.setItem('tab', name); } catch {}
}

for (const btn of document.querySelectorAll('[role="tab"]')) {
  btn.addEventListener('click', () => selectTab(btn.id.slice(4)));
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const other = btn.id === 'tab-look' ? 'sites' : 'look';
    selectTab(other);
    $(`tab-${other}`).focus();
  });
}

// ---------- language ----------
for (const btn of document.querySelectorAll('.lang button')) {
  btn.addEventListener('click', async () => {
    settings = { ...settings, lang: btn.dataset.lang };
    lang = resolveLang(settings);
    applyLang();
    render();
    await saveSettings(settings); // background re-sends to the helper, so Discord switches too
  });
}

form.addEventListener('change', async () => {
  settings = readForm();
  renderPreview();
  await saveSettings(settings);
});

(async () => {
  const manifest = chrome.runtime.getManifest();
  if (manifest.homepage_url) {
    $('repo').href = manifest.homepage_url;
    $('repo').hidden = false;
  }
  for (const [key, meta] of Object.entries(SITES)) $(`logo-${key}`).src = meta.logo;

  let tab = 'look';
  try { tab = localStorage.getItem('tab') || 'look'; } catch {}
  selectTab(tab);

  settings = await loadSettings();
  lang = resolveLang(settings);
  applyLang();
  $('conn').textContent = t(lang, 'statusChecking');
  fillForm();
  renderPreview();
  await poll();
  setInterval(poll, 2000);
})();
