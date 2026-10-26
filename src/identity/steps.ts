import type { SetupStatus } from '../messaging';

export type StepKey = 'signer' | 'handle' | 'address' | 'link';
export type StepState = 'done' | 'current' | 'todo';

export interface Step {
  key: StepKey;
  state: StepState;
  /** one line shown when done: the npub, @handle or short address */
  value?: string;
  /** why a step that was started isn't done (invalid address, failing proof tweet) */
  warning?: string;
  /** steps 3 and 4 can't be judged before a status check */
  unchecked?: boolean;
}

const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-8)}`;

/**
 * The identity setup tracker (PLAN-REDESIGN §4): which of the four steps are done, and which
 * one is next. `status` must already be the check for this signer key (see `statusFor`).
 */
export function identitySteps(i: { npub: string | null; handle: string | null; status: SetupStatus | null }): Step[] {
  const s = i.status;
  const steps: (Omit<Step, 'state'> & { done: boolean })[] = [
    { key: 'signer', done: !!i.npub, value: i.npub ? short(i.npub) : undefined },
    { key: 'handle', done: !!i.handle, value: i.handle ? `@${i.handle}` : undefined },
  ];
  if (!s) {
    steps.push({ key: 'address', done: false, unchecked: true }, { key: 'link', done: false, unchecked: true });
  } else {
    const a = s.address;
    steps.push({
      key: 'address',
      done: !!a?.check.ok,
      value: a?.check.ok ? short(a.address) : undefined,
      warning: a && !a.check.ok ? `The published address is invalid (${a.check.reason}).` : undefined,
    });
    const l = s.link;
    const proof = l?.proof;
    steps.push({
      key: 'link',
      done: proof?.status === 'verified',
      value: proof?.status === 'verified' ? `@${l!.handle}` : undefined,
      warning:
        proof && proof.status !== 'verified'
          ? proof.status === 'error'
            ? `X couldn't be reached to check the tweet (${proof.reason}).`
            : `The proof tweet fails (${proof.reason}).`
          : undefined,
    });
  }
  let current = false;
  return steps.map(({ done, ...rest }) => {
    if (done) return { ...rest, state: 'done' as const };
    if (!current) {
      current = true;
      return { ...rest, state: 'current' as const };
    }
    return { ...rest, state: 'todo' as const };
  });
}

export const doneCount = (steps: Step[]) => steps.filter((s) => s.state === 'done').length;
