import { session } from '../api.js';
import { social } from '../services/social.js';
import { h } from './dom.js';

// Bouton « Suivre / Abonné » synchronisé avec l'état partagé des abonnements.
//   author   : { id, followedByMe }
//   options  : className, onResult(résultat du serveur)
// Retourne null si l'auteur est l'utilisateur connecté (on ne se suit pas soi-même).
export function createFollowButton(author, { className = 'follow-btn', onResult = () => {} } = {}) {
  const me = session.user;
  if (me && me.id === author.id) return null;

  const el = h('button', { class: className, type: 'button' });
  const current = () => social.isFollowing(author.id, author.followedByMe);
  function paint() {
    const on = current();
    el.classList.toggle('on', on);
    el.textContent = on ? 'Abonné' : 'Suivre';
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  el.addEventListener('click', async (event) => {
    event.stopPropagation();   // ne déclenche pas la pause / le J'aime de la vidéo derrière
    const result = await social.toggle(author.id, !current());
    if (result) onResult(result);
  });

  // Se désabonne tout seul quand le bouton a quitté la page (carte supprimée, écran reconstruit).
  const off = social.onChange((userId) => {
    if (!el.isConnected) { off(); return; }
    if (userId === author.id) paint();
  });
  paint();
  return el;
}
