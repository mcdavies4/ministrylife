# Vote server + admin stats: one-time setup (about 10 minutes)

One Cloudflare Worker powers three things:
- **Daily Card votes** ("How Nigeria voted")
- **Anonymous play stats** (no names; a random ID per phone)
- **The admin dashboard** at `https://ministrylife.pages.dev/admin.html`

The game still works without it. Votes are saved on each phone and stats are simply not sent.

## 1. Create the database
1. In the Cloudflare dashboard, go to **Storage & Databases → D1 SQL Database → Create**.
2. Name it `ministrylife` and click **Create**. You don't need to create any tables; the worker creates them.

## 2. Create the worker
1. Go to **Workers & Pages → Create → Create Worker** and start from "Hello World".
2. Name it exactly `ministrylife-votes` and click **Deploy**.
3. Click **Edit code**, delete everything, paste in the contents of `worker.js`, then click **Deploy**.

## 3. Connect the database
1. Open the `ministrylife-votes` worker, then **Settings → Bindings → Add → D1 database**.
2. Set the variable name to `DB` (capital letters) and the database to `ministrylife`. Click **Save** (or **Deploy**).

## 4. Set your admin password
1. In the worker, go to **Settings → Variables and Secrets → Add**.
2. Set the type to **Secret**, the name to `ADMIN_KEY`, and the value to a long password only you know.
3. Click **Deploy**.

## 5. Check it
- Open `https://ministrylife-votes.azubuikedavies.workers.dev`. You should see `{"ok":true,"service":"ministrylife-votes", ...}`.
- Open `https://ministrylife.pages.dev/admin.html` and enter your `ADMIN_KEY`. The dashboard loads; numbers appear as people play.

The worker address is already set in the game (`VOTE_API` near the top of the Daily Card code in index.html) and in admin.html. If your worker URL is different, change it in index.html, and type the new address on the admin sign-in screen.

## What the dashboard shows
- Players today, new players, journeys started and Daily Card votes, each compared with yesterday
- Players active this week, all-time players, and how many came back the next day (D1) and a week later (D7)
- Players per day; journeys per day split by calling
- Calling, language (English or Pidgin) and device (phone or computer) split
- How journeys end, and the furthest season reached for each calling
- Daily Card results for every day
- What players choose on each decision card
- Top countries, badges earned, share and WhatsApp taps
- The latest 25 finished journeys

## Free-tier limits
D1's free tier allows 100,000 rows written per day. Each player writes about 3 rows a day (a visit, plus a start and an end for each journey), so the free tier covers roughly 25,000 to 30,000 players a day. If you grow past that, the Workers Paid plan ($5 a month) raises the limit to 50 million rows a month.
