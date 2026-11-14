# PLAN-XAPINBOX: tell me when I get a Xap

## Why
Getting a tip is what makes people keep their badge set up. Today a recipient only learns of a Xap by
opening their own badge's popup. The user asked for a notification when a Xap receipt (NKIP-0002 kind
9042) to them appears on Nostr.

## What it is, and isn't
- A receipt is the **tipper's claim**, signed by the tipper. Anyone can publish one for free, and XMRadar
  can't see the user's wallet. So every notification and list line says "says they sent", and the list
  shows each receipt's state from the existing counting rules (`countXaps`): verified (a kind 9044 from
  the user's wallet), claimed, or not counted.
- XMRadar doesn't confirm (kind 9044) or prove anything; that stays with the wallet.

## Privacy (the reason it's opt-in)
Asking relays for receipts tagged with the user's npub (`{"kinds":[9042],"#p":[me]}`), on a schedule,
tells those relays that this IP watches that npub, which links the IP to the user's Nostr identity.
XMRadar does nothing like that today without a click. So:
- **Off by default.** Switch: Options → Badges on X → "Tell me when I get a Xap", with the hint: "Every 30
  minutes, asks your relays and 3 public relays (damus, nos.lol, primal) for Xaps to your npub. They can
  see that this browser watches your npub." Under the switch, while on: "Asking N relays" with the list
  in a details line.
- Offered only once XMRadar knows the user's key (`pubkeyItem`, set by Test signer or a publish);
  otherwise the switch is disabled with "Connect your signer under Monero identity first." The switch is
  synced, so it can be on in a browser with no key yet: the keeper runs only when both are there, and
  **watches both** (`xmrSettingsItem` and `pubkeyItem`), so a key that appears later starts it, and a key
  that changes or goes away clears the state (and a new key starts a new baseline).
- Relays asked: the user's own (`resolveRelays`: the configured ones, else their NIP-65 write relays)
  plus `DEFAULT_RELAYS` (damus, nos.lol, primal), since XMRadar publishes every receipt there too. At
  most 8 relays; no index relays (they don't keep kind 9042).
- One short query each time (the same pool query as the Xap counts, 4 s max wait), never a standing
  subscription. It follows the browser's proxy or Tor settings like every other request.

## Schedule (src/xap/inbox.ts, a keeper like `updateKeeper` and `directoryKeeper`)
- Alarm `xap-inbox`, every 30 minutes while the switch is on and a pubkey is known. It's made only when
  missing or set with another period, so worker starts don't restart its countdown (the 0.6.4 lesson).
  Turning the switch off or the key going away clears the alarm and drops the kept state.
- At worker start with the switch on: check now if the last check is more than 30 minutes old.
- **Baseline, no flood.** State starts with `baseline: 'pending'`. While pending, a check marks every
  receipt it finds as seen and notifies nothing (the list still shows them). Only a **successful** check
  ends it: at least one relay answered the receipt query with EOSE in time. Each relay is read with the
  existing `readRelay` (it throws without EOSE), not the pool query, so success can be told from silence.
  A check where no relay answered changes nothing but `checkedAt` and `error`, baseline or not.

## A check
1. Per relay (`readRelay`, 4 s): `{"kinds":[9042],"#p":[me],"since":S,"limit":200}`, plus the user's own
   kinds 0/10002/10133 (`fetchProfiles([me])`) for their current address. S = the last **successful
   check's time** minus 2 days (relays can be slow to receive a receipt; a receipt's own `created_at`
   never moves the window, so fake dates can't shift it), or now minus 30 days for the baseline.
2. The user's own 9044s and deletions for the receipts found (`authors:[me]`, `#e`), so the list can show
   verified. That's the same as `fetchXapEvents`, limited to these receipts.
3. Each receipt must pass: a valid signature, `parseReceipt`, the recipient is the user, the tipper isn't
   the user, `created_at` within S and no more than 10 minutes in the future, and its **address is the
   user's current one** (the counting rule R10; a receipt to an old or wrong address is ignored).
4. **Exactly one target**, decided before anything else uses it:
   - an X post: `postOf(ev)` gives one (no `e`, exactly one canonical `i`, exactly one `k` = `web`);
   - a note: exactly one valid `e` and no `i` or `k`;
   - the profile: no `e`, `i` or `k` at all;
   - anything else (both `e` and `i`, a malformed `i` or `k`, a non-canonical X URL) is dropped.
   The target key is `post:<status id>`, `note:<event id>` or `profile`.
5. **Seen** is a list of `[receipt id, created_at]`, pruned to receipts still inside the window (created_at
   ≥ S − 1 day), so an id is only forgotten once it can no longer come back in a query. At most 20
   receipts per tipper are taken per check (the rest are dropped unseen and un-notified), and seen is
   capped at 2000 as a backstop.
6. **One per tipper and target, per 24 hours**, from its own **ledger**: `notified` = `[tipper, target key,
   at]`, kept 24 hours, capped at 500. A new receipt whose tipper and target are in the ledger is listed
   but not notified. The ledger is separate from seen and from the 50-item list, so neither one's churn
   can bring a notification back.
7. Tipper names: one REQ for the new tippers' kind 0 (at most 20 authors). `display_name` or `name`,
   NFC-normalised, with every control, format (zero-width, bidi), line- and paragraph-separator character
   removed (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`), whitespace runs collapsed to one space, and cut to 24
   graphemes (`Intl.Segmenter`) with "…". An empty result falls back to no name. Every line also shows the
   short npub (`npub1abcd…wxyz`), because names are chosen by the tipper.

Known limit: npubs are free, so a flood of receipts from many new keys could fill a check's 200 and push
real ones out of that check. They'd still come in a later check while inside the window, the
notification stays one per check, and the list shows the flood for what it is.

## The notification
- At most one per check, id `xmradar-xap` (a new one replaces the old one):
  - one Xap: "‘Alice’ (npub1abcd…wxyz) says they sent you 0.01 XMR for an X post."
    ("for your profile" / "for a Nostr note"). Never "your post": a receipt can name any post, and
    XMRadar doesn't check who wrote it.
  - several: "3 new Xaps: ‘Alice’, ‘Bob’ and 1 more say they sent you 0.03 XMR in total."
  - The text never includes anything else from the event, and never a URL.
- Click: always opens Options at the Xaps received list (never a post a tipper chose), and clears the
  notification and the unread count.

## Where you see them
- **Options → Badges on X → Xaps received:** the newest 50 (kept in local storage). Each line shows the name,
  the short npub, the amount, the target ("X post" with a link `x.com/i/status/<id>` built from the checked
  id and labelled "named by the tipper", "profile" or "Nostr note"), the time, and the state (verified / claimed /
  not counted, from `countXaps` over what the check fetched). Plus "Checked 12 minutes ago" or the last error,
  and a "Check now" button, at most once a minute.
- **Popup menu:** a line "2 new Xaps" while there are unread ones, which opens that list.

## Stored (local, never synced)
`local:xapInbox`: `{ pubkey, baseline: 'pending' | 'done', okAt (last successful check), seen: [id,
created_at][] (window-pruned, ≤ 2000), notified: [tipper, target, at][] (24 h, ≤ 500), items: Item[]
(newest 50), unread, checkedAt, error? }`. Deleted when the switch goes off or the key changes. The switch itself is `xapNotify?: boolean`
in `xmrSettingsItem` (read with `xapNotifyOn`, off unless set).

## Tests (vitest)
- inbox filtering: a receipt to another key, to an old address, a self-tip, one from the future or
  before S, a bad signature, or a duplicate id is dropped.
- targets: post (canonical `i` + `k`=web), note (`e` only), profile (none); dropped: `e`+`i`, `i` without
  `k`, `k` other than web, two `i`, a non-canonical X URL.
- ledger: a second receipt from the same tipper and target within 24 h isn't notified, also after 60 other
  receipts pushed it out of the list; after 24 h it is.
- seen: an id inside the window is never pruned (a replay doesn't notify again); 25 receipts from one
  tipper → 20 taken; ids older than the window are pruned.
- baseline: pending notifies nothing; a check where every relay fails keeps it pending, and the next
  successful one is still a baseline; after it, new receipts notify.
- `since` = last successful check minus 2 days, unaffected by receipt dates; 30 days for the baseline.
- name cleaning: control, zero-width, bidi, line/paragraph separators, newlines, NFC, the 24-grapheme cut
  (an emoji family counts as one), empty → no name.
- notification text for one and several Xaps, with "for an X post" (never "your post"); click opens the list.
- keeper: the alarm is made only when missing or at another period; switch on with no key does nothing
  until a key appears; a key change clears the state and starts a new baseline; switch off clears the alarm
  and state; a start more than 30 minutes after the last check runs one.

## Docs
README: a "Xap notifications" paragraph under Xap, including the privacy line. The options hint as above.

## Not in scope
A minimum amount, muting a tipper, the tipper's X handle (it would need a NIP-39 check per tipper),
confirming a Xap from XMRadar, and notifications for Xaps sent by the user.

## Amendment after plan review round 2 (7.3 pass)
- **Baseline needs the address.** A check counts as successful only when a relay answered the receipt
  query with EOSE **and** the user's current address is known. With no address published, the switch
  shows "Publish your Monero address under Monero identity first" and nothing is checked, notified or
  marked. Without an address no receipt can pass, so ending the baseline then would let old ones notify
  later.
- **A check is a generation.** The keeper bumps a generation on every switch, key or address change.
  After each await, a check from an older generation writes nothing and notifies nothing.
- **Caps never evict.** `seen` and `notified` are pruned only by expiry (window and 24 h). If one is full
  (5000 seen, 2000 ledger), receipts beyond it in this check are **deferred**: not seen, not listed, not
  notified. They come back in a later check while still inside the window. So an entry is never forgotten
  while it can still return. The same goes for the per-tipper 20: the excess is deferred, not dropped.
- **Counts.** The notification's count and total cover only the receipts it notifies. Unread counts every
  newly listed receipt, including ones held back by the ledger.
- **Accepted limit.** If one relay answers and others fail during the baseline, a receipt that only a
  failed relay holds, from the last 2 days, can notify later. It's a real receipt the user hadn't been
  told about, so that's acceptable.
