// Laver en Apple Music developer token, du kan sætte ind i config.js (appleDeveloperToken).
// Brug: node scripts/make-apple-token.js <TEAM_ID> <KEY_ID> <sti/til/AuthKey_XXXX.p8>
// Tokenen gælder i 180 dage (Apples maksimum). Lav en ny, før den udløber.
const fs = require('fs');
const crypto = require('crypto');
const [teamId, keyId, file] = process.argv.slice(2);
if (!teamId || !keyId || !file) {
  console.error('Brug: node scripts/make-apple-token.js <TEAM_ID> <KEY_ID> <AuthKey.p8>');
  process.exit(1);
}
const now = Math.floor(Date.now() / 1000);
const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = enc({ alg: 'ES256', kid: keyId });
const body = enc({ iss: teamId, iat: now, exp: now + 180 * 86400 });
const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: fs.readFileSync(file, 'utf8'), dsaEncoding: 'ieee-p1363' });
console.log(`${head}.${body}.${sig.toString('base64url')}`);
