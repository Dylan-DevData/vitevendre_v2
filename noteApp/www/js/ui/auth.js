import { api, session } from '../api.js';
import { h } from './dom.js';

// Connexion / inscription (téléphone + mot de passe).
export function createAuth({ onSuccess }) {
  let mode = 'login';
  const root = h('div', { class: 'auth' });

  function render(message = '') {
    const phone = h('input', { type: 'tel', name: 'phone', placeholder: 'Téléphone (ex. 699123456)', autocomplete: 'tel', required: true });
    const name = h('input', { type: 'text', name: 'name', placeholder: 'Nom complet', autocomplete: 'name', required: true });
    const password = h('input', { type: 'password', name: 'password', placeholder: 'Mot de passe (8 caractères min.)', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true });
    const error = h('p', { class: 'form-error', role: 'alert' }, message);
    const button = h('button', { class: 'btn primary', type: 'submit' }, mode === 'login' ? 'Se connecter' : 'S’inscrire');
    const form = h('form', { class: 'auth-form', novalidate: true },
      phone, mode === 'register' ? name : null, password, error, button);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true; error.textContent = '';
      try {
        const body = { phone: phone.value.trim(), password: password.value };
        if (mode === 'register') body.fullName = name.value.trim();
        const result = mode === 'login' ? await api.login(body) : await api.register(body);
        session.set(result);
        onSuccess();
      } catch (err) {
        error.textContent = err.network ? 'Réseau indisponible. Vérifiez votre connexion.' : err.message;
        button.disabled = false;
      }
    });
    root.replaceChildren(
      h('h1', { class: 'logo' }, 'ViteVendre'),
      h('p', { class: 'tagline' }, 'Partagez vos vidéos, même avec un réseau faible.'),
      form,
      h('button', { class: 'link', type: 'button', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; render(); } },
        mode === 'login' ? 'Pas de compte ? Inscrivez-vous' : 'Déjà inscrit ? Connectez-vous'));
  }
  render();
  return { el: root };
}
