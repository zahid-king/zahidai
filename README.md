# Zahid AI public app foundation

This project now serves a connected video application at http://localhost:3000. It uses a SQLite database in data/zahid.sqlite; the supplied Kling AI frontend is preserved and served from the site root. No sample users, sample jobs, fake balances, or browser localStorage data are used.

## First local setup

Node.js 22.5 or newer is required (node:sqlite is built in).

1. Keep your existing Klinggiare key in .env as KLING_API_KEY=... . Do not paste it into the site or commit .env.
2. In .env, replace ADMIN_EMAIL with your admin login email and replace ADMIN_PASSWORD with a private password of at least 12 characters. Do this before the first start. The app creates this first admin in the database once.
3. Start PowerShell in this folder and run npm.cmd start. Leave the window open.
4. Open http://localhost:3000, sign in with the admin email and password, then open Admin.
5. In Admin, set the credit conversion, payment currency, accepted transfer methods, and payment instructions/account details that customers will see. Verify a transfer manually before approving a top-up request.

The conversion is app credits charged per 1 VND in the live Klinggiare quote. Customer credits are an internal balance stored in this app; they are not the upstream wallet balance. The Admin page separately reads the real VND balance and held reserve from the Klinggiare API. Each user only sees their own credits, payment requests, and jobs.

New registrations become active immediately and can sign in without administrator approval. New accounts start with zero credits, so users still need a manually approved top-up or admin credit grant before generating videos. Admins can suspend accounts, adjust credits, review manual transfer requests, and see recent jobs. Video creation is authenticated, requires enough credits, gets a fresh quote, then reserves the app credits before creating the upstream job. Definite API failures restore the reserved credits. Upstream failed/canceled jobs are refunded locally when the provider refunds them; POLICY_VIOLATION_NO_REFUND remains charged.

## Public hosting

### HostNexo Cloud Hosting (chosen setup)

Use cPanel's Node.js application feature. The app needs Node.js 22.5 or newer because it uses the built-in `node:sqlite` module. Ask HostNexo to confirm that the Cloud Hosting account has Node.js 22.5+ (not merely a generic Node.js label), the cPanel Application Manager or Node.js Selector, a writable persistent data folder, and environment-variable support. cPanel's default Passenger startup file is `app.js`, provided here as a wrapper for `server.js`.

1. Point your domain to the hosting account and wait for DNS to resolve.
2. In cPanel, open **Setup Node.js App** or **Application Manager** and create a production Node.js app with version 22.5 or newer. Set the application root to a private folder such as `zahid-ai`, set the application URL to your domain, and use `app.js` as the startup file.
3. Clone this GitHub repository into the application root using cPanel's Git Version Control, or upload the source files. Do not upload `.env` or the local `data` folder.
4. In the app's cPanel environment-variable settings, set `KLING_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters), `NODE_ENV=production`, and `DATA_DIR` to a writable persistent directory outside `public_html`, such as `/home/CPANEL_USERNAME/zahid-ai-data`.
5. Install the app's dependencies with the cPanel Node app controls (`npm install`; this project currently has no external runtime dependencies), then deploy/restart the app.
6. Open your domain, sign in with the admin email/password, and configure payments and social links in Admin.

cPanel should proxy HTTPS requests to the Node process and provide the domain's SSL certificate. Keep the SQLite data directory persistent and backed up. Do not copy the local `data/zahid.sqlite` from your PC unless you intentionally need to migrate its users and balances.

### HostNexo VPS alternative

The repository also includes `docker-compose.yml` and `Caddyfile` for a HostNexo VPS. The VPS listing advertises SSH/root access. Use a recent Ubuntu LTS VPS, point the domain's DNS `A` record to its public IPv4 address, configure `KLING_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `DOMAIN` in a private `.env`, then run `docker compose up -d --build`. Docker stores SQLite in a named volume and Caddy requests HTTPS. Keep separate backups; the volume is not a backup if the VPS itself is lost.

### Render alternative

The included `render.yaml` also prepares the Docker app for Render with HTTPS, health checks, private secret prompts, and a persistent disk at `/app/data`. That setup uses a paid web service and persistent disk. Review current Render pricing before choosing it. The first cloud start creates the admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; keep `.env` out of GitHub.

The cloud service starts with an empty database. Existing local users, credits, jobs, and payment records in `data/zahid.sqlite` are not copied automatically; migrate them to the persistent disk separately if you need to keep them. Do not add the database file or `.env` to the Git repository.

Before accepting public users, set payment details and the final credit conversion in Admin, test signup/top-ups/generation with a small amount, and confirm the database disk is backed up. Manual transfer is the current payment flow; payments are not automatically verified. Email verification and password reset delivery are not configured because no mail provider credentials were provided.
