const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3737;

app.use(cors());
app.use(express.json());

const startedAt = Date.now();
let participants = [];
let signals = [];

function healthPayload() {
  return {
    ok: true,
    service: "redlink-hub",
    version: "0.1.0-render",
    participants: participants.length,
    signals: signals.length,
    startedAt,
    timestamp: Date.now()
  };
}

app.get("/", (req, res) => {
  res.json(healthPayload());
});

app.get("/health", (req, res) => {
  res.json(healthPayload());
});

app.get("/api/health", (req, res) => {
  res.json(healthPayload());
});

app.get("/api/presence", (req, res) => {
  res.json({
    ok: true,
    participants,
    clients: participants.length,
    signals: signals.length,
    timestamp: Date.now()
  });
});

app.post("/api/register", (req, res) => {
  const participant = req.body || {};
  participant.lastSeen = Date.now();

  participants = participants.filter(
    p => p.instanceId !== participant.instanceId
  );

  participants.push(participant);

  res.json({
    ok: true,
    participant,
    clients: participants.length
  });
});

app.get("/api/redlink/discover", (req, res) => {
  res.json({
    ok: true,
    peers: participants,
    clients: participants.length,
    timestamp: Date.now()
  });
});

app.post("/api/redlink/signal", (req, res) => {
  const signal = req.body || {};
  signal.timestamp = Date.now();
  signals.push(signal);

  res.json({
    ok: true,
    signals: signals.length
  });
});

app.get("/api/redlink/poll", (req, res) => {
  res.json({
    ok: true,
    signals,
    timestamp: Date.now()
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "route_not_found",
    path: req.path,
    available: [
      "/",
      "/health",
      "/api/health",
      "/api/presence",
      "/api/register",
      "/api/redlink/discover",
      "/api/redlink/signal",
      "/api/redlink/poll"
    ]
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RedLink Hub running on ${PORT}`);
});
