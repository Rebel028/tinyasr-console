// tinyasr console: streams 16 kHz PCM16 to a Flux-compatible /v2/listen socket and shows turns + an event log.
const $ = (id) => document.getElementById(id);
const RATE = 16000, FRAME = 640, FRAME_MS = 40, BYTES_PER_S = RATE * 2;
const TAIL_SILENCE_S = 2; // after a file, so the server can find the end of the last turn
const MAX_ROWS = 3000;
const KINDS = new Set(["Connected", "StartOfTurn", "Update", "EndOfTurn", "EagerEndOfTurn", "TurnResumed", "Error"]);

const ui = {
  url: $("url"), start: $("start"), stop: $("stop"), abort: $("abort"), file: $("file"), pace: $("pace"),
  thr: $("thr"), thrv: $("thrv"), tmo: $("tmo"), eager: $("eager"), preview: $("preview"), err: $("err"), state: $("state"),
  rid: $("rid"), turns: $("turns"), log: $("log"), showhb: $("showhb"), level: $("level"),
};

let ws = null, source = null, s = null;
const events = []; // everything, for export and re-render
let rows = [];
const hidden = new Set();

// ---------- params ----------
ui.url.value = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname || "localhost"}:8000/v2/listen`;

function buildUrl() {
  const u = new URL(ui.url.value.trim());
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error("URL must start with ws:// or wss://");
  u.search = "";
  u.searchParams.set("encoding", "linear16");
  u.searchParams.set("sample_rate", String(RATE));
  const hints = [...document.querySelectorAll("input[name=lang]:checked")].map((el) => el.value);
  for (const h of $("hintx").value.split(/[\s,]+/).filter(Boolean)) {
    // the server maps ru-RU / ru_RU to ru and answers 400 for a language the model lacks; this only catches typos
    if (!/^[a-z]{2,3}([-_][a-z0-9]{2,8})?$/i.test(h)) throw new Error(`"${h}" is not a language code`);
    if (!hints.includes(h)) hints.push(h);
  }
  for (const h of hints) u.searchParams.append("language_hint", h);
  $("hintnone").hidden = hints.length > 0;
  const thr = Number(ui.thr.value).toFixed(2);
  u.searchParams.set("eot_threshold", thr);
  const tmo = Math.round(Number(ui.tmo.value));
  if (!(tmo >= 100 && tmo <= 60000)) throw new Error("eot_timeout_ms must be 100 to 60000");
  u.searchParams.set("eot_timeout_ms", String(tmo));
  if (ui.eager.value !== "" || ui.eager.validity.badInput) { // empty: off, the parameter is left out
    const eager = Number(Number(ui.eager.value).toFixed(2)); // validate what is sent; bad input reads as "" -> 0
    if (!(eager >= 0.3 && eager <= 0.9)) throw new Error("eager_eot_threshold must be 0.3 to 0.9, or empty for off");
    if (eager > Number(thr)) throw new Error(`eager_eot_threshold must not be above eot_threshold (${thr})`);
    u.searchParams.set("eager_eot_threshold", eager.toFixed(2));
  }
  return u.toString();
}

function refreshPreview() {
  ui.thrv.value = Number(ui.thr.value).toFixed(2);
  try { ui.preview.textContent = buildUrl(); ui.preview.style.color = ""; }
  catch (e) { ui.preview.textContent = e.message; ui.preview.style.color = "var(--bad)"; }
}
document.querySelectorAll(".controls input, .bar input").forEach((el) => el.addEventListener("input", refreshPreview));

const micOk = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
function setSrc(v) { document.body.dataset.src = v; }
document.querySelectorAll("input[name=src]").forEach((el) => el.addEventListener("change", () => setSrc(el.value)));
if (!micOk) {
  $("micnote").hidden = false;
  document.querySelector('input[name=src][value=mic]').disabled = true;
  document.querySelector('input[name=src][value=file]').checked = true;
  setSrc("file");
} else setSrc("mic");
refreshPreview();

// ---------- event log ----------
const fmtTime = (t) => { const d = new Date(t); return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0"); };

function describe(ev) {
  if (ev.dir === "out" && ev.type === "audio") return { kind: "client", ty: "audio", fold: "audio" };
  if (ev.dir !== "in") return { kind: "client", ty: ev.type, sum: ev.note ?? "" };
  const m = ev.data;
  if (m?.type === "TurnInfo") {
    const eot = m.event === "EndOfTurn";
    let sum = `#${m.turn_index} ${m.transcript || "(empty)"}`;
    if (eot || m.event === "EagerEndOfTurn") sum += `  p=${Number(m.end_of_turn_confidence).toFixed(3)} ${m.trigger ?? ""}`;
    const fold = m.event === "Update" && !ui.showhb.checked ? `u|${m.turn_index}|${m.transcript}` : null;
    return { kind: KINDS.has(m.event) ? m.event : "other", ty: m.event, sum, fold };
  }
  if (m?.type === "Connected") return { kind: "Connected", ty: "Connected", sum: m.request_id };
  if (m?.type === "Error") return { kind: "Error", ty: "Error", sum: `${m.code} ${m.description ?? ""}` };
  return { kind: "other", ty: m?.type ?? "text", sum: typeof m === "string" ? m : JSON.stringify(m) };
}

function appendRow(ev) {
  const d = describe(ev);
  if (hidden.has(d.kind)) return;
  // Fold into one of the last two rows: audio-out and heartbeat-in interleave, each keeps its own row.
  if (d.fold) {
    for (const r of rows.slice(-2)) {
      if (r.fold !== d.fold) continue;
      r.n++; r.ev = ev;
      if (d.fold === "audio") { r.bytes += ev.bytes; r.sumEl.textContent = `${(r.bytes / BYTES_PER_S).toFixed(2)} s`; }
      r.nEl.textContent = `×${r.n}`; // the row keeps its first time so the log stays in order
      if (r.el.open) r.pre.textContent = pretty(ev);
      return;
    }
  }
  const el = document.createElement("details");
  el.className = `k-${d.kind}`;
  el.innerHTML = '<summary><span class="t"></span><span class="dir"></span><span class="ty"></span><span class="sum"></span><span class="n"></span></summary><pre></pre>';
  const [tEl, dirEl, tyEl, sumEl, nEl] = el.querySelectorAll("summary span");
  const r = { el, fold: d.fold, n: 1, ev, bytes: ev.bytes ?? 0, sumEl, nEl, pre: el.querySelector("pre") };
  tEl.textContent = fmtTime(ev.t);
  dirEl.textContent = ev.dir === "in" ? "↓" : ev.dir === "out" ? "↑" : "·";
  tyEl.textContent = d.ty;
  sumEl.textContent = d.fold === "audio" ? `${(r.bytes / BYTES_PER_S).toFixed(2)} s` : d.sum;
  el.addEventListener("toggle", () => { if (el.open) r.pre.textContent = pretty(r.ev); });

  const stick = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 24;
  ui.log.querySelector(".empty")?.remove();
  ui.log.append(el);
  rows.push(r);
  if (rows.length > MAX_ROWS) rows.shift().el.remove();
  if (stick) ui.log.scrollTop = ui.log.scrollHeight;
}

function pretty(ev) {
  if (ev.dir === "in") return typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data, null, 2);
  if (ev.type === "audio") return `last frame: ${ev.bytes} bytes PCM16 LE mono 16 kHz`;
  return JSON.stringify(ev.data ?? { note: ev.note }, null, 2);
}

function rerender() {
  ui.log.textContent = ""; rows = [];
  for (const ev of events) appendRow(ev);
  if (!events.length) ui.log.innerHTML = '<p class="empty">No events yet. Messages from the socket show up here, newest at the bottom.</p>';
}

function record(ev) { ev.t ??= Date.now(); events.push(ev); appendRow(ev); }

ui.showhb.addEventListener("change", rerender);
$("filters").addEventListener("change", (e) => { e.target.checked ? hidden.delete(e.target.value) : hidden.add(e.target.value); rerender(); });
$("clear").addEventListener("click", () => { events.length = 0; rerender(); });
$("dl").addEventListener("click", () => {
  const body = events.map((e) => JSON.stringify({ t: new Date(e.t).toISOString(), dir: e.dir, type: e.type, ...(e.bytes != null && { bytes: e.bytes }), ...(e.note != null && { note: e.note }), ...(e.data !== undefined && { data: e.data }) })).join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([body + "\n"], { type: "application/x-ndjson" })),
    download: `tinyasr-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  });
  a.click(); URL.revokeObjectURL(a.href);
});
rerender();

// ---------- session state & metrics ----------
function setState(v) { ui.state.dataset.s = v; ui.state.textContent = v; }
function showErr(msg) { ui.err.hidden = !msg; ui.err.textContent = msg ?? ""; }
function lockControls(on) {
  document.querySelectorAll(".controls input, .controls select, .bar input").forEach((el) => (el.disabled = on));
  ui.start.disabled = on; ui.stop.disabled = !on; ui.abort.disabled = !on;
}

function newSession() {
  s = { bytes: 0, inTimes: [], lastIn: 0, maxGap: 0, eots: 0, tClose: 0, tFinal: 0, opened: false, turns: new Map() };
  ui.turns.innerHTML = '<li class="empty">Waiting for speech.</li>';
  ui.rid.textContent = "";
  $("m-close").textContent = "-"; $("m-final").textContent = "-"; $("m-lag").textContent = "-"; $("m-drop").textContent = "-";
}

function tick() {
  if (!s) return;
  const now = performance.now();
  s.inTimes = s.inTimes.filter((t) => now - t < 1000);
  $("m-sent").textContent = `${(s.bytes / BYTES_PER_S).toFixed(1)} s`;
  $("m-rate").textContent = String(s.inTimes.length);
  $("m-gap").textContent = s.lastIn && ws ? `${Math.round(now - s.lastIn)} ms` : "-";
  $("m-maxgap").textContent = s.maxGap ? `${Math.round(s.maxGap)} ms` : "-";
  $("m-turns").textContent = String(s.eots);
}
setInterval(tick, 250);

// ---------- turns ----------
function onTurn(m) {
  const eot = m.event === "EndOfTurn";
  let li = s.turns.get(m.turn_index);
  if (!li && !m.transcript && !eot) return; // heartbeat in silence for the next turn
  if (!li) {
    ui.turns.querySelector(".empty")?.remove();
    li = document.createElement("li");
    li.innerHTML = '<span class="idx"></span><span class="text"></span><span class="meta"></span>';
    li.firstChild.textContent = `#${m.turn_index}`;
    s.turns.set(m.turn_index, li);
    ui.turns.append(li);
  }
  // EagerEndOfTurn marks the open turn as tentatively ended until TurnResumed or EndOfTurn; heartbeats keep the mark
  if (m.event === "EagerEndOfTurn") li.dataset.eager = Number(m.end_of_turn_confidence).toFixed(3);
  else if (eot || m.event === "TurnResumed") delete li.dataset.eager;
  li.className = eot ? "" : li.dataset.eager ? "open eager" : "open";
  li.children[1].textContent = m.transcript || "…";
  const meta = [`${Number(m.audio_window_start).toFixed(2)}-${Number(m.audio_window_end).toFixed(2)} s`];
  if (eot) meta.push(`p=${Number(m.end_of_turn_confidence).toFixed(3)}`);
  if (eot && m.silence_ms != null) meta.push(`silence ${m.silence_ms} ms`);
  if (li.dataset.eager) meta.push(`eager p=${li.dataset.eager}`);
  if (m.languages?.length) meta.push(m.languages.join(","));
  li.children[2].textContent = meta.join("   ");
  if (eot && m.trigger) {
    const t = document.createElement("span");
    t.className = `trig-${m.trigger}`; t.textContent = m.trigger;
    li.children[2].append(t);
  }
  ui.turns.scrollTop = ui.turns.scrollHeight;
}

// ---------- level meter ----------
const levels = new Array(60).fill(0);
const g = ui.level.getContext("2d");
function pushLevel(i16) {
  let sum = 0;
  for (let i = 0; i < i16.length; i++) sum += i16[i] * i16[i];
  levels.push(Math.min(1, Math.sqrt(sum / i16.length) / 6000)); levels.shift();
  const { width: w, height: h } = ui.level, bw = w / levels.length;
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#5fd38d";
  levels.forEach((v, i) => { const bh = Math.max(1, v * h); g.fillRect(i * bw, (h - bh) / 2, bw - 1, bh); });
}

// ---------- audio sources ----------
function sendFrame(buf) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(buf);
  s.bytes += buf.byteLength;
  record({ dir: "out", type: "audio", bytes: buf.byteLength });
  pushLevel(new Int16Array(buf));
}

async function micSource() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("worklet.js");
  const node = new AudioWorkletNode(ctx, "pcm16-downsampler");
  node.port.onmessage = (e) => sendFrame(e.data);
  const src = ctx.createMediaStreamSource(stream);
  src.connect(node); node.connect(ctx.destination); // the node writes nothing, so this outputs silence; it only keeps the graph pulling
  return { start() {}, stop() { stream.getTracks().forEach((t) => t.stop()); ctx.close(); } };
}

async function fileSource(file, pace) {
  const dctx = new AudioContext();
  const decoded = await dctx.decodeAudioData(await file.arrayBuffer()).finally(() => dctx.close());
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
  const node = off.createBufferSource();
  node.buffer = decoded; node.connect(off.destination); node.start();
  const f32 = (await off.startRendering()).getChannelData(0);
  const pcm = new Int16Array(f32.length + TAIL_SILENCE_S * RATE);
  for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }

  let timer = 0, i = 0;
  const next = () => pcm.slice(i * FRAME, ++i * FRAME).buffer;
  const total = Math.ceil(pcm.length / FRAME);
  return {
    start() {
      if (pace === 0) { while (i < total) sendFrame(next()); return closeStream(); }
      const t0 = performance.now(), step = FRAME_MS / pace;
      timer = setInterval(() => {
        while (i < total && performance.now() - t0 >= i * step) sendFrame(next());
        if (i >= total) { clearInterval(timer); closeStream(); }
      }, 5);
    },
    stop() { clearInterval(timer); },
  };
}

// ---------- socket ----------
async function start() {
  showErr(null);
  let url;
  try { url = buildUrl(); } catch (e) { return showErr(e.message); }
  const mode = document.body.dataset.src;
  if (mode === "file" && !ui.file.files[0]) return showErr("Pick an audio file first.");

  newSession();
  lockControls(true);
  setState("connecting");
  try {
    source = mode === "mic" ? await micSource() : await fileSource(ui.file.files[0], Number(ui.pace.value));
  } catch (e) {
    lockControls(false); setState("error");
    return showErr(mode === "mic" ? `Microphone: ${e.message}` : `Cannot decode the file: ${e.message}`);
  }

  record({ dir: "local", type: "open", note: url });
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { s.opened = true; setState("live"); source.start(); };
  ws.onmessage = (e) => {
    const now = performance.now();
    if (s.lastIn) s.maxGap = Math.max(s.maxGap, now - s.lastIn);
    s.lastIn = now; s.inTimes.push(now);
    let m = e.data;
    try { m = JSON.parse(e.data); } catch { /* keep raw text */ }
    record({ dir: "in", type: m?.type ?? "text", data: m });
    if (m?.type === "Connected") ui.rid.textContent = m.request_id;
    if (m?.type === "TurnInfo") {
      onTurn(m);
      if (m.lag_ms != null) $("m-lag").textContent = `${m.lag_ms} ms`; // absent on servers without these fields
      if (m.dropped_ms != null) $("m-drop").textContent = `${m.dropped_ms} ms`;
    }
    if (m?.type === "TurnInfo" && m.event === "EndOfTurn") {
      s.eots++;
      if (s.tClose) { s.tFinal = now; $("m-final").textContent = `${Math.round(now - s.tClose)} ms`; }
    }
    if (m?.type === "Error") showErr(`Server error ${m.code}: ${m.description ?? ""}`);
  };
  ws.onerror = () => record({ dir: "local", type: "error", note: "socket error" });
  ws.onclose = (e) => {
    source?.stop(); source = null; ws = null; tick();
    record({ dir: "local", type: "close", note: `${e.code} ${e.reason}`.trim(), data: { code: e.code, reason: e.reason, wasClean: e.wasClean } });
    $("m-close").textContent = String(e.code);
    lockControls(false);
    setState(e.code === 1000 ? "idle" : "error");
    if (!s.opened) explainRefusal(url);
    else if (e.code !== 1000) showErr(`Socket closed with ${e.code}${e.reason ? ": " + e.reason : ""}.`);
  };
}

// Browsers hide the HTTP status of a refused upgrade, so probe /health to tell "unreachable" from "refused".
async function explainRefusal(url) {
  const h = new URL(url); h.protocol = h.protocol === "wss:" ? "https:" : "http:"; h.pathname = "/health"; h.search = "";
  try {
    // shortcut: the server sends no CORS headers, so the /health body is readable only from the same origin (a proxy); else fall back to an opaque probe
    const r = await fetch(h, { cache: "no-store" }).catch(() => fetch(h, { mode: "no-cors", cache: "no-store" }));
    const b = r.type === "opaque" ? null : await r.json().catch(() => null);
    showErr("Server is up but refused the upgrade: bad params (400), auth on (401) or full (503). Browsers do not show which one; check the server log."
      + (r.status === 503 && b?.reason ? ` Also, /health reports ${b.status}: ${b.reason}` : ""));
  } catch {
    showErr(`Cannot reach ${h.host}. Is tinyasr-server running and the port published?`);
  }
}

function closeStream() {
  if (ws?.readyState !== WebSocket.OPEN || s.tClose) return;
  source?.stop(); source = null;
  const msg = { type: "CloseStream" };
  ws.send(JSON.stringify(msg));
  s.tClose = performance.now();
  record({ dir: "out", type: "CloseStream", data: msg });
  setState("closing");
}

ui.start.addEventListener("click", start);
ui.stop.addEventListener("click", closeStream);
ui.abort.addEventListener("click", () => { source?.stop(); source = null; ws?.close(1000, "client abort"); });
