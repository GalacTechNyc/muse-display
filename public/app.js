// Muse for Meta Ray-Ban Display.
// Input on the glasses arrives as ArrowUp/Down/Left/Right, Enter (pinch) and
// Escape (back). Pinching a focused textarea opens the on-glasses voice /
// handwriting composer; the result comes back through `input`/`change` events.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const promptEl = $("prompt");
  const speakBtn = $("speak");
  const appsBtn = $("appsBtn");
  const placeBtn = $("placeBtn");
  const resetBtn = $("reset");
  const statusEl = $("status");
  const welcomeEl = $("welcome");
  const exchangeEl = $("exchange");
  const questionEl = $("question");
  const answerEl = $("answer");
  const moreEl = $("more");
  const openAppBtn = $("openApp");
  const appsView = $("appsView");
  const appList = $("appList");
  const appsEmpty = $("appsEmpty");

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  // Access key: open the app once as https://your-host/?key=YOUR_ACCESS_TOKEN
  const params = new URLSearchParams(location.search);
  if (params.has("key")) store.set("accessKey", params.get("key"));
  const accessKey = store.get("accessKey", "");
  const authHeaders = { "X-Access-Token": accessKey };

  // Each message: { role, content, app?: {id, title} } — app is set when Muse saved an app that turn.
  let messages = store.get("messages", []);
  let speakAloud = store.get("speakAloud", false);
  let shareLocation = store.get("shareLocation", false);
  let lastPosition = null; // { lat, lon, accuracy, at }
  let watchId = null;
  let busy = false;
  let controller = null;
  let view = "chat";

  function setStatus(text, kind = "") {
    statusEl.textContent = text;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  // --- Chat view -------------------------------------------------------------

  // Size the answer box to a whole number of lines so text is never cut in half.
  function fitAnswer() {
    if (exchangeEl.hidden) return;
    answerEl.style.height = "0px";
    const lineHeight = parseFloat(getComputedStyle(answerEl).lineHeight) || 39;
    const available = exchangeEl.clientHeight - answerEl.offsetTop + exchangeEl.offsetTop;
    answerEl.style.height = Math.max(1, Math.floor(available / lineHeight)) * lineHeight + "px";
  }

  function updateMore() {
    const hasMore = !exchangeEl.hidden && answerEl.scrollTop + answerEl.clientHeight < answerEl.scrollHeight - 4;
    moreEl.hidden = !hasMore;
  }

  function setOpenApp(app) {
    openAppBtn.hidden = !app;
    if (app) {
      openAppBtn.textContent = `▶ Open ${app.title}`;
      openAppBtn.dataset.id = app.id;
    }
    fitAnswer();
    updateMore();
  }

  function showExchange(question, answer, { error = false, streaming = false } = {}) {
    welcomeEl.hidden = true;
    exchangeEl.hidden = false;
    questionEl.textContent = question;
    answerEl.textContent = answer;
    answerEl.classList.toggle("error", error);
    answerEl.classList.toggle("cursor", streaming);
    fitAnswer();
    updateMore();
  }

  function renderLatest() {
    const last = messages.length - 1;
    if (last >= 1 && messages[last].role === "assistant") {
      showExchange(messages[last - 1].content, messages[last].content);
      answerEl.scrollTop = 0;
      setOpenApp(messages[last].app || null);
    } else {
      welcomeEl.hidden = false;
      exchangeEl.hidden = true;
      setOpenApp(null);
    }
    updateMore();
  }

  function scrollAnswer(direction) {
    if (exchangeEl.hidden) return;
    const lineHeight = parseFloat(getComputedStyle(answerEl).lineHeight) || 39;
    const lines = Math.max(1, Math.floor((answerEl.clientHeight * 0.85) / lineHeight));
    answerEl.scrollTop = Math.round(answerEl.scrollTop / lineHeight + lines * direction) * lineHeight;
    updateMore();
  }

  function speak(text) {
    if (!speakAloud || !("speechSynthesis" in window) || !text) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  function setSpeak(on) {
    speakAloud = on;
    store.set("speakAloud", on);
    speakBtn.setAttribute("aria-pressed", String(on));
    speakBtn.querySelector(".ico").textContent = on ? "🔊" : "🔈";
    if (!on && "speechSynthesis" in window) speechSynthesis.cancel();
  }

  // --- Location ----------------------------------------------------------------
  // The glasses only show the permission prompt after a pinch, so location starts
  // from the Place button; afterwards a watch keeps the latest fix ready for each send.

  function startWatching() {
    if (!("geolocation" in navigator) || watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        lastPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() };
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setPlace(false);
          setStatus("Location blocked", "error");
        }
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 20000 },
    );
  }

  function stopWatching() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    lastPosition = null;
  }

  function setPlace(on) {
    shareLocation = on;
    store.set("shareLocation", on);
    placeBtn.setAttribute("aria-pressed", String(on));
    if (on) startWatching();
    else stopWatching();
  }

  function togglePlace() {
    if (shareLocation) {
      setPlace(false);
      setStatus("Location off");
      return;
    }
    if (!("geolocation" in navigator)) {
      setStatus("No location here", "error");
      return;
    }
    setStatus("Finding you…", "busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() };
        setPlace(true);
        setStatus("Location on");
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? "Location blocked" : "Can't find you", "error"),
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 20000 },
    );
  }

  // Sent with every question: local time zone always, location when shared and fresh.
  function currentContext() {
    const context = {};
    try { context.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* unknown */ }
    if (shareLocation && lastPosition && Date.now() - lastPosition.at < 10 * 60 * 1000) {
      const { lat, lon, accuracy } = lastPosition;
      context.location = { lat, lon, accuracy };
    }
    return context;
  }

  function resetChat() {
    if (controller) controller.abort();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    messages = [];
    store.set("messages", messages);
    promptEl.value = "";
    setStatus("Ready");
    renderLatest();
    promptEl.focus();
  }

  // What the server sees: text turns, with a note so Muse knows which app "it" refers to.
  function apiMessages() {
    return messages.map((m) => ({
      role: m.role,
      content: m.app ? `${m.content}\n\n[Saved app "${m.app.title}" (app_id: ${m.app.id})]` : m.content,
    }));
  }

  async function send() {
    const text = promptEl.value.trim();
    if (!text || busy) return;
    busy = true;
    promptEl.value = "";
    if ("speechSynthesis" in window) speechSynthesis.cancel();

    messages.push({ role: "user", content: text });
    let answer = "";
    let roundStart = 0;
    let savedApp = null;
    showExchange(text, "", { streaming: true });
    setOpenApp(null);
    answerEl.scrollTop = 0;
    setStatus("Thinking…", "busy");

    controller = new AbortController();
    let failed = null;
    try {
      const res = await fetch("api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ messages: apiMessages(), context: currentContext() }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          switch (event.type) {
            case "round":
              if (answer && !/\s$/.test(answer)) answer += " ";
              roundStart = answer.length;
              break;
            case "retry":
              answer = answer.slice(0, roundStart);
              answerEl.textContent = answer;
              break;
            case "text":
              setStatus("Answering…", "busy");
              answer += event.text;
              answerEl.textContent = answer;
              updateMore();
              break;
            case "status":
              setStatus(event.text, "busy");
              break;
            case "app":
              savedApp = { id: event.app.id, title: event.app.title };
              setOpenApp(savedApp);
              break;
            case "app_deleted":
              if (savedApp && savedApp.id === event.id) { savedApp = null; setOpenApp(null); }
              break;
            case "error":
              failed = event.error;
              break;
          }
        }
      }
    } catch (err) {
      failed = err.name === "AbortError" ? "Stopped." : err.message || "Network error.";
    } finally {
      busy = false;
      controller = null;
      answerEl.classList.remove("cursor");
    }

    answer = answer.trim();
    if (!answer && savedApp) answer = `Saved ${savedApp.title}.`;
    if (answer) {
      messages.push({ role: "assistant", content: answer, ...(savedApp ? { app: savedApp } : {}) });
      answerEl.textContent = answer;
    } else {
      messages.pop(); // drop the unanswered question so the conversation stays valid
    }
    store.set("messages", messages.slice(-40));

    if (failed && !answer) {
      showExchange(text, failed, { error: true });
      setStatus("Error", "error");
    } else {
      setStatus(failed ? "Stopped" : "Ready", failed ? "error" : "");
      speak(answer);
    }
    fitAnswer();
    updateMore();
    if (savedApp && view === "chat") openAppBtn.focus();
  }

  function openApp(id) {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    location.href = `apps/${encodeURIComponent(id)}/`;
  }

  // --- Apps view -------------------------------------------------------------

  async function showApps() {
    view = "apps";
    welcomeEl.hidden = true;
    exchangeEl.hidden = true;
    moreEl.hidden = true;
    openAppBtn.hidden = true;
    appsView.hidden = false;
    appsEmpty.hidden = true;
    appList.replaceChildren();
    setStatus("Your apps");

    let list = [];
    try {
      const res = await fetch("api/apps", { headers: authHeaders });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
      list = body.apps;
    } catch (err) {
      setStatus(err.message || "Couldn't load apps", "error");
    }
    if (view !== "apps") return;

    appsEmpty.hidden = list.length > 0;
    for (const app of list) {
      const row = document.createElement("div");
      row.className = "app-row";
      const open = document.createElement("button");
      open.className = "focusable app-open";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = app.title;
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = app.description;
      open.append(title, desc);
      open.addEventListener("click", () => openApp(app.id));

      const del = document.createElement("button");
      del.className = "focusable app-delete";
      del.textContent = "✕";
      del.setAttribute("aria-label", `Delete ${app.title}`);
      del.addEventListener("click", () => deleteApp(app, row, del));
      del.addEventListener("blur", () => { del.classList.remove("confirm"); del.textContent = "✕"; });

      row.append(open, del);
      appList.append(row);
    }
    const first = appList.querySelector(".app-open");
    (first || appsBtn).focus();
  }

  async function deleteApp(app, row, del) {
    if (!del.classList.contains("confirm")) {
      del.classList.add("confirm");
      del.textContent = "Delete?";
      return;
    }
    try {
      const res = await fetch(`api/apps/${encodeURIComponent(app.id)}`, { method: "DELETE", headers: authHeaders });
      if (!res.ok) throw new Error();
      const sibling = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      setStatus(`Deleted ${app.title}`);
      if (sibling) sibling.querySelector(".app-open").focus();
      else { appsEmpty.hidden = false; appsBtn.focus(); }
    } catch {
      setStatus("Delete failed", "error");
    }
  }

  function showChat() {
    view = "chat";
    appsView.hidden = true;
    setStatus(busy ? "Thinking…" : "Ready", busy ? "busy" : "");
    renderLatest();
    promptEl.focus();
  }

  // --- Input -----------------------------------------------------------------

  // Text from the on-glasses composer arrives as a change event.
  promptEl.addEventListener("change", () => { if (promptEl.value.trim()) send(); });
  speakBtn.addEventListener("click", () => setSpeak(!speakAloud));
  placeBtn.addEventListener("click", togglePlace);
  appsBtn.addEventListener("click", () => (view === "apps" ? showChat() : showApps()));
  resetBtn.addEventListener("click", () => { if (view === "apps") showChat(); resetChat(); });
  openAppBtn.addEventListener("click", () => openApp(openAppBtn.dataset.id));

  const footerControls = [promptEl, speakBtn, placeBtn, appsBtn, resetBtn];

  function moveFocusIn(list, delta) {
    const i = list.indexOf(document.activeElement);
    const next = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta));
    list[next].focus();
  }

  function handleChatKey(e) {
    switch (e.key) {
      case "ArrowUp": e.preventDefault(); scrollAnswer(-1); break;
      case "ArrowDown": e.preventDefault(); scrollAnswer(1); break;
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const list = openAppBtn.hidden ? footerControls : [openAppBtn, ...footerControls];
        moveFocusIn(list, e.key === "ArrowLeft" ? -1 : 1);
        break;
      }
      case "Enter":
        // With text already typed (e.g. in the browser simulator), Enter sends.
        // On an empty box, let the pinch through so the glasses open the composer.
        if (document.activeElement === promptEl && promptEl.value.trim()) {
          e.preventDefault();
          send();
        }
        break;
      case "Escape":
        // Back gesture: stop a reply in progress, otherwise leave the app as usual.
        if (busy && controller) { e.preventDefault(); controller.abort(); }
        break;
    }
  }

  function handleAppsKey(e) {
    const rows = [...appList.querySelectorAll(".app-row")];
    const active = document.activeElement;
    const rowIndex = rows.findIndex((r) => r.contains(active));
    const col = active && active.classList.contains("app-delete") ? 1 : 0;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        if (!rows.length) return;
        const dir = e.key === "ArrowUp" ? -1 : 1;
        if (rowIndex < 0) { if (dir < 0) rows.at(-1).children[0].focus(); return; }
        const next = rowIndex + dir;
        if (next >= rows.length) appsBtn.focus();
        else if (next >= 0) rows[next].children[col].focus();
        rows[Math.max(0, Math.min(rows.length - 1, next))].scrollIntoView({ block: "nearest" });
        break;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        if (rowIndex >= 0) rows[rowIndex].children[Math.max(0, Math.min(1, col + dir))].focus();
        else moveFocusIn(footerControls, dir);
        break;
      }
      case "Escape":
        e.preventDefault();
        showChat();
        break;
    }
  }

  document.addEventListener("keydown", (e) => (view === "apps" ? handleAppsKey(e) : handleChatKey(e)));

  // --- Meta AI (WebMCP) ------------------------------------------------------
  // On glasses with WebMCP turned on, Meta AI can run this page by voice ("Hey Meta,
  // ask Muse…"). Every tool is also the ask box or a button, so nothing depends on it.
  // Meta AI waits at most 10 seconds for a tool, so ask_muse hands the request over
  // and Muse's answer streams onto the display as usual.

  async function fetchApps(signal) {
    const res = await fetch("api/apps", { headers: authHeaders, signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    return body.apps;
  }

  const nameWords = (s) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !["the", "my", "app"].includes(w));

  // Apps whose titles best match a spoken name ("pomodoro" → "Pomodoro Timer").
  // More than one result means the name was unclear.
  function findApps(list, spoken) {
    const want = nameWords(spoken);
    if (!want.length) return [];
    const scored = list
      .map((app) => {
        const have = nameWords(app.title);
        const shared = want.filter((w) => have.some((h) => h.startsWith(w) || w.startsWith(h))).length;
        return { app, score: shared / Math.max(want.length, have.length) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score === scored[0]?.score).map((s) => s.app);
  }

  const noApps = "Tell the user they have no apps yet and can ask Muse to make one.";

  const agentTools = [
    {
      name: "ask_muse",
      description:
        'Send the wearer\'s request to Muse, the AI in this app: questions, anything to look up, and making or changing a glasses app ("make me a timer", "make the numbers bigger"). Muse\'s answer appears on the display.',
      inputSchema: {
        type: "object",
        properties: { request: { type: "string", description: "The wearer's request, in their own words." } },
        required: ["request"],
      },
      async execute(input) {
        const request = typeof input?.request === "string" ? input.request.trim() : "";
        if (!request) return { sent: false, error: "empty_request", next_action: "Ask the user what they want Muse to do." };
        if (busy) {
          return {
            sent: false,
            error: "busy",
            message: "Muse is still answering the last request.",
            next_action: "Tell the user Muse is still answering and to ask again in a moment.",
          };
        }
        if (view === "apps") showChat();
        promptEl.value = request.slice(0, 4000);
        send();
        return {
          sent: true,
          next_action: "Stop. In a few words, tell the user Muse is answering on the display. Do not answer the request yourself.",
        };
      },
    },
    {
      name: "open_app",
      description:
        "Open one of the glasses apps Muse has built for the wearer, by name. Without a name, it shows the app list and returns the app names.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "The app's name as the wearer said it." } },
      },
      async execute(input, { signal } = {}) {
        const list = await fetchApps(signal);
        const titles = list.map((a) => a.title);
        const spoken = typeof input?.name === "string" ? input.name.trim() : "";
        if (!spoken) {
          showApps();
          return { apps: titles, next_action: titles.length ? "Stop and name the apps in one short sentence." : noApps };
        }
        const matches = findApps(list, spoken);
        if (matches.length === 1) {
          setTimeout(() => openApp(matches[0].id), 300); // reply first; leaving the page removes these tools
          return { opened: matches[0].title, next_action: "Stop. Say the app is open." };
        }
        if (matches.length > 1) {
          return { opened: null, error: "unclear", matches: matches.map((a) => a.title), next_action: "Ask the user which of these apps they mean." };
        }
        return {
          opened: null,
          error: "not_found",
          apps: titles,
          next_action: titles.length ? "Tell the user there's no app by that name and name the apps they have." : noApps,
        };
      },
    },
    {
      name: "new_chat",
      description: "Clear the conversation with Muse and start a new chat.",
      async execute() {
        if (view === "apps") showChat();
        resetChat();
        return { cleared: true, next_action: "Stop. Say a new chat started." };
      },
    },
  ];

  function registerAgentTools() {
    if (!document.modelContext) return;
    for (const tool of agentTools) {
      try {
        Promise.resolve(document.modelContext.registerTool(tool)).catch(() => {});
      } catch { /* the host rejected this definition; the app still works by hand */ }
    }
  }

  // --- Start -----------------------------------------------------------------
  setSpeak(speakAloud);
  placeBtn.setAttribute("aria-pressed", String(shareLocation));
  if (shareLocation) startWatching(); // permission was granted earlier, so no prompt
  if (params.get("view") === "apps") {
    history.replaceState(null, "", location.pathname);
    showApps();
  } else {
    renderLatest();
    promptEl.focus();
  }
  registerAgentTools();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
