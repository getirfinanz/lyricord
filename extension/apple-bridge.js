// Runs in music.apple.com's own page (the content script can't see the page's JavaScript).
// Copies the now-playing song's link and length from Apple's MusicKit player onto <html>, where
// content.js reads them. Nothing is fetched or sent; it only reads what the page already has.
(() => {
  if (window.__musicDiscordBridge) return; // injected again after an extension reload
  window.__musicDiscordBridge = true;
  setInterval(() => {
    let value = '';
    try {
      const item = window.MusicKit?.getInstance?.()?.nowPlayingItem;
      if (item) {
        value = JSON.stringify({
          title: item.title ?? item.attributes?.name ?? '',
          url: item.attributes?.url ?? null,
          duration: Number(item.playbackDuration) / 1000 || 0, // ms in MusicKit
        });
      }
    } catch {
      // MusicKit not ready yet
    }
    const root = document.documentElement;
    if (root.dataset.musicDiscordNow !== value) root.dataset.musicDiscordNow = value;
  }, 1000);
})();
