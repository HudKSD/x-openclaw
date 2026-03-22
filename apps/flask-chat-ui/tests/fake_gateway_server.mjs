import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] || 0);
if (!Number.isFinite(port) || port <= 0) {
  console.error('port required');
  process.exit(1);
}

const state = {
  seq: 0,
  defaultId: 'main',
  agents: [
    { id: 'main', name: 'Main' },
    { id: 'coding', name: 'Coding' },
  ],
  sessions: {
    main: [
      {
        key: 'agent:main:main',
        sessionId: 'main-session',
        displayName: 'Main chat',
        updatedAt: Date.now(),
        lastMessageText: 'Welcome to Main',
        agentId: 'main',
      },
    ],
    coding: [],
  },
  histories: {
    'agent:main:main': [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Welcome to Main' }],
      },
    ],
  },
  activeRuns: new Map(),
};

function nextSeq() {
  state.seq += 1;
  return state.seq;
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function sessionList(agentId) {
  return (state.sessions[agentId] || []).slice().toSorted((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function findSession(key) {
  for (const sessions of Object.values(state.sessions)) {
    const hit = sessions.find((session) => session.key === key);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function findAgentForSession(key) {
  for (const [agentId, sessions] of Object.entries(state.sessions)) {
    if (sessions.some((session) => session.key === key)) {
      return agentId;
    }
  }
  return state.defaultId;
}

const wss = new WebSocketServer({ port }, () => {
  console.log(`ready:${port}`);
});

wss.on('connection', (ws) => {
  send(ws, {
    type: 'event',
    event: 'connect.challenge',
    payload: { nonce: 'fake-nonce', ts: Date.now() },
    seq: nextSeq(),
  });

  ws.on('message', (raw) => {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString('utf8')
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Buffer.from(raw).toString('utf8');
    const msg = JSON.parse(text);
    if (msg.method === 'connect') {
      send(ws, {
        type: 'res',
        id: msg.id,
        ok: true,
        payload: {
          type: 'hello-ok',
          protocol: 3,
          policy: { tickIntervalMs: 15_000 },
          features: { methods: ['agents.list', 'sessions.list', 'sessions.create', 'sessions.reset', 'chat.history', 'chat.send', 'chat.abort'] },
        },
      });
      return;
    }

    if (msg.method === 'agents.list') {
      send(ws, {
        type: 'res',
        id: msg.id,
        ok: true,
        payload: {
          defaultId: state.defaultId,
          agents: state.agents,
        },
      });
      return;
    }

    if (msg.method === 'sessions.list') {
      const agentId = msg.params?.agentId || state.defaultId;
      const sessions = sessionList(agentId);
      send(ws, {
        type: 'res',
        id: msg.id,
        ok: true,
        payload: { sessions, count: sessions.length },
      });
      return;
    }

    if (msg.method === 'sessions.create') {
      const agentId = msg.params?.agentId || state.defaultId;
      const index = (state.sessions[agentId] || []).length + 1;
      const key = `agent:${agentId}:chat-${index}`;
      const entry = {
        key,
        sessionId: `${agentId}-session-${index}`,
        displayName: msg.params?.label || `Chat ${index}`,
        updatedAt: Date.now(),
        lastMessageText: '',
        agentId,
      };
      state.sessions[agentId] = [entry, ...(state.sessions[agentId] || [])];
      state.histories[key] = [];
      send(ws, {
        type: 'res',
        id: msg.id,
        ok: true,
        payload: {
          ok: true,
          key,
          sessionId: entry.sessionId,
          entry,
        },
      });
      return;
    }

    if (msg.method === 'sessions.reset') {
      const key = msg.params?.key;
      state.histories[key] = [];
      const session = findSession(key);
      if (session) {
        session.lastMessageText = '';
        session.updatedAt = Date.now();
      }
      send(ws, {
        type: 'res',
        id: msg.id,
        ok: true,
        payload: { ok: true },
      });
      return;
    }

    if (msg.method === 'chat.history') {
      const key = msg.params?.sessionKey;
      send(ws, {
        type: 'res',
        id: msg.id,
        ok: true,
        payload: {
          sessionKey: key,
          sessionId: findSession(key)?.sessionId || key,
          messages: state.histories[key] || [],
        },
      });
      return;
    }

    if (msg.method === 'chat.abort') {
      const runId = msg.params?.runId;
      const active = state.activeRuns.get(runId);
      if (active) {
        clearTimeout(active.deltaTimer);
        clearTimeout(active.finalTimer);
        send(ws, {
          type: 'event',
          event: 'chat',
          seq: nextSeq(),
          payload: {
            runId,
            sessionKey: active.sessionKey,
            state: 'aborted',
            message: { role: 'assistant', content: [{ type: 'text', text: active.deltaText }] },
          },
        });
        state.activeRuns.delete(runId);
      }
      send(ws, {
        type: 'res',
        id: msg.id,
        ok: true,
        payload: { ok: true, aborted: Boolean(active), runIds: active ? [runId] : [] },
      });
      return;
    }

    if (msg.method === 'chat.send') {
      const sessionKey = msg.params?.sessionKey;
      const message = String(msg.params?.message || '');
      const runId = msg.params?.idempotencyKey || `run-${Date.now()}`;
      const reply = `Echo: ${message}`;
      const session = findSession(sessionKey);
      const agentId = findAgentForSession(sessionKey);
      if (session) {
        session.lastMessageText = reply;
        session.updatedAt = Date.now();
      }
      state.histories[sessionKey] = [
        ...(state.histories[sessionKey] || []),
        { role: 'user', content: [{ type: 'text', text: message }] },
      ];
      send(ws, {
        type: 'res',
        id: msg.id,
        ok: true,
        payload: { runId, status: 'started' },
      });
      const deltaTimer = setTimeout(() => {
        send(ws, {
          type: 'event',
          event: 'chat',
          seq: nextSeq(),
          payload: {
            runId,
            sessionKey,
            state: 'delta',
            message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
          },
        });
      }, 10);
      const finalTimer = setTimeout(() => {
        state.histories[sessionKey] = [
          ...(state.histories[sessionKey] || []),
          { role: 'assistant', content: [{ type: 'text', text: reply }] },
        ];
        send(ws, {
          type: 'event',
          event: 'chat',
          seq: nextSeq(),
          payload: {
            runId,
            sessionKey,
            state: 'final',
            message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
          },
        });
        state.activeRuns.delete(runId);
      }, 30);
      state.activeRuns.set(runId, { sessionKey, deltaText: reply, deltaTimer, finalTimer, agentId });
      return;
    }

    send(ws, {
      type: 'res',
      id: msg.id,
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: `unsupported method: ${msg.method}` },
    });
  });
});

process.on('SIGTERM', () => {
  wss.close(() => process.exit(0));
});
