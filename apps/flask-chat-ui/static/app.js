const state = {
  agents: [],
  sessions: [],
  selectedAgentId: null,
  selectedSessionKey: null,
  activeRunId: null,
  abortController: null,
};

const els = {
  agentSelect: document.getElementById("agent-select"),
  sessionList: document.getElementById("session-list"),
  sessionsEmpty: document.getElementById("sessions-empty"),
  sessionTitle: document.getElementById("session-title"),
  chatLog: document.getElementById("chat-log"),
  messageInput: document.getElementById("message-input"),
  composerForm: document.getElementById("composer-form"),
  sendBtn: document.getElementById("send-btn"),
  stopBtn: document.getElementById("stop-btn"),
  newSessionBtn: document.getElementById("new-session-btn"),
  resetSessionBtn: document.getElementById("reset-session-btn"),
  statusPill: document.getElementById("status-pill"),
  messageTemplate: document.getElementById("message-template"),
};

function setStatus(text, kind = "info") {
  els.statusPill.textContent = text;
  els.statusPill.dataset.kind = kind;
}

function autoResizeTextarea() {
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(els.messageInput.scrollHeight, 220)}px`;
}

function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .join("");
}

function formatSessionTitle(session) {
  return session?.displayName || session?.sessionId || session?.key || "Untitled chat";
}

function scrollChatToBottom() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function clearWelcomeCard() {
  const welcome = els.chatLog.querySelector(".welcome-card");
  if (welcome) {
    welcome.remove();
  }
}

function renderMessage(role, text, meta = "", id = null) {
  clearWelcomeCard();
  const fragment = els.messageTemplate.content.cloneNode(true);
  const row = fragment.querySelector(".message-row");
  const metaNode = fragment.querySelector(".message-meta");
  const bubble = fragment.querySelector(".message-bubble");
  row.classList.add(role);
  if (id) {
    row.dataset.messageId = id;
  }
  metaNode.textContent = meta;
  bubble.textContent = text;
  els.chatLog.appendChild(fragment);
  scrollChatToBottom();
  return row;
}

function upsertAssistantMessage(text, runId, finalState = false) {
  let row = els.chatLog.querySelector(`.message-row[data-message-id="${runId}"]`);
  if (!row) {
    row = renderMessage("assistant", text, "Assistant", runId);
  }
  row.querySelector(".message-bubble").textContent = text;
  row.querySelector(".message-meta").textContent = finalState ? "Assistant" : "Assistant · streaming";
  scrollChatToBottom();
}

function renderSessions() {
  els.sessionList.innerHTML = "";
  els.sessionsEmpty.classList.toggle("hidden", state.sessions.length > 0);
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-card";
    if (session.key === state.selectedSessionKey) {
      button.classList.add("active");
    }
    button.innerHTML = `
      <h3>${formatSessionTitle(session)}</h3>
      <p>${session.lastMessageText || "No messages yet"}</p>
    `;
    button.addEventListener("click", () => selectSession(session.key));
    els.sessionList.appendChild(button);
  }
}

function renderAgents() {
  els.agentSelect.innerHTML = "";
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.name || agent.identity?.name || agent.id;
    if (agent.id === state.selectedAgentId) {
      option.selected = true;
    }
    els.agentSelect.appendChild(option);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function loadBootstrap() {
  setStatus("Loading…");
  const data = await api("/api/bootstrap");
  state.agents = data.agents || [];
  state.selectedAgentId = data.defaultAgentId || state.agents[0]?.id || null;
  state.sessions = data.sessions || [];
  if (!state.selectedSessionKey && state.sessions.length > 0) {
    state.selectedSessionKey = state.sessions[0].key;
  }
  renderAgents();
  renderSessions();
  syncComposerState();
  setStatus("Ready", "ok");
  if (state.selectedSessionKey) {
    await loadHistory(state.selectedSessionKey);
  }
}

async function refreshSessions() {
  if (!state.selectedAgentId) {
    return;
  }
  const data = await api(`/api/sessions?agentId=${encodeURIComponent(state.selectedAgentId)}`);
  state.sessions = data.sessions || [];
  if (!state.sessions.find((session) => session.key === state.selectedSessionKey)) {
    state.selectedSessionKey = state.sessions[0]?.key || null;
  }
  renderSessions();
  syncComposerState();
}

function clearChat() {
  els.chatLog.innerHTML = `
    <div class="welcome-card">
      <h3>Ready when you are</h3>
      <p>Select a chat or create a new one to begin.</p>
    </div>
  `;
}

async function loadHistory(sessionKey) {
  state.selectedSessionKey = sessionKey;
  renderSessions();
  syncComposerState();
  const session = state.sessions.find((item) => item.key === sessionKey);
  els.sessionTitle.textContent = formatSessionTitle(session);
  clearChat();
  if (!sessionKey) {
    return;
  }
  setStatus("Loading history…");
  const data = await api(`/api/history?sessionKey=${encodeURIComponent(sessionKey)}`);
  els.chatLog.innerHTML = "";
  for (const message of data.messages || []) {
    const role = message.role === "user" ? "user" : "assistant";
    renderMessage(role, messageText(message), role === "user" ? "You" : "Assistant");
  }
  if (!data.messages || data.messages.length === 0) {
    clearChat();
  }
  setStatus("Ready", "ok");
}

async function selectSession(sessionKey) {
  try {
    await loadHistory(sessionKey);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function syncComposerState() {
  const hasSession = Boolean(state.selectedSessionKey);
  els.messageInput.disabled = !hasSession;
  els.sendBtn.disabled = !hasSession;
  els.resetSessionBtn.disabled = !hasSession;
}

async function createSession() {
  if (!state.selectedAgentId) {
    return;
  }
  setStatus("Creating session…");
  const data = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ agentId: state.selectedAgentId }),
  });
  const session = {
    key: data.session.key,
    sessionId: data.session.sessionId,
    displayName: data.session.entry?.label || "New chat",
    lastMessageText: "",
  };
  state.selectedSessionKey = session.key;
  await refreshSessions();
  await loadHistory(session.key);
}

async function resetSession() {
  if (!state.selectedSessionKey) {
    return;
  }
  setStatus("Resetting…");
  await api("/api/sessions/reset", {
    method: "POST",
    body: JSON.stringify({ sessionKey: state.selectedSessionKey }),
  });
  await loadHistory(state.selectedSessionKey);
  await refreshSessions();
  setStatus("Ready", "ok");
}

async function stopActiveRun() {
  if (!state.selectedSessionKey) {
    return;
  }
  try {
    await api("/api/chat/abort", {
      method: "POST",
      body: JSON.stringify({ sessionKey: state.selectedSessionKey, runId: state.activeRunId }),
    });
    state.abortController?.abort();
    setStatus("Stopped", "warn");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function sendMessage(message) {
  if (!state.selectedSessionKey || !message.trim()) {
    return;
  }
  renderMessage("user", message, "You");
  els.messageInput.value = "";
  autoResizeTextarea();
  els.stopBtn.classList.remove("hidden");
  els.sendBtn.disabled = true;
  setStatus("Streaming…");
  const abortController = new AbortController();
  state.abortController = abortController;
  const response = await fetch("/api/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey: state.selectedSessionKey, message }),
    signal: abortController.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error("Unable to stream reply");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalSeen = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) {
        continue;
      }
      const payload = JSON.parse(line.slice(5).trim());
      if (payload.type === "ack") {
        state.activeRunId = payload.runId;
        continue;
      }
      if (payload.type === "chat") {
        if (payload.runId) {
          state.activeRunId = payload.runId;
        }
        if (payload.state === "delta") {
          upsertAssistantMessage(payload.text || "", payload.runId, false);
        } else if (payload.state === "final") {
          upsertAssistantMessage(payload.text || "", payload.runId, true);
          finalSeen = true;
        } else if (payload.state === "aborted") {
          upsertAssistantMessage(payload.text || "", payload.runId, true);
          setStatus("Stopped", "warn");
          finalSeen = true;
        } else if (payload.state === "error") {
          throw new Error(payload.errorMessage || "Chat failed");
        }
      } else if (payload.type === "error") {
        throw new Error(payload.error || "Chat failed");
      }
    }
  }

  els.stopBtn.classList.add("hidden");
  state.activeRunId = null;
  state.abortController = null;
  els.sendBtn.disabled = false;
  await refreshSessions();
  setStatus(finalSeen ? "Ready" : "Done", "ok");
}

els.agentSelect.addEventListener("change", async (event) => {
  state.selectedAgentId = event.target.value;
  state.selectedSessionKey = null;
  clearChat();
  try {
    await refreshSessions();
    if (state.selectedSessionKey) {
      await loadHistory(state.selectedSessionKey);
    }
  } catch (error) {
    setStatus(error.message, "error");
  }
});

els.newSessionBtn.addEventListener("click", async () => {
  try {
    await createSession();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

els.resetSessionBtn.addEventListener("click", async () => {
  try {
    await resetSession();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

els.stopBtn.addEventListener("click", stopActiveRun);

els.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.messageInput.value;
  if (!message.trim()) {
    return;
  }
  try {
    await sendMessage(message);
  } catch (error) {
    els.stopBtn.classList.add("hidden");
    state.activeRunId = null;
    state.abortController = null;
    els.sendBtn.disabled = false;
    setStatus(error.message, "error");
  }
});

els.messageInput.addEventListener("input", autoResizeTextarea);
els.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.composerForm.requestSubmit();
  }
});

autoResizeTextarea();
loadBootstrap().catch((error) => setStatus(error.message, "error"));
