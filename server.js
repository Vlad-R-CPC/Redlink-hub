const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3737;

let participants = [];
let signals = [];

app.get("/", (req, res) => {
  res.send("RedLink Hub Online");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "redlink-hub",
    participants: participants.length,
    timestamp: Date.now()
  });
});

app.get("/api/presence", (req, res) => {
  res.json({
    ok: true,
    participants,
    signals,
    timestamp: Date.now()
  });
});

app.post("/api/register", (req, res) => {
  const participant = req.body;

  participant.lastSeen = Date.now();

  participants = participants.filter(
    p => p.instanceId !== participant.instanceId
  );

  participants.push(participant);

  res.json({
    ok: true,
    participants: participants.length
  });
});

app.post("/api/redlink/signal", (req, res) => {
  const signal = req.body;

  signal.timestamp = Date.now();

  signals.push(signal);

  res.json({ ok: true });
});

app.get("/api/redlink/discover", (req, res) => {
  res.json({
    ok: true,
    peers: participants
  });
});

app.listen(PORT, () => {
  console.log(`RedLink Hub running on ${PORT}`);
});
