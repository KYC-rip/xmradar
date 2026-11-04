import '../../ui/base.css';
import './style.css';
import { sendToBackground } from '../../messaging';
import { mountConsent } from '../../siwm/consent';

void mountConsent(document, {
  id: location.hash.slice(1),
  get: (id) => sendToBackground({ type: 'siwm-get', id }),
  open: (uri) => sendToBackground({ type: 'siwm-open', uri }),
  submit: (id, signature) => sendToBackground({ type: 'siwm-submit', id, signature }),
  copy: (text) => navigator.clipboard.writeText(text),
  save: (name, text) => {
    // the exact message bytes, UTF-8, no trailing newline
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    // revoked later: some browsers start the download after the click returns
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  setId: (id) => history.replaceState(null, '', `#${id}`),
  close: () => window.close(),
  now: Date.now,
});

// forget the link as soon as the window goes
addEventListener('pagehide', () => {
  const id = location.hash.slice(1);
  if (id) void sendToBackground({ type: 'siwm-close', id }).catch(() => {});
});
