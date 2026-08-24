# CalBlue public website

A standalone, dependency-free public site for CalBlue Soccer Club. It is deliberately separate from company codebases and can be hosted from any static hosting provider.

## Preview locally

```bash
cd /home/shengqin/calblue-website
python3 -m http.server 8080
```

Open `http://localhost:8080`.

Or run the included helper:

```bash
./serve.sh
```

Validate the site before publishing:

```bash
python3 scripts/check_site.py
```

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
styles.css               Responsive visual system
script.js                Navigation and small UI behavior
assets/calblue-mark-official.svg  Web wrapper for the official crest
assets/calblue-logo-web.jpg  Web-optimized official crest sourced from the shared Drive
assets/favicon.svg       Browser icon
404.html                 Branded error page
netlify.toml             Optional Netlify config
scripts/check_site.py    Dependency-free pre-deployment checks
serve.sh                 Local preview helper
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for ownership, access, DNS, publishing, maintenance, and future CMS/database guidance.
