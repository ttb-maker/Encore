// Henter koncertprogrammer direkte fra spillestedernes egne hjemmesider.
// Hvert spillested har sin egen læser, bygget ud fra hvordan siden faktisk leverer sit program
// (åben datakilde, HTML eller schema.org-data). Ukendte sider prøves med de generelle metoder.
// Resultatet caches i 6 timer på Vercel, så siderne kun besøges få gange i døgnet.
//
// /api/venues          → { events: [...] }
// /api/venues?debug=1  → læsbar oversigt over, hvad der blev fundet pr. spillested

const UA = 'Mozilla/5.0 (compatible; EncoreConcertBot/1.1; +https://encore-ttb-maker.vercel.app)';

/* ---------- Hjælpere ---------- */
async function get(url, { json = false, ms = 9000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,application/xhtml+xml', 'Accept-Language': 'da,sv;q=0.9,de;q=0.8,en;q=0.7' },
    });
    if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
    return json ? r.json() : r.text();
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('timeout'), { status: 'timeout' });
    throw Object.assign(e, { status: e.status || 'fejl' });
  } finally { clearTimeout(t); }
}

const decode = s => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#8211;|&ndash;/g, '–')
  .replace(/&([a-zA-Z]+);/g, (m, n) => NAMED[n] || m)
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
const NAMED = { aelig: 'æ', oslash: 'ø', aring: 'å', AElig: 'Æ', Oslash: 'Ø', Aring: 'Å', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', eacute: 'é', egrave: 'è', szlig: 'ß', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—' };
const abs = (u, base) => { try { return u ? new URL(decode(u), base).href : ''; } catch { return ''; } };
const pad = n => String(n).padStart(2, '0');
const todayISO = () => new Date().toISOString().slice(0, 10);

const MONTHS = {
  jan: 1, januar: 1, january: 1, januari: 1, feb: 2, februar: 2, february: 2, februari: 2, mar: 3, mär: 3, marts: 3, mars: 3, march: 3, märz: 3,
  apr: 4, april: 4, maj: 5, may: 5, mai: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8, augusti: 8,
  sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, october: 10, nov: 11, november: 11, dec: 12, dez: 12, december: 12, dezember: 12,
};
const monthNo = s => MONTHS[String(s || '').toLowerCase().replace(/[^a-zäö]/g, '')] || MONTHS[String(s || '').toLowerCase().replace(/[^a-zäö]/g, '').slice(0, 3)];
// Dag + måned uden år: næste gang datoen indtræffer
function ymd(day, month, year) {
  const d = +day, m = typeof month === 'number' ? month : monthNo(month);
  if (!d || !m) return '';
  let y = +year;
  if (!y) {
    const now = new Date();
    y = now.getUTCFullYear();
    if (`${y}-${pad(m)}-${pad(d)}` < new Date(now - 3 * 864e5).toISOString().slice(0, 10)) y++;
  } else if (y < 100) y += 2000;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const timeOf = s => { const m = String(s || '').match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/); return m ? `${pad(m[1])}:${m[2]}` : ''; };
// Klokkeslæt i dansk tid ud fra et UTC-tidsstempel
const cphTime = iso => { try { return new Intl.DateTimeFormat('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' }).format(new Date(iso)).replace('.', ':'); } catch { return ''; } };
const blocks = (html, startRe) => html.split(startRe).slice(1);
const pick = (s, re) => { const m = s.match(re); return m ? m[1] : ''; };

/* ---------- Generelle metoder (schema.org JSON-LD og indlejret app-data) ---------- */
function scripts(html, typeRe) {
  const out = []; const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) if (typeRe.test(m[1])) out.push(m[2]);
  return out;
}
const parseJSON = s => { try { return JSON.parse(s.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim()); } catch { return null; } };
function walk(node, fn, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) { for (const x of node) walk(x, fn, depth + 1); return; }
  fn(node); for (const k in node) walk(node[k], fn, depth + 1);
}
function asDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = v.match(/T(\d{2}:\d{2})/);
  return { date: v.slice(0, 10), time: t && t[1] !== '00:00' ? t[1] : '' };
}
const names = v => (Array.isArray(v) ? v : v ? [v] : []).map(p => decode(typeof p === 'string' ? p : p && p.name)).filter(Boolean);
function fromJsonLd(html, base) {
  const out = [];
  for (const s of scripts(html, /application\/ld\+json/i)) {
    walk(parseJSON(s), o => {
      const t = [].concat(o['@type'] || []).join(' ');
      const d = /Event\b/.test(t) && asDate(o.startDate);
      if (!d) return;
      const loc = Array.isArray(o.location) ? o.location[0] : o.location;
      out.push({
        title: decode(o.name), performers: names(o.performer), ...d,
        venue: decode(loc && loc.name), city: decode(loc && loc.address && loc.address.addressLocality),
        url: abs(o.url || (o.offers && (o.offers.url || (o.offers[0] && o.offers[0].url))), base),
      });
    });
  }
  return out;
}
const TITLE_KEYS = ['title', 'name', 'headline', 'eventName', 'artist', 'artistName'];
const DATE_KEYS = ['startDate', 'start_date', 'start', 'date', 'eventDate', 'event_date', 'startTime', 'datetime', 'dateTime'];
const URL_KEYS = ['url', 'link', 'href', 'permalink', 'slug', 'path', 'ticketUrl'];
function fromAppData(html, base) {
  const out = [];
  for (const s of scripts(html, /application\/json|__NEXT_DATA__/i)) {
    walk(parseJSON(s), o => {
      const tk = TITLE_KEYS.find(k => typeof o[k] === 'string' && o[k].length > 1 && o[k].length < 160);
      const dk = DATE_KEYS.find(k => asDate(o[k]));
      if (!tk || !dk) return;
      const uk = URL_KEYS.find(k => typeof o[k] === 'string' && o[k].length < 400);
      out.push({ title: decode(o[tk]), performers: [], ...asDate(o[dk]), url: uk ? abs(o[uk], base) : '' });
    });
  }
  return out;
}
const generic = urls => async () => {
  let last;
  for (const url of urls) {
    try {
      const html = await get(url);
      const ev = fromJsonLd(html, url);
      const list = ev.length ? ev : fromAppData(html, url);
      if (list.length) return { url, events: list };
      last = { url, events: [] };
    } catch (e) { last = { url, error: e.status }; }
  }
  return last;
};

/* ---------- Læsere pr. spillested ---------- */

// VEGA: åben datakilde (Payload CMS), 25 pr. side
async function vega() {
  const cfg = encodeURIComponent(JSON.stringify({ depth: 2, draft: false, siteContext: { locale: 'da', subsite: 'VEGA.dk' } }));
  const page = p => get(`https://vega.dk/api/events?direction=future&genres=&page=${p}&config=${cfg}`, { json: true, ms: 12000 });
  const first = await page(1);
  const rest = await Promise.all(Array.from({ length: Math.min((first.totalPages || 1) - 1, 15) }, (_, i) => page(i + 2).catch(() => ({ data: [] }))));
  const out = [];
  for (const e of [first, ...rest].flatMap(p => p.data || [])) {
    const dates = e.dates && e.dates.length ? e.dates : [{ date: e.firstDate }];
    for (const d of dates) {
      if (!d || !d.date) continue;
      out.push({
        title: decode(e.title), performers: [e.primaryArtist && e.primaryArtist.name].filter(Boolean).map(decode),
        date: d.date.slice(0, 10), time: dates.length === 1 && e.firstDate ? cphTime(e.firstDate) : '',
        venue: e.venue && e.venue.name ? e.venue.name : 'VEGA',
        url: e.slug ? `https://vega.dk/event/${e.slug}` : (d.purchaseAtHref || 'https://vega.dk/'),
        status: /udsolgt/i.test(d.state && d.state.name) ? 'soldout' : /aflyst/i.test(d.state && d.state.name) ? 'cancelled' : '',
      });
    }
  }
  return { url: 'vega.dk/api/events', events: out };
}

// Royal Arena: Live Nations åbne søgning
async function royalArena() {
  const url = 'https://www.royalarena.dk/__api/search/events?VenueIds=845782&IncludePostponed=true&IncludeCancelled=true&Url=%2Fshows&PageSize=200&Page=1&culture=da-DK';
  const d = await get(url, { json: true, ms: 12000 });
  return {
    url: 'royalarena.dk/__api/search/events',
    events: (d.documents || []).map(e => {
      const loc = (e.localizations || []).find(l => l.cultureName === 'da-DK') || (e.localizations || [])[0] || {};
      return {
        title: decode(loc.name || (e.lineup && e.lineup[0] && e.lineup[0].name)),
        performers: (e.lineup || []).map(l => decode(l.name)),
        date: String(e.eventDate || '').slice(0, 10), time: timeOf(e.showTime) || timeOf(e.doorTime),
        venue: 'Royal Arena', url: abs(loc.url, 'https://www.royalarena.dk/'),
        status: e.isCancelled ? 'cancelled' : e.isPostponed ? 'postponed' : '',
      };
    }),
  };
}

// DR Koncerthuset: åben datakilde (Umbraco)
async function drKoncerthuset() {
  const d = await get('https://www.drkoncerthuset.dk/umbraco/api/events/fetch?pageSize=500', { json: true, ms: 15000 });
  return {
    url: 'drkoncerthuset.dk/umbraco/api/events/fetch',
    events: (d.results || []).map(e => {
      const external = /,/.test(e.venue || '');
      return {
        title: decode([e.title, e.subTitle].filter(Boolean).join(': ')),
        performers: [e.ensembleLabel, e.secondaryEnsembleLabel, ...String(e.info && e.info.label || '').split('|')].map(decode).filter(Boolean),
        date: String(e.orderDate || '').slice(0, 10), time: timeOf(String(e.orderDate || '').slice(11)),
        venue: external ? e.venue.split(',')[0].trim() : `DR Koncerthuset${e.venue ? ', ' + e.venue : ''}`,
        city: external ? e.venue.split(',').slice(1).join(',').trim() : 'København',
        url: abs(e.url, 'https://www.drkoncerthuset.dk/') || e.ticketLink,
        status: /udsolgt/i.test(e.badge || '') ? 'soldout' : /aflyst/i.test(e.badge || '') ? 'cancelled' : '',
      };
    }),
  };
}

// Amager Bio / Beta (ab-b.dk): koncertkort i HTML
async function amagerBio() {
  const url = 'https://ab-b.dk/';
  const html = await get(url, { ms: 12000 });
  return {
    url,
    events: blocks(html, /<div class="[^"]*\bconcert type-concert\b/).map(b => {
      const scene = decode(pick(b, /data-scene="([^"]*)"/));
      return {
        title: decode(pick(b, /<h4[^>]*>([\s\S]*?)<\/h4>/)),
        performers: [],
        date: ymd(decode(pick(b, /class="day"[^>]*>([\s\S]*?)</)), decode(pick(b, /class="month"[^>]*>([\s\S]*?)</))),
        time: timeOf(pick(b, /class="time"[^>]*>([\s\S]*?)</)),
        venue: /beta/i.test(scene) ? 'BETA (Amager Bio)' : 'Amager Bio',
        url: abs(pick(b, /<a href="(https:\/\/ab-b\.dk\/k\/[^"]+)"/), url),
        status: /udsolgt/i.test(pick(b, /data-status="([^"]*)"/)) ? 'soldout' : /aflyst/i.test(pick(b, /data-status="([^"]*)"/)) ? 'cancelled' : '',
      };
    }),
  };
}

// Barclays Arena Hamburg: kalender pr. måned (JSON med HTML-stykker)
async function barclays() {
  const now = new Date();
  const months = Array.from({ length: 13 }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; });
  const pages = await Promise.all(months.map(([y, m]) =>
    get(`https://www.barclays-arena.de/events/calendar/${y}/${pad(m)}?v=2&detail_partial=modules/events/partials/full_page_calendar_event_item`, { json: true, ms: 12000 }).catch(() => ({}))));
  const out = [];
  for (const page of pages) {
    for (const [key, html] of Object.entries(page || {})) {
      const [mm, dd, yyyy] = key.split('-');
      const re = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
      while ((m = re.exec(String(html)))) out.push({ title: decode(m[2]), performers: [], date: `${yyyy}-${mm}-${dd}`, time: '', venue: 'Barclays Arena', url: m[1].replace(/\\\//g, '/') });
    }
  }
  return { url: 'barclays-arena.de/events/calendar', events: out };
}

// Malmö Arena: eventkort i HTML
async function malmoArena() {
  const url = 'https://www.malmoarena.com/evenemang';
  const html = await get(url, { ms: 12000 });
  return {
    url,
    events: blocks(html, /class="event-listing__item"/).map(b => {
      const when = decode(pick(b, /event-listing__third-block"[^>]*>([\s\S]*?)<\/div>/));
      const dm = when.match(/(\d{1,2})\s+([a-zåäö]+)/i);
      const cat = decode(pick(b, /event-listing__second-block"[^>]*>([\s\S]*?)<\/div>/));
      return {
        title: decode(pick(b, /<h2[^>]*>([\s\S]*?)<\/h2>/)), performers: [], category: cat,
        date: dm ? ymd(dm[1], dm[2]) : '', time: timeOf(when.split('|')[1]),
        venue: 'Malmö Arena', url: abs(pick(b, /href="(\/evenemang\/[^"]+)"/), url),
      };
    }).filter(e => !/redhawks|sport/i.test(e.category)),
  };
}

// Malmö Live: eventkort i HTML (Drupal)
async function malmoLive() {
  // Først den åbne datakilde (hele programmet), ellers HTML
  try {
    const list = await get('https://malmolive.se/api/events', { json: true, ms: 12000 });
    if (Array.isArray(list) && list.length) {
      return {
        url: 'malmolive.se/api/events',
        events: list.map(e => ({
          title: decode(e.title), performers: [e.field_keywords_target_id].filter(Boolean).map(decode),
          date: String(e.field_date_time || '').slice(0, 10), time: timeOf(String(e.field_date_time || '').slice(11)),
          venue: `Malmö Live${e.field_venue ? ', ' + decode(e.field_venue) : ''}`,
          url: abs(e.view_node, 'https://malmolive.se/'), status: e.sold_out === '1' ? 'soldout' : '',
        })),
      };
    }
  } catch {}
  let lastErr;
  for (const url of ['https://malmolive.se/program', 'https://malmolive.se/']) {
    try {
      const html = await get(url, { ms: 12000 });
      const events = blocks(html, /class="event-list-item full-flex"/).map(b => ({
        title: decode(pick(b, /event-list-item--info__title[^>]*>([\s\S]*?)<\/h3>/)), performers: [],
        date: ymd(decode(pick(b, /date--day-number">([^<]*)</)), decode(pick(b, /date--month">([^<]*)</)), decode(pick(b, /date--year">([^<]*)</))),
        time: timeOf(pick(b, /date--time">([^<]*)</)),
        venue: `Malmö Live${pick(b, /SCEN: <\/label>([^<]*)</) ? ', ' + decode(pick(b, /SCEN: <\/label>([^<]*)</)) : ''}`,
        url: abs(pick(b, /href="(\/program\/[^"]+)"/), url),
      }));
      if (events.length) return { url, events };
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return { url: 'malmolive.se', events: [] };
}

// Babel: titler som "261105 : Zenstation"
async function babel() {
  let found = [], used = '';
  for (const url of ['https://babelmalmo.se/program/konsert', 'https://babelmalmo.se/']) {
    try {
      const html = await get(url, { ms: 12000 });
      const re = /<a href="([^"]+)" rel="bookmark" title="(\d{2})(\d{2})(\d{2})\s*:\s*([^"]+)"/g; let m; const ev = [];
      while ((m = re.exec(html))) ev.push({ title: decode(m[5]), performers: [], date: ymd(m[4], +m[3], m[2]), time: '', venue: 'Babel', url: m[1] });
      if (ev.length > found.length) { found = ev; used = url; }
    } catch {}
  }
  return { url: used || 'babelmalmo.se', events: found };
}

// Slagthuset: eventkort i HTML (Next.js)
async function slagthuset() {
  let found = [], used = '';
  // Den åbne datakilde (WordPress bag siden)
  try {
    const list = await get('https://slagthuset.se/api/events', { json: true, ms: 12000 });
    if (Array.isArray(list)) {
      found = list.map(e => {
        const a = e.acf || {}, d = String(a.startdatum || '');
        return {
          title: decode(e.title && e.title.rendered), performers: [],
          date: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '',
          time: timeOf(a.borjar) || timeOf(a.oppnar),
          venue: `Slagthuset${a.plats && a.plats[0] && a.plats[0].name ? ', ' + decode(a.plats[0].name) : ''}`,
          url: e.slug ? `https://slagthuset.se/events/${e.slug}` : '',
        };
      });
      used = 'slagthuset.se/api/events';
    }
  } catch {}
  for (const url of ['https://slagthuset.se/events', 'https://slagthuset.se/']) {
    try {
      const html = await get(url, { ms: 12000 });
      const re = /href="(\/events\/[^"]+)"><div>([^<]+)<\/div><\/a>[\s\S]{0,240}?<div class="uppercase text-sm">([^<]+)<\/div>/g; let m; const ev = [];
      while ((m = re.exec(html))) {
        const d = decode(m[3]).match(/(\d{1,2})\s+([a-zåäö]+)\.?\s+(\d{4})?/i);
        ev.push({ title: decode(m[2]), performers: [], date: d ? ymd(d[1], d[2], d[3]) : '', time: '', venue: 'Slagthuset', url: abs(m[1], url) });
      }
      // Læg sammen med datakilden; dubletter fjernes senere
      found = found.concat(ev); if (!used && ev.length) used = url;
    } catch {}
  }
  return { url: used || 'slagthuset.se', events: found };
}

// Soundvenue: månedlig artikel "Her er koncerterne, du skal opleve i …"
// Hver koncert står som <h2>Kunstner</h2> efterfulgt af "1. november, VoxHall + 5. november, Lille Vega"
async function soundvenue() {
  const list = await get('https://soundvenue.com/musik', { ms: 12000 });
  const guides = [...new Set((list.match(/https:\/\/soundvenue\.com\/musik\/\d{4}\/\d{2}\/her-er-koncerterne-du-skal-opleve-i-[^"'#?\s]+/g) || []))].slice(0, 3);
  const out = [];
  for (const url of guides) {
    let html;
    try { html = await get(url, { ms: 12000 }); } catch { continue; }
    // Året tages fra artiklens adresse (/musik/2026/10/…); en guide i december kan pege ind i januar
    const [, ay, am] = url.match(/\/musik\/(\d{4})\/(\d{2})\//).map(Number);
    const yearFor = mon => (mon < am - 1 ? ay + 1 : ay);
    const re = /<h2[^>]*>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>/g; let m;
    while ((m = re.exec(html))) {
      const artist = decode(m[1]);
      const line = decode(m[2]);
      for (const part of line.split(/\s+\+\s+|\s+og\s+(?=\d)/)) {
        const d = part.match(/^(\d{1,2})\.\s*([a-zæøå]+)\s*(\d{4})?,\s*(.+)$/i);
        if (!d || !monthNo(d[2])) continue;
        out.push({ title: artist, performers: [artist], date: ymd(d[1], d[2], d[3] || yearFor(monthNo(d[2]))), time: '', venue: d[4].trim(), city: '', url });
      }
    }
  }
  return { url: guides.length ? `${guides.length} guides på soundvenue.com` : 'soundvenue.com/musik', events: out };
}

// Plan B: åben datakilde
const localDate = (iso, tz) => { try { return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); } catch { return String(iso || '').slice(0, 10); } };
async function planB() {
  const list = await get('https://www.planbmalmo.com/api/eventsEdge?', { json: true, ms: 12000 });
  return {
    url: 'planbmalmo.com/api/eventsEdge',
    events: (Array.isArray(list) ? list : []).filter(e => !e.custom_fields || e.custom_fields.published !== false).map(e => {
      const c = e.custom_fields || {};
      const start = c.show_start_time || e.start_time;
      return {
        title: decode(e.name), performers: [],
        date: localDate(start, 'Europe/Stockholm'), time: cphTime(start),
        venue: 'Plan B', url: c.ticketUrl || 'https://www.planbmalmo.com/',
        status: c.soldOut ? 'soldout' : /cancel/i.test(c.eventStatus || '') ? 'cancelled' : '',
      };
    }),
  };
}

const SOURCES = [
  // Danmark
  { id: 'vega', name: 'VEGA', city: 'København', country: 'DK', run: vega },
  { id: 'amagerbio', name: 'Amager Bio', city: 'København', country: 'DK', run: amagerBio },
  { id: 'loppen', name: 'Loppen', city: 'København', country: 'DK', run: generic(['https://loppen.dk/']) },
  { id: 'royalarena', name: 'Royal Arena', city: 'København', country: 'DK', run: royalArena },
  { id: 'kbhallen', name: 'K.B. Hallen', city: 'Frederiksberg', country: 'DK', run: generic(['https://kbhallen.dk/']) },
  { id: 'drkoncerthuset', name: 'DR Koncerthuset', city: 'København', country: 'DK', run: drKoncerthuset },
  { id: 'soundvenue', name: 'Soundvenue (koncertguide)', city: '', country: 'DK', run: soundvenue },
  // Sverige (Malmö)
  { id: 'malmoarena', name: 'Malmö Arena', city: 'Malmö', country: 'SE', run: malmoArena },
  { id: 'malmolive', name: 'Malmö Live', city: 'Malmö', country: 'SE', run: malmoLive },
  { id: 'planb', name: 'Plan B', city: 'Malmö', country: 'SE', run: planB },
  { id: 'babel', name: 'Babel', city: 'Malmö', country: 'SE', run: babel },
  { id: 'slagthuset', name: 'Slagthuset', city: 'Malmö', country: 'SE', run: slagthuset },
  // Tyskland
  { id: 'barclays', name: 'Barclays Arena', city: 'Hamburg', country: 'DE', run: barclays },
];

async function scrape(src) {
  let r;
  try { r = await src.run(); } catch (e) { r = { url: '', error: e.status || 'fejl', events: [] }; }
  const today = todayISO();
  const seen = new Set();
  const events = (r.events || []).filter(e => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= today).filter(e => {
    const k = e.title + e.date; if (seen.has(k)) return false; seen.add(k); return true;
  }).map(e => ({
    title: e.title, performers: e.performers || [], date: e.date, time: e.time || '',
    venue: e.venue || src.name, city: e.city || src.city, country: src.country,
    url: e.url || '', status: e.status || '', source: src.id,
  }));
  return { src, url: r.url, error: r.error, events };
}

module.exports = async (req, res) => {
  const results = await Promise.all(SOURCES.map(scrape));
  if (req.query && req.query.debug) {
    const lines = [`Encore – spillesteder (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`, ''];
    for (const r of results) {
      lines.push(`${r.events.length ? 'OK ' : '-- '} ${r.src.name}: ${r.events.length} koncerter${r.error ? `  (fejl: ${r.error})` : ''}`);
      if (r.url) lines.push(`     ${r.url}`);
      for (const e of r.events.slice(0, 3)) lines.push(`     · ${e.date} ${e.time} ${e.title}`);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(lines.join('\n'));
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
  res.status(200).json({
    updated: new Date().toISOString(),
    sources: results.map(r => ({ id: r.src.id, name: r.src.name, count: r.events.length })),
    events: results.flatMap(r => r.events),
  });
};

module.exports._test = { fromJsonLd, fromAppData, ymd, SOURCES };
