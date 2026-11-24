#!/usr/bin/env node
// Hooks de estado do Claude Code (UserPromptSubmit / Stop / Notification),
// rodados pelo colmeia via --settings. Avisam o app que o agente começou a
// trabalhar, terminou o turno ou precisa de atenção (F4).
// Nunca bloqueiam nem alteram o agente: não imprimem nada (no UserPromptSubmit
// o stdout viraria contexto do prompt) e sempre saem com 0, rápido.

const http = require("http");

const PORT = process.env.COLMEIA_PORT || "0";
const TOKEN = process.env.COLMEIA_TOKEN || "";
const EVENT = process.argv[2] || "";

const done = () => process.exit(0);
setTimeout(done, 3000).unref();

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("error", done);
process.stdin.on("end", () => {
  if (!TOKEN || PORT === "0" || !EVENT) return done();
  let data = {};
  try {
    data = JSON.parse(input || "{}");
  } catch {
    /* ignora */
  }
  const payload = JSON.stringify({
    event: EVENT,
    notification_type: String(data.notification_type || ""),
    message: String(data.message || "").slice(0, 300),
  });
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: Number(PORT),
      path: "/event",
      method: "POST",
      timeout: 2500,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-Colmeia-Token": TOKEN,
      },
    },
    (res) => {
      res.resume();
      res.on("end", done);
    },
  );
  req.on("error", done);
  req.on("timeout", () => {
    req.destroy();
    done();
  });
  req.write(payload);
  req.end();
});
