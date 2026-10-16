/* Encore – udgivelser og koncerter fra kunstnerne i dit bibliotek */
(() => {
'use strict';

const CFG = Object.assign({
  appleTokenEndpoint: '', appleDeveloperToken: '',
  spotifyClientId: '', spotifyRedirectUri: '',
  ticketmasterProxy: '', ticketmasterApiKey: '',
  countries: ['DK', 'SE', 'DE'], storefront: 'dk', demoOnly: false,
}, window.ENCORE_CONFIG || {});

const COUNTRY = { DK: 'Danmark', SE: 'Sverige', DE: 'Tyskland', NO: 'Norge', FI: 'Finland', NL: 'Holland' };
const DAY = 864e5;
const TTL_ARTISTS = 24 * 3600e3;
const TTL_RELEASES = 12 * 3600e3;
const TTL_CONCERTS = 6 * 3600e3;
const PAGE = 150;

/* ---------- Lager (localStorage, tåler at være slået fra) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('encore:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('encore:' + k, JSON.stringify(v)); } catch { /* fuld eller blokeret */ } },
  del(k) { try { localStorage.removeItem('encore:' + k); } catch {} },
  clearCache() {
    try {
      Object.keys(localStorage).filter(k => k.startsWith('encore:c:')).forEach(k => localStorage.removeItem(k));
    } catch {}
  },
};
const cache = {
  get(k, ttl) { const c = store.get('c:' + k); return c && Date.now() - c.t < ttl ? c.v : null; },
  set(k, v) { store.set('c:' + k, { t: Date.now(), v }); },
};

/* ---------- Hjælpere ---------- */
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/^the\s+/, '').replace(/&/g, ' and ').replace(/[^a-z0-9æøß]+/g, ' ').trim();
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 360; };
const initials = s => String(s || '?').replace(/^the\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const randStr = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join(''); };
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function isoDay(d) { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
const TODAY = isoDay(new Date());
function parseDay(s) {
  const [y, m = 1, d = 1] = String(s || '').slice(0, 10).split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1, 12);
}
function daysFromToday(s) { return Math.round((parseDay(s) - parseDay(TODAY)) / DAY); }
const fmt = {
  day: new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'short', year: 'numeric' }),
  monthYear: new Intl.DateTimeFormat('da-DK', { month: 'long', year: 'numeric' }),
  wd: new Intl.DateTimeFormat('da-DK', { weekday: 'short' }),
  mon: new Intl.DateTimeFormat('da-DK', { month: 'short' }),
  time: new Intl.DateTimeFormat('da-DK', { hour: '2-digit', minute: '2-digit' }),
};
function releaseDateLabel(r) {
  if (r.precision === 'year') return r.date.slice(0, 4);
  if (r.precision === 'month') return fmt.monthYear.format(parseDay(r.date));
  return fmt.day.format(parseDay(r.date));
}
function relTime(r) {
  const n = daysFromToday(r.date);
  if (n === 0) return 'I dag';
  if (n === 1) return 'I morgen';
  if (n === -1) return 'I går';
  if (n > 1 && n < 60) return `Om ${n} dage`;
  if (n < -1 && n > -45) return `${-n} dage siden`;
  return releaseDateLabel(r);
}

function rateLimiter(ms) {
  let last = 0, chain = Promise.resolve();
  return fn => {
    const slot = chain.then(async () => {
      const wait = last + ms - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    chain = slot.catch(() => {});
    return slot.then(fn);
  };
}
async function pool(items, size, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Kunne ikke hente ' + src));
    document.head.appendChild(s);
  });
}
function jsonp(url, timeout = 15000) {
  return new Promise((res, rej) => {
    const cb = '__encore' + randStr(10);
    const s = document.createElement('script');
    const done = () => { clearTimeout(t); delete window[cb]; s.remove(); };
    const t = setTimeout(() => { done(); rej(new Error('Opslaget tog for lang tid')); }, timeout);
    window[cb] = d => { done(); res(d); };
    s.onerror = () => { done(); rej(new Error('Netværksfejl')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}
class SetupError extends Error {}

function releaseType(name, tracks, hint) {
  const n = String(name || '');
  if (/\s[-–]\s?EP$|\(EP\)$|\bEP$/i.test(n)) return 'EP';
  if (/\s[-–]\s?Single$/i.test(n)) return 'Single';
  if (hint === 'single') return tracks >= 4 ? 'EP' : 'Single';
  if (hint === 'compilation') return 'Opsamling';
  if (tracks && tracks <= 3) return 'Single';
  if (tracks && tracks <= 6) return 'EP';
  return 'Album';
}
const cleanTitle = t => String(t || '').replace(/\s[-–]\s?(Single|EP)$/i, '');
function dedupeReleases(list) {
  const m = new Map();
  for (const r of list) {
    const k = norm(r.title) + '|' + r.type;
    const cur = m.get(k);
    if (!cur || r.date < cur.date) m.set(k, r);
  }
  return [...m.values()];
}

/* ---------- Tilstand ---------- */
const state = {
  tab: store.get('tab', 'releases'),
  sources: store.get('sources', { apple: false, spotify: false }),
  manual: store.get('manual', []),
  hidden: new Set(store.get('hidden', [])),
  artists: store.get('artists', []),
  artistsAt: store.get('artistsAt', 0),
  rel: {}, ev: {},
  demo: CFG.demoOnly || store.get('demo', false),
  busy: false,
  progress: null,
  updatedAt: store.get('updatedAt', 0),
  notices: [],
  concertsBlocked: '',
  f: Object.assign({ period: 'all', type: 'all', countries: CFG.countries.slice(), qr: '', qc: '', qa: '' }, store.get('filters', {})),
  limit: PAGE,
};
state.f.countries = state.f.countries.filter(c => CFG.countries.includes(c));
if (!state.f.countries.length) state.f.countries = CFG.countries.slice();
const saveFilters = () => store.set('filters', { period: state.f.period, type: state.f.type, countries: state.f.countries });
const notice = (msg, kind = 'error') => { if (!state.notices.some(n => n.msg === msg)) state.notices.push({ msg, kind }); };

/* ---------- Apple Music (MusicKit JS) ---------- */
const Apple = {
  configured: () => !!(CFG.appleDeveloperToken || CFG.appleTokenEndpoint),
  mk: null,
  async token() {
    if (CFG.appleDeveloperToken) return CFG.appleDeveloperToken;
    if (!CFG.appleTokenEndpoint) throw new SetupError('Apple Music er ikke sat op i denne app endnu.');
    let r;
    try { r = await fetch(CFG.appleTokenEndpoint); } catch { throw new SetupError('Kunne ikke hente adgangsnøgle til Apple Music.'); }
    if (!r.ok) throw new SetupError('Apple Music er ikke sat op i denne app endnu.');
    return (await r.json()).token;
  },
  async instance() {
    if (this.mk) return this.mk;
    const developerToken = await this.token();
    if (!window.MusicKit) {
      const ready = new Promise(res => document.addEventListener('musickitloaded', res, { once: true }));
      await loadScript('https://js-cdn.music.apple.com/musickit/v3/musickit.js');
      if (!window.MusicKit) await ready;
    }
    await MusicKit.configure({ developerToken, app: { name: 'Encore', build: '1.0.0' } });
    this.mk = MusicKit.getInstance();
    return this.mk;
  },
  async connect() { const mk = await this.instance(); await mk.authorize(); return mk.isAuthorized; },
  async disconnect() { try { const mk = await this.instance(); await mk.unauthorize(); } catch {} },
  sf(mk) { return mk.storefrontId || CFG.storefront; },
  async artists() {
    const mk = await this.instance();
    if (!mk.isAuthorized) await mk.authorize();
    const out = [];
    for (let page = 0; page < 60; page++) {
      const r = await mk.api.music('/v1/me/library/artists', { limit: 100, offset: page * 100, include: 'catalog' });
      const d = r.data || {};
      for (const a of d.data || []) {
        const cat = a.relationships?.catalog?.data?.[0];
        const art = cat?.attributes?.artwork?.url;
        out.push({
          name: a.attributes?.name || cat?.attributes?.name, source: 'apple', appleId: cat?.id || null,
          image: art ? art.replace('{w}', '160').replace('{h}', '160') : '',
        });
      }
      setProgress(null, null, `Fandt ${out.length} kunstnere i Apple Music …`);
      if (!d.next || (d.data || []).length < 100) break;
    }
    return out;
  },
  async releases(a) {
    const mk = await this.instance();
    const out = [];
    for (let page = 0; page < 8; page++) {
      const r = await mk.api.music(`/v1/catalog/${this.sf(mk)}/artists/${a.appleId}/albums`, { limit: 25, offset: page * 25 });
      const d = r.data || {};
      for (const al of d.data || []) {
        const at = al.attributes || {};
        if (!at.releaseDate) continue;
        out.push({
          id: 'am' + al.id, title: cleanTitle(at.name), artist: at.artistName || a.name, artistKey: a.key,
          date: at.releaseDate, precision: at.releaseDate.length === 4 ? 'year' : 'day',
          type: at.isSingle ? releaseType(at.name, at.trackCount, 'single') : at.isCompilation ? 'Opsamling' : releaseType(at.name, at.trackCount),
          cover: at.artwork?.url ? at.artwork.url.replace('{w}', '300').replace('{h}', '300') : '',
          url: at.url || '', source: 'apple',
        });
      }
      if (!d.next || (d.data || []).length < 25) break;
    }
    return out;
  },
};

/* ---------- Spotify (OAuth med PKCE, ingen server nødvendig) ---------- */
const Spotify = {
  configured: () => !!CFG.spotifyClientId,
  redirect: () => CFG.spotifyRedirectUri || (location.origin + location.pathname),
  async connect() {
    if (!this.configured()) throw new SetupError('Spotify er ikke sat op i denne app endnu.');
    const verifier = randStr(64);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const st = randStr(16);
    store.set('sp_pkce', { verifier, st });
    const p = new URLSearchParams({
      client_id: CFG.spotifyClientId, response_type: 'code', redirect_uri: this.redirect(),
      scope: 'user-follow-read user-library-read user-top-read', code_challenge_method: 'S256',
      code_challenge: challenge, state: st,
    });
    location.assign('https://accounts.spotify.com/authorize?' + p);
  },
  async handleCallback() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code'), err = q.get('error');
    if (!code && !err) return false;
    history.replaceState(null, '', location.pathname);
    const pk = store.get('sp_pkce');
    store.del('sp_pkce');
    if (err || !pk || pk.st !== q.get('state')) { notice('Forbindelsen til Spotify blev ikke gennemført. Prøv igen.'); return true; }
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirect(), client_id: CFG.spotifyClientId, code_verifier: pk.verifier }),
    });
    if (!r.ok) { notice('Spotify afviste login. Er din konto tilføjet som bruger af appen?'); return true; }
    this.save(await r.json());
    state.sources.spotify = true; store.set('sources', state.sources);
    state.demo = false; store.set('demo', false);
    state.artistsAt = 0;
    return true;
  },
  save(t) {
    const old = store.get('sp_token', {});
    store.set('sp_token', { access_token: t.access_token, refresh_token: t.refresh_token || old.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000 });
  },
  async refresh() {
    const t = store.get('sp_token');
    if (!t?.refresh_token) throw new SetupError('Log ind med Spotify igen.');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CFG.spotifyClientId }),
    });
    if (!r.ok) { store.del('sp_token'); throw new SetupError('Din Spotify-forbindelse er udløbet. Forbind igen under Konto.'); }
    this.save(await r.json());
  },
  async token() {
    const t = store.get('sp_token');
    if (!t) throw new SetupError('Spotify er ikke forbundet.');
    if (Date.now() > t.expires_at - 60e3) await this.refresh();
    return store.get('sp_token').access_token;
  },
  limit: rateLimiter(120),
  async api(url, retry = 2) {
    const full = url.startsWith('http') ? url : 'https://api.spotify.com/v1' + url;
    const r = await this.limit(async () => fetch(full, { headers: { Authorization: 'Bearer ' + await this.token() } }));
    if (r.status === 429 && retry) { await sleep((Number(r.headers.get('Retry-After')) || 2) * 1000); return this.api(url, retry - 1); }
    if (r.status === 401 && retry) { await this.refresh(); return this.api(url, retry - 1); }
    if (r.status === 403) throw new SetupError('Spotify gav ikke adgang. Appens ejer skal tilføje din konto som bruger.');
    if (!r.ok) throw new Error('Spotify svarede ' + r.status);
    return r.json();
  },
  async artists() {
    const out = [];
    const add = (a, why) => a && out.push({
      name: a.name, source: 'spotify', spotifyId: a.id,
      image: (a.images || []).slice(-2)[0]?.url || '',
      why,
    });
    let next = '/me/following?type=artist&limit=50';
    for (let i = 0; next && i < 40; i++) {
      const d = await this.api(next);
      d.artists.items.forEach(a => add(a, 'følger'));
      next = d.artists.next;
      setProgress(null, null, `Fandt ${out.length} kunstnere på Spotify …`);
    }
    for (const range of ['long_term', 'medium_term', 'short_term']) {
      try { (await this.api(`/me/top/artists?limit=50&time_range=${range}`)).items.forEach(a => add(a, 'top')); } catch (e) { if (e instanceof SetupError) throw e; }
    }
    for (const path of ['/me/albums?limit=50', '/me/tracks?limit=50']) {
      let n = path;
      for (let i = 0; n && i < 10; i++) {
        const d = await this.api(n);
        for (const it of d.items || []) {
          const src = it.album || it.track;
          (src?.artists || []).slice(0, 1).forEach(a => add(a, 'gemt'));
        }
        n = d.next;
        setProgress(null, null, `Gennemgår dit Spotify-bibliotek … ${out.length}`);
      }
    }
    return out;
  },
  async releases(a) {
    const out = [];
    let next = `/artists/${a.spotifyId}/albums?include_groups=album,single&limit=50&market=from_token`;
    for (let i = 0; next && i < 6; i++) {
      const d = await this.api(next);
      for (const al of d.items || []) {
        out.push({
          id: 'sp' + al.id, title: al.name, artist: (al.artists || []).map(x => x.name).join(', ') || a.name, artistKey: a.key,
          date: al.release_date, precision: al.release_date_precision || 'day',
          type: releaseType(al.name, al.total_tracks, al.album_type),
          cover: (al.images || []).find(im => im.width && im.width <= 320)?.url || al.images?.[0]?.url || '',
          url: al.external_urls?.spotify || '', source: 'spotify',
        });
      }
      next = d.next;
    }
    return out;
  },
};

/* ---------- iTunes-søgning (uden login, til manuelle kunstnere) ---------- */
const ITunes = {
  limit: rateLimiter(2600), // Apple tillader ca. 20 opslag i minuttet
  base: 'https://itunes.apple.com/',
  async artistId(name) {
    const map = store.get('itunesIds', {});
    const k = norm(name);
    if (k in map) return map[k];
    const d = await this.limit(() => jsonp(`${this.base}search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=10&country=${CFG.storefront}`));
    const hit = (d.results || []).find(r => norm(r.artistName) === k) || null;
    map[k] = hit ? hit.artistId : null;
    store.set('itunesIds', map);
    return map[k];
  },
  async releases(a) {
    const id = a.appleId || await this.artistId(a.name);
    if (!id) return [];
    const d = await this.limit(() => jsonp(`${this.base}lookup?id=${id}&entity=album&limit=200&sort=recent&country=${CFG.storefront}`));
    return (d.results || []).filter(r => r.wrapperType === 'collection' && r.releaseDate).map(r => ({
      id: 'it' + r.collectionId, title: cleanTitle(r.collectionName), artist: r.artistName, artistKey: a.key,
      date: r.releaseDate.slice(0, 10), precision: 'day',
      type: releaseType(r.collectionName, r.trackCount, r.collectionType === 'Compilation' ? 'compilation' : ''),
      cover: (r.artworkUrl100 || '').replace('100x100', '300x300'), url: r.collectionViewUrl || '', source: 'itunes',
    }));
  },
};

/* ---------- Ticketmaster Discovery API (koncerter) ---------- */
const TM = {
  configured: () => !!(CFG.ticketmasterProxy || CFG.ticketmasterApiKey),
  limit: rateLimiter(230),
  async get(path, params, retry = 2) {
    let url;
    if (CFG.ticketmasterApiKey) {
      url = new URL('https://app.ticketmaster.com/discovery/v2/' + path);
      url.searchParams.set('apikey', CFG.ticketmasterApiKey);
    } else {
      url = new URL(CFG.ticketmasterProxy, location.href);
      url.searchParams.set('path', path);
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let r;
    try { r = await this.limit(() => fetch(url)); } catch { throw new Error('Kunne ikke kontakte Ticketmaster'); }
    if (r.status === 429 && retry) { await sleep(1500); return this.get(path, params, retry - 1); }
    if (r.status === 501) throw new SetupError('Serveren har ikke fået Ticketmaster-nøglen. Tjek at TICKETMASTER_API_KEY står i Vercel for "Production", og lav en Redeploy.');
    if (r.status === 404 && !CFG.ticketmasterApiKey) throw new SetupError('Serverfunktionen til koncerter (/api/tm) blev ikke fundet. Ligger appen på Vercel?');
    if (r.status === 401 || r.status === 403) throw new SetupError('Ticketmaster afviste nøglen. Tjek at det er "Consumer Key" (ikke Secret), kopieret helt uden ekstra tegn.');
    if (!r.ok) throw new Error('Ticketmaster svarede ' + r.status);
    return r.json();
  },
  async attraction(name) {
    const map = store.get('tmIds', {});
    const k = norm(name);
    if (k in map) return map[k];
    const d = await this.get('attractions.json', { keyword: name, classificationName: 'music', size: 20 });
    const list = d._embedded?.attractions || [];
    const hit = list.filter(x => norm(x.name) === k)
      .sort((x, y) => (y.upcomingEvents?._total || 0) - (x.upcomingEvents?._total || 0))[0];
    map[k] = hit ? hit.id : null;
    store.set('tmIds', map);
    return map[k];
  },
  async events(a) {
    const id = await this.attraction(a.name);
    if (!id) return [];
    const d = await this.get('events.json', { attractionId: id, size: 200, sort: 'date,asc' });
    return (d._embedded?.events || []).map(e => {
      const v = e._embedded?.venues?.[0] || {};
      return {
        id: 'tm' + e.id, artist: a.name, artistKey: a.key, name: e.name,
        date: e.dates?.start?.localDate || '', time: e.dates?.start?.timeTBA ? '' : (e.dates?.start?.localTime || '').slice(0, 5),
        venue: v.name || '', city: v.city?.name || '', country: v.country?.countryCode || '',
        status: e.dates?.status?.code || 'onsale', url: e.url || '', source: 'ticketmaster',
      };
    }).filter(e => e.date && CFG.countries.includes(e.country) && daysFromToday(e.date) >= 0);
  },
};

/* ---------- Kunstnere ---------- */
function mergeArtists(lists) {
  const m = new Map();
  for (const list of lists) for (const a of list) {
    const k = norm(a.name);
    if (!k) continue;
    const cur = m.get(k) || { key: k, name: a.name, sources: [], appleId: null, spotifyId: null, image: '' };
    if (!cur.appleId && a.appleId) cur.appleId = a.appleId;
    if (!cur.spotifyId && a.spotifyId) cur.spotifyId = a.spotifyId;
    if (!cur.image && a.image) cur.image = a.image;
    if (!cur.sources.includes(a.source)) cur.sources.push(a.source);
    m.set(k, cur);
  }
  return [...m.values()].sort((x, y) => x.name.localeCompare(y.name, 'da'));
}
const manualArtists = () => state.manual.map(name => ({ name, source: 'manual' }));
const hasSources = () => state.sources.apple || state.sources.spotify || state.manual.length > 0;
const visibleArtists = () => state.artists.filter(a => !state.hidden.has(a.key));

async function syncArtists(force) {
  const lists = [manualArtists()];
  const fresh = !force && Date.now() - state.artistsAt < TTL_ARTISTS;
  const prev = state.artists;
  if (state.sources.apple) {
    try { lists.push(fresh ? prev.filter(a => a.sources.includes('apple')).map(a => ({ ...a, source: 'apple' })) : await Apple.artists()); }
    catch (e) { notice('Apple Music: ' + e.message); lists.push(prev.filter(a => a.sources.includes('apple')).map(a => ({ ...a, source: 'apple' }))); }
  }
  if (state.sources.spotify) {
    try { lists.push(fresh ? prev.filter(a => a.sources.includes('spotify')).map(a => ({ ...a, source: 'spotify' })) : await Spotify.artists()); }
    catch (e) { notice('Spotify: ' + e.message); lists.push(prev.filter(a => a.sources.includes('spotify')).map(a => ({ ...a, source: 'spotify' }))); }
  }
  state.artists = mergeArtists(lists);
  if (!fresh) { state.artistsAt = Date.now(); store.set('artistsAt', state.artistsAt); }
  store.set('artists', state.artists);
}

async function releasesFor(a, force) {
  const ck = 'rel:' + a.key;
  if (!force) { const c = cache.get(ck, TTL_RELEASES); if (c) return c; }
  let list;
  if (a.spotifyId && state.sources.spotify) list = await Spotify.releases(a);
  else if (a.appleId && state.sources.apple) list = await Apple.releases(a);
  else list = await ITunes.releases(a);
  list = dedupeReleases(list).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 80);
  cache.set(ck, list);
  return list;
}
async function concertsFor(a, force) {
  const ck = 'ev:' + a.key;
  if (!force) { const c = cache.get(ck, TTL_CONCERTS); if (c) return c; }
  const list = await TM.events(a);
  cache.set(ck, list);
  return list;
}

/* ---------- Opdatering ---------- */
let renderTimer = 0;
function scheduleRender() { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; update(); }, 350); }
function setProgress(done, total, label) {
  state.progress = Object.assign(state.progress || {}, label != null ? { label } : {}, done != null ? { done } : {}, total != null ? { total } : {});
  renderTop();
}

function loadFromCache() {
  for (const a of state.artists) {
    const r = store.get('c:rel:' + a.key); if (r) state.rel[a.key] = r.v;
    const e = store.get('c:ev:' + a.key); if (e) state.ev[a.key] = e.v;
  }
}

async function refreshAll(force = false) {
  if (state.demo) { loadDemo(); render(); return; }
  if (state.busy || !hasSources()) return;
  state.busy = true; state.notices = []; state.concertsBlocked = '';
  setProgress(0, 0, 'Henter dine kunstnere …');
  try {
    await syncArtists(force);
    loadFromCache();
    render();
    const list = visibleArtists();
    const doConcerts = TM.configured();
    if (!doConcerts) state.concertsBlocked = 'Koncerter er ikke sat op i denne app endnu (mangler Ticketmaster-nøgle).';
    let done = 0;
    const total = list.length * (doConcerts ? 2 : 1);
    const tick = () => { done++; setProgress(done, total, `Opdaterer ${list.length} kunstnere …`); scheduleRender(); };
    setProgress(0, total, `Opdaterer ${list.length} kunstnere …`);
    await Promise.all([
      pool(list, 3, async a => {
        try { state.rel[a.key] = await releasesFor(a, force); }
        catch (e) { if (e instanceof SetupError) notice(e.message); }
        tick();
      }),
      doConcerts && pool(list, 2, async a => {
        if (!state.concertsBlocked) {
          try { state.ev[a.key] = await concertsFor(a, force); }
          catch (e) { if (e instanceof SetupError) state.concertsBlocked = e.message; }
        }
        tick();
      }),
    ]);
    state.updatedAt = Date.now(); store.set('updatedAt', state.updatedAt);
  } catch (e) {
    notice(e.message || 'Noget gik galt under opdateringen.');
  } finally {
    state.busy = false; state.progress = null;
    render();
  }
}

/* ---------- Udledte lister ---------- */
function allReleases() {
  const vis = new Set(visibleArtists().map(a => a.key));
  const seen = new Set(), out = [];
  for (const [k, list] of Object.entries(state.rel)) {
    if (!vis.has(k)) continue;
    for (const r of list) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } }
  }
  return out.sort((x, y) => y.date.localeCompare(x.date));
}
function filteredReleases() {
  const { period, type, qr } = state.f;
  const q = norm(qr);
  return allReleases().filter(r => {
    const d = daysFromToday(r.date);
    if (period === 'upcoming' && d <= 0) return false;
    if (period !== 'all' && period !== 'upcoming' && (d > 0 || d < -Number(period))) return false;
    if (type !== 'all' && (type === 'Single' ? !['Single', 'EP'].includes(r.type) : r.type !== type)) return false;
    if (q && !norm(r.title + ' ' + r.artist).includes(q)) return false;
    return true;
  });
}
function allConcerts() {
  const vis = new Set(visibleArtists().map(a => a.key));
  const seen = new Set(), out = [];
  for (const [k, list] of Object.entries(state.ev)) {
    if (!vis.has(k)) continue;
    for (const e of list) { if (!seen.has(e.id) && daysFromToday(e.date) >= 0) { seen.add(e.id); out.push(e); } }
  }
  return out.sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
}
function filteredConcerts() {
  const q = norm(state.f.qc);
  return allConcerts().filter(e => state.f.countries.includes(e.country) &&
    (!q || norm(`${e.artist} ${e.name} ${e.venue} ${e.city}`).includes(q)));
}

/* ---------- Ikoner ---------- */
const I = {
  disc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3a9 9 0 0 1 9 9" opacity=".5"/></svg>',
  ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v2h18v-2a2 2 0 0 1 0-4 2 2 0 0 0 0-4V6H3z" transform="translate(0 -1)"/><path d="M14 6v12" stroke-dasharray="2 2"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M4 12h16M4 17h7"/><circle cx="18" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M7 9.5c3.5-1 7-.6 10 1M7.7 12.7c3-.8 5.8-.4 8.3.9M8.4 15.6c2.4-.5 4.6-.2 6.5.8"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
};

/* ---------- Visning ---------- */
const art = (img, name, cls = '') => `<span class="art ${cls}" style="--h:${hue(name)}" aria-hidden="true">${esc(initials(name))}${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
const sourceName = { apple: 'Apple Music', spotify: 'Spotify', manual: 'Manuel', itunes: 'Apple Music', demo: 'Eksempel' };

function renderTop() {
  const top = $('#top');
  if (!top) return;
  const n = visibleArtists().length;
  const when = state.updatedAt ? `opdateret ${fmt.time.format(new Date(state.updatedAt))}` : '';
  const meta = state.demo ? '<b>Eksempeldata</b><br>ingen konto forbundet'
    : hasSources() ? `<b>${n}</b> kunstnere<br>${when}` : '';
  const p = state.progress;
  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 6;
  top.innerHTML = `
    <div class="top-row">
      <h1 class="wordmark"><span class="dot"></span>Encore</h1>
      <div class="top-meta">${meta}</div>
      ${hasSources() || state.demo ? `<button class="icon-btn ${state.busy ? 'spin' : ''}" data-action="refresh" aria-label="Opdater">${I.refresh}</button>` : ''}
    </div>
    ${p ? `<div class="progress" role="status"><div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div><div class="progress-label">${esc(p.label || '')}${p.total ? ` ${p.done}/${p.total}` : ''}</div></div>` : ''}`;
}

function renderNav() {
  const nav = $('#nav');
  if (!hasSources() && !state.demo) { nav.hidden = true; return; }
  nav.hidden = false;
  const nC = filteredConcerts().length;
  const tabs = [
    ['releases', 'Udgivelser', I.disc, 0],
    ['concerts', 'Koncerter', I.ticket, nC],
    ['artists', 'Kunstnere', I.mic, 0],
    ['settings', 'Konto', I.user, 0],
  ];
  nav.innerHTML = `<div class="nav-inner">${tabs.map(([id, label, icon, badge]) => `
    <button data-action="tab" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}>
      ${icon}<span>${label}</span>${badge ? `<span class="badge">${badge > 99 ? '99+' : badge}</span>` : ''}
    </button>`).join('')}</div>`;
}

function banners() {
  let h = '';
  if (state.demo) {
    h += `<div class="banner"><p>Du ser <b>eksempeldata</b> med opdigtede kunstnere. ${CFG.demoOnly ? 'I den rigtige app forbinder du Apple Music eller Spotify.' : 'Forbind din egen musiktjeneste for at se dine kunstnere.'}</p>${CFG.demoOnly ? '' : '<button class="btn small primary" data-action="exit-demo">Kom i gang</button>'}</div>`;
  }
  for (const n of state.notices) h += `<div class="banner ${n.kind === 'error' ? 'error' : ''}"><p>${esc(n.msg)}</p><button class="btn small ghost" data-action="dismiss" data-msg="${esc(n.msg)}">Luk</button></div>`;
  return h;
}

function viewOnboarding() {
  const svc = (id, label, sub, icon, ok) => `
    <button class="btn ${id === 'apple' ? 'primary' : ''}" data-action="connect-${id}" ${ok ? '' : 'aria-disabled="true"'}>
      ${icon}<span class="grow">${label}<br><small>${sub}</small></span>${I.out}
    </button>`;
  return `
    <section class="hero">
      <p class="eyebrow">Udgivelser · Koncerter · DK SE DE</p>
      <h2>Hør det <em>først.</em><br>Se dem <span class="g">live.</span></h2>
      <p>Encore samler nye plader og kommende koncerter i Danmark, Sverige og Tyskland fra kunstnerne i dit eget musikbibliotek.</p>
    </section>
    <div class="marquee" aria-hidden="true"><span>${'Vega · Royal Arena · Train · Annexet · Pustervik · KB Malmö · Columbiahalle · Uebel &amp; Gefährlich · Posten · Debaser · Live Music Hall · '.repeat(2)}</span></div>
    ${banners()}
    <div class="connect">
      ${svc('apple', 'Forbind Apple Music', Apple.configured() ? 'Bruger kunstnerne i dit bibliotek' : 'Ikke sat op endnu', I.apple, Apple.configured() && !CFG.demoOnly)}
      ${svc('spotify', 'Forbind Spotify', Spotify.configured() ? 'Kunstnere du følger, gemmer og lytter mest til' : 'Ikke sat op endnu', I.wave, Spotify.configured() && !CFG.demoOnly)}
    </div>
    <form class="card" data-form="onboard-manual">
      <h3>Eller skriv dine kunstnere selv</h3>
      <p>Én kunstner pr. linje. Virker uden konto.</p>
      <textarea id="onboard-list" placeholder="Fontaines D.C.&#10;Tove Lo&#10;Kraftklub&#10;Mø"></textarea>
      <div class="actions"><button class="btn" type="submit">${I.pen}Brug min liste</button><button class="btn ghost" type="button" data-action="demo">${I.play}Se et eksempel</button></div>
    </form>
    <p class="note">Encore gemmer intet på en server. Din liste og dine valg ligger kun på denne telefon.</p>`;
}

function viewReleases() {
  const all = allReleases();
  const fresh = all.filter(r => { const d = daysFromToday(r.date); return d <= 60 && d >= -21; }).slice(0, 14).reverse();
  const P = [['upcoming', 'Kommende'], ['30', '30 dage'], ['90', '3 mdr.'], ['365', '1 år'], ['all', 'Alle']];
  const T = [['all', 'Alle typer'], ['Album', 'Album'], ['Single', 'Singler & EP']];
  return `
    ${banners()}
    <div class="page-head"><h2>Udgivelser</h2><p>${all.length ? `${all.length} plader og singler fra ${Object.keys(state.rel).length} kunstnere` : 'Nye plader og singler fra dine kunstnere'}</p></div>
    ${fresh.length ? `<section class="group"><div class="strip-head"><p class="eyebrow">Lige nu</p><p class="eyebrow">Sidste 3 uger + kommende</p></div>
      <div class="strip">${fresh.map(r => `<a class="tile" ${r.url ? `href="${esc(r.url)}" target="_blank" rel="noopener"` : ''}>
        ${art(r.cover, r.title)}<b>${esc(r.title)}</b><span>${esc(r.artist)} · ${esc(relTime(r))}</span></a>`).join('')}</div></section>` : ''}
    <label class="search">${I.search}<input id="q-releases" type="search" placeholder="Søg i titler og kunstnere" value="${esc(state.f.qr)}" data-q="qr" autocomplete="off"></label>
    <div class="chips" role="group" aria-label="Periode">${P.map(([v, l]) => `<button class="chip" data-action="period" data-v="${v}" aria-pressed="${state.f.period === v}">${l}</button>`).join('')}</div>
    <div class="chips" role="group" aria-label="Type">${T.map(([v, l]) => `<button class="chip" data-action="type" data-v="${v}" aria-pressed="${state.f.type === v}">${l}</button>`).join('')}</div>
    <div id="list" class="view" style="padding:0">${listReleases()}</div>`;
}

function groupByMonth(items) {
  const g = new Map();
  for (const it of items) { const k = it.date.slice(0, 7); if (!g.has(k)) g.set(k, []); g.get(k).push(it); }
  return [...g.entries()];
}

function listReleases() {
  const items = filteredReleases();
  if (!items.length) {
    if (state.busy) return `<div class="empty"><b>Henter udgivelser …</b><p>Det kan tage et par minutter første gang.</p></div>`;
    return `<div class="empty"><b>Ingen udgivelser her</b><p>Prøv en anden periode eller type${state.f.qr ? ', eller ryd søgningen' : ''}.</p></div>`;
  }
  const shown = items.slice(0, state.limit);
  return groupByMonth(shown).map(([k, list]) => `
    <section class="group">
      <div class="group-head"><h3>${esc(fmt.monthYear.format(parseDay(k + '-01')))}</h3><span>${list.length} ${list.length === 1 ? 'UDGIVELSE' : 'UDGIVELSER'}</span></div>
      ${list.map(r => {
        const d = daysFromToday(r.date);
        const tag = d > 0 ? `<span class="pill soon">Kommer</span>` : d >= -7 ? `<span class="pill hot">Ny</span>` : '';
        return `<a class="row" ${r.url ? `href="${esc(r.url)}" target="_blank" rel="noopener"` : ''}>
          ${art(r.cover, r.title)}
          <div class="row-main"><div class="row-title">${esc(r.title)}</div><div class="row-sub">${esc(r.artist)}</div>
            <div class="row-meta"><span class="pill">${esc(r.type)}</span>${tag}</div></div>
          <div class="row-end"><span>${esc(relTime(r))}</span></div></a>`;
      }).join('')}
    </section>`).join('') + (items.length > shown.length ? `<button class="btn more" data-action="more">Vis flere (${items.length - shown.length})</button>` : '');
}

const concertsBlocked = () => state.concertsBlocked || (!state.demo && !TM.configured() ? 'Koncerter er ikke sat op i denne app endnu (mangler Ticketmaster-nøgle).' : '');

function viewConcerts() {
  const all = allConcerts();
  const counts = Object.fromEntries(CFG.countries.map(c => [c, all.filter(e => e.country === c).length]));
  return `
    ${banners()}
    <div class="page-head"><h2>Koncerter</h2><p>Kommende shows i ${CFG.countries.map(c => COUNTRY[c] || c).join(', ').replace(/, ([^,]*)$/, ' og $1')}</p></div>
    ${concertsBlocked() ? `<div class="banner"><p>${esc(concertsBlocked())}</p><button class="btn small" data-action="refresh">Prøv igen</button></div>` : ''}
    <div class="chips" role="group" aria-label="Lande">${CFG.countries.map(c => `<button class="chip stamp" data-action="country" data-v="${c}" aria-pressed="${state.f.countries.includes(c)}">${c} <span class="n">${counts[c]}</span></button>`).join('')}</div>
    <label class="search">${I.search}<input id="q-concerts" type="search" placeholder="Søg kunstner, spillested eller by" value="${esc(state.f.qc)}" data-q="qc" autocomplete="off"></label>
    <div id="list" class="view" style="padding:0">${listConcerts()}</div>`;
}

function listConcerts() {
  const items = filteredConcerts();
  if (!items.length) {
    if (state.busy) return `<div class="empty"><b>Leder efter koncerter …</b><p>Vi tjekker hver kunstner hos Ticketmaster.</p></div>`;
    return `<div class="empty"><b>Ingen kommende koncerter fundet</b><p>${concertsBlocked() ? 'Koncertdata er ikke slået til endnu.' : 'Ingen af dine kunstnere har annonceret shows i de valgte lande. Vi tjekker igen ved næste opdatering.'}</p></div>`;
  }
  const STATUS = { cancelled: ['Aflyst', 'bad'], postponed: ['Udskudt', 'soon'], rescheduled: ['Flyttet', 'soon'], offsale: ['Ikke til salg', ''] };
  return groupByMonth(items).map(([k, list]) => `
    <section class="group">
      <div class="group-head"><h3>${esc(fmt.monthYear.format(parseDay(k + '-01')))}</h3><span>${list.length} ${list.length === 1 ? 'KONCERT' : 'KONCERTER'}</span></div>
      <div class="tickets">${list.map(e => {
        const dt = parseDay(e.date);
        const st = STATUS[e.status];
        const sub = e.name && norm(e.name) !== norm(e.artist) ? `<div class="tk-name">${esc(e.name)}</div>` : '';
        const days = daysFromToday(e.date);
        const when = days === 0 ? 'I aften' : days === 1 ? 'I morgen' : days < 14 ? `Om ${days} dage` : '';
        return `<article class="ticket">
          <div class="stub"><span class="wd">${esc(fmt.wd.format(dt).replace('.', ''))}</span><span class="d">${dt.getDate()}</span><span class="m">${esc(fmt.mon.format(dt).replace('.', ''))}</span></div>
          <div class="tk-body">
            <div class="tk-artist">${esc(e.artist)}</div>${sub}
            <div class="tk-place"><span class="stampc" title="${esc(COUNTRY[e.country] || e.country)}">${esc(e.country)}</span><span>${esc(e.venue)}${e.city ? ', ' + esc(e.city) : ''}</span></div>
            <div class="tk-foot">
              <span class="tk-time">${e.time ? 'KL. ' + esc(e.time) : 'TID FØLGER'}${when ? ' · ' + when.toUpperCase() : ''}</span>
              <span class="tags">${st ? `<span class="pill ${st[1]}">${st[0]}</span>` : ''}
              ${e.url ? `<a class="btn small primary" href="${esc(e.url)}" target="_blank" rel="noopener">Billetter${I.out}</a>` : `<span class="btn small" aria-disabled="true">Eksempel</span>`}</span>
            </div>
          </div></article>`;
      }).join('')}</div>
    </section>`).join('');
}

function viewArtists() {
  return `
    ${banners()}
    <div class="page-head"><h2>Kunstnere</h2><p>${state.artists.length} i alt · ${state.hidden.size} skjult</p></div>
    <form class="field" data-form="add-artist">
      <input id="add-artist" placeholder="Tilføj kunstner, fx Mø" autocomplete="off" aria-label="Kunstnernavn">
      <button class="btn primary" type="submit">Tilføj</button>
    </form>
    <details class="card"><summary>Importer en liste</summary>
      <form data-form="import" style="display:grid;gap:10px">
        <textarea id="import-list" placeholder="Én kunstner pr. linje, eller adskilt med komma"></textarea>
        <button class="btn" type="submit">Tilføj alle</button>
      </form>
    </details>
    <label class="search">${I.search}<input id="q-artists" type="search" placeholder="Søg i dine kunstnere" value="${esc(state.f.qa)}" data-q="qa" autocomplete="off"></label>
    <div id="list" class="group">${listArtists()}</div>`;
}

function listArtists() {
  const q = norm(state.f.qa);
  const items = state.artists.filter(a => !q || a.key.includes(q));
  if (!items.length) return `<div class="empty"><b>${state.artists.length ? 'Ingen match' : 'Ingen kunstnere endnu'}</b><p>${state.artists.length ? 'Prøv et andet navn.' : 'Forbind en musiktjeneste under Konto, eller tilføj kunstnere ovenfor.'}</p></div>`;
  return items.slice(0, state.limit * 2).map(a => {
    const hidden = state.hidden.has(a.key);
    const nr = (state.rel[a.key] || []).length, ne = (state.ev[a.key] || []).length;
    return `<div class="row" style="${hidden ? 'opacity:.5' : ''}">
      ${art(a.image, a.name, 'round')}
      <div class="row-main"><div class="row-title">${esc(a.name)}</div>
        <div class="row-sub">${nr} udgivelser · ${ne} ${ne === 1 ? 'koncert' : 'koncerter'}</div>
        <div class="row-meta">${a.sources.map(s => `<span class="pill">${sourceName[s] || s}</span>`).join('')}</div></div>
      <div class="row-end">
        <button class="btn small ghost" data-action="toggle-artist" data-key="${esc(a.key)}">${hidden ? 'Vis' : 'Skjul'}</button>
        ${a.sources.includes('manual') ? `<button class="btn small ghost" data-action="remove-manual" data-name="${esc(a.name)}" aria-label="Fjern ${esc(a.name)}">${I.x}</button>` : ''}
      </div></div>`;
  }).join('');
}

function viewSettings() {
  const svc = (id, title, desc, on, ok) => `
    <div class="card">
      <div class="svc-head"><h3>${title}</h3><span class="status ${on ? 'on' : ''}">${on ? 'Forbundet' : ok ? 'Ikke forbundet' : 'Ikke sat op'}</span></div>
      <p>${desc}</p>
      <div class="actions">${on
        ? `<button class="btn" data-action="resync">${I.refresh}Hent kunstnere igen</button><button class="btn ghost" data-action="disconnect-${id}">Afbryd</button>`
        : `<button class="btn primary" data-action="connect-${id}" ${ok && !CFG.demoOnly ? '' : 'aria-disabled="true"'}>Forbind</button>`}</div>
    </div>`;
  return `
    ${banners()}
    <div class="page-head"><h2>Konto</h2><p>Vælg hvor dine kunstnere kommer fra</p></div>
    ${svc('apple', 'Apple Music', 'Henter kunstnerne fra dit bibliotek. Kræver et Apple Music-abonnement.', state.sources.apple, Apple.configured())}
    ${svc('spotify', 'Spotify', 'Henter kunstnere du følger, har gemt musik fra og lytter mest til.', state.sources.spotify, Spotify.configured())}
    <div class="card">
      <div class="svc-head"><h3>Manuel liste</h3><span class="status ${state.manual.length ? 'on' : ''}">${state.manual.length} kunstnere</span></div>
      <p>Kunstnere du selv har tilføjet. Udgivelser findes via Apple Musics åbne katalog.</p>
      <div class="actions"><button class="btn" data-action="tab" data-tab="artists">Rediger liste</button></div>
    </div>
    <div class="card">
      <h3>Datakilder</h3>
      <p>Udgivelser: ${[state.sources.spotify && 'Spotify', (state.sources.apple || state.manual.length) && 'Apple Music-kataloget'].filter(Boolean).join(' og ') || 'Apple Music og Spotify'}. Koncerter: Ticketmaster (Danmark, Sverige og Tyskland). Koncerter, der kun sælges gennem andre billetsælgere, kan mangle.</p>
      <p>Data gemmes kun på denne enhed og opdateres automatisk, når de er mere end 12 timer gamle.</p>
      <div class="actions">
        <button class="btn" data-action="hard-refresh">${I.refresh}Opdater alt nu</button>
        <button class="btn ghost" data-action="reset">Nulstil appen</button>
      </div>
    </div>
    ${state.demo && !CFG.demoOnly ? '<button class="btn" data-action="exit-demo">Forlad eksemplet</button>' : ''}
    <p class="note">Tip: Tilføj Encore til hjemmeskærmen. På iPhone: Del › Føj til hjemmeskærm. På Android: menuen › Installer app.</p>`;
}

function update() {
  const a = document.activeElement;
  if (a && a.matches('#view input, #view textarea') && a.value) { renderTop(); renderNav(); renderList(); }
  else render();
}
function renderList() {
  const el = $('#list');
  if (!el) return;
  el.innerHTML = { releases: listReleases, concerts: listConcerts, artists: listArtists }[state.tab]?.() ?? '';
}
function render() {
  renderTop();
  renderNav();
  const v = $('#view');
  if (!hasSources() && !state.demo) { v.innerHTML = viewOnboarding(); return; }
  v.innerHTML = ({ releases: viewReleases, concerts: viewConcerts, artists: viewArtists, settings: viewSettings }[state.tab] || viewReleases)();
}

/* ---------- Handlinger ---------- */
function addManual(names) {
  const have = new Set(state.manual.map(norm));
  for (const n of names.map(s => s.trim()).filter(Boolean)) {
    if (!have.has(norm(n))) { state.manual.push(n); have.add(norm(n)); }
  }
  store.set('manual', state.manual);
  state.artists = mergeArtists([state.artists.flatMap(a => a.sources.filter(s => s !== 'manual').map(s => ({ ...a, source: s }))), manualArtists()]);
  store.set('artists', state.artists);
}
function dropSource(src) {
  state.sources[src] = false; store.set('sources', state.sources);
  state.artists = state.artists.map(a => ({ ...a, sources: a.sources.filter(s => s !== src) })).filter(a => a.sources.length);
  store.set('artists', state.artists);
  render();
}
const splitList = s => String(s).split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);

async function connect(id) {
  const svc = id === 'apple' ? Apple : Spotify;
  if (CFG.demoOnly) { notice('Forhåndsvisningen viser kun eksempeldata. Åbn den installerede app for at forbinde.', 'info'); render(); return; }
  if (!svc.configured()) { notice(`${id === 'apple' ? 'Apple Music' : 'Spotify'} er ikke sat op i denne app endnu. Se README for opsætning.`); render(); return; }
  try {
    if (id === 'apple') {
      if (await Apple.connect()) {
        state.sources.apple = true; store.set('sources', state.sources);
        state.demo = false; store.set('demo', false); state.artistsAt = 0;
        state.tab = 'releases'; render(); refreshAll();
      }
    } else await Spotify.connect();
  } catch (e) { notice(e.message || 'Kunne ikke forbinde.'); render(); }
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (!b || b.getAttribute('aria-disabled') === 'true' && !b.dataset.action.startsWith('connect')) return;
  const { action, v } = b.dataset;
  switch (action) {
    case 'tab': state.tab = b.dataset.tab; state.limit = PAGE; store.set('tab', state.tab); render(); window.scrollTo({ top: 0 }); break;
    case 'refresh': refreshAll(true); break;
    case 'hard-refresh': store.clearCache(); state.rel = {}; state.ev = {}; state.artistsAt = 0; refreshAll(true); break;
    case 'resync': state.artistsAt = 0; refreshAll(false); break;
    case 'period': state.f.period = v; state.limit = PAGE; saveFilters(); render(); break;
    case 'type': state.f.type = v; state.limit = PAGE; saveFilters(); render(); break;
    case 'country': {
      const set = new Set(state.f.countries);
      set.has(v) ? set.delete(v) : set.add(v);
      state.f.countries = set.size ? CFG.countries.filter(c => set.has(c)) : CFG.countries.slice();
      saveFilters(); render(); break;
    }
    case 'more': state.limit += PAGE; renderList(); break;
    case 'toggle-artist': {
      const k = b.dataset.key;
      state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k);
      store.set('hidden', [...state.hidden]); update(); break;
    }
    case 'remove-manual': {
      const n = norm(b.dataset.name);
      state.manual = state.manual.filter(x => norm(x) !== n); store.set('manual', state.manual);
      state.artists = state.artists.map(a => a.key === n ? { ...a, sources: a.sources.filter(s => s !== 'manual') } : a).filter(a => a.sources.length);
      store.set('artists', state.artists); render(); break;
    }
    case 'connect-apple': connect('apple'); break;
    case 'connect-spotify': connect('spotify'); break;
    case 'disconnect-apple': Apple.disconnect(); dropSource('apple'); break;
    case 'disconnect-spotify': store.del('sp_token'); dropSource('spotify'); break;
    case 'demo': state.demo = true; store.set('demo', true); loadDemo(); state.tab = 'releases'; render(); break;
    case 'exit-demo':
      state.demo = false; store.set('demo', false); state.rel = {}; state.ev = {};
      state.artists = store.get('artists', []); loadFromCache(); state.tab = 'releases'; render();
      if (hasSources()) refreshAll();
      break;
    case 'dismiss': state.notices = state.notices.filter(n => n.msg !== b.dataset.msg); render(); break;
    case 'reset': {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tryk igen for at slette alt'; return; }
      try { Object.keys(localStorage).filter(k => k.startsWith('encore:')).forEach(k => localStorage.removeItem(k)); } catch {}
      location.reload(); break;
    }
  }
});

document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  if (state.demo && !CFG.demoOnly) { state.demo = false; store.set('demo', false); state.rel = {}; state.ev = {}; state.artists = store.get('artists', []); }
  if (CFG.demoOnly) { notice('Forhåndsvisningen viser kun eksempeldata. Åbn den installerede app for at bruge din egen liste.', 'info'); render(); return; }
  const kind = f.dataset.form;
  const src = kind === 'add-artist' ? $('#add-artist').value : kind === 'import' ? $('#import-list').value : $('#onboard-list').value;
  const names = kind === 'add-artist' ? [src.trim()].filter(Boolean) : splitList(src);
  if (!names.length) return;
  addManual(names);
  if (kind === 'onboard-manual') state.tab = 'releases';
  render();
  refreshAll();
});

document.addEventListener('input', e => {
  const k = e.target.dataset?.q;
  if (!k) return;
  state.f[k] = e.target.value; state.limit = PAGE;
  renderList();
});

/* ---------- Eksempeldata (opdigtede kunstnere, rigtige spillesteder) ---------- */
function loadDemo() {
  const off = n => isoDay(new Date(Date.now() + n * DAY));
  const A = ['Mira Vang', 'Nordlys Kollektiv', 'The Halcyon Static', 'Søster Sol', 'Lowtide Ballroom', 'Kasper Engel & Ekkoerne', 'Velvet Arcade', 'Frida Ström', 'Autobahn Lieder', 'Grey Harbour', 'Juno Kestrel', 'Polar Postkort'];
  state.artists = mergeArtists([A.map(name => ({ name, source: 'demo' }))]);
  const R = [
    [0, 'Glasvinger', 'Album', -2], [1, 'Kuldegrader', 'Single', -5], [2, 'Signal Under Water', 'Album', 12], [3, 'Morgenrøde', 'EP', -9],
    [4, 'Paper Moons', 'Single', -16], [5, 'Alt det vi sagde', 'Album', -27], [6, 'Neon Psalms', 'Album', -41], [7, 'Midsommarnatt', 'Single', 3],
    [8, 'Kilometerzähler', 'Album', -58], [9, 'Breakwater', 'EP', -73], [10, 'Static Bloom', 'Single', -11], [11, 'Hilsner fra Nord', 'Album', -120],
    [0, 'Hvis du blev', 'Single', -46], [2, 'Low Light Hymns', 'EP', -190], [1, 'Fjordlys', 'Album', -260], [6, 'Glow Theory', 'Single', -95],
    [7, 'Isbrytare', 'Album', -330], [8, 'Nachtfahrt', 'Single', -150], [3, 'Hjem igen', 'Single', 26], [4, 'Saltwater Ballads', 'Album', -400],
    [9, 'North Sea Radio', 'Album', -620], [5, 'Ekko', 'Single', -210], [10, 'Kestrel', 'Album', -540], [11, 'Vinterpost', 'EP', -300],
  ];
  state.rel = {};
  R.forEach(([ai, title, type, d], i) => {
    const a = state.artists.find(x => x.name === A[ai]);
    (state.rel[a.key] ||= []).push({ id: 'demo-r' + i, title, artist: a.name, artistKey: a.key, date: off(d), precision: 'day', type, cover: '', url: '', source: 'demo' });
  });
  const V = {
    vega: ['Store Vega', 'København', 'DK'], royal: ['Royal Arena', 'København', 'DK'], train: ['Train', 'Aarhus', 'DK'], posten: ['Posten', 'Odense', 'DK'],
    pumpe: ['Pumpehuset', 'København', 'DK'], debaser: ['Debaser Strand', 'Stockholm', 'SE'], annexet: ['Annexet', 'Stockholm', 'SE'], pust: ['Pustervik', 'Göteborg', 'SE'],
    kb: ['KB', 'Malmö', 'SE'], columbia: ['Columbiahalle', 'Berlin', 'DE'], uebel: ['Uebel & Gefährlich', 'Hamburg', 'DE'], lmh: ['Live Music Hall', 'Köln', 'DE'],
    tonhalle: ['Tonhalle', 'München', 'DE'], astra: ['Astra Kulturhaus', 'Berlin', 'DE'],
  };
  const E = [
    [0, 'vega', 4, '20:00'], [0, 'debaser', 6, '20:30'], [0, 'columbia', 9, '21:00'], [1, 'posten', 13, '20:00'], [2, 'uebel', 17, '20:00', 'postponed'],
    [3, 'train', 21, '21:00'], [4, 'kb', 25, '19:30'], [5, 'royal', 33, '19:00'], [6, 'astra', 38, '20:00'], [7, 'pust', 44, '20:00'],
    [8, 'lmh', 49, ''], [9, 'pumpe', 57, '20:30'], [10, 'annexet', 66, '19:30'], [2, 'vega', 72, '20:00'], [11, 'tonhalle', 85, '20:00'], [7, 'vega', 101, '20:00'],
  ];
  state.ev = {};
  E.forEach(([ai, v, d, time, status], i) => {
    const a = state.artists.find(x => x.name === A[ai]);
    const [venue, city, country] = V[v];
    (state.ev[a.key] ||= []).push({ id: 'demo-e' + i, artist: a.name, artistKey: a.key, name: '', date: off(d), time, venue, city, country, status: status || 'onsale', url: '', source: 'demo' });
  });
  state.updatedAt = Date.now();
}

/* ---------- Start ---------- */
async function boot() {
  try { await Spotify.handleCallback(); } catch (e) { notice('Spotify: ' + e.message); }
  if (state.demo) loadDemo(); else loadFromCache();
  render();
  if (!state.demo && hasSources()) {
    const stale = Date.now() - state.updatedAt > TTL_RELEASES || !Object.keys(state.rel).length;
    if (stale || Date.now() - state.artistsAt > TTL_ARTISTS) refreshAll();
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:' && window.top === window.self && !CFG.demoOnly) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
})();
