// Petits utilitaires DOM. Le texte venant du serveur passe toujours par textContent.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  Object.entries(props || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key === 'class') el.className = value;
    else if (key === 'icon') el.innerHTML = value; // SVG statiques uniquement
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  });
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return el;
}

export function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'À l’instant';
  if (seconds < 3600) return `Il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `Il y a ${Math.floor(seconds / 3600)} h`;
  return `Il y a ${Math.floor(seconds / 86400)} j`;
}

export function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} Go`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds === null) return '';
  if (seconds < 60) return `${seconds} s restantes`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min restantes`;
  return `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min restantes`;
}

export function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace('.', ',')} k`;
  return String(n);
}

let toastTimer;
export function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
