/* ============================================================
   ФАЙЛ: tools/redlink-render-hub/server.js
   ВЕРСИЯ ФАЙЛА: 0.1.0
   ВЕРСИЯ ПРОЕКТА: 0.4.2
   ДАТА: 2026-04-29 22:45 Europe/Berlin
   АВТОР: Влад.Р
   НАЗНАЧЕНИЕ: Минимальный публичный RedLink Hub для Render.
   ИЗМЕНЕНИЕ: Версия под Remote RedLink Endpoint: /health, /api/register, /api/presence, discover/signal/poll.
   ============================================================ */

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3737;
const startedAt = Date.now();
const HEARTBEAT_TIMEOUT_MS = Number(process.env.REDLINK_HEARTBEAT_TIMEOUT_MS || 45000);
const SIGNAL_TTL_MS = Number(process.env.REDLINK_SIGNAL_TTL_MS || 120000);

app.use(cors());
app.use(express.json({ limit: "64kb" }));

let participants = [];
let signals = [];

function now() {
  return Date.now();
}

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function roomKeyFrom(payload = {}) {
  if (payload.roomKey) return String(payload.roomKey);
  const workspaceId = String(payload.workspaceId || "redbox-test");
  const projectId = String(payload.projectId || "main");
  const roomId = String(payload.roomId || "lobby");
  return `${workspaceId}/${projectId}/${roomId}`;
}

function normalizeParticipant(payload = {}) {
  const instanceId = String(payload.instanceId || payload.clientId || "").trim() || makeId("rbx-native");
  const sessionId = String(payload.sessionId || "").trim() || makeId("session");
  const nickname = String(payload.nickname || payload.name || "Vlad").trim() || "Vlad";
  const workspaceId = String(payload.workspaceId || "redbox-test");
  const projectId = String(payload.projectId || "main");
  const roomId = String(payload.roomId || "lobby");
  const roomKey = roomKeyFrom({ ...payload, workspaceId, projectId, roomId });

  return {
    socketId: `native:${instanceId}`,
    clientId: instanceId,
    instanceId,
    sessionId,
    nickname,
    name: nickname,
    status: String(payload.status || "online"),
    activity: String(payload.activity || "native-redbox"),
    workspaceId,
    projectId,
    roomId,
    roomKey,
    lastSeen: now(),
    transport: "render-http",
    source: "render-redlink-hub"
  };
}

function cleanup() {
  const participantCutoff = now() - HEARTBEAT_TIMEOUT_MS;
  participants = participants.filter((p) => Number(p.lastSeen || 0) >= participantCutoff);

  const signalCutoff = now() - SIGNAL_TTL_MS;
  signals = signals.filter((s) => Number(s.sentAt || 0) >= signalCutoff);
}

function upsertParticipant(payload = {}) {
  cleanup();
  const participant = normalizeParticipant(payload);
  participants = participants.filter((p) => p.instanceId !== participant.instanceId);
  participants.push(participant);
  return participant;
}

function payloadFrom(req) {
  return { ...(req.body || {}), ...(req.query || {}) };
}

function healthPayload() {
  cleanup();
  return {
    ok: true,
    service: "redlink-hub",
    version: "0.4.2-render",
    participants: participants.length,
    signals: signals.length,
    startedAt,
    timestamp: now()
  };
}

app.get("/", (_req, res) => {
  res.json(healthPayload());
});

app.get("/health", (_req, res) => {
  res.json(healthPayload());
});

app.get("/api/health", (_req, res) => {
  res.json(healthPayload());
});

function handleRegister(req, res) {
  const self = upsertParticipant(payloadFrom(req));
  res.json({
    ok: true,
    service: "redlink-hub",
    version: "0.4.2-render",
    action: "register-writeback",
    self,
    clients: participants.length,
    participants,
    members: participants,
    generatedAt: now()
  });
}

app.get("/api/register", handleRegister);
app.post("/api/register", handleRegister);
app.get("/api/native/register", handleRegister);
app.post("/api/native/register", handleRegister);

app.get("/api/presence", (_req, res) => {
  cleanup();
  const rooms = {};
  for (const p of participants) {
    if (!rooms[p.roomKey]) rooms[p.roomKey] = [];
    rooms[p.roomKey].push(p);
  }
  const roomKey = Object.keys(rooms).sort()[0] || "redbox-test/main/lobby";
  res.json({
    ok: true,
    service: "redlink-hub",
    version: "0.4.2-render",
    roomKey,
    generatedAt: now(),
    clients: participants.length,
    participants,
    members: participants,
    rooms,
    time: now()
  });
});

app.get("/api/redlink/discover", (req, res) => {
  const payload = payloadFrom(req);
  const self = upsertParticipant({ ...payload, activity: payload.activity || "redlink-discovery" });
  const peers = participants
    .filter((p) => p.roomKey === self.roomKey)
    .filter((p) => p.instanceId !== self.instanceId);

  res.json({
    ok: true,
    service: "redlink-hub",
    version: "0.4.2-render",
    layer: "redlink-discovery",
    roomKey: self.roomKey,
    generatedAt: now(),
    self,
    peers,
    peerCount: peers.length,
    signaling: {
      endpoints: {
        discover: "/api/redlink/discover",
        signal: "/api/redlink/signal",
        poll: "/api/redlink/poll"
      },
      supportedTypes: ["offer", "answer", "ice", "hello", "probe"]
    }
  });
});

app.post("/api/redlink/signal", (req, res) => {
  cleanup();
  const payload = payloadFrom(req);
  const signal = {
    id: makeId("signal"),
    roomKey: roomKeyFrom(payload),
    from: String(payload.from || payload.fromInstanceId || payload.instanceId || ""),
    to: String(payload.to || payload.toInstanceId || ""),
    type: String(payload.type || "probe"),
    data: payload.data || payload.payload || {},
    sentAt: now()
  };
  signals.push(signal);
  res.json({ ok: true, service: "redlink-hub", version: "0.4.2-render", action: "signal-queued", signal });
});

app.get("/api/redlink/poll", (req, res) => {
  cleanup();
  const payload = payloadFrom(req);
  const instanceId = String(payload.instanceId || payload.to || "");
  const roomKey = roomKeyFrom(payload);
  const inbox = signals.filter((signal) => signal.roomKey === roomKey
    && (!signal.to || signal.to === instanceId)
    && signal.from !== instanceId);
  res.json({ ok: true, service: "redlink-hub", version: "0.4.2-render", layer: "redlink-signaling-poll", roomKey, instanceId, signals: inbox, generatedAt: now() });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "route_not_found",
    path: req.path,
    available: ["/", "/health", "/api/health", "/api/presence", "/api/register", "/api/native/register", "/api/redlink/discover", "/api/redlink/signal", "/api/redlink/poll"]
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RedLink Hub 0.4.2 running on ${PORT}`);
});

// --- КОНЕЦ ФАЙЛА ---
