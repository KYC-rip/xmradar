/**
 * What pages and the popup need of a lookalike warning (PLAN-LOOKALIKE §7), kept apart from the matcher
 * so the content script doesn't carry the suffix list and the confusables table.
 */

export type LookalikeKind = 'listed-phishing' | 'segment' | 'homoglyph' | 'typo' | 'same-name';
export interface Lookalike {
  kind: LookalikeKind;
  /** the listed registrable domain (`trocador.app`) */
  imitates: string;
  /** the host the "Go to" link opens, from the feed only */
  target: string;
  /** the listing's name */
  name: string;
}

/** The banner and popup wording for a lookalike. */
export function lookalikeText(l: Lookalike): string {
  if (l.kind === 'listed-phishing') return `xmr.club lists this site as a phishing copy of ${l.target} (${l.name}).`;
  if (l.kind === 'same-name') return `This site has the same name as ${l.target} (listed on xmr.club as ${l.name}) on another domain. If you meant ${l.target}, go there.`;
  return `This site's name looks like ${l.target} (listed on xmr.club as ${l.name}), but it isn't. Copies of exchange sites take the coins you send.`;
}

/** The "Go to" link: built from the feed's host only. */
export const lookalikeHref = (l: Lookalike) => new URL(`https://${l.target}/`).href;
