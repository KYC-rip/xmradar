# Changelog

What changed in each XMRadar release. Downloads, checksums and build provenance are on the
[releases page](https://github.com/KYC-rip/xmradar/releases).

## 0.6.13

- **xo anyone with a badge.** The heart no longer fades for X accounts that have a Monero badge but no Nostr key. Your xo goes to their X handle and waits on relays; when they set up XMRadar, it finds those xos and tells them once: "N Monero people sent your posts xos before you set up XMRadar". Every xo now names the author's handle as well as their key (an `X` tag, `twitter:<handle>`); earlier XMRadar versions still count xos sent to a key.
- **Set up in a minute.** Until your Monero identity is complete, a small card on X offers to set it up. It opens a new setup page in XMRadar: your Nostr key (your signer, or the XMRadar identity), your X handle and Monero address, and one proof tweet, which XMRadar fills in when it sees it on X. "Not now" hides the card for a week, × for good. After your first xo it says once that the xo counts after setup. In the toolbar popup, *Your tip badge* opens the same page until you're set up.
- **xo rings.** On X, the avatar of an account Monero people sent xos gets a thin orange ring, and its badge shows the total (`ɱ❤ 37`). xmr.bio counts them every 10 minutes and adds them to its signed directory: xos from Monero people, distinct posts, at most 10 per sender, so a soft public signal, not proof of distinct people. Switch: Options → Badges on X → *xo rings and counts*.
- With *Tell me when I get a Xap or an xo* on, XMRadar now also asks relays for xos to your proven X handle, not only to your key.

## 0.6.12

- **XMRadar identity.** No Nostr signer? XMRadar makes a Nostr key for you, kept in this browser only and announced with a notification, so xo, Xap receipts and the Monero identity steps work without one. Options → Monero identity chooses automatic, only your signer, or the XMRadar identity, and can export or delete it.
- **Listed on xmr.bio.** Once your X link verifies and you've published a Monero address, XMRadar lists you on xmr.bio (on by default; untick *Also list me on xmr.bio* in Options → Monero identity). It sends your handle, address, Nostr key and the proof tweet's id; no challenge tweet. Your badge then reaches XMRadar users through xmr.bio's directory, not only those with Nostr discovery on, and your xos count. You also get a wallet name, `yourhandle.oa.xmr.bio`, that OpenAlias wallets (Feather, Cake) resolve to your address, with DNSSEC. A *List me on xmr.bio now* button retries; on xmr.bio, Sign in with Monero to unlist or delete.
- **The proof tweet** XMRadar writes for you ends with "try it on: XMRadar.app".

## 0.6.11

- **xo: a Monero like.** A heart next to the Xap button on X posts sends the author a Monero like over Nostr. Hold it (or Shift+Enter) to also like the post on X; an option makes a plain click do both. Received xos count only from Monero people, notify you with the Xaps, and show on your own posts with a few floating hearts. Where an account has linked no Nostr key, the heart is faded and can only like on X.
- **Update badge.** The toolbar icon shows a green ↑ while a newer XMRadar is out.
- XMRadar no longer flags the example on nkips.org's NKIP-0001 page as an unreadable receipt.

## 0.6.10

- **Nostr ✓ on copied posts.** On X, a post you copied to Nostr gets a small *Nostr ✓* at its top right, in front of Grok's button. It opens the copy (notes on ros.rip, articles on njump). XMRadar keeps the post's id and the copy's reference for the last 1,000 copies, in this browser only. A thread is marked on its first tweet; posts copied before 0.6.10 aren't marked. Switch: Options → Posting to Nostr → Behaviour.

## 0.6.9

- **Sign in with Monero (NKIP-0003).** Click a `monero-signin:` link (on xmr.bio: *Any other wallet → Open in wallet*) and XMRadar opens its own window with the site, the account, the address, where the signature goes, when it expires and the full message to sign. Links that break the spec, have expired, or come from a page that isn't the site they sign in to are refused. Your wallet signs; XMRadar checks the signature (spend key only) and sends it to the site, without cookies. It holds no keys.
- **Signing guide.** Step-by-step instructions in that window for Feather, Monero GUI, Cake Wallet, monero-wallet-cli and monero-wallet-rpc, adjusted to the address (the GUI can't sign for a subaddress), with *Copy address* and *Save message as file*.
- **Swap records: Open order and View.** Each saved receipt and letter can go back to the exchange's order page (kyc.rip: `/track/<reference>`) and show what was signed: amounts, addresses, rate, times and policy, with the signature checked again. The salt is never shown.
- Quoted-post pictures no longer show XMRadar's own pills.
- Firefox: the chat sidebar no longer opens by itself after installing.

## 0.6.8

- **Chat.** Menu → Chat opens chat.xmr.club in Chrome's side panel or Firefox's sidebar: a lobby, an X room and a room for each site listed on xmr.club. Rooms change only when you pick one.
- Firefox: the quoted-post picture works again ("Couldn't take a picture of the quoted post").
- Menu: space under the Chat and New Xaps cards.

## 0.6.7

- **Relays that work out of the box.** With no relay list, posts go to damus, nos.lol, primal, nostr.mom and relay.ditto.pub; Options shows where your posts go and why.
- A switch to post only to XMRadar's relays instead of your NIP-65 list.
- A relay that failed 3 posts in a row is skipped for a day, and the results say which.
- Options → Updates: *Check now*.
- Options: the Xap notifications card is padded like the others.

## 0.6.6

- **Quote tweets** get the quoted post as a picture in the note (it can be unticked).
- Tags drop hyphens (`#selfcustody`), since clients end a hashtag at a hyphen.
- Includes 0.6.5, which was tagged but not released.

## 0.6.5

- **Xap notifications** (off by default): a check every 30 minutes for Xap receipts to your npub, with a notification and a list in Options.
- X Articles: images inside the text show on Primal.
- The daily update check no longer gets postponed by background restarts.

## 0.6.4

- The XMR pill on X profiles sits right after the name.
- The xmr.bio directory is fetched every hour, so new badges show within about an hour.

## 0.6.3

- X threads: each tweet's images sit right under it in the note.
- *Copy to Nostr* from the Share button at the bottom of an X Article copies the article.

## 0.6.2

- **Whole X threads** copy as one note (up to 50 posts).
- Saved receipts and letters show the exchange's logo.
- Fewer false "deposit address not found" warnings on pages past the deposit step.
- The receipt card on swap pages shows the XMRadar mark.
- Firefox: no more manifest warning about `use_dynamic_url`.

## 0.6.1

- **A daily update check**, since browsers don't update a zip install: one notification per new version, linking to its release page. Nothing is downloaded. Switch: Options → Updates.
