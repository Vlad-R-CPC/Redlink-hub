/* ============================================================
   ФАЙЛ: tools/redlink-render-hub/server.js
   ВЕРСИЯ ФАЙЛА: 0.1.13
   ВЕРСИЯ ПРОЕКТА: 0.4.17.3.5.9
   ДАТА: 2026-05-10 Europe/Riga
   АВТОР: Влад.Р
   НАЗНАЧЕНИЕ: Публичный RedLink Hub для Render/cloud presence, signaling и tracker-метаданных телепорта.
   ИЗМЕНЕНИЕ: File Teleport Policy Guard: cloud payload relay выключен по умолчанию, hub остаётся tracker/signaling.
   ============================================================ */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3737;
const startedAt = Date.now();
const HEARTBEAT_TIMEOUT_MS = Number(process.env.REDLINK_HEARTBEAT_TIMEOUT_MS || 60000);
const SIGNAL_TTL_MS = Number(process.env.REDLINK_SIGNAL_TTL_MS || 120000);
const VERSION = "0.4.17.3.5.9-render";
const TRANSFER_DIR = path.join(__dirname, "redlink_transfers");
const ALLOW_CLOUD_FILE_RELAY = process.env.REDBOX_ALLOW_CLOUD_FILE_RELAY === "1" || process.env.REDLINK_ALLOW_CLOUD_FILE_RELAY === "1";

fs.mkdirSync(TRANSFER_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

let participants = [];
let signals = [];

function now() {
  return Date.now();
}

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function cleanString(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function safeSlice(value, length = 512) {
  return cleanString(value).slice(0, length);
}

function roomKeyFrom(payload = {}) {
  if (payload.roomKey) return String(payload.roomKey);
  const workspaceId = String(payload.workspaceId || "redbox-test");
  const projectId = String(payload.projectId || "main");
  const roomId = String(payload.roomId || "lobby");
  return `${workspaceId}/${projectId}/${roomId}`;
}

function payloadFrom(req) {
  return { ...(req.body || {}), ...(req.query || {}) };
}

function parseMaybeJson(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  const text = String(value).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_err) {
    return { payload: text };
  }
}

function stripHeavyPresenceData(value, depth = 0) {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => stripHeavyPresenceData(item, depth + 1));
  if (typeof value !== "object") return value;

  const out = {};
  for (const [key, innerValue] of Object.entries(value)) {
    const lower = String(key).toLowerCase();
    if (lower === "avatardata" || lower === "imagedata" || lower === "thumbnaildata" || lower === "previewdata") {
      out[`${key}Stripped`] = true;
      continue;
    }
    out[key] = stripHeavyPresenceData(innerValue, depth + 1);
  }
  return out;
}

function normalizeParticipant(payload = {}) {
  const instanceId = cleanString(payload.instanceId || payload.clientId) || makeId("rbx-native");
  const sessionId = cleanString(payload.sessionId) || makeId("session");
  const nickname = cleanString(payload.nickname || payload.name, "Vlad") || "Vlad";
  const workspaceId = cleanString(payload.workspaceId, "redbox-test") || "redbox-test";
  const projectId = cleanString(payload.projectId, "main") || "main";
  const roomId = cleanString(payload.roomId, "lobby") || "lobby";
  const roomKey = roomKeyFrom({ ...payload, workspaceId, projectId, roomId });
  const machineFingerprint = safeSlice(payload.machineFingerprint, 1024);
  const avatarAsset = safeSlice(payload.avatarAsset || payload.avatarHash, 1024);
  const avatarHash = safeSlice(payload.avatarHash, 256);

  return {
    socketId: `native:${instanceId}`,
    clientId: instanceId,
    instanceId,
    sessionId,
    machineFingerprint,
    nickname,
    name: nickname,
    status: cleanString(payload.status, "online") || "online",
    activity: cleanString(payload.activity, "native-redbox") || "native-redbox",
    workspaceId,
    projectId,
    roomId,
    roomKey,
    avatarAsset,
    avatarHash,
    lastSeen: now(),
    transport: "render-http",
    source: "render-redlink-hub"
  };
}

function publicParticipant(participant = {}) {
  return {
    socketId: participant.socketId,
    clientId: participant.clientId,
    instanceId: participant.instanceId || participant.clientId,
    sessionId: participant.sessionId || "",
    machineFingerprint: participant.machineFingerprint || "",
    nickname: participant.nickname || participant.name,
    name: participant.name || participant.nickname,
    status: participant.status || "online",
    activity: participant.activity || "native-redbox",
    workspaceId: participant.workspaceId || "redbox-test",
    projectId: participant.projectId || "main",
    roomId: participant.roomId || "lobby",
    roomKey: participant.roomKey || "redbox-test/main/lobby",
    avatarAsset: participant.avatarAsset || "",
    avatarHash: participant.avatarHash || "",
    lastSeen: participant.lastSeen || 0,
    transport: participant.transport || "render-http",
    source: participant.source || "render-redlink-hub"
  };
}

function cleanup() {
  const participantCutoff = now() - HEARTBEAT_TIMEOUT_MS;
  participants = participants.filter((p) => Number(p.lastSeen || 0) >= participantCutoff);

  const signalCutoff = now() - SIGNAL_TTL_MS;
  signals = signals.filter((s) => Number(s.sentAt || 0) >= signalCutoff);
}

function removeOlderMachineClones(instanceId, machineFingerprint) {
  const fingerprint = cleanString(machineFingerprint);
  if (!fingerprint) return;
  participants = participants.filter((p) => {
    if (p.instanceId === instanceId) return true;
    if (cleanString(p.machineFingerprint) !== fingerprint) return true;
    return false;
  });
}

function upsertParticipant(payload = {}) {
  cleanup();
  const participant = normalizeParticipant(payload);
  removeOlderMachineClones(participant.instanceId, participant.machineFingerprint);
  participants = participants.filter((p) => p.instanceId !== participant.instanceId);
  participants.push(participant);
  return participant;
}

function dedupeParticipants(list) {
  cleanup();
  const best = new Map();
  for (const participant of list) {
    const publicValue = publicParticipant(participant);
    if (Number(publicValue.lastSeen || 0) < now() - HEARTBEAT_TIMEOUT_MS) continue;
    const fingerprint = cleanString(publicValue.machineFingerprint);
    const key = fingerprint ? `machine:${fingerprint}` : `id:${publicValue.instanceId || publicValue.clientId}`;
    const previous = best.get(key);
    if (!previous || Number(publicValue.lastSeen || 0) >= Number(previous.lastSeen || 0))
      best.set(key, publicValue);
  }
  return [...best.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function roomsFromParticipants(list) {
  const rooms = {};
  for (const participant of list) {
    if (!rooms[participant.roomKey]) rooms[participant.roomKey] = [];
    rooms[participant.roomKey].push(participant);
  }
  return rooms;
}

function healthPayload() {
  const visibleParticipants = dedupeParticipants(participants);
  return {
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    participants: visibleParticipants.length,
    rawParticipants: participants.length,
    signals: signals.length,
    startedAt,
    timestamp: now()
  };
}

function debugPresencePayload() {
  cleanup();
  const rawParticipants = participants
    .map((p) => ({ ...publicParticipant(p), ageMs: now() - Number(p.lastSeen || 0), stale: Number(p.lastSeen || 0) < now() - HEARTBEAT_TIMEOUT_MS }))
    .sort((a, b) => String(a.roomKey).localeCompare(String(b.roomKey)) || String(a.name).localeCompare(String(b.name)));
  const dedupedParticipants = dedupeParticipants(participants);

  let transferCount = 0;
  try {
    transferCount = fs.readdirSync(TRANSFER_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch (_err) {
    transferCount = 0;
  }

  return {
    ok: true,
    service: "redlink-hub",
    name: "redlink-hub",
    version: VERSION,
    layer: "presence-debug",
    generatedAt: now(),
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    signalTtlMs: SIGNAL_TTL_MS,
    rawParticipantCount: rawParticipants.length,
    dedupedParticipantCount: dedupedParticipants.length,
    signalCount: signals.length,
    transferCount,
    roomCount: Object.keys(roomsFromParticipants(dedupedParticipants)).length,
    rooms: roomsFromParticipants(dedupedParticipants),
    rawParticipants,
    dedupedParticipants,
    hint: "Presence is lightweight. File payload relay is disabled by default; cloud RedLink is tracker/signaling for File Teleport."
  };
}

app.get("/", (_req, res) => res.json(healthPayload()));
app.get("/health", (_req, res) => res.json(healthPayload()));
app.get("/api/health", (_req, res) => res.json(healthPayload()));
app.get("/api/debug/presence", (_req, res) => res.json(debugPresencePayload()));
app.post("/api/debug/presence", (_req, res) => res.json(debugPresencePayload()));

function handleRegister(req, res) {
  const self = upsertParticipant(payloadFrom(req));
  const visibleParticipants = dedupeParticipants(participants);
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    action: "register-writeback",
    self: publicParticipant(self),
    clients: visibleParticipants.length,
    participants: visibleParticipants,
    members: visibleParticipants,
    generatedAt: now()
  });
}

app.get("/api/register", handleRegister);
app.post("/api/register", handleRegister);
app.get("/api/native/register", handleRegister);
app.post("/api/native/register", handleRegister);
app.get("/api/native/heartbeat", handleRegister);
app.post("/api/native/heartbeat", handleRegister);

function handleGoodbye(req, res) {
  const payload = payloadFrom(req);
  const instanceId = cleanString(payload.instanceId || payload.clientId);
  if (instanceId)
    participants = participants.filter((p) => cleanString(p.instanceId || p.clientId) !== instanceId);

  const visibleParticipants = dedupeParticipants(participants);
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    action: "native-goodbye",
    removedInstanceId: instanceId,
    clients: visibleParticipants.length,
    participants: visibleParticipants,
    members: visibleParticipants,
    generatedAt: now()
  });
}

app.get("/api/native/goodbye", handleGoodbye);
app.post("/api/native/goodbye", handleGoodbye);

function handlePresence(req, res) {
  const payload = payloadFrom(req);
  if (cleanString(payload.instanceId || payload.clientId))
    upsertParticipant({ ...payload, activity: payload.activity || "presence-heartbeat" });

  const visibleParticipants = dedupeParticipants(participants);
  const rooms = roomsFromParticipants(visibleParticipants);
  const roomKey = Object.keys(rooms).sort()[0] || "redbox-test/main/lobby";
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    roomKey,
    generatedAt: now(),
    clients: visibleParticipants.length,
    participants: visibleParticipants,
    members: visibleParticipants,
    rooms,
    time: now()
  });
}

app.get("/api/presence", handlePresence);
app.post("/api/presence", handlePresence);

function handleRedLinkDiscover(req, res) {
  const payload = payloadFrom(req);
  const self = upsertParticipant({ ...payload, activity: payload.activity || "redlink-discovery" });
  const visibleParticipants = dedupeParticipants(participants);
  const peers = visibleParticipants
    .filter((p) => p.roomKey === self.roomKey)
    .filter((p) => p.instanceId !== self.instanceId);

  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    layer: "redlink-discovery",
    roomKey: self.roomKey,
    generatedAt: now(),
    self: publicParticipant(self),
    peers,
    peerCount: peers.length,
    signaling: {
      endpoints: {
        discover: "/api/redlink/discover",
        signal: "/api/redlink/signal",
        poll: "/api/redlink/poll"
      },
      supportedTypes: ["offer", "answer", "ice", "hello", "probe", "dm", "box_discussion", "box_share_invite", "group_invite", "invite_response", "resource_access_request", "folder_share_invite", "shared_resource_manifest", "resource_unshare", "file_offer", "file_ready", "file_ticket", "file_accept", "file_chunk", "file_complete", "file_reject"]
    }
  });
}

app.get("/api/redlink/discover", handleRedLinkDiscover);
app.post("/api/redlink/discover", handleRedLinkDiscover);

function handleRedLinkSignal(req, res) {
  cleanup();
  const payload = payloadFrom(req);
  const type = cleanString(payload.type, "probe") || "probe";
  let data = payload.data || payload.payload || {};
  data = stripHeavyPresenceData(parseMaybeJson(data));

  if (type === "dm") {
    data = stripHeavyPresenceData({
      message: cleanString(payload.message || payload.payload),
      payload: cleanString(payload.payload || payload.message),
      fromName: cleanString(payload.fromName || payload.nickname || payload.name),
      toName: cleanString(payload.toName),
      createdAt: now()
    });
  }

  if (type === "box_discussion") {
    data = stripHeavyPresenceData(payload.data || payload.payload || {
      message: cleanString(payload.message),
      fromName: cleanString(payload.fromName || payload.nickname || payload.name),
      createdAt: now()
    });
  }

  const signal = {
    id: makeId("signal"),
    roomKey: roomKeyFrom(payload),
    from: cleanString(payload.from || payload.fromInstanceId || payload.instanceId),
    to: cleanString(payload.to || payload.toInstanceId),
    type,
    data,
    sentAt: now()
  };

  signals.push(signal);
  res.json({ ok: true, service: "redlink-hub", version: VERSION, action: "signal-queued", signal });
}

app.get("/api/redlink/signal", handleRedLinkSignal);
app.post("/api/redlink/signal", handleRedLinkSignal);

app.get("/api/redlink/poll", (req, res) => {
  cleanup();
  const payload = payloadFrom(req);
  const instanceId = cleanString(payload.instanceId || payload.to);
  const roomKey = roomKeyFrom(payload);
  const inbox = signals.filter((signal) => signal.roomKey === roomKey
    && (!signal.to || signal.to === instanceId)
    && signal.from !== instanceId);
  res.json({ ok: true, service: "redlink-hub", version: VERSION, layer: "redlink-signaling-poll", roomKey, instanceId, signals: inbox, generatedAt: now() });
});

function safeTransferId(value) {
  return cleanString(value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96) || makeId("transfer");
}

function safeFileName(value) {
  return cleanString(value, "received_file.bin").replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) || "received_file.bin";
}

function transferDirFor(id) {
  const cleanId = safeTransferId(id);
  const dir = path.join(TRANSFER_DIR, cleanId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function transferMetaPath(id) { return path.join(transferDirFor(id), "meta.json"); }
function transferPayloadPath(id) { return path.join(transferDirFor(id), "payload.bin"); }

function readTransferMeta(id) {
  const metaPath = transferMetaPath(id);
  if (!fs.existsSync(metaPath)) return null;
  try { return JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch (_err) { return null; }
}

function writeTransferMeta(id, meta) {
  const cleanId = safeTransferId(id);
  fs.writeFileSync(transferMetaPath(cleanId), JSON.stringify({ ...meta, transferId: cleanId }, null, 2), "utf8");
  return cleanId;
}

function cloudFileRelayDisabled(res, action = "file-transfer") {
  return res.status(403).json({
    ok: false,
    service: "redlink-hub",
    version: VERSION,
    action,
    error: "cloud_file_relay_disabled",
    policy: "file_teleport_direct_p2p_default",
    hint: "Cloud RedLink is tracker/signaling only. Enable REDBOX_ALLOW_CLOUD_FILE_RELAY=1 only for explicit temporary fallback tests."
  });
}

app.post("/api/redlink/file-transfer/start", (req, res) => {
  if (!ALLOW_CLOUD_FILE_RELAY) return cloudFileRelayDisabled(res, "file-transfer-start");
  const payload = payloadFrom(req);
  const transferId = safeTransferId(payload.transferId);
  const fileName = safeFileName(payload.fileName);
  try {
    const payloadPath = transferPayloadPath(transferId);
    if (fs.existsSync(payloadPath)) fs.unlinkSync(payloadPath);
    const meta = {
      roomKey: roomKeyFrom(payload),
      from: cleanString(payload.from || payload.fromInstanceId || payload.instanceId),
      fromName: cleanString(payload.fromName || payload.nickname || payload.name),
      to: cleanString(payload.to || payload.toInstanceId),
      fileName,
      fileSize: Number(payload.fileSize || 0),
      chunkCount: Number(payload.chunkCount || 0),
      folderName: cleanString(payload.folderName),
      relativePath: cleanString(payload.relativePath),
      receivedBytes: 0,
      completed: false,
      createdAt: now(),
      updatedAt: now(),
      downloadPath: `/api/redlink/file-transfer/download/${transferId}`
    };
    writeTransferMeta(transferId, meta);
    res.json({ ok: true, service: "redlink-hub", version: VERSION, action: "file-transfer-started", transferId, meta });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err), transferId });
  }
});

app.post("/api/redlink/file-transfer/chunk", (req, res) => {
  if (!ALLOW_CLOUD_FILE_RELAY) return cloudFileRelayDisabled(res, "file-transfer-chunk");
  const payload = payloadFrom(req);
  const transferId = safeTransferId(payload.transferId);
  const meta = readTransferMeta(transferId);
  if (!meta) return res.status(404).json({ ok: false, error: "unknown transferId", transferId });
  try {
    const encoded = cleanString(payload.chunkBase64);
    if (!encoded) return res.status(400).json({ ok: false, error: "empty chunkBase64", transferId });
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.length <= 0) return res.status(400).json({ ok: false, error: "decoded chunk is empty", transferId });
    fs.appendFileSync(transferPayloadPath(transferId), buffer);
    const receivedBytes = fs.statSync(transferPayloadPath(transferId)).size;
    writeTransferMeta(transferId, { ...meta, receivedBytes, updatedAt: now(), lastChunkIndex: Number(payload.chunkIndex || 0) });
    res.json({ ok: true, service: "redlink-hub", version: VERSION, action: "file-transfer-chunk-stored", transferId, receivedBytes });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err), transferId });
  }
});

app.post("/api/redlink/file-transfer/complete", (req, res) => {
  if (!ALLOW_CLOUD_FILE_RELAY) return cloudFileRelayDisabled(res, "file-transfer-complete");
  const payload = payloadFrom(req);
  const transferId = safeTransferId(payload.transferId);
  const meta = readTransferMeta(transferId);
  if (!meta) return res.status(404).json({ ok: false, error: "unknown transferId", transferId });
  const payloadPath = transferPayloadPath(transferId);
  const receivedBytes = fs.existsSync(payloadPath) ? fs.statSync(payloadPath).size : 0;
  const nextMeta = { ...meta, receivedBytes, completed: true, completedAt: now(), updatedAt: now(), downloadPath: `/api/redlink/file-transfer/download/${transferId}` };
  writeTransferMeta(transferId, nextMeta);
  res.json({ ok: true, service: "redlink-hub", version: VERSION, action: "file-transfer-complete", transferId, meta: nextMeta });
});

app.get("/api/redlink/file-transfer/meta/:transferId", (req, res) => {
  if (!ALLOW_CLOUD_FILE_RELAY) return cloudFileRelayDisabled(res, "file-transfer-meta");
  const transferId = safeTransferId(req.params.transferId);
  const meta = readTransferMeta(transferId);
  if (!meta) return res.status(404).json({ ok: false, error: "unknown transferId", transferId });
  res.json({ ok: true, service: "redlink-hub", version: VERSION, transferId, meta });
});

app.get("/api/redlink/file-transfer/download/:transferId", (req, res) => {
  if (!ALLOW_CLOUD_FILE_RELAY) return cloudFileRelayDisabled(res, "file-transfer-download");
  const transferId = safeTransferId(req.params.transferId);
  const meta = readTransferMeta(transferId);
  const payloadPath = transferPayloadPath(transferId);
  if (!meta || !fs.existsSync(payloadPath)) return res.status(404).json({ ok: false, error: "transfer payload not found", transferId });
  res.download(payloadPath, safeFileName(meta.fileName));
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "route_not_found",
    path: req.path,
    available: ["/", "/health", "/api/health", "/api/debug/presence", "/api/presence", "/api/register", "/api/native/register", "/api/native/heartbeat", "/api/native/goodbye", "/api/redlink/discover", "/api/redlink/signal", "/api/redlink/poll", "/api/redlink/file-transfer/start", "/api/redlink/file-transfer/chunk", "/api/redlink/file-transfer/complete", "/api/redlink/file-transfer/download/:transferId"]
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RedLink Hub ${VERSION} running on ${PORT}`);
});

// --- КОНЕЦ ФАЙЛА ---
