// Minimal client: renders the agent's SSE event stream. No framework, no build step.

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendEl = $("#send");

let conversationId = new URLSearchParams(location.search).get("c") || undefined;
let busy = false;

// ── boot ────────────────────────────────────────────────────────────────
init();

async function init() {
  const status = await fetch("/api/status").then((r) => r.json());
  $("#status").textContent = status.model ? `${status.model} · ${status.search}` : "not configured";
  if (status.missing.length) {
    const banner = $("#banner");
    banner.hidden = false;
    banner.textContent = `Missing configuration: ${status.missing.join(", ")}. Copy .env.example to .env, fill it in, and restart.`;
  }
  await refreshConversations();
  if (conversationId) await openConversation(conversationId);
}

$("#new-chat").addEventListener("click", () => {
  conversationId = undefined;
  history.pushState(null, "", "/");
  messagesEl.replaceChildren($("#empty") ?? emptyState());
  refreshConversations();
  inputEl.focus();
});

for (const b of document.querySelectorAll("#examples button")) {
  b.addEventListener("click", () => {
    inputEl.value = b.textContent;
    send();
  });
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${inputEl.scrollHeight}px`;
});

// ── conversations ───────────────────────────────────────────────────────
async function refreshConversations() {
  const list = await fetch("/api/conversations").then((r) => r.json());
  const nav = $("#conversations");
  nav.replaceChildren(
    ...list.map((c) => {
      const a = document.createElement("a");
      a.href = `/?c=${c.id}`;
      a.className = c.id === conversationId ? "active" : "";
      a.textContent = c.title;
      const when = document.createElement("small");
      when.textContent = fmtDateTime(c.updatedAt);
      a.append(when);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        history.pushState(null, "", a.href);
        openConversation(c.id);
      });
      return a;
    }),
  );
}

async function openConversation(id) {
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) return;
  const data = await res.json();
  conversationId = data.id;
  messagesEl.replaceChildren();
  for (const e of data.exchanges) {
    addUser(e.question, e.askedAt);
    const view = addAssistant(e.askedAt);
    view.setAnswer(e.answer, e.sources);
    if (e.searches.length) view.activity(`Searched: ${e.searches.map((s) => `“${s.query}”`).join(", ")}`);
  }
  refreshConversations();
  scrollDown();
}

// ── sending ─────────────────────────────────────────────────────────────
async function send() {
  const message = inputEl.value.trim();
  if (!message || busy) return;
  busy = true;
  sendEl.disabled = true;
  inputEl.value = "";
  inputEl.style.height = "auto";
  $("#empty")?.remove();

  const userMeta = addUser(message, new Date().toISOString());
  const view = addAssistant();
  const pending = new Map(); // callId → activity row
  const liveSources = new Map(); // n → source, for linking citations while streaming
  let text = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, message }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);

    for await (const { event, data } of readSSE(res.body)) {
      switch (event) {
        case "turn_start":
          if (conversationId !== data.conversationId) {
            conversationId = data.conversationId;
            history.replaceState(null, "", `/?c=${conversationId}`);
          }
          // Server time is authoritative (it may be overridden with AGENT_NOW).
          userMeta.textContent = fmtDateTime(data.askedAt);
          view.setTime(data.askedAt);
          break;
        case "memory": {
          for (const r of data.recalled) {
            const why = r.reason === "date" ? `from “${r.matched}”` : "related";
            view.activity(`Remembered ${fmtDateTime(r.askedAt)} (${why}): “${truncate(r.question, 70)}”`);
          }
          for (const n of data.notes) view.activity(n);
          break;
        }
        case "search_start": {
          const scope = `${data.since ? ` since ${data.since}` : ""}${data.topic === "news" ? " (news)" : ""}`;
          const row = view.activity(`Searching “${data.query}”${scope}…`, true);
          row.dataset.scope = scope;
          pending.set(data.callId, row);
          break;
        }
        case "search_done": {
          const row = pending.get(data.callId);
          for (const s of data.sources) liveSources.set(s.n, s);
          if (row) {
            row.classList.remove("pending");
            row.textContent = data.error
              ? `Search “${data.query}” failed`
              : `Searched “${data.query}”${row.dataset.scope} · ${data.sources.length} result${data.sources.length === 1 ? "" : "s"}`;
          }
          break;
        }
        case "text":
          text += data.delta;
          view.setAnswer(text, [...liveSources.values()], { streaming: true });
          scrollDown();
          break;
        case "done":
          view.setAnswer(data.answer, data.sources);
          break;
        case "error":
          view.error(data.message);
          break;
      }
    }
  } catch (err) {
    view.error(err.message);
  } finally {
    busy = false;
    sendEl.disabled = false;
    refreshConversations();
    scrollDown();
    inputEl.focus();
  }
}

/** Parses a text/event-stream body into { event, data } objects. */
async function* readSSE(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value.replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const data = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
    }
  }
}

// ── rendering ───────────────────────────────────────────────────────────
function addUser(text, at) {
  const el = div("msg user");
  const meta = div("meta");
  meta.textContent = fmtDateTime(at);
  const body = div("body");
  body.textContent = text;
  el.append(meta, body);
  messagesEl.append(el);
  scrollDown();
  return meta;
}

function addAssistant(at) {
  const el = div("msg assistant");
  const meta = div("meta");
  meta.textContent = at ? `minimi · ${fmtDateTime(at)}` : "minimi";
  const activity = div("activity");
  const body = div("body");
  const sources = div("sources");
  el.append(meta, activity, body, sources);
  messagesEl.append(el);
  return {
    setTime(t) {
      meta.textContent = `minimi · ${fmtDateTime(t)}`;
    },
    activity(text, isPending = false) {
      const row = div(`row${isPending ? " pending" : ""}`);
      row.textContent = text;
      activity.append(row);
      return row;
    },
    setAnswer(markdown, srcs, { streaming = false } = {}) {
      const byN = new Map(srcs.map((s) => [s.n, s]));
      body.innerHTML = renderMarkdown(markdown, byN);
      if (streaming) return;
      sources.replaceChildren(
        ...srcs
          .sort((a, b) => a.n - b.n)
          .map((s) => {
            const a = document.createElement("a");
            a.href = s.url;
            a.target = "_blank";
            a.rel = "noopener";
            a.title = `${s.title}${s.publishedDate ? ` · ${s.publishedDate.slice(0, 10)}` : ""}\n${s.url}`;
            const b = document.createElement("b");
            b.textContent = s.n;
            a.append(b, hostname(s.url));
            return a;
          }),
      );
    },
    error(message) {
      const p = div("error");
      p.textContent = `Error: ${message}`;
      body.append(p);
    },
  };
}

function emptyState() {
  const el = div("");
  el.id = "empty";
  el.innerHTML = "<h1>minimi</h1><p>Ask anything.</p>";
  return el;
}

/** Small, safe Markdown subset: everything is HTML-escaped first, then formatted. */
function renderMarkdown(src, sourcesByN) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[(\d+)\]/g, (m, n) => {
        const s = sourcesByN.get(Number(n));
        return s ? `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">${n}</a>` : m;
      });

  const lines = src.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`<h4>${inline(line.replace(/^#+\s/, ""))}</h4>`);
      i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s/, "")));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${x}</li>`).join("")}</${tag}>`);
    } else if (line.trim() === "") {
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,6}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      if (para.length === 0) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
  }
  return out.join("");
}

function div(className) {
  const el = document.createElement("div");
  el.className = className;
  return el;
}
function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
