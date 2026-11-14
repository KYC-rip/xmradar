# PLAN-NAMESERVER: OpenAlias names for every listed xmr.bio profile, from a box of our own

## Why
Cloudflare's free zone for xmr.bio holds at most 200 DNS records (100+ used). Each xmr.bio sign-up takes one
(`<handle>.xmr.bio` TXT, OpenAlias); XMRadar listings get none (`registerNostr.ts`), and new sign-ups stop at 180
(the reserve). The user decided the 0.6.12 release (XMRadar identity, xmr.bio auto-listing, landing pages) waits
until wallet names come from a nameserver we run.

## Facts
- Box: Servitro VPS "ns1", Debian 13 Minimal, 1 vCore, 1 GB RAM (+512 MB swap), 10 GB SSD, 1 TB traffic, IPv4 + IPv6,
  root by SSH key only (the panel installed the user's key). Nothing else runs on it.
- Source of truth: `GET https://api.kyc.rip/v1/bio/directory` → `{ payload, signature, public_key, alg }`, ed25519
  over the exact payload bytes, key pinned in XMRadar (`fb9c9025…dff94`). Payload `{ v: 1, service: "xmr.bio",
  generated_at, count, entries: [{ handle, address, verified_at, nostr_pubkey? }] }`: every profile with
  `directory_listed = 1` (sign-ups and XMRadar listings alike), rebuilt by the API's cron.
- OpenAlias record: TXT `oa1:xmr recipient_address=<address>; recipient_name=<name>;` (as `oaContent` in
  `openalias.ts`). Wallets (Feather, Cake, Monerujo, GUI) check DNSSEC and warn without it.
- Checked 2026-11-05: xmr.bio is DNSSEC-signed (DS `2371 13 2 …` in .bio; 1.1.1.1 answers with AD), so an `oa` DS
  in Cloudflare completes the chain. The directory endpoint adds `X-Directory-Stale: 1` when its build is older
  than 30 min. The API has a `*/30` cron.
- Where it lives: config, sync script and tests in kyc-rip, `ops/oa-ns/` (private repo), deployed to the box by
  `scp` + a short install script; nothing on the box is edited by hand.

## Design
1. **Names:** a delegated subzone, `oa.xmr.bio` (name to be confirmed by the user): `<handle>.oa.xmr.bio` TXT for
   every directory entry, `recipient_name=<handle>`. Existing `<handle>.xmr.bio` records on Cloudflare stay as they
   are (no migration).
2. **Server:** Knot DNS from Debian's own packages, authoritative only (it has no recursion), on 53/udp and
   53/tcp, IPv4 and IPv6. One zone, `oa.xmr.bio`, SOA + NS + TXT records; ANY answered minimally; response rate
   limiting (Knot's `mod-rrl`) on; systemd `MemoryMax=256M`, `CPUQuota=50%` so it can't starve the box.
3. **DNSSEC:** Knot's automatic signing with a **single CSK** (combined signing key: `single-type-signing: on`),
   ECDSA P-256 (algorithm 13, small answers), NSEC (the names are public in the directory anyway, so zone walking
   reveals nothing new). No automatic key rolls (`ksk-lifetime: 0`); RRSIGs are refreshed automatically. The DS in
   Cloudflare's xmr.bio zone is the CSK's digest (SHA-256); Cloudflare already signs xmr.bio, so the chain is
   complete. A roll is manual: new CSK published, new DS added, old DS removed after its TTL, old key retired;
   then a new key backup. The key backup covers exactly this one CSK.
4. **Sync:** a small Python 3 script (Debian's `python3-nacl` for ed25519, `python3-pycryptodome` for Keccak),
   run by a systemd timer every 5 minutes as a dedicated system user `oasync`:
   - **Permissions:** `oasync` is in group `knot`; the zone directory `/var/lib/knot/zones` is `knot:knot 2775`
     (group-writable, setgid) so the zone file it writes stays readable by Knot; Knot's control socket
     `/run/knot/knot.sock` is `knot:knot 0770`, so `oasync` can run `knotc zone-reload`/`zone-status`. The
     DNSSEC key store (`/var/lib/knot/keys`) stays `knot 0700`, out of its reach. State in `StateDirectory=oa-sync`
     (persistent: last applied `generated_at`, serial, entry count). Unit hardening: `NoNewPrivileges`,
     `ProtectSystem=strict`, `ReadWritePaths=/var/lib/knot/zones /var/lib/oa-sync`, `ProtectHome`,
     `PrivateTmp`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `MemoryMax=128M`.
   - **Source checks:** HTTPS GET, 10 s timeout, 4 MB cap; envelope `alg` ed25519, `public_key` in the pinned set
     (a list in config: a key rotation ships both keys, as XMRadar's `PINNED_XMRBIO_KEYS`; an unknown key fails
     safe and is reported in the health record), signature over the exact payload bytes; payload `v == 1`,
     `service == "xmr.bio"`, `entries` an array, `count == len(entries)`, `generated_at` not older than the last
     applied and not more than 10 min ahead. `X-Directory-Stale: 1` is applied but reported.
   - **Entries:** handle `[a-z0-9_]{1,15}`, unique; address checked like XMRadar's `validateMoneroAddress`
     (which accepts all three mainnet types, as the directory does): Monero base58 (8-byte blocks), network byte
     18 (standard, 95 chars), 42 (subaddress, 95) or 19 (integrated, 106; OpenAlias allows it), Keccak-256
     checksum. Anything else (testnet, bad checksum, bad length) is skipped, counted and reported; that is a data
     error worth an alert, not an expected case.
   - **Truncation guard:** a directory with fewer than half of the last applied entries isn't applied (reported);
     `oa-sync --force` applies it.
   - **Zone:** serial = max(Unix time, last serial + 1), so it always increases (state file). TTLs: TXT 300 s, SOA
     minimum 300, NS 3600. Every TXT string is quoted. The fixed parts (`oa1:xmr recipient_address=`, `;`,
     `recipient_name=`, the health record's `key=value` pairs) contain no quotes or backslashes; the dynamic
     parts are checked before writing: handles `[a-z0-9_]`, base58 addresses, ISO timestamps, integers, and
     reason words `[a-z_]`. Each string stays under 255 bytes.
   - **Apply:** write `oa.xmr.bio.zone.new`, `kzonecheck` it, rename over the zone file, `knotc zone-reload`, then
     confirm with `knotc zone-status` that the loaded serial is the new one. Only then is the state saved. A
     failed check, reload or confirm leaves the state unchanged, so the next run retries; the previous file is
     kept as `.prev` and restored if the new one fails `kzonecheck`.
   - A directory that fails to fetch or verify changes nothing: the box keeps serving the last good zone.
   - **Health record:** `_health.oa.xmr.bio TXT "ok=<1|0> stale=<0|1> applied=<generated_at> checked=<unix time>
     skipped=<n> reason=<word>"`, rewritten on every run, also after a failed fetch or check (from the last good
     records plus the new health line; a run that only updates `checked` still reloads; cheap at this size).
     `stale=1` when the directory came with `X-Directory-Stale: 1`. `ns2=<0|1>`: each run, ns1 asks ns2 for the
     zone's SOA over TCP (`kdig +tcp`, 3 s) and writes 1 when ns2's serial is the one before this run's or newer
     (it lags one run at most), so a dead or stuck secondary shows up while ns1 is fine.
5. **Cloudflare (xmr.bio zone), unproxied:** `ns1` A and AAAA (the box), `oa` NS → `ns1.xmr.bio`, `oa` DS; and for
   the secondary `ns2` A/AAAA + a second `oa` NS. 6–7 records.
5b. **Secondary, before the release:** a second Knot as secondary on another box (the user's egress box #2, or a
   second small VPS at another provider; the user picks), zone transfer by AXFR/IXFR with TSIG and NOTIFY from
   ns1, transfers allowed only from ns1's addresses. It serves the zone as signed by ns1 (no keys on it). Same
   firewall and RRL. If either box is down, resolvers use the other. If both are down, `<handle>.oa.xmr.bio` names
   fail to resolve; nothing else breaks (profiles, the directory, badges, and the existing `<handle>.xmr.bio`
   records are unaffected).
6. **Box hardening:** nftables: input drop except established, 22/tcp, 53/udp, 53/tcp, ICMP/ICMPv6 essentials;
   SSH: keys only, `PermitRootLogin prohibit-password`; `unattended-upgrades` for security updates; journald
   size cap; no other services.
7. **Monitoring:** the API's `*/30` cron asks Cloudflare's DoH (`https://cloudflare-dns.com/dns-query`, JSON) for
   `_health.oa.xmr.bio` TXT and alerts on Telegram (at most once per 6 h per reason, via KV) when: no answer or
   `AD` not set (DNS down or DNSSEC broken); `ok=0`; `stale=1`; `ns2=0` (secondary dead or stuck); `checked` older than 30 min (sync stopped);
   `applied` older than 2 h (directory not moving); `skipped` > 0. The health record is static in meaning, not a
   real profile. A Worker can't query each nameserver directly (no UDP), so per-server checks are the outside
   `kdig` checks at rollout; ns2's freshness shows in the health record whenever resolvers reach it.
8. **API and pages ([NS] items):** the registration path needs no change (names come from the directory). Copy:
   XMRadar's listing hint and the landing pages gain "and a wallet name, `<handle>.oa.xmr.bio`"; the xmr.bio
   profile page shows the name for listings without a `<handle>.xmr.bio` record. CHANGELOG line.

## Rollout
1. **ns1:** install and harden the box (install script); Knot with the zone signed by the CSK; the sync timer;
   check locally (`kdig @127.0.0.1 … +dnssec`, `knotc zone-status`).
2. **Key backup:** `knotc zone-backup +keysonly`, `age`-encrypted to the user's key, copied off; a restore test on
   a scratch Knot instance (same DNSKEY after restore).
3. **ns2 (secondary):** the user picks the box (egress box #2, or a second VPS). Install Knot from the same repo
   (secondary profile: no keys, no sync); a TSIG key (HMAC-SHA256) shared by ns1 and ns2; ns1 allows AXFR/IXFR
   only from ns2's addresses with that key and sends NOTIFY to ns2; ns2 accepts NOTIFY only from ns1. Check:
   `kdig @ns2 oa.xmr.bio SOA` serial equals ns1's within a minute of a change; `kdig @ns2 … AXFR` from elsewhere
   refused.
4. **Cloudflare:** `ns1` and `ns2` A/AAAA, two `oa` NS records; then the DS once both serve the DNSKEY; verify from
   outside (`kdig +dnssec` via 1.1.1.1 and 8.8.8.8 with `AD`; `kdig @ns1` and `@ns2` directly; a DNSViz-style
   chain check).
5. **Wallet test:** resolve `xbtoshi.oa.xmr.bio` in Feather (DNSSEC-valid, no warning).
6. **Monitoring** deployed; each alert path triggered once on purpose and seen in Telegram: stop the timer →
   `checked`; a bad envelope → `ok=0`; a stale test directory → `stale=1`; a frozen test directory → `applied`;
   a test directory with a checksum-bad address → `skipped`; Knot on ns2 stopped → `ns2=0`; the monitor pointed
   at an unsigned test name → no `AD`.
7. The [NS] copy, then the 0.6.12 release.
Rollback: delete the `oa` DS record in Cloudflare, then after its TTL both `oa` NS records (and the `ns1`/`ns2`
address records), and remove the
[NS] wallet-name lines from XMRadar's hint, the landing pages, the xmr.bio profile page and the CHANGELOG (one
revert commit in each repo, prepared with the [NS] change).

## Backup and restore
- **Reproducible from the repo and the directory:** the box (install script), Knot config, sync script, the zone
  (regenerated from the next directory).
- **Not reproducible: the DNSSEC signing key.** After setup, `knotc zone-backup +keysonly` to a file, encrypted
  with `age` to the user's key, copied off the box (kept by the user; never in a repo). Restore: new box from the
  install script, `knotc zone-restore` of the key backup, same DS, no Cloudflare change. Without the backup: new
  key, replace the `oa` DS in Cloudflare (names are unvalidated or fail until the old DS's TTL expires), so the
  backup is part of the setup checklist.
- The key backup is redone after any manual key roll.

## Checks
- Sync script unit-tested locally (pytest): good envelope applied; bad signature, unknown key, older or future
  `generated_at`, wrong `v`/`service`, `count` mismatch, truncated directory, bad handles; standard, subaddress
  and integrated addresses accepted; checksum-bad, wrong-length and testnet ones skipped and counted; zone file content exact; serial strictly
  increasing; reload failure leaves state unchanged; health record content. Address tests use the same vectors as
  XMRadar's `validateMoneroAddress` tests.
- `kdig` from outside, against ns1 and ns2 each: TXT answer, `AD` via validating resolvers, TCP works, RRL engages
  under a burst, no recursion (`+rec` for another name refused), `ANY` minimal, AXFR refused.
- Secondary: SOA serials equal after a change; NOTIFY seen in ns2's log; a transfer without the TSIG key refused.
- Reload recovery: a sync run with Knot stopped leaves the state unchanged and the next run applies.
- Backup: the restore test of rollout step 2.
- Monitoring: the deliberate alerts of rollout step 6.
- Box: `nft list ruleset`, `sshd -T`, `systemctl status knot`, timer runs, memory under the cap.

## Out of scope
Moving existing `<handle>.xmr.bio` records; serving anything but OpenAlias; a third nameserver.
