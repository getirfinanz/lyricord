// Collects reports from every YouTube Music / SoundCloud / Spotify / Apple Music tab or app window and forwards a
// single "winner" (plus the user's settings) to the local helper, so a paused tab can't
// wipe the status of the one that is actually playing.
import { HELPER, loadSettings, resolveLang } from './settings.js';
import { t } from './i18n.js';

const STALE_MS = 15000;
const WARN_AFTER_MS = 8000; // a quick helper restart or Discord reconnect stays silent
const reports = new Map(); // tabId -> { data, at }
let currentTab = null;

function pickWinner(settings) {
  const now = Date.now();
  for (const [id, r] of reports) {
    if (now - r.at > STALE_MS) reports.delete(id);
  }
  const usable = r => r && r.data && r.data.title && settings.sites[r.data.source] !== false;
  const playing = r => usable(r) && !r.data.paused;

  // Stick with the tab we already show while it keeps playing (avoids flip-flopping).
  if (playing(reports.get(currentTab))) return reports.get(currentTab).data;

  let best = null, bestId = null;
  for (const [id, r] of reports) {
    if (playing(r) && (!best || r.at > best.at)) { best = r; bestId = id; }
  }
  if (best) { currentTab = bestId; return best.data; }

  // Nothing playing: optionally keep showing the paused track.
  if (settings.onPause === 'show') {
    if (usable(reports.get(currentTab))) return reports.get(currentTab).data;
    for (const [id, r] of reports) {
      if (usable(r) && (!best || r.at > best.at)) { best = r; bestId = id; }
    }
    if (best) { currentTab = bestId; return best.data; }
  }
  currentTab = null;
  return { title: null };
}

async function forward() {
  const settings = await loadSettings();
  const lang = resolveLang(settings);
  const data = { ...pickWinner(settings), prefs: { ...settings, lang } };
  let state = 'ok';
  try {
    const res = await fetch(`${HELPER}/np`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.status === 200 && (await res.json()).discord === false) state = 'noDiscord';
  } catch {
    state = 'noHelper';
  }
  await updateHealth(state, Boolean(data.title), lang);
}

// ---------- connection warning ----------
// While something is wrong: a "!" badge on the toolbar icon (red = helper off, yellow = Discord
// not connected). If it breaks while a song is playing, also one notification until it works again.
// Kept in session storage because the worker sleeps between reports.
const BADGE = { noHelper: '#F23F43', noDiscord: '#F0B232' };
const KEYS = {
  noHelper: ['statusNoHelper', 'notifyNoHelperTitle', 'notifyNoHelperBody'],
  noDiscord: ['statusNoDiscord', 'notifyNoDiscordTitle', 'notifyNoDiscordBody'],
};

async function updateHealth(state, listening, lang) {
  const { health } = await chrome.storage.session.get('health');
  const prev = health || { state: 'ok', since: 0, notified: false };

  if (state === 'ok') {
    if (prev.state === 'ok') return;
    await chrome.storage.session.set({ health: { state: 'ok', since: 0, notified: false } });
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: t(lang, 'appName') });
    chrome.notifications.clear('health');
    return;
  }

  const since = prev.state === 'ok' ? Date.now() : prev.since;
  const next = { state, since, notified: prev.notified };
  if (Date.now() - since >= WARN_AFTER_MS) {
    const [status, title, body] = KEYS[state];
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: BADGE[state] });
    chrome.action.setTitle({ title: `${t(lang, 'appName')}: ${t(lang, status)}` });
    if (listening && !prev.notified) {
      next.notified = true; // once per outage, even if it turns from "helper off" into "no Discord"
      chrome.notifications.create('health', {
        type: 'basic', iconUrl: 'icons/icon128.png', priority: 1,
        title: t(lang, title), message: t(lang, body),
      });
    }
  }
  await chrome.storage.session.set({ health: next });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id !== 'health') return;
  chrome.notifications.clear(id);
  chrome.action.openPopup?.().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'np') return;
  reports.set(sender.tab?.id ?? -1, { data: msg.data, at: Date.now() });
  forward();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (reports.delete(tabId)) forward();
});

// Apply setting changes right away instead of waiting for the next 5 s report.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) forward();
});

// Chrome doesn't inject content scripts into pages that were already open when the
// extension was installed/reloaded (e.g. an installed YouTube Music app window), so do it here.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['https://music.youtube.com/*', 'https://soundcloud.com/*', 'https://open.spotify.com/*', 'https://music.apple.com/*'] });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    if (tab.url?.startsWith('https://music.apple.com/')) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['apple-bridge.js'], world: 'MAIN' }).catch(() => {});
    }
  }
});
