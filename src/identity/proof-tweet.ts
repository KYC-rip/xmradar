/** The X post that links an X account to a Nostr key (NIP-39): the npub as a whole word, then where it's from. */
export const proofTweetText = (npub: string) => `Verifying that I control the following Nostr public key: ${npub}\n\ntry it on: XMRadar.app`;
