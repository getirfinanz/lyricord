// Reads the current track from YouTube Music, SoundCloud, Spotify or Apple Music and reports it every few
// seconds and whenever playback state changes.
(() => {
  const INTERVAL_MS = 5000;
  const q = (s) => document.querySelector(s);

  function safeArt(src) {
    return src && src.startsWith('https://') && src.length <= 256 ? src : null;
  }

  // "1:02:03" / "3:04" -> seconds
  // Absolute https link of an anchor (or of the anchor around/inside an element), without tracking params.
  function linkOf(el) {
    const a = el && (el.closest?.('a[href]') || el.querySelector?.('a[href]'));
    return a && a.href.startsWith('https://') ? a.href.split('?')[0] : null;
  }

  function parseTime(t) {
    if (!t || !/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
    return t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  // ---------- YouTube Music ----------
  // For gapless playback YouTube Music can append the next song to the same <video>, so
  // video.currentTime keeps counting across songs. The player bar's slider always has the position
  // within the current song, but only in whole seconds.
  //  - When the video clock agrees with the slider, the video holds just this song: use the clock.
  //  - Otherwise work out where this song starts on the video clock (`offset`). Every time the
  //    slider ticks to a new second, the song has just crossed that second (YouTube updates it
  //    about every 250 ms), which pins the offset down to a fraction of a second.
  let track = null; // { title, lo, hi }: lo <= offset <= hi

  const ytSlider = () => q('ytmusic-player-bar #progress-bar');

  function narrowOffset(lo, hi, title) {
    if (!track || track.title !== title || lo > track.hi + 0.5 || hi < track.lo - 0.5) {
      track = { title, lo, hi }; // new song or a seek: start over
    } else {
      track.lo = Math.max(track.lo, lo);
      track.hi = Math.max(track.lo, Math.min(track.hi, hi));
    }
  }

  // Called when the slider moves to a new whole second.
  function onSliderTick() {
    const video = q('video');
    const now = Number(ytSlider()?.getAttribute('aria-valuenow'));
    if (!video || !Number.isFinite(now)) return;
    const clock = video.currentTime;
    narrowOffset(clock - now - 0.3, clock - now, navigator.mediaSession?.metadata?.title);
  }

  function ytProgress(video, title) {
    const slider = ytSlider();
    const now = Number(slider?.getAttribute('aria-valuenow'));
    const max = Number(slider?.getAttribute('aria-valuemax'));
    const clock = video.currentTime || 0;
    if (!slider || !(max > 0) || !Number.isFinite(now)) {
      return { position: clock, duration: Number.isFinite(video.duration) ? video.duration : 0 };
    }
    if (clock >= now - 0.5 && clock < now + 1.5) return { position: clock, duration: max };
    // The slider shows floor(position), so the true position is in [now, now + 1).
    narrowOffset(clock - now - 1, clock - now, title);
    const position = Math.min(Math.max(clock - (track.lo + track.hi) / 2, now), now + 1);
    return { position, duration: max };
  }

  function readYouTube() {
    const video = q('video');
    const meta = navigator.mediaSession?.metadata;
    const title = meta?.title || q('ytmusic-player-bar .title')?.textContent?.trim();
    if (!video || !title) return { title: null };

    let art = null;
    if (meta?.artwork?.length) {
      const sorted = [...meta.artwork].sort((a, b) => parseInt(b.sizes) - parseInt(a.sizes));
      art = safeArt(sorted[0].src);
    }
    let id = new URL(location.href).searchParams.get('v');
    if (!id) {
      const link = q('ytmusic-player-bar a.yt-simple-endpoint[href*="watch?v="]');
      id = link ? new URL(link.href).searchParams.get('v') : null;
    }
    const { position, duration } = ytProgress(video, title);
    return {
      source: 'youtube',
      title,
      artist: meta?.artist || q('ytmusic-player-bar .byline a')?.textContent?.trim() || '',
      album: meta?.album || '',
      art,
      url: id ? `https://music.youtube.com/watch?v=${id}` : null,
      artistUrl: linkOf(q('ytmusic-player-bar .byline a[href*="channel/"], ytmusic-player-bar .byline a[href*="browse/"]')),
      position,
      duration,
      paused: video.paused,
    };
  }

  // ---------- SoundCloud / Spotify position ----------
  // Both only show the position as "m:ss" text, i.e. rounded down to whole seconds, which would put
  // lyrics up to a second late. But the moment the text moves on to the next second, the song is at
  // exactly that second; remember when that happened and add the time since.
  const timeText = () => q(isSpotify ? '[data-testid="playback-position"]' : '.playbackTimeline__timePassed > span:nth-child(2)');
  // { sec, at, exact }: the text changed to `sec` at performance.now() === `at`. `exact` when it
  // was the step from the previous second (a seek or the first sighting can land mid-second).
  let tick = null;
  const TEXT_LAG_S = 0.1; // the sites refresh the text a little after the second actually starts

  function onTimeText() {
    const sec = parseTime(timeText()?.textContent?.trim());
    if (sec == null || sec === tick?.sec) return;
    const now = performance.now();
    const step = tick && sec === tick.sec + 1 && now - tick.at < 1600;
    const expected = tick ? tick.sec + (now - tick.at) / 1000 : sec;
    const wasExact = tick?.exact;
    tick = { sec, at: now, exact: Boolean(step) };
    if (Math.abs(sec - expected) > 2) setTimeout(send, 300); // a seek: tell Discord right away
    else if (step && !wasExact) send();                       // first exact second after a seek or start
  }

  function textPosition(sec, paused) {
    if (sec == null) return 0;
    if (paused) { tick = null; return sec; } // the second can't be pinned down again until it ticks
    if (tick?.sec !== sec) return sec + 0.5; // no tick seen: middle of the second is the best guess
    const since = (performance.now() - tick.at) / 1000;
    const pos = tick.exact ? sec + TEXT_LAG_S + since : Math.max(sec + 0.5, sec + since);
    return Math.min(pos, sec + 0.99);
  }

  // ---------- SoundCloud ----------
  // SoundCloud plays through detached audio objects, so everything comes from the player bar.
  function readSoundCloud() {
    const titleLink = q('.playbackSoundBadge__titleLink');
    const title = q('.playbackSoundBadge__titleLink > span:nth-child(2)')?.textContent?.trim()
      || titleLink?.getAttribute('title');
    if (!titleLink || !title) return { title: null };

    const passed = parseTime(q('.playbackTimeline__timePassed > span:nth-child(2)')?.textContent?.trim());
    let durText = q('.playbackTimeline__duration > span:nth-child(2)')?.textContent?.trim() || '';
    let duration = durText.startsWith('-')                // "remaining time" display mode
      ? (parseTime(durText.slice(1)) ?? 0) + (passed ?? 0)
      : parseTime(durText) ?? 0;

    const bg = q('.playbackSoundBadge__avatar.sc-media-image > div > span')?.style?.backgroundImage;
    // The player bar uses a small thumbnail (t50x50 / t120x120); ask for the 500px version.
    const art = bg?.match(/"(.*)"/)?.[1]?.replace(/-t\d+x\d+\./, '-t500x500.');
    const paused = !q('.playControls__play.playing');

    return {
      source: 'soundcloud',
      title,
      artist: q('.playbackSoundBadge__lightLink')?.textContent?.trim() || '',
      album: '',
      art: safeArt(art),
      url: titleLink.href ? titleLink.href.split('?')[0] : null,
      artistUrl: linkOf(q('.playbackSoundBadge__lightLink')),
      position: textPosition(passed, paused),
      duration,
      paused,
    };
  }

  // ---------- Spotify (web player) ----------
  function readSpotify() {
    const titleEl = q('[data-testid="context-item-link"], [data-testid="nowplaying-track-link"]');
    const title = titleEl?.textContent?.trim();
    if (!title) return { title: null };

    const coverLink = q('a[data-testid="cover-art-link"], a[data-testid="context-link"]');
    const isPodcast = coverLink && /\/(?:show|episode)\//.test(coverLink.href);
    const artistEl = q(isPodcast
      ? '[data-testid="context-item-info-show"], [data-testid="track-info-artists"]'
      : '[data-testid="context-item-info-artist"], [data-testid="track-info-artists"]');
    const artist = artistEl?.textContent?.trim() || '';

    // The play/pause label is localized ("Pause", "Duraklat", ...), so prefer the Media Session state.
    let paused;
    const ps = navigator.mediaSession?.playbackState;
    if (ps === 'playing' || ps === 'paused') paused = ps === 'paused';
    else paused = !/pause|duraklat/i.test(q('[data-testid="control-button-playpause"]')?.getAttribute('aria-label') || '');

    const href = (titleEl.closest('a') || titleEl).href || coverLink?.href || null;
    return {
      source: 'spotify',
      title,
      artist,
      album: navigator.mediaSession?.metadata?.album || '',
      art: safeArt(coverLink?.querySelector('img')?.src),
      url: href ? href.split('?')[0] : null,
      artistUrl: linkOf(artistEl),
      position: textPosition(parseTime(q('[data-testid="playback-position"]')?.textContent?.trim()), paused),
      duration: parseTime(q('[data-testid="playback-duration"]')?.textContent?.trim()) ?? 0,
      paused,
    };
  }

  // ---------- Apple Music (web player) ----------
  // Plays through one <audio>, so the position is exact. Title, artist and cover come from the
  // Media Session; the song link and full length from apple-bridge.js (Apple's own player object).
  const appleAudio = () => q('audio#apple-music-player');

  function appleNow() {
    try {
      return JSON.parse(document.documentElement.dataset.musicDiscordNow || 'null');
    } catch {
      return null;
    }
  }

  // Apple's player has no artist link, but the page often does (album, song and artist pages).
  function appleArtistUrl(artist) {
    if (!artist) return null;
    const a = [...document.querySelectorAll('a[href*="/artist/"]')].find(el => el.textContent.trim() === artist);
    return a?.href.startsWith('https://music.apple.com/') ? a.href.split('?')[0] : null;
  }

  function readAppleMusic() {
    const audio = appleAudio();
    const meta = navigator.mediaSession?.metadata;
    if (!audio || !meta?.title || !audio.currentSrc) return { title: null };

    let art = null;
    if (meta.artwork?.length) {
      const sorted = [...meta.artwork].sort((a, b) => parseInt(b.sizes) - parseInt(a.sizes));
      art = safeArt(sorted[0].src);
    }
    // The bridge refreshes once a second, so right after a song change it can still describe the
    // previous song; only trust it when the titles agree.
    const bridged = appleNow();
    const now = bridged?.title === meta.title ? bridged : null;
    let url = null;
    if (typeof now?.url === 'string' && now.url.startsWith('https://music.apple.com/')) {
      const u = new URL(now.url);
      const song = u.searchParams.get('i'); // album link + ?i=<song id> opens that song
      url = u.origin + u.pathname + (song ? `?i=${song}` : '');
    }
    // Signed out, Apple only plays a short preview clip: use the clip's own length then.
    const preview = /AudioPreview/i.test(audio.currentSrc);
    const duration = !preview && now?.duration > 0 ? now.duration : Number.isFinite(audio.duration) ? audio.duration : 0;
    return {
      source: 'apple',
      title: meta.title,
      artist: meta.artist || '',
      album: meta.album || '',
      art,
      url,
      artistUrl: appleArtistUrl(meta.artist),
      position: audio.currentTime || 0,
      duration,
      paused: audio.paused,
    };
  }

  const host = location.hostname;
  const isSoundCloud = host.endsWith('soundcloud.com');
  const isSpotify = host === 'open.spotify.com';
  const isApple = host === 'music.apple.com';
  const read = isApple ? readAppleMusic : isSpotify ? readSpotify : isSoundCloud ? readSoundCloud : readYouTube;

  function send() {
    try {
      chrome.runtime.sendMessage({ type: 'np', data: read() }).catch(() => {});
    } catch {
      // extension was reloaded; this old content script is orphaned
      clearInterval(timer);
      clearInterval(hookTimer);
      observer?.disconnect();
      timeObserver?.disconnect();
    }
  }

  const timer = setInterval(send, INTERVAL_MS);
  let hookTimer = null;
  let observer = null;
  let timeObserver = null;

  if (isSoundCloud || isSpotify) {
    // Watch the position text tick (the element can be replaced, so check it every second).
    let watchedTime = null;
    timeObserver = new MutationObserver(onTimeText);
    hookTimer = setInterval(() => {
      const el = timeText();
      if (el && el !== watchedTime) {
        watchedTime = el;
        timeObserver.disconnect();
        timeObserver.observe(el, { childList: true, characterData: true, subtree: true });
      }
    }, 1000);
    // These players don't expose a <video>; react to play/pause and track changes in the player bar.
    const signature = isSpotify
      ? () => `${q('[data-testid="control-button-playpause"]')?.getAttribute('aria-label')}|${q('[data-testid="context-item-link"], [data-testid="nowplaying-track-link"]')?.textContent}`
      : () => `${q('.playControls__play')?.classList.contains('playing')}|${q('.playbackSoundBadge__titleLink')?.href}`;
    let last = '';
    observer = new MutationObserver(() => {
      const sig = signature();
      if (sig !== last) { last = sig; setTimeout(send, 300); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'href', 'aria-label'] });
  } else {
    // React immediately to play / pause / seek / track change. Gapless song changes fire no video
    // event, so also watch the song title.
    // Apple Music works the same way with its <audio>, minus the gapless slider fix-up.
    let hooked = null;
    let lastTitle = null;
    let watchedSlider = null;
    if (!isApple) observer = new MutationObserver(onSliderTick);
    hookTimer = setInterval(() => {
      const slider = !isApple && ytSlider();
      if (slider && slider !== watchedSlider) {
        watchedSlider = slider;
        observer.disconnect();
        observer.observe(slider, { attributes: true, attributeFilter: ['aria-valuenow'] });
      }
      const video = isApple ? appleAudio() : q('video');
      if (video && video !== hooked) {
        hooked = video;
        for (const ev of ['play', 'pause', 'seeked', 'loadedmetadata']) {
          video.addEventListener(ev, () => setTimeout(send, 300));
        }
      }
      const title = navigator.mediaSession?.metadata?.title;
      if (title && title !== lastTitle) {
        if (lastTitle !== null) setTimeout(send, isApple ? 1200 : 500); // let the player bar (or apple-bridge.js) catch up first
        lastTitle = title;
      }
    }, 1000);
  }

  send();
})();
