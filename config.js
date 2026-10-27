/*
 * Encore – opsætning
 * Udfyldes én gang af den, der driver appen. Brugerne skal ikke røre noget her.
 * Se README.md for trin-for-trin vejledning.
 */
window.ENCORE_CONFIG = {
  // Apple Music (MusicKit). Brug ENTEN et endpoint, der udsteder en developer token
  // (api/apple-token.js på Vercel), ELLER indsæt en færdig token direkte.
  appleTokenEndpoint: '/api/apple-token',
  appleDeveloperToken: '',

  // Spotify: Client ID fra developer.spotify.com/dashboard.
  // Redirect URI i Spotify skal være præcis adressen på appen (fx https://encore.vercel.app/).
  spotifyClientId: '',
  spotifyRedirectUri: '', // tom = appens egen adresse

  // Ticketmaster Discovery API (koncerter). Brug ENTEN proxyen (api/tm.js, holder nøglen hemmelig)
  // ELLER indsæt nøglen direkte, hvis appen ligger på en statisk host som GitHub Pages.
  ticketmasterProxy: '/api/tm',
  ticketmasterApiKey: '',

  // Koncerter hentet direkte fra spillestedernes egne hjemmesider (api/venues.js). Tom = slået fra.
  venuesEndpoint: '/api/venues',

  // Lande, der vises koncerter fra
  countries: ['DK', 'SE', 'DE'],

  // Apple-butik, der bruges til opslag uden login (manuelle kunstnere)
  storefront: 'dk',

  // true = vis kun eksempeldata (bruges i forhåndsvisningen)
  demoOnly: false,
};
