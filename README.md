# Muse for Meta Ray-Ban Display

A web app that puts **Muse**, Meta's Muse Spark model, on your **Meta Ray-Ban Display** glasses. Pinch to speak or write a question, and the answer streams onto the 600×600 in-lens display. It can also read answers aloud.

Muse can also **write new apps for your glasses**. Say *"make me a pomodoro timer"* and Muse writes the code, saves it and shows an **▶ Open** button. Then say *"make the numbers bigger"* and Muse reads its own code and updates the app.

- **Pinch the "Ask Muse…" box** to open the glasses' composer: speak, handwrite, or swipe down for the on-screen keyboard (glasses software v129+). Your message is sent as soon as you finish.
- **Swipe ↑ / ↓** to page through long answers.
- **Swipe ← / →** to move between the ask box and the buttons:
  - **🔈 Voice:** reads Muse's answers aloud (🔊 when on).
  - **📍 Place:** shares your location so "near me" and "here" questions work. Your first pinch asks for permission. It uses your phone's location, and the server turns it into a neighborhood and city with OpenStreetMap.
  - **▦ Apps:** the apps Muse has built for you.
  - **＋ New:** starts a new chat.
- **Back gesture** while Muse is answering stops the reply.

### Apps Muse builds

- Ask for anything that fits a 600×600 swipe-and-pinch screen: timers, counters, checklists, flashcards, a compass, games, a dashboard that pulls from a public API.
- Ask for changes in plain words (*"add a reset button"*, *"make it green"*). Muse edits the app it just built, or the one you name.
- **▦ Your apps** lists everything Muse has built. Pinch one to open it. Swipe → then pinch twice on ✕ to delete it.
- Inside an app, the **back gesture** returns you to your app list.

### "Hey Meta" can run Muse

When Meta AI can use web apps on your glasses (see below), you can talk to it while Muse is open:

- *"Hey Meta, ask Muse what's open near me"* or *"ask Muse to make me a pomodoro timer"*: Meta AI hands the request to Muse, and Muse's answer appears on the display as usual.
- *"Hey Meta, open my pomodoro timer"*: opens one of your apps by name. *"Hey Meta, what apps do I have?"* shows your app list.
- *"Hey Meta, start a new chat"*: same as ＋.

Apps Muse builds come with their own voice actions too, so inside a counter you can say *"Hey Meta, add five"* or *"reset it"*. Apps built before this feature don't have them; ask Muse to "add voice control" to one.

This uses **WebMCP**, which Meta is rolling out. It's on when your glasses are in Developer Mode (which you need for web apps anyway) or part of Meta's rollout. If it doesn't respond, restart the glasses and the Meta AI app. Everything still works by hand without it.

**What Muse can't change:** Meta only lets outside code run as web apps, so this app can't touch the glasses' system software, settings, firmware or Meta's built-in apps. Muse's apps can use the display, swipes and pinches, the voice/handwriting composer, text-to-speech, motion sensors, your phone's location, local storage and the internet. The camera and microphone aren't open to web apps yet.

Muse searches the web for anything current or local, like weather, news, scores, hours and places nearby, and it always knows your local time. It knows it's on a small heads-up display, so it keeps replies short and in plain text. Your conversation is kept on the glasses between sessions until you tap ＋.

> **Already have "Hey Meta"?** The glasses' built-in Meta AI has run on Muse Spark since the v127 update, and it can use the camera. This app adds what the built-in assistant can't do: building your own glasses apps, your own instructions, and your choice of model and effort.

## How it works

```
Glasses (web app)  ──HTTPS──▶  server.js  ──▶  Meta Model API (Muse Spark)
 public/*                       holds your API key
 /apps/<id>/  ◀──────────────   Vercel Blob or data/apps/  (apps Muse wrote)
```

The glasses load a normal web page. `server.js` serves that page and forwards chat requests to Meta Model API, so your API key never reaches the glasses. Meta Model API has an Anthropic-compatible Messages endpoint, so the server talks to it with the Anthropic SDK pointed at `https://api.meta.ai`.

Muse has four tools on the server: `list_apps`, `read_app`, `save_app` and `delete_app`. Each app it writes is one HTML file, saved to Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set and to `APPS_DIR` otherwise. It's served at `/apps/<id>/`.

## 1. Get a Meta Model API key

Sign up at https://dev.meta.ai and create a key under **API keys**. The API is in public preview for developers in the US.

## 2. Deploy it on Vercel (the glasses need HTTPS)

Meta's glasses only load `https://` web apps. Vercel gives you that for free, and it runs `server.js` as-is with no config file.

1. **Import the repo.** Go to https://vercel.com/new and import `GalacTechNyc/muse-display`. Leave the framework preset as **Other** and the build settings empty.
2. **Add environment variables** before you deploy:
   - `MODEL_API_KEY`: your Meta Model API key.
   - `ACCESS_TOKEN`: any long random passcode you make up. The glasses send it with every request.
3. **Deploy.**
4. **Connect storage for the apps Muse builds.** In the project, open **Storage → Create → Blob**. Choose **Private** access and connect it to the project. Vercel adds `BLOB_READ_WRITE_TOKEN` for you.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the app picks up the storage token.

Your app URL is the project's production domain, e.g. `https://muse-display-yourname.vercel.app`. Open `https://YOUR-APP-URL/api/health` to check it: `apiKey` should be `true`.

> **Use the production URL, not a preview URL.** Vercel protects preview deployments with a login page by default, and the glasses can't get past it. Production deploys come from `main`. If the glasses still see a login screen, check **Settings → Deployment Protection**.

**Other hosts:** anything that runs Node 22+ behind HTTPS works (Railway, Fly.io, Render, a VPS). Run `npm ci && npm start`. Without Blob storage, apps are saved to `APPS_DIR` on disk, so use a persistent disk there.

## 3. Add it to your glasses

1. In the **Meta AI** app, turn on Developer Mode: **Settings → App Info**, then tap **App version** 5 times.
2. Go to **Settings → App Connections → Web Apps → Add a Web App**.
3. Name it `Muse` and use this URL, with your access token on the end:
   ```
   https://YOUR-APP-URL/?key=YOUR_ACCESS_TOKEN
   ```
4. Open **Muse** from the app launcher on your glasses.

You need glasses firmware v125+ and Meta AI app v272+. The key is saved on the glasses after the first launch.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `MODEL_API_KEY` | — | **Required.** Your Meta Model API key. |
| `ACCESS_TOKEN` | *(none)* | Passcode the glasses must send. **Set this.** Without it, anyone who finds your URL can spend your API credits. |
| `MUSE_MODEL` | `muse-spark-1.3` | The Muse model to use. `muse-spark-1.3-contributor` is far cheaper, but Meta may train on your chats. |
| `MUSE_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max`. Lower is faster and cheaper; higher writes better apps. |
| `BLOB_READ_WRITE_TOKEN` | *(none)* | Set automatically when you connect a Vercel Blob store. Apps are then saved there. |
| `BLOB_ACCESS` | `private` | Match your Blob store's access type (`private` or `public`). |
| `APPS_DIR` | `data/apps` | Where apps are saved when there's no Blob store (local or other hosts). |
| `SYSTEM_PROMPT` | glasses-tuned | Replaces the chat instructions. The app-building rules are always added. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens locally. Vercel ignores these. |

**Cost:** Muse Spark costs about $1.25 per million input tokens and $4.25 per million output tokens, plus $2.50 per 1,000 web searches.

**Web search:** Meta's docs don't say which tool name its Anthropic-compatible endpoint expects for web search. `web_search_20250305` works as of October 2026. If Meta ever rejects it, the server tries `web_search`, then keeps working without search. `/api/health` shows which one is in use (`"webSearch"`).

## Run locally / test without glasses

```bash
cp .env.example .env   # add your MODEL_API_KEY
npm install
npm start              # http://localhost:3000
```

Open it in Chrome with the [Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/meta-ray-ban-display-simu/jpjlmmodokemlepklkdbimceggpbjcll) extension. It previews the 600×600 display and lets you test D-pad input. In a plain browser, use the arrow keys, type in the box and press Enter.

To try it on the real glasses before deploying, give your local server an HTTPS address with a tunnel such as `cloudflared tunnel --url http://localhost:3000`.
