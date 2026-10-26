import { DEFAULT_BLOSSOM, parseRelayList, patchSettings, settingsItem } from '../settings';
import { part } from './dom';

const SAVED_MS = 1500;

/** "Saved" next to a field for a moment after it saved. */
function flashSaved(el: HTMLElement) {
  el.textContent = 'Saved';
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(setTimeout(() => (el.textContent = ''), SAVED_MS));
}

function setError(input: HTMLInputElement, errorEl: HTMLElement, text: string) {
  errorEl.textContent = text;
  if (text) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/**
 * Relays as chips with ×, plus an input that adds one on Enter or blur (PLAN-REDESIGN §8):
 * empty → nothing; valid → chip, input cleared, saved; already listed → input cleared;
 * invalid → text kept, error shown, nothing saved. Returns `replace`, used by "Load from NIP-65".
 */
export function mountRelayEditor(root: HTMLElement) {
  const chips = part(root, 'relays', 'chips');
  const input = part<HTMLInputElement>(root, 'relays', 'input');
  const errorEl = part(root, 'relays', 'error');
  const savedEl = part(root, 'relays', 'saved');
  let relays: string[] = [];

  function render() {
    chips.replaceChildren(
      ...relays.map((r) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.append(r);
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.setAttribute('aria-label', `Remove ${r}`);
        x.addEventListener('click', () => void save(relays.filter((v) => v !== r)).catch((e) => setError(input, errorEl, `Couldn't save: ${(e as Error).message}`)));
        chip.append(x);
        return chip;
      }),
    );
  }

  async function save(next: string[]) {
    await ready;
    const before = relays;
    relays = next;
    render();
    try {
      await patchSettings({ relays });
      flashSaved(savedEl);
    } catch (e) {
      relays = before;
      render();
      throw e;
    }
  }

  async function add() {
    const text = input.value.trim();
    if (!text) return setError(input, errorEl, '');
    const [relay] = parseRelayList(text);
    if (!relay || text.split(/[\s,]+/).length > 1) {
      return setError(input, errorEl, 'Enter one relay URL starting with wss:// (ws:// only for localhost).');
    }
    setError(input, errorEl, '');
    await ready;
    if (!relays.includes(relay)) {
      try {
        await save([...relays, relay]);
      } catch (e) {
        // the text stays, so it can be added again
        return setError(input, errorEl, `Couldn't save: ${(e as Error).message}`);
      }
    }
    if (input.value.trim() === text) input.value = '';
  }

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void add();
  });
  input.addEventListener('blur', () => void add());
  input.addEventListener('input', () => setError(input, errorEl, ''));

  // adding or loading relays waits for the saved list, so it can't replace it with a partial one
  const ready = settingsItem.getValue().then((s) => {
    relays = s.relays;
    render();
  });
  /** Replaces the whole list (Load from NIP-65); whatever was typed in the input is dropped. */
  async function replace(next: string[]) {
    await save(next);
    input.value = '';
    setError(input, errorEl, '');
  }
  return { ready, replace };
}

export const validBlossom = (v: string) => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

/** The Blossom server, saved on blur when it's an https:// URL; otherwise the old value stays saved. */
export function mountBlossomField(root: HTMLElement) {
  const input = part<HTMLInputElement>(root, 'blossom', 'input');
  const errorEl = part(root, 'blossom', 'error');
  const savedEl = part(root, 'blossom', 'saved');

  input.addEventListener('input', () => setError(input, errorEl, ''));
  input.addEventListener('blur', async () => {
    const s = await settingsItem.getValue();
    const v = input.value.trim().replace(/\/+$/, '') || DEFAULT_BLOSSOM;
    if (!validBlossom(v)) return setError(input, errorEl, 'The Blossom server must be an https:// URL.');
    setError(input, errorEl, '');
    input.value = v;
    if (v === s.blossomServer) return;
    try {
      await patchSettings({ blossomServer: v });
      flashSaved(savedEl);
    } catch (e) {
      setError(input, errorEl, `Couldn't save: ${(e as Error).message}`);
    }
  });

  // typing before the saved value loads would be overwritten by it
  input.disabled = true;
  return settingsItem.getValue().then((s) => {
    input.value = s.blossomServer;
    input.disabled = false;
  });
}
