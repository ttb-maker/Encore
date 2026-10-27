// Henter koncertprogrammer direkte fra spillestedernes egne hjemmesider.
// Bruger de strukturerede data (schema.org Event / JSON-LD), som de fleste sider har til Google,
// og falder tilbage på sidens indlejrede JSON-data (fx Next.js).
// Resultatet caches i 6 timer på Vercel, så siderne kun besøges få gange i døgnet.
//
// /api/venues          → { events: [...] }
// /api/venues?debug=1  → læsbar oversigt over, hvad der blev fundet pr. spillested

const SOURCES = [
  // Danmark
  { id: 'vega', name: 'VEGA', city: 'København', country: 'DK', urls: ['https://vega.dk/kalender', 'https://vega.dk/koncerter', 'https://vega.dk/'] },
  { id: 'amagerbio', name: 'Amager Bio', city: 'København', country: 'DK', urls: ['https://amagerbio.dk/koncerter', 'https://amagerbio.dk/program', 'https://amagerbio.dk/'] },
  { id: 'loppen', name: 'Loppen', city: 'København', country: 'DK', urls: ['https://loppen.dk/', 'https://loppen.dk/program'] },
  { id: 'royalarena', name: 'Royal Arena', city: 'København', country: 'DK', urls: ['https://www.royalarena.dk/events', 'https://www.royalarena.dk/'] },
  { id: 'kbhallen', name: 'K.B. Hallen', city: 'Frederiksberg', country: 'DK', urls: ['https://kbhallen.dk/events', 'https://kbhallen.dk/koncerter', 'https://kbhallen.dk/'] },
  { id: 'drkoncerthuset', name: 'DR Koncerthuset', city: 'København', country: 'DK', urls: ['https://www.drkoncerthuset.dk/koncerter', 'https://www.drkoncerthuset.dk/'] },
  { id: 'gaffa', name: 'GAFFA', city: '', country: 'DK', aggregator: true, urls: ['https://gaffa.dk/koncerter', 'https://gaffa.dk/kalender', 'https://gaffa.dk/'] },
  // Sverige (Malmö)
  { id: 'malmoarena', name: 'Malmö Arena', city: 'Malmö', country: 'SE', urls: ['https://www.malmoarena.com/evenemang', 'https://www.malmoarena.com/'] },
  { id: 'malmolive', name: 'Malmö Live', city: 'Malmö', country: 'SE', urls: ['https://malmolive.se/kalender', 'https://malmolive.se/'] },
  { id: 'planb', name: 'Plan B', city: 'Malmö', country: 'SE', urls: ['https://www.planbmalmo.se/', 'https://planbmalmo.se/'] },
  { id: 'babel', name: 'Babel', city: 'Malmö', country: 'SE', urls: ['https://babelmalmo.se/', 'https://babelmalmo.se/evenemang'] },
  { id: 'slagthuset', name: 'Slagthuset', city: 'Malmö', country: 'SE', urls: ['https://slagthuset.se/', 'https://slagthuset.se/evenemang'] },
  // Tyskland
  { id: 'barclays', name: 'Barclays Arena', city: 'Hamburg', country: 'DE', urls: ['https://www.barclays-arena.de/events', 'https://www.barclays-arena.de/'] },
];

const UA = 'Mozilla/5.0 (compatible; EncoreConcertBot/1.0; +https://encore-ttb-maker.vercel.app)';

async function fetchText(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'da,sv;q=0.9,de;q=0.8,en;q=0.7' } });
    return { status: r.status, text: r.ok ? await r.text() : '' };
  } catch (e) {
    return { status: e.name === 'AbortError' ? 'timeout' : 'fejl', text: '' };
  } finally { clearTimeout(t); }
}

const decode = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

function scripts(html, typeRe) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (typeRe.test(m[1])) out.push(m[2]);
  return out;
}
function parseJSON(s) {
  try { return JSON.parse(s.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim()); } catch { return null; }
}
function walk(node, fn, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) { for (const x of node) walk(x, fn, depth + 1); return; }
  fn(node);
  for (const k in node) walk(node[k], fn, depth + 1);
}

const ISO = /^\d{4}-\d{2}-\d{2}/;
function asDate(v) {
  if (typeof v === 'number' && v > 1e12) v = new Date(v).toISOString();
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  return { date: v.slice(0, 10), time: /T(\d{2}:\d{2})/.test(v) && !/T00:00(:00)?(\.0+)?(Z|[+-]00:00)?$/.test(v) ? v.match(/T(\d{2}:\d{2})/)[1] : '' };
}
const absolute = (u, base) => { try { return u ? new URL(u, base).href : ''; } catch { return ''; } };
const names = v => (Array.isArray(v) ? v : v ? [v] : []).map(p => decode(typeof p === 'string' ? p : p && p.name)).filter(Boolean);

// 1) schema.org-events i JSON-LD
function fromJsonLd(html, base) {
  const out = [];
  for (const s of scripts(html, /application\/ld\+json/i)) {
    walk(parseJSON(s), o => {
      const t = [].concat(o['@type'] || []).join(' ');
      if (!/Event\b/.test(t) || !o.startDate) return;
      const d = asDate(o.startDate);
      if (!d) return;
      out.push({
        title: decode(o.name), performers: names(o.performer), ...d,
        venue: decode(o.location && (o.location.name || (Array.isArray(o.location) && o.location[0] && o.location[0].name))),
        city: decode(o.location && o.location.address && o.location.address.addressLocality),
        url: absolute(o.url || (o.offers && (o.offers.url || (o.offers[0] && o.offers[0].url))), base),
      });
    });
  }
  return out;
}

// 2) Indlejret app-data (Next.js, Nuxt m.fl.): objekter med en titel og en dato
const TITLE_KEYS = ['title', 'name', 'headline', 'eventName', 'artist', 'artistName'];
const DATE_KEYS = ['startDate', 'start_date', 'start', 'date', 'eventDate', 'event_date', 'startTime', 'start_time', 'datetime', 'dateTime', 'begins', 'from'];
const URL_KEYS = ['url', 'link', 'href', 'permalink', 'slug', 'path', 'ticketUrl', 'ticket_url'];
function fromAppData(html, base) {
  const out = [];
  for (const s of scripts(html, /application\/json|__NEXT_DATA__|__NUXT_DATA__/i)) {
    walk(parseJSON(s), o => {
      const tk = TITLE_KEYS.find(k => typeof o[k] === 'string' && o[k].length > 1 && o[k].length < 160);
      const dk = DATE_KEYS.find(k => asDate(o[k]));
      if (!tk || !dk) return;
      const uk = URL_KEYS.find(k => typeof o[k] === 'string' && o[k].length < 400);
      out.push({ title: decode(o[tk]), performers: [], ...asDate(o[dk]), venue: '', city: '', url: uk ? absolute(o[uk], base) : '' });
    });
  }
  return out;
}

async function scrape(src) {
  const tried = [];
  for (const url of src.urls) {
    const { status, text } = await fetchText(url);
    let events = [];
    if (text) {
      events = fromJsonLd(text, url);
      if (!events.length) events = fromAppData(text, url);
    }
    tried.push({ url, status, found: events.length });
    if (events.length) {
      const today = new Date().toISOString().slice(0, 10);
      const seen = new Set();
      events = events.filter(e => e.title && e.date >= today).filter(e => {
        const k = e.title + e.date; if (seen.has(k)) return false; seen.add(k); return true;
      }).map(e => ({
        ...e,
        venue: src.aggregator ? e.venue : (e.venue || src.name),
        city: e.city || src.city,
        country: src.country,
        url: e.url || url,
        source: src.id,
      }));
      return { src, tried, events };
    }
  }
  return { src, tried, events: [] };
}

module.exports = async (req, res) => {
  const results = await Promise.all(SOURCES.map(scrape));
  const debug = req.query && req.query.debug;
  if (debug) {
    const lines = [`Encore – spillesteder (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`, ''];
    for (const r of results) {
      lines.push(`${r.events.length ? 'OK ' : '-- '} ${r.src.name}: ${r.events.length} koncerter`);
      for (const t of r.tried) lines.push(`     ${t.status}  ${t.found} fundet  ${t.url}`);
      for (const e of r.events.slice(0, 3)) lines.push(`     · ${e.date} ${e.title}`);
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

module.exports._test = { fromJsonLd, fromAppData };
