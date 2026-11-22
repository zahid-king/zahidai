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

The included `render.yaml` prepares this Docker app for Render with HTTPS, health checks, private secret prompts, and a persistent disk at `/app/data`. It uses Render's paid 0.5 CPU / 512 MB web plan and a 1 GB persistent disk. At current listed rates these start at about US$7.25/month before bandwidth, tax, or any optional domain; Render requires paid compute for persistent disks. Review the live price before creating the service.

To deploy, push this folder to a private GitHub repository, import the repository into Render as a Blueprint, and enter `KLING_API_KEY`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` when prompted. Keep `.env` out of GitHub. The first cloud start creates the admin account using those environment variables. For repeatable deployments, keep the persistent disk mounted at `/app/data`; without it the SQLite user database and balances can be lost.

The cloud service starts with an empty database. Existing local users, credits, jobs, and payment records in `data/zahid.sqlite` are not copied automatically; migrate them to the persistent disk separately if you need to keep them. Do not add the database file or `.env` to the Git repository.

Before accepting public users, set payment details and the final credit conversion in Admin, test signup/top-ups/generation with a small amount, and confirm the database disk is backed up. Manual transfer is the current payment flow; payments are not automatically verified. Email verification and password reset delivery are not configured because no mail provider credentials were provided.
