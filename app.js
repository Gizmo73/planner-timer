// Planner timer on the web. It shares one small file (timer.json, in the app's hidden
// Google Drive folder) with the phone, so a session started on either shows on both.
"use strict";

const SCOPES = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/tasks";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const ENGAGE_MS = 200;
const HOLD_MS = 2500;
const RATCHET_CLICKS = 24;
const POLL_MS = 5000;
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (id) => document.getElementById(id);

let token = null;
let tokenClient = null;
let fileId = null;
let doc = null;      // the shared state
let seen = 0;        // updatedAt of the newest state we have
let pickedMode = "SESSION";
let workOn = null;   // "now", "other" or "none": what a new session is for
let workText = "";
let busy = false;    // avoids two writes racing at the end of a session
const hold = { pressing: false, full: false, p: 0, eased: 0, t0: 0, clicks: 0, hint: "" };
let interruptionKind = "head";
let audio = null;

// ---------- Boot and sign-in ----------

function clientId() {
  return window.PLANNER_CLIENT_ID || localStorage.getItem("clientId") || "";
}

function show(section) {
  for (const id of ["setup", "signin", "timer"]) $(id).hidden = id !== section;
}

function boot() {
  if (!clientId()) {
    show("setup");
    $("saveClient").onclick = () => {
      const v = $("clientId").value.trim();
      if (v) { localStorage.setItem("clientId", v); boot(); }
    };
    return;
  }
  const wait = () => {
    if (!window.google?.accounts?.oauth2) return setTimeout(wait, 100);
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPES,
      callback: (r) => {
        if (!r.access_token) return;
        token = r.access_token;
        localStorage.setItem("signedIn", "1");
        start();
      },
    });
    show("signin");
    $("signinBtn").textContent = localStorage.getItem("signedIn") ? "Continue" : "Sign in with Google";
    $("signinBtn").onclick = () =>
      tokenClient.requestAccessToken({ prompt: localStorage.getItem("signedIn") ? "" : "consent" });
  };
  wait();
}

async function api(method, url, body, type) {
  const headers = { Authorization: `Bearer ${token}` };
  if (type) headers["Content-Type"] = type;
  const res = await fetch(url, { method, headers, body });
  if (res.status === 401) {
    // Tokens last an hour; ask again.
    token = null;
    show("signin");
    throw new Error("signed out");
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- The shared file ----------

async function ensureFile() {
  if (fileId) return fileId;
  const q = encodeURIComponent("name='timer.json'");
  const found = await api("GET", `${DRIVE}/files?spaces=appDataFolder&fields=files(id)&q=${q}`);
  if (found.files?.length) return (fileId = found.files[0].id);
  const created = await api("POST", `${DRIVE}/files?fields=id`,
    JSON.stringify({ name: "timer.json", parents: ["appDataFolder"] }), "application/json");
  return (fileId = created.id);
}

async function readDoc() {
  const id = await ensureFile();
  const res = await fetch(`${DRIVE}/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { token = null; show("signin"); return null; }
  const text = res.ok ? await res.text() : "";
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function writeDoc() {
  const id = await ensureFile();
  doc.by = "web";
  doc.updatedAt = Date.now();
  seen = doc.updatedAt;
  await api("PATCH", `${UPLOAD}/files/${id}?uploadType=media`, JSON.stringify(doc), "application/json");
  render();
}

async function start() {
  show("timer");
  await pull();
  setInterval(pull, POLL_MS);
  setInterval(tick, 250);
}

async function pull() {
  if (!token) return;
  try {
    const d = await readDoc();
    $("sync").textContent = "In sync";
    if (!d) {
      if (!doc) { doc = { v: 1, timer: null, now: null, task: null, sessionsInSet: 0 }; render(); }
      return;
    }
    if (d.updatedAt > seen || !doc) {
      doc = d;
      seen = d.updatedAt || 0;
      render();
    }
  } catch (e) {
    $("sync").textContent = "Can't reach Google right now";
  }
}

// ---------- Timer actions ----------

const settings = () => doc?.settings || { focusMin: 25, breakMin: 5, longBreakMin: 25, longEvery: 4 };
const timer = () => doc?.timer || null;
const running = (t) => t && (t.phase === "FOCUS" || t.phase === "BREAK");
const remaining = (t) => (t.pausedRemaining >= 0 ? t.pausedRemaining : Math.max(0, t.endAt - Date.now()));

// The Now task, unless you picked something else or nothing.
function chosenWork() {
  const choice = workOn || (doc.now ? "now" : "none");
  if (choice === "now" && doc.now) return { task: doc.now, label: null };
  const label = choice === "other" && workText.trim() ? workText.trim() : null;
  return { task: { id: 0, title: label || "Focus session", next: null }, label };
}

function begin(phase, ms, extra = {}) {
  const now = Date.now();
  const t = timer();
  const work = t ? { task: doc.task, label: t.label || null } : chosenWork();
  const task = work.task;
  doc.timer = {
    taskId: task ? task.id : 0,
    label: work.label,
    mode: t ? t.mode : pickedMode,
    phase, total: ms, endAt: now + ms, pausedRemaining: -1, startedAt: now,
    longBreak: false, stoppedEarly: false, endedAt: 0,
    interruptions: [], counted: false, stopNote: null,
    ...extra,
  };
  doc.task = task;
  writeDoc();
}

function startFocus() {
  const t = timer();
  const mode = t ? t.mode : pickedMode;
  begin("FOCUS", (mode === "JUST10" ? 10 : settings().focusMin) * 60000);
  bell();
}

function togglePause() {
  const t = timer();
  if (t.pausedRemaining >= 0) {
    t.endAt = Date.now() + t.pausedRemaining;
    t.pausedRemaining = -1;
  } else {
    t.pausedRemaining = remaining(t);
  }
  writeDoc();
}

function toSummary(early, note) {
  const t = timer();
  t.phase = "SUMMARY";
  t.stoppedEarly = early;
  t.endedAt = early ? Date.now() : t.endAt;
  if (note) t.stopNote = note;
  writeDoc();
}

function longBreakDue() {
  const t = timer();
  const n = doc.sessionsInSet || 0;
  return t.mode === "SESSION" && !t.stoppedEarly && n > 0 && n % settings().longEvery === 0;
}

async function tick() {
  const t = timer();
  if (running(t)) {
    const left = remaining(t);
    document.title = `${fmt(left)} · Planner`;
    $("clock").textContent = fmt(left);
    drawRing(1 - left / t.total);
    drawGlass(left / t.total, 0);
    if (t.pausedRemaining < 0 && left === 0 && !busy) {
      busy = true;
      // The phone may have finished it already; go with whoever got there first.
      const latest = await readDoc().catch(() => null);
      if (latest && latest.updatedAt > seen) { doc = latest; seen = latest.updatedAt; }
      const cur = timer();
      if (cur && cur.startedAt === t.startedAt && cur.phase === t.phase) {
        if (cur.phase === "FOCUS") {
          if (cur.mode === "SESSION") doc.sessionsInSet = (doc.sessionsInSet || 0) + 1;
          cur.counted = false; // the phone counts it towards the task when it picks this up
          bell();
          toSummary(false);
        } else {
          if (cur.longBreak) doc.sessionsInSet = 0;
          cur.phase = "READY";
          bell();
          writeDoc();
        }
      } else {
        render();
      }
      busy = false;
    }
  } else {
    document.title = "Planner timer";
  }
}

// ---------- Hold to start ----------

function holdable() {
  const t = timer();
  return !t || t.phase === "READY";
}

function pressStart(e) {
  if (!holdable() || hold.pressing) return;
  e?.preventDefault?.();
  if (!audio) { try { audio = new AudioContext(); } catch { audio = null; } }
  Object.assign(hold, { pressing: true, full: false, p: 0, eased: 0, t0: performance.now(), clicks: 0, hint: "" });
  requestAnimationFrame(wind);
}

function wind(now) {
  if (!hold.pressing) return;
  hold.p = Math.min(1, Math.max(0, (now - hold.t0 - ENGAGE_MS) / HOLD_MS));
  // Resistance: the same steady press winds it less the further it goes.
  hold.eased = 1 - (1 - hold.p) * (1 - hold.p);
  const due = Math.floor(hold.eased * RATCHET_CLICKS);
  while (hold.clicks < due) { hold.clicks++; click(hold.eased); }
  if (hold.p >= 1 && !hold.full) {
    hold.full = true;
    navigator.vibrate?.(30);
  }
  drawHold();
  requestAnimationFrame(wind);
}

function pressEnd() {
  if (!hold.pressing) return;
  hold.pressing = false;
  if (hold.full) {
    hold.full = false;
    hold.eased = 0;
    startFocus();
    return;
  }
  if (hold.eased === 0) hold.hint = "Hold it";
  // Let go early and it unwinds; nothing starts.
  const from = hold.eased;
  const t0 = performance.now();
  const unwind = (now) => {
    const f = Math.min(1, (now - t0) / 300);
    hold.eased = from * (1 - f);
    drawHold();
    if (f < 1) requestAnimationFrame(unwind);
    else setTimeout(() => { hold.hint = ""; if (holdable()) render(); }, 1200);
  };
  requestAnimationFrame(unwind);
}

function drawHold() {
  if (!holdable()) return;
  drawRing(hold.eased);
  drawGlass(hold.eased, REDUCED_MOTION ? 0 : 180 * hold.eased);
  $("prompt").textContent = hold.full ? "Let go" : hold.pressing && hold.eased > 0 ? "Keep holding" : hold.hint || readyPrompt();
}

// A soft ratchet click whose pitch drops as the spring fills.
function click(level) {
  if (!audio || REDUCED_MOTION) return;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = "triangle";
  o.frequency.value = 2200 - 1200 * level;
  g.gain.setValueAtTime(0.04, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.03);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + 0.03);
}

function bell() {
  if (!audio) return;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = "sine";
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.12, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 1.6);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + 1.6);
}

// ---------- Drawing ----------

function drawRing(progress) {
  const arc = $("arc");
  const c = 2 * Math.PI * 46;
  arc.style.strokeDasharray = `${c}`;
  arc.style.strokeDashoffset = `${c * (1 - Math.max(0, Math.min(1, progress)))}`;
  arc.style.stroke = timer()?.phase === "BREAK" ? "var(--green)" : "var(--accent)";
}

// Peach sand is time left, sage is time used.
function drawGlass(sandTop, rotation) {
  const L = 20, R = 80, T = 8, B = 92, M = 50, N = 6, C = 50;
  const t = Math.max(0, Math.min(1, sandTop));
  let s = "";
  if (t > 0) {
    const y = M - (M - T) * t;
    const hw = ((R - L) / 2) * t + N * (1 - t);
    s += `<polygon fill="var(--peach)" points="${C - hw},${y} ${C + hw},${y} ${C + N},${M} ${C - N},${M}"/>`;
  }
  const b = 1 - t;
  if (b > 0) {
    const top = B - (B - M) * 0.85 * b;
    s += `<polygon fill="var(--sage)" points="${L + 2},${B} ${R - 2},${B} ${C + 6},${top} ${C - 6},${top}"/>`;
    if (t > 0) s += `<line x1="${C}" y1="${M}" x2="${C}" y2="${top}" stroke="var(--peach)" stroke-width="1"/>`;
  }
  s += `<polygon fill="none" stroke="var(--text)" stroke-width="2.5" stroke-linejoin="round" points="${L},${T} ${R},${T} ${C + N},${M} ${R},${B} ${L},${B} ${C - N},${M}"/>`;
  s += `<line x1="${L - 6}" y1="${T}" x2="${R + 6}" y2="${T}" stroke="var(--text)" stroke-width="3.5" stroke-linecap="round"/>`;
  s += `<line x1="${L - 6}" y1="${B}" x2="${R + 6}" y2="${B}" stroke="var(--text)" stroke-width="3.5" stroke-linecap="round"/>`;
  $("glass").innerHTML = s;
  $("glass").style.transform = `rotate(${rotation}deg)`;
}

const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function readyPrompt() {
  const t = timer();
  return t && t.phase === "READY" && t.startedAt ? "Break over. Hold to start the next session" : "Hold to start";
}

// ---------- Rendering ----------

function render() {
  if (!doc) return;
  const t = timer();
  const phase = t ? t.phase : "READY";
  const task = t ? (doc.task || { id: 0, title: t.label || "Focus session" }) : chosenWork().task;
  const mode = t ? t.mode : pickedMode;
  renderWorkPick(!t);
  const st = settings();
  const n = doc.sessionsInSet || 0;

  $("label").textContent = {
    READY: mode === "JUST10" ? "JUST 10" : "SESSION",
    FOCUS: t && t.pausedRemaining >= 0 ? "PAUSED" : "FOCUSING",
    BREAK: t && t.longBreak ? "LONG BREAK" : "BREAK",
    SUMMARY: "NICE WORK",
  }[phase];
  $("title").textContent = task ? task.title : "Focus session";
  $("next").textContent = task && task.next ? `Next: ${task.next}` : "";
  $("set").textContent = mode === "SESSION"
    ? `Session ${phase === "SUMMARY" ? ((Math.max(n, 1) - 1) % st.longEvery) + 1 : (n % st.longEvery) + 1} of ${st.longEvery} in this set`
    : "";

  $("modePick").hidden = !!t;
  for (const b of $("modePick").querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === pickedMode);

  $("glassWrap").style.cursor = holdable() ? "grab" : "default";
  const controls = $("controls");
  controls.innerHTML = "";
  $("review").innerHTML = "";
  $("hint").textContent = "";

  const btn = (label, fn, cls = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    controls.appendChild(b);
  };

  if (phase === "READY") {
    $("clock").textContent = "";
    drawRing(hold.eased);
    drawGlass(hold.eased, 0);
    $("prompt").textContent = readyPrompt();
    $("hint").textContent = `Hold the hourglass (or Space) for a few seconds. Your ${mode === "JUST10" ? 10 : st.focusMin} minutes begin when you let go.`;
    if (t) btn("Close", () => { doc.timer = null; writeDoc(); }, "text");
  } else if (phase === "FOCUS" || phase === "BREAK") {
    $("prompt").textContent = phase === "BREAK" ? "Step away from the screen if you can." : "";
    if (phase === "FOCUS") {
      const count = t.interruptions?.length || 0;
      btn(count ? `Interruption (${count})` : "Interruption", openInterruption, "primary");
    }
    btn(t.pausedRemaining >= 0 ? "Resume" : "Pause", togglePause);
    btn(phase === "BREAK" ? "End the break" : "Stop", () => {
      if (phase === "BREAK") { t.phase = "READY"; writeDoc(); } else openStop();
    }, "text");
    tick();
  } else {
    $("clock").textContent = "";
    drawRing(1);
    drawGlass(0, 0);
    const mins = Math.max(1, Math.round(((t.stoppedEarly ? t.endedAt - t.startedAt : t.total)) / 60000));
    $("prompt").textContent = t.stoppedEarly ? `You focused for ${mins} min. Showing up counts.` : `You focused for ${mins} min. As planned.`;
    renderReview(t);
    if (!t.taskId) renderCountDone(t);
    if (t.mode === "SESSION" && !t.stoppedEarly) {
      const long = longBreakDue();
      btn(long ? `Start the long break (${st.longBreakMin} min)` : `Start the break (${st.breakMin} min)`, () =>
        begin("BREAK", (long ? st.longBreakMin : st.breakMin) * 60000, { taskId: t.taskId, mode: t.mode, longBreak: long }), "primary");
    } else {
      btn("Go again", () => { t.phase = "READY"; t.interruptions = []; writeDoc(); }, "primary");
    }
    btn("Close", () => { doc.timer = null; writeDoc(); }, "text");
  }
}

function renderReview(t) {
  const list = (t.interruptions || []).filter((i) => i.text && i.text.trim());
  const total = t.interruptions?.length || 0;
  if (!total) return;
  const head = (t.interruptions || []).filter((i) => i.inHead).length;
  const box = document.createElement("div");
  box.className = "card";
  box.innerHTML = `<p>You noticed ${total} interruption${total === 1 ? "" : "s"}: ${head} in your head, ${total - head} around you.</p>`;
  if (list.length) {
    box.innerHTML += "<b>Turn any into tasks?</b>";
    list.forEach((i, k) => {
      const row = document.createElement("label");
      row.innerHTML = `<input type="checkbox" checked data-k="${k}" style="width:auto;margin:3px 0"><span>${escapeHtml(i.text)}<small>${i.inHead ? "In my head" : "Around me"}</small></span>`;
      box.appendChild(row);
    });
    const add = document.createElement("button");
    add.className = "primary";
    add.textContent = "Add to Next";
    add.onclick = async () => {
      const picked = [...box.querySelectorAll("input:checked")].map((c) => list[+c.dataset.k].text);
      add.disabled = true;
      // Straight into Google Tasks, which the phone pulls into Next.
      for (const title of picked) {
        await api("POST", "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks", JSON.stringify({ title }), "application/json");
      }
      t.interruptions = [];
      writeDoc();
    };
    box.appendChild(add);
  }
  $("review").appendChild(box);
}

function renderWorkPick(visible) {
  $("workPick").hidden = !visible;
  if (!visible) return;
  const choice = workOn || (doc.now ? "now" : "none");
  for (const b of $("workPick").querySelectorAll("button")) {
    if (b.dataset.work === "now") {
      b.hidden = !doc.now;
      b.textContent = doc.now ? doc.now.title : "";
    }
    b.classList.toggle("on", b.dataset.work === choice);
  }
  $("workText").hidden = choice !== "other";
}

// Work that wasn't on the list still counts: the phone logs it as a finished task.
function renderCountDone(t) {
  const box = document.createElement("div");
  box.className = "card";
  if (t.loggedDone) {
    box.innerHTML = `<b style="color:var(--green)">✓ Counted as done today.</b>`;
  } else {
    box.innerHTML = `<b>Count it as done?</b><small>It wasn't on your list, but it still counts.</small>`;
    const input = document.createElement("input");
    input.placeholder = "What did you work on?";
    input.value = t.label || "";
    const add = document.createElement("button");
    add.className = "primary";
    add.textContent = "Add as done";
    add.onclick = () => {
      const sessions = t.mode === "SESSION" && !t.stoppedEarly ? 1 : 0;
      doc.logDone = [...(doc.logDone || []).slice(-20), { title: input.value.trim() || "Focus session", at: Date.now(), sessions }];
      t.loggedDone = true;
      writeDoc();
    };
    box.append(input, add);
  }
  $("review").appendChild(box);
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Dialogs ----------

function openInterruption() {
  const dlg = $("interruptDlg");
  $("intText").value = "";
  interruptionKind = "head";
  for (const b of dlg.querySelectorAll("[data-kind]")) {
    b.classList.toggle("on", b.dataset.kind === interruptionKind);
    b.onclick = () => {
      interruptionKind = b.dataset.kind;
      for (const x of dlg.querySelectorAll("[data-kind]")) x.classList.toggle("on", x === b);
    };
  }
  dlg.onclose = () => {
    if (dlg.returnValue !== "save") return;
    const t = timer();
    if (!t) return;
    t.interruptions = [...(t.interruptions || []), { inHead: interruptionKind === "head", text: $("intText").value.trim() }];
    writeDoc();
  };
  dlg.showModal();
  $("intText").focus();
}

function openStop() {
  const dlg = $("stopDlg");
  $("stopText").value = "";
  const free = !timer()?.taskId;
  $("stopText").hidden = free;
  $("stopHelp").textContent = free
    ? "Showing up counts. You can still count it as done on the next screen."
    : "Where did you get to? It becomes the task's next step on your phone.";
  dlg.onclose = () => {
    if (dlg.returnValue === "stop") toSummary(true, $("stopText").value.trim() || null);
  };
  dlg.showModal();
  $("stopText").focus();
}

// ---------- Input ----------

const glass = $("glassWrap");
glass.addEventListener("pointerdown", (e) => { glass.setPointerCapture?.(e.pointerId); pressStart(e); });
glass.addEventListener("pointerup", pressEnd);
glass.addEventListener("pointercancel", pressEnd);
glass.addEventListener("keydown", (e) => {
  if ((e.key === " " || e.key === "Enter") && !e.repeat) pressStart(e);
});
glass.addEventListener("keyup", (e) => {
  if (e.key === " " || e.key === "Enter") pressEnd();
});
for (const b of $("workPick").querySelectorAll("button")) {
  b.onclick = () => { workOn = b.dataset.work; render(); if (workOn === "other") $("workText").focus(); };
}
$("workText").addEventListener("input", (e) => { workText = e.target.value; $("title").textContent = workText.trim() || "Focus session"; });
for (const b of $("modePick").querySelectorAll("button")) {
  b.onclick = () => { pickedMode = b.dataset.mode; render(); };
}

boot();
