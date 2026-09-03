# CalBlue public website

A standalone, dependency-free public site for CalBlue Soccer Club. It is deliberately separate from company codebases and can be hosted from any static hosting provider.

## Preview locally

```bash
cd /Users/shengqin/calblue-website
python3 -m http.server 8080
```

Open `http://localhost:8080`.

For simultaneous desktop and mobile review, open `http://localhost:8080/design-preview.html`. The preview can switch pages and compare the preserved **Classic** site with all three redesigns: **Codex Stadium**, **Muse Pro Stadium**, and **Claude — Floodlight**.

The on-site design picker remembers a visitor's choice. You can also link directly to a design with `?design=classic`, `?design=codex-pro`, `?design=musecode-pro`, or `?design=floodlight`.

Or run the included helper:

```bash
./serve.sh
```

Validate the site before publishing:

```bash
python3 scripts/check_site.py
```

## SWPL schedule sync

The homepage match center is generated from CalBlue's official SWPL profile:

```bash
curl --fail --silent --show-error --location \
  --header 'User-Agent: CalBlueScheduleSync/1.0 (+https://calbluefc.com/)' \
  'https://pacific.swplsoccer.com/teams/calblue-fc' \
  | python3 scripts/sync_swpl.py --source-file -
```

The deploy workflow runs this sync every six hours and before every Pages deployment. It writes a small `data/swpl.json` snapshot, which the homepage uses to emphasize the next match and list the following fixtures. The parser only accepts rows involving CalBlue and deliberately ignores SWPL contact details and unrelated matches. If SWPL is unavailable or changes its page structure, deployment stops and the previous Pages deployment remains live.

## Content to confirm before launch

- Confirm that `calblue1996@gmail.com` is the approved public contact address.
- Add confirmed league, team, training, and fixture information.
- Add official social profile URLs.
- Confirm the club's preferred legal name and approve the 1996 founding language.
- Confirm the `calbluefc.com` DNS configuration and enable HTTPS.

## Recommended publishing path

### Option A: GitHub Pages (recommended for simplicity)

1. Create a new personal/public GitHub repository such as `calblue-website`.
2. Push only this folder's contents. Do not mirror or fork an internal repository.
3. In **Settings → Pages**, select **Deploy from a branch**, `main`, and `/ (root)`.
4. Add the custom domain in Pages settings and configure the DNS records GitHub provides.
5. Enable **Enforce HTTPS** after DNS validation completes.

### Option B: Netlify

1. Import the standalone public repository into Netlify.
2. Leave the build command empty and set the publish directory to `.`.
3. The included `netlify.toml` supplies security headers and the custom 404 route.
4. Attach the custom domain and enable HTTPS.

## Independence and safety checklist

- Use a personal or club-owned repository and hosting account.
- Never copy internal source code, credentials, analytics IDs, or private member data.
- Keep roster/contact details opt-in and public-safe.
- Use a dedicated club mailbox instead of a company address.
- Grant at least two club admins access to the domain, repository, and hosting account.
- Turn on branch protection and two-factor authentication.

## Structure

```text
index.html               Main one-page site
roster.html              Public Kylin Cup roster
gallery.html             2026 NCCSF Tournament photo gallery
gallery-*.html           Individual match albums backed by Cloudflare R2
styles.css                         Classic responsive visual system
designs/codex-pro.css              Codex Stadium design layer
designs/musecode-pro/theme.css     Muse Pro Stadium design
designs/floodlight/theme.css       Floodlight design
designs/floodlight/theme.js        Floodlight motion enhancements
designs/registry.js                Shared design registry
designs/switcher.js                Persistent multi-design loader and picker
designs/switcher.css               Theme-neutral picker styling
design-preview.html                Multi-page desktop/mobile review tool
script.js                Navigation and small UI behavior
swpl-schedule.js         Safe rendering for the next match and following fixtures
media-config.js          Public R2 media base URL
assets/calblue-logo-web.jpg  Web-optimized official crest sourced from the shared Drive
assets/roster/           Public face photos sourced from the roster sheet
assets/matchday/         Time-bounded match-day posters displayed on the homepage
assets/favicon.svg       Browser icon
404.html                 Branded error page
netlify.toml             Optional Netlify config
scripts/check_site.py    Dependency-free pre-deployment checks
scripts/sync_swpl.py     Dependency-free official SWPL schedule importer
data/swpl.json           Build-time SWPL snapshot and local fallback
serve.sh                 Local preview helper
```

Gallery images are stored in Cloudflare R2 rather than in the Git repository. See [R2_MEDIA.md](R2_MEDIA.md) for the media build and upload workflow.

See [DEPLOYMENT.md](DEPLOYMENT.md) for ownership, access, DNS, publishing, maintenance, and future CMS/database guidance.
