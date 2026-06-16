/* ============================================================
   FILE: tools/redlink-render-hub/server.js
   PROJECT VERSION: 0.5.0.9
   DATE: 2026-06-16 Europe/Moscow
   PURPOSE: Public RedLink Hub for lightweight presence, signaling and discovery only.
   CHANGE: Bandwidth guard after Render free bandwidth suspension: debug endpoints are dev/auth-only; cloud file relay is hard-disabled; payload/history/queue data is compacted; TTL, pruning, poll limits and backoff are enforced.
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
const SIGNAL_MAX_AGE_MS = Math.min(SIGNAL_TTL_MS, Number(process.env.REDLINK_SIGNAL_MAX_AGE_MS || 120000));
const MAX_SIGNALS = Math.max(32, Number(process.env.REDLINK_MAX_SIGNALS || 600));
const MAX_POLL_SIGNALS = Math.max(1, Math.min(50, Number(process.env.REDLINK_MAX_POLL_SIGNALS || 20)));
const MAX_PRESENCE_MEMBERS = Math.max(4, Math.min(200, Number(process.env.REDLINK_MAX_PRESENCE_MEMBERS || 80)));
const MAX_SIGNAL_DATA_BYTES = Math.max(1024, Math.min(32768, Number(process.env.REDLINK_MAX_SIGNAL_DATA_BYTES || 16384)));
const MAX_RESPONSE_BYTES = Math.max(4096, Math.min(262144, Number(process.env.REDLINK_MAX_RESPONSE_BYTES || 65536)));
const MAX_SIGNAL_STORE_BYTES = Math.max(65536, Math.min(4194304, Number(process.env.REDLINK_MAX_SIGNAL_STORE_BYTES || 1048576)));
const POLL_RETRY_AFTER_MS = Math.max(1000, Number(process.env.REDLINK_POLL_RETRY_AFTER_MS || 5000));
const DEBUG_ENABLED = process.env.REDLINK_DEBUG === "1" || process.env.NODE_ENV === "development";
const DEBUG_TOKEN = cleanString(process.env.REDLINK_DEBUG_TOKEN);
const DEBUG_ALLOW_NO_TOKEN = process.env.REDLINK_DEBUG_ALLOW_NO_TOKEN === "1";
const BANDWIDTH_BUCKET_MS = Math.max(60000, Number(process.env.REDLINK_BANDWIDTH_BUCKET_MS || 300000));
const BANDWIDTH_MAX_BUCKETS = Math.max(3, Math.min(288, Number(process.env.REDLINK_BANDWIDTH_MAX_BUCKETS || 36)));
const VERSION = "0.5.0.9-bandwidth-guard";
const TRANSFER_DIR = path.join(__dirname, "redlink_transfers");
const ALLOW_CLOUD_FILE_RELAY = false;

fs.mkdirSync(TRANSFER_DIR, { recursive: true });

app.use(cors());
app.use(rateLimit);
app.use((req, res, next) => {
  const started = now();
  let responseBytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = (chunk, encoding, callback) => {
    if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding);
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding);
    recordBandwidth(req, res.statusCode, responseBytes, now() - started);
    return originalEnd(chunk, encoding, callback);
  };
  return next();
});
app.use(express.json({ limit: process.env.REDLINK_BODY_LIMIT || "64kb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.REDLINK_BODY_LIMIT || "64kb" }));

let participants = [];
let signals = [];
let requestBuckets = new Map();
let bandwidthBuckets = new Map();

function now() {
  return Date.now();
}
function rateLimit(req, res, next) {
  const windowMs = Math.max(1000, Number(process.env.REDLINK_RATE_WINDOW_MS || 60000));
  const maxRequests = Math.max(30, Number(process.env.REDLINK_RATE_MAX || 240));
  const key = cleanString(req.ip || req.headers["x-forwarded-for"] || "unknown").slice(0, 80);
  const current = now();
  const bucket = requestBuckets.get(key) || { count: 0, resetAt: current + windowMs };
  if (current > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = current + windowMs;
  }
  bucket.count += 1;
  requestBuckets.set(key, bucket);
  if (requestBuckets.size > 1000) requestBuckets = new Map([...requestBuckets.entries()].slice(-500));
  if (bucket.count > maxRequests) {
    const retryAfterMs = Math.max(1000, bucket.resetAt - current);
    res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ ok: false, error: "rate_limited", retryAfterMs });
  }
  return next();
}

function hashClient(value) {
  const text = cleanString(value, "unknown");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16)}`;
}

function compactPath(pathValue) {
  const text = cleanString(pathValue, "/");
  return text.replace(/\/api\/redlink\/file-transfer\/(?:meta|download)\/[^/?#]+/g, "/api/redlink/file-transfer/:kind/:transferId");
}

function recordBandwidth(req, statusCode, responseBytes, elapsedMs) {
  const bucketStart = Math.floor(now() / BANDWIDTH_BUCKET_MS) * BANDWIDTH_BUCKET_MS;
  const pathKey = compactPath(req.path || req.url || "/");
  const clientHash = hashClient(`${req.ip || ""}|${req.get("user-agent") || ""}|${req.query.instanceId || req.query.clientId || req.query.to || ""}`);
  const bucket = bandwidthBuckets.get(bucketStart) || {
    bucketStart,
    requestCount: 0,
    responseBytes: 0,
    endpoints: {},
    clients: {}
  };
  bucket.requestCount += 1;
  bucket.responseBytes += responseBytes;
  const endpoint = bucket.endpoints[pathKey] || { requests: 0, responseBytes: 0, status: {} };
  endpoint.requests += 1;
  endpoint.responseBytes += responseBytes;
  endpoint.status[String(statusCode || 0)] = (endpoint.status[String(statusCode || 0)] || 0) + 1;
  bucket.endpoints[pathKey] = endpoint;
  const client = bucket.clients[clientHash] || { requests: 0, responseBytes: 0 };
  client.requests += 1;
  client.responseBytes += responseBytes;
  bucket.clients[clientHash] = client;
  bandwidthBuckets.set(bucketStart, bucket);
  const keys = [...bandwidthBuckets.keys()].sort((a, b) => a - b);
  while (keys.length > BANDWIDTH_MAX_BUCKETS) {
    bandwidthBuckets.delete(keys.shift());
  }
}

function bandwidthSummary(limit = 10) {
  const buckets = [...bandwidthBuckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
  const total = { requests: 0, responseBytes: 0 };
  const endpoints = {};
  const clients = {};
  for (const bucket of buckets) {
    total.requests += bucket.requestCount;
    total.responseBytes += bucket.responseBytes;
    for (const [pathKey, value] of Object.entries(bucket.endpoints)) {
      const item = endpoints[pathKey] || { requests: 0, responseBytes: 0 };
      item.requests += value.requests;
      item.responseBytes += value.responseBytes;
      endpoints[pathKey] = item;
    }
    for (const [clientHash, value] of Object.entries(bucket.clients)) {
      const item = clients[clientHash] || { requests: 0, responseBytes: 0 };
      item.requests += value.requests;
      item.responseBytes += value.responseBytes;
      clients[clientHash] = item;
    }
  }
  const topEndpoints = Object.entries(endpoints)
    .map(([endpoint, value]) => ({ endpoint, ...value }))
    .sort((a, b) => b.responseBytes - a.responseBytes)
    .slice(0, limit);
  const topClients = Object.entries(clients)
    .map(([clientHash, value]) => ({ clientHash, ...value }))
    .sort((a, b) => b.responseBytes - a.responseBytes)
    .slice(0, limit);
  return {
    windowBuckets: buckets.length,
    bucketMs: BANDWIDTH_BUCKET_MS,
    total,
    topEndpoints,
    topClients
  };
}

function publicBoardStatus() {
  const summary = bandwidthSummary(8);
  return {
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    role: "public-lightweight-board",
    policy: {
      noFiles: true,
      noHistory: true,
      noBase64: true,
      noFullDumps: true,
      noCloudPayloadRelay: true
    },
    limits: {
      signalTtlMs: SIGNAL_MAX_AGE_MS,
      maxSignals: MAX_SIGNALS,
      maxPollSignals: MAX_POLL_SIGNALS,
      maxPresenceMembers: MAX_PRESENCE_MEMBERS,
      maxSignalDataBytes: MAX_SIGNAL_DATA_BYTES,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxSignalStoreBytes: MAX_SIGNAL_STORE_BYTES,
      pollRetryAfterMs: POLL_RETRY_AFTER_MS
    },
    counters: {
      participants: dedupeParticipants(participants).length,
      rawParticipants: participants.length,
      signals: signals.length,
      bandwidthRequests: summary.total.requests,
      bandwidthResponseBytes: summary.total.responseBytes
    },
    topEndpoints: summary.topEndpoints,
    generatedAt: now()
  };
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

function intParam(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function compactValue(value, maxBytes = MAX_SIGNAL_DATA_BYTES, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return "[depth-stripped]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactValue(item, Math.floor(maxBytes / 2), depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, innerValue] of Object.entries(value)) {
      const lower = String(key).toLowerCase();
      if (lower.includes("payload") || lower.includes("history") || lower.includes("queue")
          || lower.includes("base64") || lower.includes("chunk") || lower.includes("body")
          || lower.includes("avatar") || lower.includes("image") || lower.includes("thumbnail")
          || lower.includes("preview")) {
        out[`${key}Stripped`] = true;
        continue;
      }
      out[key] = compactValue(innerValue, Math.floor(maxBytes / 2), depth + 1);
    }
    return out;
  }
  const text = String(value);
  if (utf8Bytes(text) <= maxBytes) return text;
  return text.slice(0, Math.max(64, maxBytes)) + "...[truncated]";
}

function compactSignal(signal = {}, includeData = true) {
  const out = {
    id: signal.id || "",
    roomKey: signal.roomKey || "",
    from: signal.from || "",
    to: signal.to || "",
    type: signal.type || "probe",
    actionId: signal.actionId || "",
    sentAt: signal.sentAt || 0,
    expiresAt: Number(signal.sentAt || 0) + SIGNAL_MAX_AGE_MS
  };
  if (includeData) out.data = compactValue(signal.data || {}, MAX_SIGNAL_DATA_BYTES);
  return out;
}

function boundedSignalsForResponse(list, includeData = true, maxBytes = MAX_RESPONSE_BYTES) {
  const out = [];
  let used = 2;
  for (const signal of list) {
    const compact = compactSignal(signal, includeData);
    const bytes = utf8Bytes(JSON.stringify(compact)) + 1;
    if (out.length > 0 && used + bytes > maxBytes) break;
    out.push(compact);
    used += bytes;
  }
  return out;
}

function compactParticipant(participant = {}) {
  return {
    instanceId: participant.instanceId || participant.clientId || "",
    clientId: participant.clientId || participant.instanceId || "",
    nickname: participant.nickname || participant.name || "",
    name: participant.name || participant.nickname || "",
    status: participant.status || "online",
    activity: safeSlice(participant.activity || "native-redbox", 96),
    workspaceId: participant.workspaceId || "redbox-test",
    projectId: participant.projectId || "main",
    roomId: participant.roomId || "lobby",
    roomKey: participant.roomKey || "redbox-test/main/lobby",
    lastSeen: participant.lastSeen || 0,
    transport: participant.transport || "render-http"
  };
}

function requireDebug(req, res, next) {
  if (!DEBUG_ENABLED) {
    return res.status(404).json({ ok: false, error: "route_not_found", path: req.path });
  }
  const token = cleanString(req.get("x-redlink-debug-token") || req.query.debugToken || req.query.token);
  if (!DEBUG_TOKEN && !DEBUG_ALLOW_NO_TOKEN) {
    return res.status(403).json({ ok: false, error: "debug_token_not_configured" });
  }
  if (DEBUG_TOKEN && token !== DEBUG_TOKEN) {
    return res.status(403).json({ ok: false, error: "debug_auth_required" });
  }
  return next();
}

function pruneSignals() {
  const cutoff = now() - SIGNAL_MAX_AGE_MS;
  signals = signals.filter((s) => Number(s.sentAt || 0) >= cutoff);
  if (signals.length > MAX_SIGNALS) signals = signals.slice(signals.length - MAX_SIGNALS);
  let storeBytes = utf8Bytes(JSON.stringify(signals.map((signal) => compactSignal(signal, true))));
  while (signals.length > 1 && storeBytes > MAX_SIGNAL_STORE_BYTES) {
    signals.shift();
    storeBytes = utf8Bytes(JSON.stringify(signals.map((signal) => compactSignal(signal, true))));
  }
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
  pruneSignals();
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
    if (rooms[participant.roomKey].length < MAX_PRESENCE_MEMBERS) rooms[participant.roomKey].push(compactParticipant(participant));
  }
  return rooms;
}

function limitedParticipants(list, limit = MAX_PRESENCE_MEMBERS) {
  return list.slice(0, limit).map(compactParticipant);
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
    debugEnabled: DEBUG_ENABLED,
    cloudFileRelayEnabled: ALLOW_CLOUD_FILE_RELAY,
    signalTtlMs: SIGNAL_MAX_AGE_MS,
    maxSignals: MAX_SIGNALS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    pollRetryAfterMs: POLL_RETRY_AFTER_MS,
    startedAt,
    timestamp: now()
  };
}

function debugPresencePayload() {
  cleanup();
  const rawParticipants = participants
    .map((p) => ({ ...compactParticipant(p), ageMs: now() - Number(p.lastSeen || 0), stale: Number(p.lastSeen || 0) < now() - HEARTBEAT_TIMEOUT_MS }))
    .sort((a, b) => String(a.roomKey).localeCompare(String(b.roomKey)) || String(a.name).localeCompare(String(b.name)));
  const dedupedParticipants = dedupeParticipants(participants).map(compactParticipant);

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
app.get("/api/board/status", (_req, res) => res.json(publicBoardStatus()));
app.get("/api/diagnostics/bandwidth", (_req, res) => res.json({
  ok: true,
  service: "redlink-hub",
  version: VERSION,
  layer: "public-bandwidth-aggregate",
  summary: bandwidthSummary(8),
  generatedAt: now()
}));
app.get("/api/debug/presence", requireDebug, (req, res) => {
  const payload = debugPresencePayload();
  res.json({
    ...payload,
    rawParticipants: payload.rawParticipants.slice(0, intParam(req.query.limit, 25, 1, 100))
  });
});
app.post("/api/debug/presence", requireDebug, (req, res) => {
  const payload = debugPresencePayload();
  res.json({
    ...payload,
    rawParticipants: payload.rawParticipants.slice(0, intParam(req.query.limit, 25, 1, 100))
  });
});
app.get("/api/debug/signals", requireDebug, (req, res) => {
  cleanup();
  const limit = intParam(req.query.limit, 20, 1, 100);
  const offset = intParam(req.query.offset, 0, 0, Math.max(0, signals.length));
  const includeData = cleanString(req.query.includeData) === "1";
  const page = boundedSignalsForResponse(signals.slice(offset, offset + limit), includeData);
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    layer: "signals-debug",
    generatedAt: now(),
    signalCount: signals.length,
    warning: signals.length > Math.floor(MAX_SIGNALS * 0.8) ? "signal_store_near_cap" : "",
    limit,
    offset,
    hasMore: offset + limit < signals.length,
    signals: page,
    boundedByBytes: MAX_RESPONSE_BYTES
  });
});

app.get("/api/debug/bandwidth", requireDebug, (req, res) => {
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    layer: "bandwidth-debug",
    generatedAt: now(),
    summary: bandwidthSummary(intParam(req.query.limit, 10, 1, 50))
  });
});

function handleRegister(req, res) {
  const self = upsertParticipant(payloadFrom(req));
  const visibleParticipants = limitedParticipants(dedupeParticipants(participants));
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    action: "register-writeback",
    self: compactParticipant(self),
    clients: visibleParticipants.length,
    participants: visibleParticipants,
    members: visibleParticipants,
    limit: MAX_PRESENCE_MEMBERS,
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

  const visibleParticipants = limitedParticipants(dedupeParticipants(participants));
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    action: "native-goodbye",
    removedInstanceId: instanceId,
    clients: visibleParticipants.length,
    participants: visibleParticipants,
    members: visibleParticipants,
    limit: MAX_PRESENCE_MEMBERS,
    generatedAt: now()
  });
}

app.get("/api/native/goodbye", handleGoodbye);
app.post("/api/native/goodbye", handleGoodbye);

function handlePresence(req, res) {
  const payload = payloadFrom(req);
  if (cleanString(payload.instanceId || payload.clientId))
    upsertParticipant({ ...payload, activity: payload.activity || "presence-heartbeat" });

  const visibleParticipants = limitedParticipants(dedupeParticipants(participants));
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
    limit: MAX_PRESENCE_MEMBERS,
    retryAfterMs: POLL_RETRY_AFTER_MS,
    time: now()
  });
}

app.get("/api/presence", handlePresence);
app.post("/api/presence", handlePresence);

function handleRedLinkDiscover(req, res) {
  const payload = payloadFrom(req);
  const self = upsertParticipant({ ...payload, activity: payload.activity || "redlink-discovery" });
  const visibleParticipants = limitedParticipants(dedupeParticipants(participants));
  const peers = visibleParticipants
    .filter((p) => p.roomKey === self.roomKey)
    .filter((p) => p.instanceId !== self.instanceId)
    .slice(0, MAX_PRESENCE_MEMBERS);

  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    layer: "redlink-discovery",
    roomKey: self.roomKey,
    generatedAt: now(),
    self: compactParticipant(self),
    peers,
    peerCount: peers.length,
    limit: MAX_PRESENCE_MEMBERS,
    retryAfterMs: POLL_RETRY_AFTER_MS,
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
    data = compactValue({
      actionId: cleanString(payload.actionId || payload.messageId || payload.id),
      message: safeSlice(payload.message || payload.payload, 1024),
      fromName: safeSlice(payload.fromName || payload.nickname || payload.name, 96),
      toName: safeSlice(payload.toName, 96),
      createdAt: now()
    });
  }

  if (type === "box_discussion") {
    data = compactValue({
      actionId: cleanString(payload.actionId || payload.messageId || payload.id),
      message: safeSlice(payload.message, 1024),
      fromName: safeSlice(payload.fromName || payload.nickname || payload.name, 96),
      createdAt: now()
    });
  }

  if (type !== "dm" && type !== "box_discussion") {
    data = compactValue(data, MAX_SIGNAL_DATA_BYTES);
  }

  const signal = {
    id: makeId("signal"),
    roomKey: roomKeyFrom(payload),
    from: cleanString(payload.from || payload.fromInstanceId || payload.instanceId),
    to: cleanString(payload.to || payload.toInstanceId),
    type,
    actionId: cleanString(payload.actionId || (data && data.actionId)),
    data,
    sentAt: now()
  };

  signals.push(signal);
  pruneSignals();
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    action: "signal-queued",
    signal: compactSignal(signal, false),
    signalTtlMs: SIGNAL_MAX_AGE_MS,
    retryAfterMs: POLL_RETRY_AFTER_MS
  });
}

app.get("/api/redlink/signal", (_req, res) => res.status(405).json({ ok: false, error: "method_not_allowed", hint: "Use POST /api/redlink/signal" }));
app.post("/api/redlink/signal", handleRedLinkSignal);

app.get("/api/redlink/poll", (req, res) => {
  cleanup();
  const payload = payloadFrom(req);
  const instanceId = cleanString(payload.instanceId || payload.to);
  const roomKey = roomKeyFrom(payload);
  const limit = intParam(payload.limit, MAX_POLL_SIGNALS, 1, MAX_POLL_SIGNALS);
  const inbox = signals
    .filter((signal) => signal.roomKey === roomKey
      && (!signal.to || signal.to === instanceId)
      && signal.from !== instanceId)
    .slice(0, limit);
  const boundedInbox = boundedSignalsForResponse(inbox, true);
  const deliveredIds = new Set(boundedInbox.filter((signal) => signal.to === instanceId).map((signal) => signal.id));

  signals = signals.filter((signal) => !deliveredIds.has(signal.id));

  res.set("Cache-Control", "no-store");
  res.set("X-RedLink-Retry-After-Ms", String(POLL_RETRY_AFTER_MS));
  res.json({
    ok: true,
    service: "redlink-hub",
    version: VERSION,
    layer: "redlink-signaling-poll",
    roomKey,
    instanceId,
    signalCount: inbox.length,
    returnedSignalCount: boundedInbox.length,
    limit,
    retryAfterMs: POLL_RETRY_AFTER_MS,
    boundedByBytes: MAX_RESPONSE_BYTES,
    signals: boundedInbox,
    generatedAt: now()
  });
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
  return res.status(410).json({
    ok: false,
    service: "redlink-hub",
    version: VERSION,
    action,
    error: "cloud_file_relay_disabled",
    policy: "no_cloud_payload_storage_or_download",
    hint: "Cloud RedLink is presence/signaling/discovery only. File payloads must use direct P2P or client-side donor routes."
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
    available: ["/", "/health", "/api/health", "/api/board/status", "/api/diagnostics/bandwidth", "/api/presence", "/api/register", "/api/native/register", "/api/native/heartbeat", "/api/native/goodbye", "/api/redlink/discover", "POST /api/redlink/signal", "/api/redlink/poll"]
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RedLink Hub ${VERSION} running on ${PORT}`);
});

// --- END FILE ---
