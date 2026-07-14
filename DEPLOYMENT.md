# Deploying the current SDC Job Fair system to `job-fair-server` (AWS free tier)

Target instance, as discovered on 2026-07-14:

| | |
|---|---|
| EC2 instance | `job-fair-server`, `t3.micro`, `ap-south-1a` (Mumbai), public IP `15.206.27.140` |
| OS | Ubuntu 24.04.4 LTS |
| RAM | 911Mi total — **very tight**, no swap configured |
| Disk | 6.8GB total, 3.9GB free |
| Node | v20.20.2 (already installed — fine, no upgrade needed) |
| Postgres | **not local** — RDS instance `jobfair-db.c988ugwcogm9.ap-south-1.rds.amazonaws.com` |
| Redis / Docker | not installed |
| Currently running | PM2 process `job-fair` running the *old* pre-refactor Express app (`~/job-fair-system/express-app/server.js`, port 3000, 48 restarts). Nginx is still the untouched Debian default stub — it isn't actually proxying to that app. |

The new system adds Redis (native queue/ETA engine), Socket.IO, and a built React SPA that Nginx needs to serve and reverse-proxy for — none of which the old deployment has. This doc replaces the old app end-to-end but reuses the existing RDS instance and EC2 box.

---

## Step 0 — Rotate exposed credentials (do this first, not last)

Two secrets were pasted into a chat session while diagnosing this box and must be treated as burned:

1. **GitHub PAT** embedded in `~/job-fair-system/.git/config`'s remote URL. Revoke it at GitHub → Settings → Developer settings → Personal access tokens, then generate a new one (or better, switch to a deploy key — step 5 below does this instead of reusing a PAT).
2. **RDS master password** (`DB_PASSWORD` in the old `.env`). Rotate it:
   ```bash
   # From the EC2 box (RDS security group already allows it) or any psql client that can reach RDS:
   psql "host=jobfair-db.c988ugwcogm9.ap-south-1.rds.amazonaws.com port=5432 user=postgres dbname=postgres" \
     -c "ALTER USER postgres WITH PASSWORD 'PICK_A_NEW_STRONG_PASSWORD_HERE';"
   ```
   Pick something long and random (e.g. `openssl rand -base64 24`), not a dictionary phrase + digits. You'll use the new password in the new `.env` in step 6 — don't reuse the old one anywhere.

---

## Step 1 — Decide the access model: get HTTPS without owning a domain

The app's auth cookie is `sameSite: 'lax', secure: NODE_ENV==='production'` (a deliberate red-team fix — see `RED_TEAM_AUDIT.md` M3). Run in production mode over plain HTTP and browsers will silently drop the cookie — **login will not work**. So this deploy needs real TLS, even for a demo.

You don't have a domain, so use **sslip.io** — a free wildcard DNS service that resolves `<any-ip-with-dashes>.sslip.io` to that IP automatically, with no registration. That gives Let's Encrypt (via certbot) a real hostname to issue a cert for.

First, make the IP permanent — if `15.206.27.140` is just the default public IP (not an Elastic IP), it changes on stop/start and breaks the cert:

- AWS Console → EC2 → Elastic IPs → Allocate → Associate with `job-fair-server`. (Free while attached to a running instance; this may already be the case — check first under EC2 → Instances → job-fair-server → Elastic IP.)

Your hostname is then: **`15-206-27-140.sslip.io`** (replace dashes if your IP differs after allocating the EIP — recheck it after associating).

---

## Step 2 — Add swap (mandatory safety net)

911MB RAM with zero swap is one `npm install` or traffic spike away from the OOM killer taking out Postgres... except there's no local Postgres, so it'll take out Node/Redis instead. Add 2GB of swap — cheap, permanent insurance:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # confirm Swap: 2.0Gi
```

---

## Step 3 — Install Redis natively (not Docker)

Docker's daemon overhead isn't worth it on a 911MB box for one container. Native `redis-server` idles at ~5-10MB:

```bash
sudo apt update
sudo apt install -y redis-server
```

Bind it to localhost only (default `/etc/redis/redis.conf` already has `bind 127.0.0.1 -::1` — verify, don't open it to `0.0.0.0`):

```bash
grep -E '^bind|^protected-mode' /etc/redis/redis.conf
sudo systemctl enable --now redis-server
redis-cli ping   # expect PONG
```

---

## Step 4 — Retire the old app

Don't delete yet — stop and rename, so there's a fallback if something in the new deploy goes sideways:

```bash
pm2 stop job-fair
pm2 delete job-fair
mv ~/job-fair-system ~/job-fair-system.old-$(date +%Y%m%d)
```

---

## Step 5 — Get the new code onto the box via a deploy key (not a PAT-in-URL)

On the EC2 box:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/jobfair_deploy -N "" -C "job-fair-server deploy key"
cat ~/.ssh/jobfair_deploy.pub
```

Copy that public key to GitHub → your repo → Settings → Deploy keys → Add deploy key (read-only is enough — this box only ever pulls).

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/jobfair_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T git@github.com   # expect "Hi Honeymajortom/job-fair-system! You've successfully authenticated"
```

From your **Windows machine**, push the current project to that repo on its own branch first (keeps `master` — and the fallback — untouched until you've verified the new deploy):

```powershell
cd "C:\Users\honey\Desktop\SDC Career Path"
git remote -v                                   # confirm/add the job-fair-system remote if it isn't already there
git push origin main:deploy-live                # push current main to a new branch
```

Back on the EC2 box:

```bash
git clone --branch deploy-live git@github.com:Honeymajortom/job-fair-system.git ~/sdc-job-fair
cd ~/sdc-job-fair/prototype/express-app
npm install --omit=dev
```

---

## Step 6 — Configure `.env`

```bash
cd ~/sdc-job-fair/prototype/express-app
cp .env.example .env
nano .env
```

Fill in:

```
DATABASE_URL=postgresql://postgres:PICK_A_NEW_STRONG_PASSWORD_HERE@jobfair-db.c988ugwcogm9.ap-south-1.rds.amazonaws.com:5432/sdc_jobfair
PORT=3000
JWT_SECRET=<openssl rand -hex 32>
SERVER_SECRET=<a different openssl rand -hex 32>
REDIS_URL=redis://localhost:6379
CORS_ORIGIN=https://15-206-27-140.sslip.io
```

Generate the two secrets:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # SERVER_SECRET — must differ from JWT_SECRET, see .env.example
```

Note the **new database name** (`sdc_jobfair`, not the old app's `jobfair`) — deliberately a fresh database on the same RDS instance rather than reusing/wiping the old one, so the old app's data stays intact and recoverable until you're sure you don't need it:

```bash
psql "host=jobfair-db.c988ugwcogm9.ap-south-1.rds.amazonaws.com port=5432 user=postgres dbname=postgres" \
  -c "CREATE DATABASE sdc_jobfair;"
```

---

## Step 7 — Migrate, seed, verify DB

```bash
cd ~/sdc-job-fair/prototype/express-app
npm run migrate
npm run seed
```

`seed.js` prints a random admin password once — **copy it now**, it's not recoverable after (see `db/seed.js`'s red-team-driven design — no static default credential anymore).

---

## Step 8 — Build the frontend **locally**, not on the server

Rollup/esbuild's minify pass can transiently spike memory well past what this box comfortably has free, even with swap. Build on your Windows machine and upload the static output — faster and avoids the risk entirely:

```powershell
cd "C:\Users\honey\Desktop\SDC Career Path\prototype\react-app"
npm install
npm run build
scp -i "C:\Users\honey\Desktop\job_fair_system\job-fair-key.pem" -r dist ubuntu@15.206.27.140:~/sdc-job-fair/prototype/react-app/dist
```

(If you'd rather build on-server for future redeploys now that swap exists, `npm install && npm run build` in `prototype/react-app` works too — just expect it to be slow.)

---

## Step 9 — PM2: start the API + no-show worker

The repo already ships `ecosystem.config.js` covering both long-running processes:

```bash
cd ~/sdc-job-fair/prototype/express-app
npx pm2 start ecosystem.config.js
npx pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu   # run the sudo command it prints, once
```

`pm2 startup` makes both processes survive a reboot — the old deployment apparently didn't have this wired up, worth confirming it's now in place.

---

## Step 10 — Nginx: serve the SPA, reverse-proxy `/api` and `/socket.io`, TLS

Replace the default stub with a real site:

```bash
sudo rm /etc/nginx/sites-enabled/default
sudo tee /etc/nginx/sites-available/sdc-job-fair > /dev/null <<'EOF'
server {
    listen 80;
    server_name 15-206-27-140.sslip.io;

    root /home/ubuntu/sdc-job-fair/prototype/react-app/dist;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/sdc-job-fair /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Get a real cert (certbot edits the block above to add the 443 server + HTTP→HTTPS redirect):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 15-206-27-140.sslip.io
```

---

## Step 11 — Security group cleanup

AWS Console → EC2 → Security Groups → the one attached to `job-fair-server`:

- **Allow**: 22 (SSH — ideally restrict source to your own IP, not `0.0.0.0/0`), 80, 443
- **Remove/don't add**: 3000 (Node — now only reachable via Nginx, no reason for it to be public), 6379 (Redis binds to localhost only, shouldn't be reachable regardless)
- RDS's own security group is separate — confirm it only allows inbound 5432 from the EC2 instance's security group, not `0.0.0.0/0`. Worth checking now given the password was just exposed.

---

## Step 12 — Smoke test

```bash
curl -sk https://15-206-27-140.sslip.io/api/health          # expect {"ok":true}
pm2 status                                                    # both processes "online"
redis-cli ping                                                # PONG
```

Then in a browser: `https://15-206-27-140.sslip.io` → register a test candidate through the public flow, log in as `admin` with the password `seed.js` printed, confirm the Floor Monitor and a live position page both load and the Socket.IO connection in devtools' Network tab shows `101 Switching Protocols` (not falling back to polling, and not erroring).

---

## Redeploying after future code changes

```bash
# local: build + upload
cd "C:\Users\honey\Desktop\SDC Career Path\prototype\react-app"
npm run build
scp -i ...\job-fair-key.pem -r dist ubuntu@15.206.27.140:~/sdc-job-fair/prototype/react-app/dist

# server: pull + restart
ssh -i job-fair-key.pem ubuntu@15.206.27.140
cd ~/sdc-job-fair && git pull
cd prototype/express-app && npm install --omit=dev
npm run migrate                 # only if schema.sql changed
npx pm2 restart ecosystem.config.js
```

## Rollback

The old app is preserved, stopped, at `~/job-fair-system.old-<date>`. To roll back: `pm2 start ~/job-fair-system.old-<date>/express-app/server.js --name job-fair`, restore the old Nginx default stub, and remove the new site from `sites-enabled`. The old RDS database (`jobfair`) was never touched, so no data recovery is needed for that path.
