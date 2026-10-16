// Proxy til Ticketmaster Discovery API, så API-nøglen ikke ligger i browseren.
// Miljøvariabel: TICKETMASTER_API_KEY
const ALLOWED = new Set(['events.json', 'attractions.json']);

module.exports = async (req, res) => {
  const key = (process.env.TICKETMASTER_API_KEY || '').trim();
  if (!key) { res.status(501).json({ error: 'Ticketmaster er ikke konfigureret på serveren.' }); return; }
  const { path, ...params } = req.query || {};
  if (!ALLOWED.has(path)) { res.status(400).json({ error: 'Ukendt sti' }); return; }
  const url = new URL('https://app.ticketmaster.com/discovery/v2/' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('apikey', key);
  try {
    const r = await fetch(url);
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (r.ok) res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ error: 'Ticketmaster kunne ikke nås' });
  }
};
