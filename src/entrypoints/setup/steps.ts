import type { Step } from '../../identity/steps';

export type WizardKey = 'key' | 'address' | 'link';
export interface WizardStep {
  key: WizardKey;
  state: Step['state'];
  value?: string;
  warning?: string;
}

/**
 * The setup page's three steps from the identity tracker's four (PLAN-XOREACH): the X handle is asked with the
 * address, so step 2 is done when both are, and shows the address. A step after a step not done is never done
 * here; the first not done is the current one.
 */
export function wizardSteps(steps: Step[]): WizardStep[] {
  const by = Object.fromEntries(steps.map((s) => [s.key, s])) as Record<Step['key'], Step>;
  const done = {
    key: by.signer.state === 'done',
    address: by.handle.state === 'done' && by.address.state === 'done',
    link: by.link.state === 'done',
  };
  const out: WizardStep[] = [];
  let current = false;
  for (const key of ['key', 'address', 'link'] as const) {
    const src = key === 'key' ? by.signer : key === 'address' ? by.address : by.link;
    const isDone = done[key] && !current;
    const state = isDone ? 'done' : current ? 'todo' : 'current';
    if (!isDone) current = true;
    out.push({ key, state, value: isDone ? src.value : undefined, warning: src.warning });
  }
  return out;
}
