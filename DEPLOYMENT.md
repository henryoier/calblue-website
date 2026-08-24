# CalBlue public launch plan

## Recommended architecture

Use a club-owned GitHub repository connected to static hosting. The browser receives HTML, CSS, JavaScript, and images directly from the hosting edge network.

```text
Maintainers → GitHub repository → automatic deployment → public HTTPS website
                       ↓
                 preview/review
```

There is no application server or database to patch in the first release. This is the simplest reliable architecture for a team profile, schedule, news, links, and contact information.

## Accounts and ownership

Create every account in the club's name, not under a company identity or one member's personal account.

1. Create a GitHub organization for CalBlue and a repository named `calblue-website`.
2. Create a hosting account. GitHub Pages is sufficient; Cloudflare Pages or Netlify are good alternatives.
3. Register the domain through a club-owned registrar account. Cloudflare Registrar or Porkbun are reasonable options.
4. Keep recovery codes and registrar credentials in a shared password manager.
5. Assign at least two trusted owners. Require two-factor authentication for every administrator.

Suggested roles:

| Role | Access |
| --- | --- |
| Club owner | Domain, billing, hosting, GitHub organization owner |
| Site maintainer | GitHub write access and hosting deployment access |
| Content contributor | Pull requests only; no domain or billing access |
| Viewer | No administration access |

Never share a single password among maintainers. Invite each person by their own account.

## Domain and DNS

The registered production domain is `calbluefc.com`.

After registration:

1. Add the domain in the selected hosting dashboard.
2. Copy the exact DNS records supplied by the host into the registrar's DNS settings.
3. Add both the root domain and `www` version; redirect one to the other.
4. Enable automatic HTTPS and force HTTPS redirects.
5. Turn on registrar lock, two-factor authentication, and automatic renewal.
6. Add the chosen domain to the site's metadata, sitemap, and analytics configuration.

Domain registration usually costs roughly $10–$35 USD per year depending on the extension. Static hosting can remain free at this traffic level.

## Initial publication with GitHub Pages

1. Create a new repository outside all company codebases.
2. Copy this project into it and push the `main` branch.
3. Open **Settings → Pages** in GitHub.
4. Under **Build and deployment**, choose **GitHub Actions**.
5. The included workflow deploys every accepted change to `main`.
6. Add the custom domain under **Settings → Pages** after DNS is ready.
7. Enable **Enforce HTTPS**.

Each proposed change should use a branch and pull request. GitHub Actions produces the public release after the change is reviewed and merged.

## Content workflow

For the first release, edit copy and links in `index.html`, replace images in `assets/`, and submit a pull request. This keeps all history reviewable and makes rollback easy.

Recommended repository rules:

- Protect the `main` branch.
- Require one approval before merge.
- Prevent force pushes and branch deletion.
- Restrict deployment settings to owners.
- Never commit passwords, API keys, private rosters, medical information, or financial data.

If several nontechnical contributors need frequent updates, add a hosted content management system later. CloudCannon is a straightforward option for static HTML; Sanity or Contentful fit a larger news/archive site. Keep the GitHub repository as the source of truth where possible.

## Database decision

No database is needed for the current site. A database would add backups, access controls, schema migrations, privacy obligations, and ongoing security maintenance without providing meaningful benefit yet.

Store public schedules and announcements as reviewed static content. Introduce a managed data service only if CalBlue later needs features such as player accounts, registration, payments, private availability tracking, or a large searchable match archive. Private player operations should be a separate authenticated system, not part of the public website.

## Contact form

The initial mail link has no backend and no stored personal data. Confirm that `calblue1996@gmail.com` should receive public inquiries before launch.

If a web form is required later, use a managed form endpoint or a small serverless function with spam protection. Publish a privacy notice that explains what is collected, why, who receives it, and how long it is retained.

## Ongoing maintenance

| Frequency | Task |
| --- | --- |
| After every change | Review the preview, test mobile layout, check links, merge via pull request |
| Monthly | Check contact route, fixtures, broken links, and admin membership |
| Quarterly | Review public content, privacy exposure, analytics, and account recovery access |
| Annually | Renew domain, review billing, rotate recovery codes, archive old seasons |

Static hosting handles operating systems, web servers, TLS certificates, and global delivery. The club maintains only content, access, the domain, and source code.

## Launch checklist

- Approve club name, history, logo treatment, and public copy.
- Confirm that every player photo/name is approved for public use.
- Replace the placeholder email address.
- Add confirmed current fixtures and social links.
- Select and register the domain.
- Create the independent GitHub organization and hosting account.
- Enable two-factor authentication and add a second club owner.
- Test phone, tablet, and desktop views.
- Check keyboard navigation, contrast, and image alternative text.
- Publish, enable HTTPS, and verify both `www` and root URLs.
- Update or retire the old Google Site after the new domain is stable.
