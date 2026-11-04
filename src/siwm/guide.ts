/**
 * How to sign the sign-in message in each wallet (PLAN-SIWM-GUIDE), for people whose wallet doesn't open
 * `monero-signin:` links. Every step was checked against the wallet's own source (November 2026):
 * Feather's SignVerifyDialog, the GUI's pages/Sign.qml, Cake Wallet's sign_form.dart, simplewallet's
 * `sign` and wallet-rpc's `sign`. Text only; rendered with textContent.
 */

/** a step is plain text with commands in between */
export type Part = string | { code: string };
export interface WalletGuide {
  id: string;
  name: string;
  /** shown above the steps when this wallet can't sign this message */
  warn?: string;
  steps: Part[][];
}

export interface GuideFor {
  /**
   * the address signing in is a subaddress, not the wallet's main address. In Monero only account 0 / index 0
   * is a standard address; every other one, other accounts' first addresses included, is a subaddress.
   */
  subaddress: boolean;
  /** the message has an `=` (a handle may), which Cake Wallet's paste button reads as a payment link */
  equalsSign: boolean;
}

const PASTE_BELOW = 'Paste the signature in step 2 below.';

export function walletGuides(g: GuideFor): WalletGuide[] {
  return [
    {
      id: 'feather',
      name: 'Feather',
      steps: [
        ['Open the wallet that holds this address, then Tools → Sign/verify message.'],
        ['Click Copy message here and paste it into Message.'],
        g.subaddress
          ? ['Address shows your main address, but this is a subaddress: click Copy address here and paste it over Address.']
          : ['Address should be the address shown above; if it isn’t, click Copy address here and paste it over Address.'],
        ['Click Sign, then Copy to clipboard. ' + PASTE_BELOW],
      ],
    },
    {
      id: 'gui',
      name: 'Monero GUI',
      warn: g.subaddress
        ? 'The GUI signs only with the wallet’s main address, and this is a subaddress. Use Feather, Cake Wallet or monero-wallet-cli instead.'
        : undefined,
      steps: [
        ['Open the wallet that holds this address. No Advanced in the left menu? Settings → Wallet → Close this wallet, then Change wallet mode → Advanced mode, and open the wallet again.'],
        ['Advanced → Sign/verify.'],
        ['Click Copy message here, paste it into Message, and click Sign Message. Or, to be sure of every line break: Save message as file here, switch Mode to File, Browse to the file and click Sign File.'],
        ['Copy the Signature. ' + PASTE_BELOW],
      ],
    },
    {
      id: 'cake',
      name: 'Cake Wallet',
      warn: g.equalsSign
        ? 'This message has an “=”, and Cake Wallet’s paste button treats it as a payment link and cuts the message. Use another wallet.'
        : undefined,
      steps: [
        ['Open the wallet that holds this address, then Settings → Other settings → Sign / Verify.'],
        ['Click Copy message here. In Cake, tap the paste icon in the Message field. Don’t type it or long-press to paste: that field is one line, so the line breaks become spaces and the signature won’t match.'],
        ['Click Copy address here and use the paste icon in the address field (or pick the address from your wallet’s list).'],
        ['Sign, then tap the signature to copy it. ' + PASTE_BELOW],
      ],
    },
    {
      id: 'cli',
      name: 'monero-wallet-cli',
      steps: [
        ['Click Save message as file here. It saves xmr-signin.txt with the exact message.'],
        g.subaddress
          ? ['In the wallet that holds this address, run ', { code: 'address all' }, ' to find this subaddress’s account and index, then ', { code: 'sign <account>,<index> /path/to/xmr-signin.txt' }, ' (for example ', { code: 'sign 0,3 ~/Downloads/xmr-signin.txt' }, ').']
          : ['In the wallet that holds this address, run ', { code: 'sign /path/to/xmr-signin.txt' }, ' (for example ', { code: 'sign ~/Downloads/xmr-signin.txt' }, ').'],
        ['Copy the line that starts with SigV2. ' + PASTE_BELOW],
      ],
    },
    {
      id: 'rpc',
      name: 'monero-wallet-rpc',
      steps: [
        ['Find the address’s indices with ', { code: 'get_address_index' }, ' and the address.'],
        ['Call ', { code: 'sign' }, ' with ', { code: 'data' }, ' set to the exact message (line breaks as \\n), ', { code: 'account_index' }, ', ', { code: 'address_index' }, ' and ', { code: '"signature_type": "spend"' }, '.'],
        ['Take ', { code: 'signature' }, ' from the result. ' + PASTE_BELOW],
      ],
    },
  ];
}

export const GUIDE_FOOTNOTE =
  'Another wallet? Look for “Sign message” or “Sign/verify”: it must sign with the spend key, for this address, and the message exactly as shown, line breaks included. View-only and multisig wallets can’t sign, and neither can hardware wallets in monero-wallet-cli. XMRadar never sees your keys.';
