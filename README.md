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

### HostNexo VPS (chosen setup)

Use a HostNexo VPS, not shared/cPanel hosting. The VPS page advertises root access, which this Docker app needs. Confirm the selected plan is available and supports Docker/Compose before paying; the checkout page may show unavailable inventory. Ask HostNexo to provision a recent Ubuntu LTS VPS with a public IPv4 address and inbound ports 80 and 443 available.

1. Point your domain's DNS `A` record to the VPS public IPv4 address and wait for it to resolve.
2. Connect to the VPS over SSH. Install Docker Engine and the Docker Compose plugin, or ask HostNexo support to install them.
3. Clone this public GitHub repository onto the VPS and enter its folder.
4. Copy `.env.example` to `.env`. Set `KLING_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters), and `DOMAIN` to your real values. Keep `.env` private and never upload it to GitHub.
5. Run `docker compose up -d --build`. The Compose setup runs the app behind Caddy, requests HTTPS for your domain, and stores SQLite data in a persistent Docker volume.
6. Check startup with `docker compose logs -f app`, then visit your domain and sign in using the admin email and password.

The VPS setup requires maintaining the server and making off-server backups. The Docker volume persists through container rebuilds, but it is not a backup if the VPS itself is lost. Configure HostNexo snapshots or copy regular SQLite backups to a separate storage location. Do not copy the local `data/zahid.sqlite` from your PC unless you intentionally need to migrate its users and balances.

### Render alternative

The included `render.yaml` also prepares the Docker app for Render with HTTPS, health checks, private secret prompts, and a persistent disk at `/app/data`. That setup uses a paid web service and persistent disk. Review current Render pricing before choosing it. The first cloud start creates the admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; keep `.env` out of GitHub.

The cloud service starts with an empty database. Existing local users, credits, jobs, and payment records in `data/zahid.sqlite` are not copied automatically; migrate them to the persistent disk separately if you need to keep them. Do not add the database file or `.env` to the Git repository.

Before accepting public users, set payment details and the final credit conversion in Admin, test signup/top-ups/generation with a small amount, and confirm the database disk is backed up. Manual transfer is the current payment flow; payments are not automatically verified. Email verification and password reset delivery are not configured because no mail provider credentials were provided.
