// Engangsværktøj: åbner spillestedernes sider i en rigtig browser og gemmer,
// hvad siden viser, og hvilke datakilder (JSON/API) den henter koncerterne fra.
import { chromium } from 'playwright';
import fs from 'fs';
fs.mkdirSync('snapshots', { recursive: true });
const urls = fs.readFileSync('debug/urls.txt', 'utf8').trim().split('\n').map(l => l.trim().split(/\s+/));
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const cap = (s, n) => (s || '').length > n ? s.slice(0, n) + '\n…[afkortet]' : (s || '');
const b = await chromium.launch();
const index = [];
for (const [id, url] of urls) {
  const ctx = await b.newContext({ locale: 'da-DK', userAgent: UA, viewport: { width: 1280, height: 2000 } });
  const p = await ctx.newPage();
  const calls = [];
  p.on('response', async r => {
    const rt = r.request().resourceType(), ct = r.headers()['content-type'] || '';
    if (!['xhr', 'fetch'].includes(rt) && !ct.includes('json')) return;
    let body = ''; try { body = await r.text(); } catch {}
    calls.push({ url: r.url(), method: r.request().method(), post: cap(r.request().postData() || '', 2000), status: r.status(), ct, body: cap(body, 6000) });
  });
  let status = '', err = '';
  try { const resp = await p.goto(url, { waitUntil: 'networkidle', timeout: 45000 }); status = resp ? resp.status() : ''; }
  catch (e) { err = String(e).split('\n')[0].slice(0, 200); }
  try { await p.mouse.wheel(0, 4000); await p.waitForTimeout(2500); } catch {}
  const html = await p.content().catch(() => '');
  const text = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const links = await p.$$eval('a[href]', as => as.map(a => ({ h: a.href, t: a.innerText.trim().replace(/\s+/g, ' ').slice(0, 160) })).filter(x => x.t)).catch(() => []);
  let raw = '';
  try { const r = await ctx.request.get(url, { timeout: 30000, headers: { 'User-Agent': UA } }); raw = `HTTP ${r.status()}\n` + await r.text(); } catch (e) { raw = 'FEJL ' + String(e).slice(0, 300); }
  fs.writeFileSync(`snapshots/${id}.raw.html`, cap(raw, 1500000));
  fs.writeFileSync(`snapshots/${id}.rendered.html`, cap(html, 1500000));
  fs.writeFileSync(`snapshots/${id}.text.txt`, cap(text, 60000));
  fs.writeFileSync(`snapshots/${id}.json`, JSON.stringify({ url, status, err, finalUrl: p.url(), calls, links: links.slice(0, 600) }, null, 1));
  index.push(`${id}\t${status}\t${err}\tcalls=${calls.length}\tlinks=${links.length}\traw=${raw.length}\trendered=${html.length}`);
  await ctx.close();
}
fs.writeFileSync('snapshots/index.txt', index.join('\n') + '\n');
await b.close();
