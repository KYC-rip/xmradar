import type { GuardAnswer } from '../sites/guard-rules';

/** The page as text and links for one answer. */
export function renderGuard(doc: Document, a: GuardAnswer, onContinue: () => void): void {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const card = el('guard');
  const show = (id: string, text?: string) => {
    const e = el(id);
    if (text !== undefined) e.textContent = text;
    e.hidden = false;
    return e;
  };
  card.hidden = false;
  if (a.kind === 'invalid') {
    show('title', 'Nothing to check here.');
    return;
  }
  if (a.kind === 'off') {
    show('title', "XMRadar's site warnings are off.");
    const plain = show('plain', a.host) as HTMLAnchorElement;
    plain.href = a.url;
    plain.rel = 'noreferrer';
    return;
  }
  const red = a.kind === 'red';
  card.classList.add(red ? 'red' : 'amber');
  const listed = `listed on xmr.club as ${a.name}`;
  if (red && a.why === 'listed-phishing') {
    show('title', `This isn't ${a.target}.`);
    show('text', `xmr.club lists ${a.host} as a phishing copy of ${a.target} (${a.name}).`);
  } else if (red) {
    show('title', `This isn't ${a.target}.`);
    show('text', `${a.host} looks like ${a.target} (${listed}), but it isn't. Copies of exchange sites take the coins you send.`);
  } else if (a.kind === 'same-name') {
    show('title', `This is not ${a.target}.`);
    show('text', `${a.target} is ${listed}. This site has the same name on another domain and may not be theirs.`);
  } else {
    show('title', `This site's address contains ${a.target}'s name.`);
    show('text', `${a.target} is ${listed}. If you meant to go there, use the button.`);
  }
  show('address', `Address: ${a.host}`);
  const go = show('go', `Go to ${a.target}`) as HTMLAnchorElement;
  go.href = new URL(`https://${a.target}/`).href;
  go.rel = 'noreferrer';
  const cont = el<HTMLButtonElement>('continue');
  cont.textContent = red ? `Continue to ${a.host} (not recommended)` : `Continue to ${a.host}`;
  cont.addEventListener('click', (e) => {
    if (e.isTrusted) onContinue();
  });
  if (red) {
    const details = show('details');
    details.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      details.hidden = true;
      cont.hidden = false;
    });
  } else {
    cont.hidden = false;
  }
}
