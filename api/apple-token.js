// Udsteder en Apple Music developer token (ES256-signeret JWT).
// Miljøvariabler: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (indholdet af .p8-filen)
const crypto = require('crypto');

let cached = null;

module.exports = (req, res) => {
  const APPLE_TEAM_ID = (process.env.APPLE_TEAM_ID || '').trim();
  const APPLE_KEY_ID = (process.env.APPLE_KEY_ID || '').trim();
  const APPLE_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').trim();
  if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
    res.status(501).json({ error: 'Apple Music er ikke konfigureret på serveren.' });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!cached || cached.exp - now < 7 * 86400) {
    const exp = now + 90 * 86400; // Apple tillader op til 6 måneder
    const enc = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const head = enc({ alg: 'ES256', kid: APPLE_KEY_ID });
    const body = enc({ iss: APPLE_TEAM_ID, iat: now, exp });
    const key = APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    cached = { token: `${head}.${body}.${sig.toString('base64url')}`, exp };
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).json({ token: cached.token });
};
