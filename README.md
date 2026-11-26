# RSVX_Status

One place to see whether everything is running correctly: the VPS, Render, GitHub and your websites. It runs on the VPS, serves a status page, keeps one Discord message up to date with everything on it, and posts an alert when something fails, errors or recovers.

No dependencies. Needs Node 18 or newer.

## What it checks (every minute)

| Area | Checks |
| --- | --- |
| VPS | CPU, RAM, disk space, uptime. Services you list (systemd units, ports such as FiveM and txAdmin), plus every PM2 process and Docker container it finds. |
| Repos on the VPS | Every git repo under `REPO_ROOTS`, compared with the newest commit on GitHub. Flags a repo that has fallen behind (pull did not happen) or has commits that were never pushed (auto-push did not happen). |
| Render | Every service: latest deploy failed or live, whether the live commit matches GitHub (auto-deploy fired), and whether the URL answers. Free web services are not pinged so they are not kept awake. Suspended services show as off. |
| GitHub | Every repo you own: latest commit, and the latest run of each GitHub Actions workflow on the default branch. A failed workflow is a failure. |
| Websites | Each address in `SITES` answers, and how many days its SSL certificate has left (warning at 14 days, failure at 3). |

A failure has to be seen twice in a row before it alerts, so a single blip does not ping you.

## Install on the VPS

```bash
git clone https://github.com/rhyslloyd0-png/RSVX-STATUS.git
cd RSVX-STATUS
sudo ./install.sh        # first run creates .env
nano .env                # fill in the keys below
sudo ./install.sh        # second run starts the service
```

Then open `http://YOUR-VPS-IP:8787` (allow the port in the firewall, or put it behind your reverse proxy on a subdomain).

## Install on Windows Server

Needs Node 18 or newer and Git for Windows, both installed for all users.

```powershell
git clone https://github.com/rhyslloyd0-png/RSVX-STATUS.git
cd RSVX-STATUS
powershell -ExecutionPolicy Bypass -File .\install.ps1                 # first run creates .env and opens it in Notepad
powershell -ExecutionPolicy Bypass -File .\install.ps1 -OpenFirewall   # second run starts it and opens the port
```

Run PowerShell as Administrator. It is installed as a scheduled task called "RSVX Status" that starts with the machine and restarts if it stops. The log is `data\status.log`.

Windows differences in `.env`:

- `WATCH_SERVICES` instead of `WATCH_SYSTEMD`: Windows service names, for example `MariaDB,W3SVC`.
- `REPO_ROOTS` must be Windows folders, for example `C:\FXServer,C:\Users\Administrator\Documents`.
- Delete the Linux `REPO_ROOTS` line or it will find nothing.

Running a board on two servers: each keeps its own Discord message. Give each a `VPS_NAME`, and on the second one set `ALERT_GROUPS=vps,sites` so GitHub and Render failures are only alerted once.

## Settings (.env)

| Key | What it is |
| --- | --- |
| `STATUS_PASSWORD` | Password for the page. Set one: the page lists private repo names. |
| `GITHUB_TOKEN` | Fine-grained token, all repositories, read-only on Metadata, Contents and Actions. |
| `RENDER_API_KEY` | Render dashboard, Account Settings, API Keys. |
| `DISCORD_WEBHOOK_URL` | Webhook for the live message and the alerts. |
| `DISCORD_MENTION` | Optional. Who to ping on a failure, for example `<@123456789012345678>`. |
| `SITES` | `Name|https://address`, comma separated. |
| `WATCH_SYSTEMD` | systemd units to watch, comma separated, for example `nginx,mariadb`. |
| `WATCH_SERVICES` | Windows only. Service names to watch, for example `MariaDB,W3SVC`. |
| `VPS_NAME` | Optional. Name shown for this server. |
| `ALERT_GROUPS` | Optional. Which areas send alerts: any of `vps,render,github,sites`. |
| `WATCH_PORTS` | `Name:port`, comma separated. Default watches FiveM 30120 and txAdmin 40120. |
| `WATCH_PM2`, `WATCH_DOCKER` | `auto` (default) or `off`. |
| `REPO_ROOTS` | Folders searched for git repos. |
| `PUBLIC_URL` | Optional. Address of the page, so Discord messages link to it. |
| `HEARTBEAT_URL` | Optional. See below. |
| `IGNORE_REPOS`, `IGNORE_SERVICES` | Optional. Names to leave out. |

## If the VPS itself goes down

This runs on the VPS, so if the whole VPS dies it cannot tell you. To cover that, create a check on a dead-man's-switch service (healthchecks.io is one), point its alert at Discord, and put its ping address in `HEARTBEAT_URL`. The board pings it every minute; when the pings stop, that service raises the alarm.

## Discord

The first time it runs it posts one message with everything on it and then edits that same message every minute. Pin it. If you delete it, a new one is posted. Alerts arrive as separate messages so they notify you.

## Test

```bash
npm test
```

Runs the real server against fake GitHub, Render and Discord servers, breaks a deploy, a workflow and a site, and checks the alerts and recoveries arrive.

Contact: rhys@rsvx.co.uk
