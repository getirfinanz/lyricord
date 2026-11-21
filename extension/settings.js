// Shared between the background worker and the popup.
export const HELPER = 'http://127.0.0.1:48231';

// Display info per site. Logos are the sites' own icons, loaded by Discord from these URLs.
// Button labels live in i18n.js (listenOn).
export const SITES = {
  youtube:    { name: 'YouTube Music', logo: 'https://music.youtube.com/img/favicon_144.png' },
  soundcloud: { name: 'SoundCloud',    logo: 'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-a62dfc8fe7.png' },
  spotify:    { name: 'Spotify',       logo: 'https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://open.spotify.com&size=128' },
  apple:      { name: 'Apple Music',   logo: 'https://music.apple.com/assets/favicon/favicon-180.png' },
};

// Where people can report a problem or ask for something (General tab). Empty = button hidden.
export const CONTACT = {
  discord: 'https://discord.com/users/1468110996064178338', // fare's Discord profile
  whatsapp: '905312812211',                                 // wa.me number, country code first
  instagram: 'cnglate',                                     // Instagram username
};

export const DEFAULTS = {
  lang: null,                 // null = follow the browser language; otherwise 'tr' or 'en'
  sites: { youtube: true, soundcloud: true, spotify: true, apple: true },
  statusDisplay: 'details',   // 'details' = song title, 'state' = artist, 'name' = app name
  showArt: true,
  showSiteLogo: true,         // small site logo in the corner of the cover art
  showTimestamps: true,
  showButton: true,
  showLyrics: true,           // current lyric line as the third line (from lrclib.net)
  onPause: 'clear',           // 'clear' = remove status, 'show' = keep it with a paused label
};

// Turkish browsers get Turkish, everyone else English, unless the user picked one.
export function resolveLang(settings) {
  if (settings.lang === 'tr' || settings.lang === 'en') return settings.lang;
  return chrome.i18n.getUILanguage().toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

export async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  const s = stored.settings || {};
  return { ...DEFAULTS, ...s, sites: { ...DEFAULTS.sites, ...(s.sites || {}) } };
}

export function saveSettings(settings) {
  return chrome.storage.sync.set({ settings });
}
