/**
 * Adresse du serveur. Ordre de priorité :
 *  1. ?api=http://hote:3000 dans l'URL (pratique pour tester dans un navigateur) ;
 *  2. localStorage "vv.api" (réglage mémorisé) ;
 *  3. APK Cordova : adresse de API_BASE_URL (à adapter à ton serveur) ;
 *  4. navigateur servi depuis une IP du réseau local : même hôte, port 3000.
 */
export const API_BASE_URL = 'http://192.168.1.208:3000';

export function getApiOrigin() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('api');
    if (fromQuery) {
      window.localStorage.setItem('vv.api', fromQuery);
      return fromQuery.replace(/\/$/, '');
    }
    const saved = window.localStorage.getItem('vv.api');
    if (saved) return saved.replace(/\/$/, '');
  } catch (error) { /* stockage indisponible */ }

  if (window.cordova && window.cordova.platformId === 'android') return API_BASE_URL;
  const host = window.location && window.location.hostname;
  if (host && host !== 'localhost' && host !== '127.0.0.1') return `http://${host}:3000`;
  return API_BASE_URL;
}
