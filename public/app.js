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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
