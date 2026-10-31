import '../../ui/base.css';
import './style.css';
import { sendToBackground } from '../../messaging';
import type { GuardAnswer } from '../../sites/guard-rules';
import { renderGuard } from '../../ui/guard-view';

/**
 * The guard page (PLAN-PRELOAD §4): the browser sent a navigation here before it left the device. The
 * background says what the address is; nothing here navigates or lets a host through without a click.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function main() {
  // framed by some page: show nothing
  if (window.top !== window) return;
  const hash = location.hash;
  let answer: GuardAnswer;
  try {
    answer = await sendToBackground({ type: 'guard-check', hash });
  } catch {
    answer = { kind: 'invalid' };
  }
  renderGuard(document, answer, () => {
    const cont = $<HTMLButtonElement>('continue');
    cont.disabled = true;
    void sendToBackground({ type: 'guard-continue', hash })
      .then(({ url }) => location.replace(url))
      .catch(() => (cont.disabled = false));
  }, () => sendToBackground({ type: 'guard-report', hash }).then((r) => r.status));
}

void main();
