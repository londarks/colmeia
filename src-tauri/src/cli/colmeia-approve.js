#!/usr/bin/env node
// Hook PreToolUse do Claude Code (rodado pelo colmeia via --settings).
// Recebe a solicitação de uso de ferramenta no stdin, e — para ferramentas
// sensíveis — PAUSA o agente e pede aprovação ao painel central do colmeia.
// A resposta do servidor loopback é o próprio JSON de decisão do hook.

const http = require("http");

const PORT = process.env.COLMEIA_PORT || "0";
const TOKEN = process.env.COLMEIA_TOKEN || "";
const NODE_ID = process.env.COLMEIA_NODE_ID || "";

// Ferramentas que exigem aprovação humana (rodar comando / alterar arquivos).
const SENSITIVE = new Set([
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

const ALLOW = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
const ASK = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let tool = "";
  let summary = "";
  try {
    const data = JSON.parse(input || "{}");
    tool = data.tool_name || "";
    const ti = data.tool_input || {};
    summary =
      ti.command ||
      ti.file_path ||
      ti.path ||
      ti.url ||
      (Object.keys(ti).length ? JSON.stringify(ti).slice(0, 400) : "");
  } catch {
    /* input inválido */
  }

  // Ferramentas não-sensíveis (Read/Grep/Glob/...) seguem o fluxo normal.
  if (!SENSITIVE.has(tool)) emit(ASK);

  const payload = JSON.stringify({ tool, summary: String(summary) });
  const path =
    `/approve?source=${encodeURIComponent(NODE_ID)}&token=${encodeURIComponent(TOKEN)}`;

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: Number(PORT),
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        // O servidor devolve o JSON de decisão do hook pronto.
        process.stdout.write(body || JSON.stringify(ASK));
        process.exit(0);
      });
    },
  );
  // Se o colmeia estiver inacessível, cai no fluxo normal (prompt no terminal).
  req.on("error", () => emit(ASK));
  req.write(payload);
  req.end();
});
