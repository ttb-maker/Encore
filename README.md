# Encore

En web-app til mobilen, der viser:

- **Udgivelser** (album, EP'er og singler, også kommende) fra kunstnerne i dit bibliotek
- **Koncerter** i Danmark, Sverige og Tyskland med de samme kunstnere, med link til billetter

Brugerne vælger selv, hvor kunstnerne kommer fra:

| Kilde | Hvad der hentes |
|---|---|
| Apple Music | Alle kunstnere i dit bibliotek |
| Spotify | Kunstnere du følger, har gemt album og numre fra, og dine mest spillede |
| Manuel liste | Kunstnere man selv skriver ind eller indsætter som liste. Kræver ingen konto. |

Appen er en PWA. Den kan føjes til hjemmeskærmen på iPhone og Android og opfører sig så som en almindelig app. Alt gemmes lokalt på telefonen, og der er ingen database og ingen brugerkonti.

---

## Opsætning (ca. 30 minutter, én gang)

Det er kun dig, der driver appen, som skal igennem det her. Dine brugere åbner bare linket.

### 1. Læg appen online på Vercel (gratis)

1. Læg mappen `encore/` i et GitHub-repo.
2. Gå til [vercel.com](https://vercel.com), log ind med GitHub, vælg **Add New › Project** og importér repoet. Der er ingen build-trin, så standardindstillingerne er fine.
3. Du får en adresse som `https://encore-xyz.vercel.app`. Den bruger du i de næste trin.

Mappen `api/` bliver automatisk til to små serverfunktioner på Vercel:
- `api/apple-token.js` udsteder Apple Music-adgangsnøglen
- `api/tm.js` henter koncerter fra Ticketmaster, så API-nøglen forbliver hemmelig

### 2. Koncerter: Ticketmaster (gratis)

1. Opret en konto på [developer.ticketmaster.com](https://developer.ticketmaster.com) og opret en app.
2. Kopiér din **Consumer Key**.
3. I Vercel: **Settings › Environment Variables** → tilføj `TICKETMASTER_API_KEY`.

Gratisnøglen giver 5.000 opslag i døgnet. Appen bruger ca. 1–2 opslag pr. kunstner pr. opdatering og gemmer resultaterne i 6 timer.

### 3. Spotify

1. Gå til [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) › **Create app**.
2. **Redirect URI**: din app-adresse med skråstreg til sidst, fx `https://encore-xyz.vercel.app/`.
3. Vælg **Web API**.
4. Kopiér **Client ID** ind i `config.js` → `spotifyClientId`.

**Vigtigt om Spotify:** Nye Spotify-apps kører i *Development Mode*. Her skal hver bruger tilføjes manuelt under **User Management** i dashboardet, og der er et lille loft over antallet af brugere. Spotify åbner kun for fri adgang ("Extended Quota") for etablerede virksomheder. Spotify passer derfor bedst til dig selv og en lille kreds af venner. Andre kan bruge Apple Music eller en manuel liste.

### 4. Apple Music

Det kræver medlemskab af [Apple Developer Program](https://developer.apple.com/programs/) (99 USD om året).

1. Gå til **Certificates, Identifiers & Profiles › Identifiers** og opret et **Media ID** (MusicKit).
2. Gå til **Keys**, opret en nøgle, og sæt flueben ved **Media Services (MusicKit, ShazamKit)**, knyttet til dit Media ID.
3. Hent `.p8`-filen og notér **Key ID** og dit **Team ID** (øverst til højre i developer-portalen).
4. I Vercel skal du tilføje:
   - `APPLE_TEAM_ID`
   - `APPLE_KEY_ID`
   - `APPLE_PRIVATE_KEY`: hele indholdet af `.p8`-filen, inklusive `-----BEGIN PRIVATE KEY-----`

Når det er gjort, kan alle med et Apple Music-abonnement logge ind. Der er intet loft over antallet af brugere.

### 5. Redeploy

Lav en ny deploy i Vercel (eller push en ændring), så miljøvariablerne slår igennem. Send derefter linket til dine venner.

---

## Alternativ: helt statisk hosting (GitHub Pages, Netlify Drop o.l.)

Uden serverfunktioner skal nøglerne stå direkte i `config.js`:

```js
appleTokenEndpoint: '',
appleDeveloperToken: '<token fra scriptet nedenfor>',
ticketmasterProxy: '',
ticketmasterApiKey: '<din Consumer Key>',
```

Lav Apple-tokenen sådan (den gælder i 180 dage):

```
node scripts/make-apple-token.js <TEAM_ID> <KEY_ID> AuthKey_XXXX.p8
```

Ticketmaster-nøglen er så synlig i browseren. Det er acceptabelt til privat brug, men proxyen på Vercel er at foretrække.

---

## Afprøv lokalt

```
cd encore
npx serve .        # eller: python3 -m http.server 8080
```

Åbn adressen og tryk **Se et eksempel** for at se appen med eksempeldata. Login med Apple og Spotify kræver, at appen kører på sin rigtige https-adresse.

---

## Godt at vide

- **Dækning af koncerter:** Data kommer fra Ticketmaster (Ticketmaster.dk, .se og .de). Koncerter, der kun sælges hos andre (fx Billetlugen, Tix, Eventim-only), kan mangle. Flere kilder kan tilføjes i `app.js` ved siden af `TM`.
- **Kommende udgivelser:** Streamingtjenesterne viser ofte først et album, når det udkommer. Encore supplerer derfor med [MusicBrainz](https://musicbrainz.org), en åben musikdatabase, hvor kommende udgivelser typisk registreres i forvejen.
- **Opdatering:** Appen tjekker for nyt, hver gang den åbnes eller kommer frem fra baggrunden. Hver kunstner hentes højst hver 12. time (koncerter hver 6. time), og nye kunstnere hentes først.
- **Udgivelser:** Spotify-brugere får diskografien fra Spotify. Apple Music-brugere og manuelle lister bruger Apple Musics katalog. Opslag i det åbne katalog (manuelle lister) er begrænset til ca. 20 i minuttet, så første indlæsning af en lang manuel liste tager et par minutter. Bagefter gemmes resultaterne i 12 timer.
- **Privatliv:** Der er ingen server-database. Login-nøgler, kunstnerlister og cache ligger i telefonens browserlager og kan slettes under **Konto › Nulstil appen**.

## Filer

```
index.html            selve appen
styles.css            grafisk udtryk (mørkt og lyst tema)
app.js                al logik: Apple Music, Spotify, iTunes-katalog, Ticketmaster, visning
config.js             opsætning, udfyldes af dig
manifest.webmanifest  gør appen installerbar
sw.js                 offline-skal
icons/                app-ikoner
api/apple-token.js    Vercel-funktion: Apple Music developer token
api/tm.js             Vercel-funktion: Ticketmaster-proxy
scripts/make-apple-token.js  laver en Apple-token til statisk hosting
```
