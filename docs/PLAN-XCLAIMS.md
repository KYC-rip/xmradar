# X self-claims: Monero addresses and npubs in X bios and pinned posts (Phase 2g)

Draft 3, 2026-10-30: owner decisions in §6; OpenCode plan review (7.1) applied in §7.

## 0. Goal

Many X accounts show a Monero address or an npub in their bio or a pinned post, but have neither an xmr.bio profile nor a NIP-39 identity. This phase gives them a tip badge:

- **with no new trust root,**
- **with no new request that shows which accounts you look at.**

Today a badge comes from two sources (`src/identity/resolve.ts`):

- **xmr.bio:** the signed directory (K1, live from 2026-11-03) or a lookup you click.
- **Nostr NIP-39:** only with relay discovery on.

This adds a third, weaker source: what the account says about itself on X.

## 1. Why the account's own text is enough, and where it isn't

A bio and a pinned post can only be written by the account itself. An address there is the owner saying "pay me here". That is the same statement a NIP-39 proof tweet makes from the X side.

- A tip badge means "pay @foo".
- If @foo lists someone else's npub or address, only @foo's tips go astray. Someone with control of @foo could do that anyway.

So the X side alone is enough for a tip badge. What it doesn't give:

| Weakness | Handling |
|---|---|
| **Staleness.** The bio can change after XMRadar saw it. | Every entry stores when it was seen. The popup shows it ("from their X bio, seen 3 days ago"). Seeing it again refreshes it. Seeing the bio without it removes it. |
| **Context.** "Don't send to 4…, it's a scam" is also an address in a post. | Only the bio and the *pinned* post count, never any other post. A field with more than one distinct valid address or npub gives nothing (ambiguous). |
| **Nostr side unproven.** A bio npub isn't confirmed by a matching Nostr event. | Fine for a tip badge. Not used for Xaps (§6). |

Order of preference when sources disagree:

1. xmr.bio
2. verified NIP-39
3. bio
4. pinned post

The existing `differ` warning shows when the addresses differ.

## 2. Part A: XMRadar only, client-side (recommended first)

**No server, no new network traffic for addresses.** The content script already sees the bio and pinned post when you open a profile or a hover card. It reads them there and keeps what it found locally.

### A1. Where it reads (content script, `x.com` only)

| Place | Element | Bound to the handle by |
|---|---|---|
| Profile page `/<handle>` | `[data-testid="UserDescription"]` in the primary column | the page path and the `UserName` handle, which must agree (as `profileSlot` does) |
| Hover card | `[data-testid="UserDescription"]` inside `[data-testid="HoverCard"]` | the card's own handle link (as `hoverCardSlot` does) |
| Pinned post on `/<handle>` | the timeline `article` whose social context marks it as pinned | the article's author link, which must be `<handle>` |

- **Text only.** It reads the element's text, with these inside the field excluded:
  - the quoted post (`[data-testid="tweetText"]` of a nested quoted card, and the quote container);
  - link cards;
  - alt text.
- **Pinned marker, locale-independent.** The pinned marker must not depend on the word "Pinned" (X is localised).
  - The spike (A0) picks the marker: the social-context icon's path or a `data-testid`, plus "it is the first article and its author is the profile".
  - If no reliable marker exists, the pinned post is dropped from Part A, and only bios count.
- **X-shortened links.** Addresses in `t.co` links aren't read. Only visible text counts, and an address in a URL is shown truncated by X anyway.

### A2. What it accepts

**Monero addresses:**
- Mainnet standard or subaddress, checked with `validateMoneroAddress` (checksum, network).
- Integrated addresses are refused, as `xapEntry` already does.
- Testnet and stagenet are refused.
- Matched on base58 word boundaries, so an address glued to other text isn't half-read.

**npubs:**
- `npub1…` that decodes to 32 bytes.
- `nprofile1…` is also accepted, and only its pubkey is used.

**Rules per field:**
- Exactly one distinct address or one npub per field, or nothing from that field.
- A field with one address *and* one npub keeps both: the address is the badge, and the npub is kept for the popup.

### A3. What it stores

`local:xClaims`: one entry per normalised handle:

```
{ handle,
  bio?:    { address?, npub?, seenAt, confirmedAt },
  pinned?: { address?, npub?, tweetId, seenAt, confirmedAt } }
```

- **`seenAt`:** when this exact value was first seen.
- **`confirmedAt`:** the last time it was seen again.
  - A changed value starts a new `seenAt`, so "address changed today" stands out, like K4's `address_updated_at`.
- **Removal:**
  - Removed when the same place is seen without a claim: a bio without one, or a pinned post without one, or no pinned post at all.
  - A hover card can only update or remove `bio`.
- **Limits:**
  - At most 1000 handles; the oldest `confirmedAt` is dropped first.
  - An entry not confirmed for 30 days is dropped.
- Writes go through the background, as the badge cache does, so two tabs can't overwrite each other.
  - Message: `x-claims-seen {handle, place, claim | null}`.
  - The sender must be a tab on `x.com`. Same rules as other content-script messages: sender check and a size cap.

### A4. Turning a claim into a badge

- **Address claim → entry.** It becomes a `BadgeEntry` with:
  - `source: 'xself'`, `method: 'x-bio'` or `'x-pinned'`;
  - `verified: true`, `check` from the validator;
  - `seenAt`/`confirmedAt` for the popup;
  - `tweetId` for a pinned post.
- **npub claim → entry.** It gives a badge only with relay discovery on, which already means relay traffic:
  - It reads the npub's 10133 with the existing `fetchPayto`. The first valid Monero payto becomes the entry's address (`method: 'x-bio-npub'`).
  - With discovery off, the popup shows the npub, with no badge from it.
- **Merge.**
  - `mergeBadge` gets the third tier: xmr.bio, then NIP-39, then bio, then pinned.
  - `withoutNostr` keeps `xself` address entries and drops npub-derived ones.
  - The badge cache key stays the handle. A new or changed claim clears that handle's cached badge, so the next scan picks it up.
- **Popup.** The tip popup says where the address came from:
  - "From @foo's X bio, seen <date>";
  - "From @foo's pinned post (link), seen <date>";
  - plus the existing "addresses differ" warning when sources disagree.

### A5. Setting

- Options → Badges on X, a new switch: **"Read Monero addresses and npubs from X bios and pinned posts (stays on this device)"**.
- Off: nothing is read or stored, and turning it off clears `xClaims`.
- Default: on (§6).

### A6. Tests

**Parser (unit, saved X DOM fixtures):**
- A bio with one address → claim.
- Two different addresses → none.
- The same address twice → claim.
- An integrated address, testnet, or a bad checksum → none.
- An npub; an nprofile; an npub plus an address.
- An address in a quoted post inside the pinned post → none.
- An address only in a non-pinned post → none.
- A hover card for @a inside @b's page → bound to @a.
- A profile path/`UserName` mismatch → none.

**Store:**
- A new value starts `seenAt`; seeing it again only bumps `confirmedAt`.
- A changed value resets `seenAt`.
- Seen without a claim → removed.
- The cap and the 30-day expiry.
- A hover card can't remove `pinned`.

**Merge:**
- The tier order; `differ` with xmr.bio.
- `withoutNostr` keeps a bio address and drops a bio-npub payto.
- An npub with discovery off gives no badge.

**Messages:**
- A non-x.com sender is refused; an oversized payload is refused.
- The switch off → nothing stored, and the store is cleared.

**Live (Chrome and Firefox):**
1. On a profile with an address in its bio: badge, and the popup source line.
2. Change your own bio and reload: the entry updates.
3. Remove it from the bio and reload: it's gone.

Test accounts are your own (@XBToshi) plus a public account; fixtures are saved without other users' data.

### A0. Spike first (read-only, about 30 minutes)

In the mnr_network tab (English) and one non-English session:
- Find a locale-independent pinned-post marker.
- Check that `UserDescription` holds the full bio text, with t.co links rendered as text.
- Check the hover card's description.

The spike's result decides whether the pinned post is in Part A.

## 3. Part B: kyc-rip, server-side (optional, later)

Part A only knows profiles you have opened or hovered. Badges for accounts you've never opened would need the server to read bios and publish them in the signed directory.

**Sketch (K7, not designed yet):**
- A directory section `x_self: [{handle, address?, npub?, place, tweet_id?, seen_at, checked_at}]`, apart from `entries` and `nip39`.
- **Where handles come from:** a submission on xmr.bio ("this account shows its address in its bio"). The bio itself is the proof, so anyone can submit.
- **Rechecks:**
  - Weekly; a removed claim drops out.
  - Needs to read X profiles from Workers. oEmbed has no bios, so this means Grok or the X API (cost, rate limits). The K6 spike already tests whether X answers Workers.
- **Privacy decision, like K1:** listing accounts that never used xmr.bio in a public, downloadable directory makes them more findable, even though each bio is public. Needs your decision: anyone submits, or only the owner, via the xmr.bio login.
- **Rejected:** XMRadar reporting what it found to the server. That would tell xmr.bio which profiles you open.

Part B is a separate plan and review in kyc-rip, after Part A ships and only if you want it.

## 4. Threats

| Threat | Mitigation |
|---|---|
| A claim attributed to the wrong account (hover card, quoted post, reposted pinned post) | binding by handle link and author link (A1), quoted content excluded, tests with fixtures |
| A scam address in a post's text | only bio and pinned; one-distinct-value rule |
| An account changes its address to a thief's after being hacked | that's the account speaking, as with any source. The popup shows "seen today" for a new value, and `differ` shows when xmr.bio disagrees |
| A page script on x.com edits the DOM | x.com is X itself; XMRadar already trusts its DOM for handles |
| Look-alike handles | the badge only shows on that exact handle, as today |
| Storage growth | cap of 1000, 30-day expiry |
| Leaking what you browse | no requests for addresses; npub payto only with discovery on (already disclosed); nothing sent to xmr.bio |

## 5. Order

| # | Step | Network | Review |
|---|---|---|---|
| A0 | Spike: DOM markers | none | report to you |
| A1–A3 | Parser, store, messages | none | code review |
| A4–A5 | Merge, popup source line, setting | relays for npub, discovery only | code review |
| A6 | Live test, Chrome and Firefox | none | — |
| B | kyc-rip K7 | X from Workers | own plan, your approval |

## 6. Decisions (owner, 2026-10-30)

1. **The switch defaults to on.** It stays on the device and makes no requests.
2. **No Xaps to a bio npub.** Xaps stay with NIP-39 identities. A later NKIP-0002 note may allow X-side-only links.
3. **Pinned posts are in,** if the spike (A0) finds a locale-independent marker. Otherwise bios only.
4. **Part B is later and separate.** Who may submit a handle is decided in its own plan.

## 7. Plan review round 1 (OpenCode, passed 7.1): changes

These override the sections above where they differ.

- **X1, context.** A lone address can still be a warning ("scam address: 4…").
  - X self-claims are a labelled, weaker tier. The badge pill is the same, but the popup heads the entry "Self-claim on X (not verified)", with the source and date. It never outranks xmr.bio or a verified NIP-39 entry.
  - A field is skipped when a warning cue appears in it. The cue list starts with: scam, fake, impersonat, don't send, do not send, never send, not my, stolen, hacked. It's matched case-insensitively, English only.
  - The fixtures include a single-address scam warning, in a bio and in a pinned post.
- **X2, removal only after a complete look.**
  - Removal of `bio` happens only on a profile page whose `UserName` and `UserDescription` are both in the primary column and whose handle matches the path. A profile with no bio has no `UserDescription`; then `UserName` plus the rendered profile timeline must be present.
  - Removal of `pinned` happens only after the first timeline article has rendered and stayed for 1 s. That article is not pinned, or is pinned without a claim.
  - Hover cards never remove; they only add or refresh `bio`.
  - Fixtures: partial and lazy profiles, no bio, no pinned post, a truncated hover card.
- **X3, both caches.**
  - The `x-claims-seen` reply tells the sending tab whether the handle's badge changed.
  - The background clears its cached badge for that handle, and broadcasts `badge-invalidate {handle}` to x.com tabs.
  - The content script drops that handle from `results` and rescans.
  - Test: a changed bio re-renders the badge without waiting out the 6-hour TTL.
- **X4, one value per type.**
  - A field yields at most one Monero address (standard or subaddress) and at most one public key.
  - npub and nprofile are compared by their pubkey.
  - Two different addresses, or two different pubkeys, make that type empty; the other type is unaffected.
  - Any integrated address in the field makes the address type empty: it's ambiguous whether it's the one meant.
  - Tests for each combination.
- **X5, profile binding.** `profileSlot` only reads the path today. For claims, a new `profileClaimScope`:
  - The path must be exactly `/<handle>` (or `/<handle>/with_replies`, `/media`, `/likes`, where the header is shown too).
  - The `UserName` in the primary column must show `@<handle>`.
  - The `UserDescription` must be inside the same primary column.
  - Status pages, mentions and stale columns are refused, with a fixture for each.
- **X6, store maintenance.**
  - `xClaims` is `{v:1, entries}`.
  - Expiry and the cap run on every background read and write of the store; no alarm is needed.
  - A new pinned `tweetId` with the same value refreshes `confirmedAt` and stores the new `tweetId`. `seenAt` stays.
  - Handles are normalised as everywhere else (`normalizeHandle`), and pubkeys are kept as lowercase hex.
- **X7, tests added.**
  - Pinned binding by author; a quoted post and a reposted post inside the pinned slot.
  - Partial-DOM removal; cache invalidation; npub plus nprofile for the same key; pinned replacement.
  - The tier order with the bio npub's payto; the popup source line.
  - A network spy proving an address-only bio makes no request; a discovery-off npub gives no badge and no relay request.
- **Pinned posts.** Unchanged: in only if A0 finds a reliable marker. Bios ship first either way.

## 8. A0 spike result (2026-10-30, Chrome, two English sessions)

- **Pinned marker found, locale-independent.**
  - X marks the pinned post with a `[data-testid="socialContext"]` row holding a pin icon. The icon's `svg path` `d` starts `M13 21l-1 2-1-2v-5H4.5v-2.287` (the same on @XBToshi and @xmr_club).
  - The context isn't inside a link. A repost's context links to the reposter.
  - The label text ("Pinned") is localised and is not used.
  - Rule: the article is the first `article[data-testid="tweet"]` in the primary column; it has a `socialContext` whose row icon starts with that path and isn't inside an `<a>`; and its `User-Name` author link is `/<handle>`.
  - If X changes the icon, pinned claims stop being read (fail closed), and bios keep working.
- **Quoted posts.** A quoted post sits inside a `div[role="link"]` with its own `tweetText`. Only the article's top-level `tweetText`, not inside a `div[role="link"]`, is read.
- **Profile bio.** `[data-testid="UserDescription"]` sits in `primaryColumn`, next to `UserName` ("Name\n@handle"), so the `@handle` line can be matched against the path. Links render split across lines (`http://\nwalls.rip`). That doesn't matter for addresses or npubs, which X doesn't linkify.
- **Hover cards: dropped from Part A.** The card has no `UserDescription` test id. Its bio is an unlabelled `div`, next to other text with handle links ("Automated by @XBToshi", "Followed by …"). Reading it would mean guessing which block is the bio. Profile pages only; the A3 rule that a hover card never removes no longer applies.
- **Not seen:** a repost in a profile timeline within 10 screens on @XBToshi, @xmr_club and @monero. The repost rule (a context inside a link, a different icon) comes from the markup above. The fixtures get a hand-made repost, and the live test checks one.

## 9. An xmr.bio link in the bio or pinned post counts as a Monero address (owner, 2026-10-30)

Example: @franz_fk19's bio says "Monero: xmr.bio/franz_fk19". The account points to its xmr.bio profile, and that profile holds a Monero address signed by xmr.bio. So the link is a claim like an address in the bio, one step removed.

- **What is read.**
  - The visible link text in the bio or pinned post (X shows `xmr.bio/<name>`, often split as `http://` + `xmr.bio/<name>`; the `href` is a `t.co` link and isn't used).
  - Accepted forms: `xmr.bio/<name>`, with or without `http(s)://` and `www.`, and an optional trailing `/`, where `<name>` matches `^[A-Za-z0-9_]{1,15}$`.
  - Text X cut short (ending in `…`) is refused.
- **What it gives.** A claim `{ xmrbio: <name> }`, kept with the address and npub in `local:xClaims`, under the same rules:
  - one value per type, so two different xmr.bio links make that type empty;
  - the warning-word skip;
  - removal after a complete look;
  - the 30-day expiry.
- **From link to address, without telling xmr.bio what you view.**
  - The address comes from the signed directory that 2d downloads whole: the entry for `<name>`.
  - No per-handle request is made when a link is seen. An automatic `/resolve` would tell xmr.bio which profile you opened.
  - `<name>` isn't in the directory (not listed, or not verified): no badge. The tip popup offers the existing one-click "Look up on xmr.bio".
  - Before 2d ships (directory live 2026-11-03): no badge from links; the popup shows the link with the one-click lookup.
- **Badge and order.**
  - `<name>` equal to the X handle: the account already has its xmr.bio entry from the directory. The link adds nothing, and the badge source stays "xmr.bio".
  - `<name>` different (for example @foo links `xmr.bio/foo_tips`): a self-claim entry, `method: 'x-bio-xmrbio'` or `'x-pinned-xmrbio'`. The popup says "From @foo's X bio: links xmr.bio/foo_tips (address signed by xmr.bio)". It ranks with the bio and pinned tier: below xmr.bio's own entry for @foo and verified NIP-39.
  - Within a field, a direct address wins over an xmr.bio link if both are present and differ, and `differ` is shown.
- **Tests.**
  - The link forms, both split and whole.
  - A cut-short link is refused.
  - A link to the same handle adds no second entry.
  - A link to another handle that is in the directory → badge with the right source line.
  - Not in the directory → no badge, and the popup shows the lookup button.
  - Two different links → none.
  - A network spy: seeing a link makes no request.
- **Order.** This lands with or after 2d, since it needs the directory. The address and npub parts don't wait for it.

## 10. The profile's Website field (owner, 2026-10-30)

Many accounts put their xmr.bio link in the profile's Website field rather than the bio: @Mr_XMR_, @Zeegirl_4 and @R3st4rtY0urL1f3 link `https://xmr.bio/<handle>` there.

- **Read too, as a third place:** `[data-testid="UserUrl"]` in the profile header, on the same profile pages and with the same binding (§7 X5). Only its visible text is read: X shows `xmr.bio/Mr_XMR_` and links it through `t.co`.
- **Only an xmr.bio link counts there.** The field holds one URL, so it never holds a Monero address or an npub. A bare address or npub in it is ignored.
- **Same rules as §9:**
  - The address comes from the downloaded directory, with no request.
  - Text X cut short is refused.
  - Removal happens after a complete look at the header: the field is gone, or it holds another URL.
- **Order:** the Website field ranks with the bio, ahead of the pinned post. Two different xmr.bio names across bio and Website: the bio wins, and `differ` is shown.
- **Tests:**
  - A Website-field fixture with `xmr.bio/Mr_XMR_`.
  - Another URL there → nothing.
  - A Website link and a bio address that differ.
  - The field removed → the claim is removed.
