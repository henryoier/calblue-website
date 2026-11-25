# CalBlue local club office

A working, no-build companion to the existing member app. The club manager keeps
an encrypted local database; players return encrypted registration files. No online
database, Supabase migration, bank login or email credentials are required to use it.

## Start

From the repository root, run:

```sh
python3 scripts/start_club_office.py
```

Open `http://127.0.0.1:8765/club-office/`. The launcher serves only an explicit
allowlist of program assets on loopback; it does not serve the repository, private
backups, arbitrary uploads, or `.git`. Keep the window open. Use the same browser,
hostname and port each time: browser storage belongs to an origin.

Create a vault with a unique passphrase of at least 14 characters. Store the
passphrase in a password manager and keep the initial encrypted backup. Do not use
the synthetic test passphrases in this repository. This is separate from the online
member login and its admin roles.

## Registration and player IDs

1. In **Players**, choose **Registration link**. The link contains only the vault's
   RSA public key; share the displayed key fingerprint through the team's trusted
   channel too. The player should compare it before filling in details.
2. For remote players, serve the program over HTTPS and generate the link there
   after restoring the same vault. A localhost link only works on the computer that
   runs the local server. Alternatively distribute the program for local use and
   transfer the public link fragment. There is no unattended intake server.
3. A player enters name, email, phone, DOB, year joined, emergency contact, optional
   address/guardian/league ID/jersey, and a front-facing photo. They acknowledge
   administrative use. This is not an electronic league waiver or guardian identity
   verification. Government ID numbers or images are **not collected**.
4. The browser downloads an encrypted `.cbreg` file. The player sends it through
   the team's usual channel. Downloading is not submission or delivery.
5. Import the file in **Players**, check the join year and details, save the profile
   to assign its club ID, then mark it reviewed.
   Possible duplicates are rejected, never merged automatically. Shared family
   email addresses are allowed for different DOBs/names. Profile review is not
   legal identity verification or league eligibility approval.

CalBlue IDs look like `CB-2024-001`: year joined plus a vault-maintained sequence.
They remain stable after editing, archiving and reactivation; deleted numbers are
not reused. A private UUID is the internal database key. League IDs remain separate.
Use **one authoritative vault**. Independent copies cannot safely generate shared
sequences or merge histories; this is a single-manager local tool, not a multiuser
distributed database. Check the join year when creating the profile; an existing
ID's join year is read-only so IDs cannot silently change.

Photo imports accept JPG/PNG/WebP up to 8 MB, resize to a maximum 1200-pixel edge,
and re-encode JPEG to discard location/EXIF metadata. Full-size originals are not
retained. Only real consented player data should go in the operational vault.

## Dues, Zelle / Venmo transfers and receipt review

Create a charge for one player or all active players. Review the count and total
before confirming. Amounts are integer USD cents. Partial payments, reversal,
voiding unpaid charges and an append-only action history are supported. Reversal
restores the balance and releases any linked bank transaction. Invoice references
are generated separately from player IDs (`INV-2026-0001`).

For Chase, download one account's activity as QFX/OFX if your account offers it.
The importer reads posted transactions, `FITID` bank IDs, currency, signed amounts,
dates and description; it does not retain account or routing numbers. Give the
account the same nickname on every import. A normalized CSV alternative allows
column mapping and requires transaction ID, ISO date, USD currency, posted/pending
status, signed amount (credits positive) and description. Many bank CSV exports
lack stable transaction IDs: do not invent IDs from amounts/names or treat them
as authenticated bank evidence. Prefer QFX/OFX or obtain reliable references.

Exact duplicate account/transaction IDs are skipped. Changed transactions are
rejected for investigation. Pending rows and outgoing payments cannot settle dues.
Candidates require enough remaining balance for the receipt, so partial payments are supported; complete reference tokens are highlighted,
but **every bank match requires a manager's confirmation and note**. A transaction
can settle only one charge. Combined payments, refunds,
chargebacks and pending-to-posted corrections require separate review. The local
ledger is not automatically reconciled after a bank correction.

**No live Chase connection is configured.** Live read-only account syncing would
require a supported banking provider (for example, a production Plaid integration),
the account holder's authorization, a server-side credential store, cursor/webhook
processing, and handling added/modified/removed transactions. Do not put provider
secrets or bank passwords into frontend code, GitHub, or the vault settings.

Reminder previews always calculate the current remaining balance. An unresolved player payment report changes the message into a receipt-review follow-up, explicitly asking the player not to pay again solely because of that message. Paid/voided
charges cannot generate reminders. **Open email draft** uses the local mail app;
it does not claim the message was sent. No message is sent automatically.

For a batch, export **Reminder batch CSV**, inspect the recipients/content and use
the optional local sender:

```sh
# Preview only: no network connection
python3 scripts/send_club_reminders.py /absolute/private/path/calblue-reminders.csv

# Explicit send, only after reviewing a freshly exported batch
python3 scripts/send_club_reminders.py /absolute/private/path/calblue-reminders.csv \
  --send --from-address club@example.com --smtp-host smtp.example.com \
  --smtp-user club@example.com --ledger /absolute/private/path/receipts.sqlite3
```

Replace example addresses/provider details. TLS on port 465 is default; for a
provider requiring STARTTLS use `--starttls --smtp-port 587`. The password is entered
through a hidden prompt or `CALBLUE_SMTP_PASSWORD`; it is not stored. OAuth-only
mail providers need a separate provider integration or supported app-password setup.
Keep the receipt ledger outside every served directory. It suppresses duplicate
attempts and holds uncertain outcomes for provider-log review. “SMTP accepted” is
not confirmed delivery. Export again immediately before sending so a stale batch
does not chase someone who has just paid. No scheduler is installed.


### Give players payment instructions; verify the actual receipt

CalBlue currently uses Zelle only. Venmo setup is optional and collapsed by
default; the player page only offers configured methods, and a single configured
method is selected automatically. The confirmed club default is Zelle tag `gocalblue1996`, recipient name
`CALBLUE CHINESE COMMUNITY`. New vaults use these defaults; existing vaults can
choose **Use club Zelle details**, then **Save settings**. Existing payment
links remain snapshots and must be regenerated when settings change.

1. In **Backup & settings**, enter the club's Zelle email/phone/tag and recipient
   display name, and/or Venmo username, recipient display name and profile type.
   New vaults prefill the club-approved Zelle destination. Extra payment instructions remain available.
2. On an unpaid charge choose **Payment instructions & report link**. The player
   page shows the amount and memo `INV-YYYY-NNNN CB-YYYY-NNN`. Send the link and
   displayed club key directly to that player. Teammates need an HTTPS deployment
   of the program files; localhost links only work on the same device.
3. The player transfers in their own Zelle/Venmo app, then fills payer name,
   method, date, amount and optional confirmation ID. They download an encrypted
   `.cbpay` file and send it through the normal team channel. There is no upload
   endpoint, automatic delivery, bank access or actual transfer on this page.
4. Import the report on its matching charge. **Awaiting receipt review** does not
   reduce the balance. Encryption protects confidentiality; it does not prove
   payer identity or that a payment occurred. Dismiss incorrect reports without
   erasing history.
5. Import actual Chase activity for Zelle, or a normalized Venmo statement for
   Venmo. Review payer, memo, date and gross amount against the original statement,
   choose the charge, optionally link the report, then confirm receipt. Only this
   confirmation reduces the balance. Reversing the payment reopens a linked report.

The payment link is an unsigned snapshot, not a live balance or proof of origin.
It includes internal player ID, charge amount/title and club payment destinations,
but no player name, email, DOB or photo. Treat it as private correspondence. Players
must check the recipient name in their banking app and confirm changed destinations
with the manager. Existing links do not update after payment or settings changes.

### Venmo statements and payouts

Download the statement from Venmo's **Statements** screen. The current importer
requires a **normalized CSV**, not a raw Venmo export. Preserve the original
transaction IDs and original statement for review. Select **Venmo** as the source.
In addition to the bank columns above, provide:

| Column | Meaning |
| --- | --- |
| amount | Gross USD payment before the recipient fee; incoming positive, outgoing negative |
| fee | Nonnegative USD recipient fee, or `0` |
| kind | `payment`, `payout`, `refund`, or `other` |
| status | `posted` only for completed payments; `pending` for unfinished payments |
| description | Original payer and payment note / memo |

Only positive, posted Venmo `payment` rows can settle dues. The gross amount is
credited; the fee and net amount are retained/displayed separately. Payouts,
refunds, transfers and pending rows cannot settle a charge. A bank credit whose
description contains the word `Venmo` is excluded to prevent crediting its payout
again. Bank descriptions can vary: manually check unlabelled credits, too. Importing
a refund does not automatically reverse an earlier payment; inspect and reverse it
on the original charge. Changed provider rows are rejected for investigation.
Use consistent source, profile and account nickname; changing nicknames creates a
new account namespace and defeats cross-import duplicate detection.

### Future live verification — not implemented or connected

Chase syncing requires a provider with production access (for example Plaid
Transactions), Chase OAuth approval and the account holder's consent. A separate
local/background or hosted service must keep credentials outside static assets,
process added/modified/removed transactions and pending-to-posted transitions,
reconcile refunds and display freshness/errors. The office does not currently
include this service or a fake Connect button.

Venmo confirms statement CSV downloads for both personal and business profiles.
The PayPal Transaction Search API is documented for **PayPal accounts**; that is
not evidence that it can read arbitrary Venmo peer-to-peer transfers. Direct
Venmo account-history API access remains unconfirmed. Do not scrape login sessions
or use bank payout amounts as individual Venmo receipts. A future PayPal/Venmo
checkout integration would be a different payment flow from the manual transfers
used by the team today.


## Forms, exports and retention

- Default roster CSV includes internal player ID, names, league ID and jersey only.
  Select DOB/contact fields deliberately; ordinary CSV/PDF exports are unencrypted.
- Map arbitrary spreadsheet headings using `Heading=playerField`. Save/load the
  mapping text to reuse it for the next event. This outputs a CSV suitable for a
  spreadsheet form; arbitrary PDF/Word templates are not automatically filled.
- Each player has a printable registration record with headshot; use the browser's
  **Save as PDF** option. League-specific documents still need the actual template
  and a field mapping/overlay, plus any required signature workflow.
- Archive preserves dues and history. Profiles with no financial records can be
  deleted. Records with finances must be archived or have optional details cleared;
  complete personal-data erasure with financial retention needs an agreed policy.
- Deleting from the current vault does not rewrite older backups. Manage backup
  retention and unencrypted exports explicitly.

## Storage and trust boundary

- IndexedDB stores only a versioned encrypted envelope plus a revision token.
  AES-256-GCM authenticates the contents; a random 96-bit nonce is used on every save.
  A 16-byte salt and PBKDF2-HMAC-SHA256 with 600,000 iterations derive the key from
  the passphrase. The passphrase is never persisted; derived keys/plaintext exist in
  the unlocked page memory. The vault includes the registration private key.
- Registration uses a fresh AES-256-GCM key per file, wrapped with RSA-OAEP-3072 /
  SHA-256 to the vault's public key. Anyone with the link can encrypt a submission;
  it is **not proof of the sender's identity**. Review with the player.
- A compare-and-swap storage transaction rejects stale saves from another tab.
  Failed saves leave the last committed vault intact. Export a fresh `.cbvault`
  after changes; test restoring it before deleting the old working copy.
- The page locks after ten minutes without user input and on expired-idle return
  from a background tab. The timer cannot erase OS swap, browser process snapshots
  or a compromised device. An unlocked browser/user extension can read the data.
- There are no third-party scripts, analytics or network data calls in the office.
  CSP blocks connections, external scripts and form submissions. This does not
  defend against malicious replacement of the application files or another
  compromised page on the same origin. Prefer the allowlisted local launcher and
  a dedicated browser profile; use a dedicated origin if hosting a real vault.
- Password changes re-encrypt the current vault and produce a new backup; old
  backups retain their original password. There is no recovery service.
- This is a small-team encrypted document database, not SQL, a managed backup
  service, authenticated bank verification, or a security audit certification.

## Deployment and repository handling

The public source files may be committed. Do **not** commit player data, exported
rosters, reminder batches, receipts or encrypted vault snapshots to the public site
repository. `.gitignore` is an accident guard, not web access control. Back up the
vault to a private location. If the club deliberately uses Git for encrypted backups,
use a separate private backup repository, no Pages deployment, strong independent
passphrases and a retention plan; no such repository is created here.

The existing Supabase member app is untouched except for a link on its home page.
The two stores do not sync. No real profiles, migrations, seed rows, emails, provider
accounts or production settings are changed by this feature.

## Verification

```sh
node --test tests/club-office/*.test.mjs  # Node 22+, no packages
python3 -m unittest discover -s tests -p test_club_office.py -v
python3 scripts/check_no_build.py
python3 scripts/check_secrets.py
python3 scripts/run_js_tests.py
python3 scripts/run_async_js_tests.py
python3 -m unittest discover -s tests
python3 scripts/check_site.py
```

Crypto tests exercise real Web Crypto operations, tamper rejection, wrong passwords,
wrong recipient keys, encrypted round trips and file limits. Accounting tests cover
stable IDs, duplicate players, partial payments, reversal, overpayment, repeat bank
imports, pending/debit exclusion, one-payment-one-charge enforcement and CSV quoting/
formula neutralization. SMTP tests use a fake server and exercise duplicate and
uncertain-outcome suppression. Browser acceptance uses synthetic players and bank
files only; no real banking or live mail delivery has been verified.

References used for feature design:
[Byga registration and payments](https://www.byga.net/registration-and-payments),
[TeamSnap registration](https://info.teamsnap.com/registration),
[Chase data sharing](https://www.chase.com/digital/data-sharing),
[Chase account activity formats](https://www.chase.com/content/dam/chaseonline/en/legacy/content/secure/sso/document/cco_account_activity_quick_reference-lores.pdf),
[Plaid transaction states](https://plaid.com/docs/transactions/transactions-data/),
[Web Crypto authenticated encryption](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt).

Payment integration references (checked 2026-10-21):
[Chase business Zelle](https://www.chase.com/business/support/banking/online-banking/zelle),
[Venmo statements](https://help.venmo.com/cs/articles/transaction-history-vhel281),
[Venmo payment status](https://help.venmo.com/cs/articles/payments-requests-faq-vhel149),
[Plaid OAuth / Chase prerequisites](https://plaid.com/docs/link/oauth/),
[PayPal API scope](https://developer.paypal.com/api/rest/current-resources/).
