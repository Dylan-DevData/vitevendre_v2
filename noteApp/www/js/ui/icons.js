// Icônes au trait (style Instagram). Contenu statique, donc sûr pour innerHTML.
const svg = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const icons = {
  home: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  homeFill: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" fill="currentColor"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>'),
  plus: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M12 8v8M8 12h8"/>'),
  reels: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M3.5 9h17M9 3.5l3 5.5M15 3.5 18 9"/><path d="m10.5 12.5 4 2.5-4 2.5z" fill="currentColor"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  heart: svg('<path d="M12 20.5s-8-4.7-8-10.6A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 2.9c0 5.9-8 10.6-8 10.6z"/>'),
  heartFill: svg('<path d="M12 20.5s-8-4.7-8-10.6A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 2.9c0 5.9-8 10.6-8 10.6z" fill="currentColor"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  volume: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>'),
  mute: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="3"/>'),
  play: svg('<path d="m8 5 11 7-11 7z" fill="currentColor"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5" stroke-width="2.4"/>'),
  retry: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  film: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m10.5 9.5 4 2.5-4 2.5z" fill="currentColor"/>'),
  comment: svg('<path d="M20.5 11.5a8 8 0 0 1-11.6 7.1L4 20l1.5-4.4A8 8 0 1 1 20.5 11.5z"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  send: svg('<path d="M4 12l16-8-6 16-2.5-6.5z" fill="currentColor"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>'),
};
