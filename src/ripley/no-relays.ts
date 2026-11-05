/**
 * `nostr-tools/pool` and `nostr-tools/relay` in the Ripley builds: no relay connection is ever opened from
 * them. The service's relay reads come only through the `query` RipleyOS injects (R15); the X bundle reads no
 * relays at all. Anything that still reached for a pool fails loudly instead of connecting.
 */
const refuse = () => {
  throw new Error('XMRadar in Ripley opens no relay connections of its own');
};
export class SimplePool {
  constructor() {
    refuse();
  }
}
export class AbstractSimplePool extends SimplePool {}
export class Relay {
  constructor() {
    refuse();
  }
  static connect() {
    return refuse();
  }
}
export class AbstractRelay extends Relay {}
export const useWebSocketImplementation = refuse;
