# Daily Card votes: one-time setup (about 5 minutes)

The game works without this; votes are saved on each phone and results show
"Live results will appear once the vote server is online". Do these steps to
switch on "How Nigeria voted".

## 1. Create the database
1. Cloudflare dashboard → **Storage & Databases → D1 SQL Database → Create**.
2. Name it `ministrylife` and click **Create**. (No tables needed; the worker creates them.)

## 2. Create the worker
1. **Workers & Pages → Create → Create Worker** (start from "Hello World").
2. Name it exactly `ministrylife-votes` and click **Deploy**.
3. Click **Edit code**, delete everything, paste the contents of `worker.js`, then **Deploy**.

## 3. Connect the database to the worker
1. Open the `ministrylife-votes` worker → **Settings → Bindings → Add → D1 database**.
2. Variable name: `DB` (capital letters). Database: `ministrylife`. **Save / Deploy**.

## 4. Check it
Open `https://ministrylife-votes.azubuikedavies.workers.dev` in your browser.
You should see: `{"ok":true,"service":"ministrylife-votes", ...}`

That address is already set in the game (`VOTE_API` near the top of the Daily
Card code in index.html). If your worker URL is different, change that one line.

## Free-tier limits
D1's free tier allows 100,000 writes a day, which is roughly 100,000 votes a day.
Each phone can vote once per Daily Card.
