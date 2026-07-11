#!/usr/bin/env node
// CLI `colmeia` — injetada no PATH de cada terminal do canvas.
// Permite que um agente veja e converse com os agentes conectados a ele,
// falando com o servidor loopback do backend (127.0.0.1:COLMEIA_PORT).

const http = require("http");

const PORT = process.env.COLMEIA_PORT || "0";
const TOKEN = process.env.COLMEIA_TOKEN || "";
const NODE_ID = process.env.COLMEIA_NODE_ID || "";

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log("colmeia — orquestrador de agentes\n");
  console.log("  colmeia list                        lista os agentes conectados a este");
  console.log('  colmeia check "<agente>"            lê a saída recente de outro agente');
  console.log('  colmeia ask "<agente>" "<prompt>"   envia um prompt para outro agente');
  console.log('  colmeia note "<título>" "<texto>"   cria uma nota no canvas');
  console.log('  colmeia connect "<a>" "<b>"         conecta dois nós no canvas');
}

function request(path, method, data) {
  return new Promise((resolve, reject) => {
    const sep = path.includes("?") ? "&" : "?";
    const fullPath = `${path}${sep}source=${encodeURIComponent(NODE_ID)}&token=${encodeURIComponent(TOKEN)}`;
    const payload = data ? JSON.stringify(data) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(PORT),
        path: fullPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          res.statusCode >= 200 && res.statusCode < 300
            ? resolve(body)
            : reject(new Error(`HTTP ${res.statusCode}: ${body}`)),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }
  try {
    if (command === "list") {
      console.log(await request("/list", "GET"));
    } else if (command === "check") {
      const agent = args[1];
      if (!agent) return fail('Uso: colmeia check "<agente>"');
      console.log(await request(`/check?agent=${encodeURIComponent(agent)}`, "GET"));
    } else if (command === "ask") {
      const agent = args[1];
      const prompt = args[2];
      if (!agent || !prompt) return fail('Uso: colmeia ask "<agente>" "<prompt>"');
      console.log(await request("/ask", "POST", { agent, prompt }));
    } else if (command === "note") {
      const title = args[1];
      const content = args[2] || "";
      if (!title) return fail('Uso: colmeia note "<título>" "<texto>"');
      console.log(await request("/note", "POST", { title, content }));
    } else if (command === "connect") {
      const source = args[1];
      const target = args[2];
      if (!source || !target) return fail('Uso: colmeia connect "<a>" "<b>"');
      console.log(await request("/connect", "POST", { source, target }));
    } else {
      fail(`Comando desconhecido: ${command}`);
    }
  } catch (err) {
    console.error(`colmeia: falha na conexão: ${err.message}`);
    process.exit(1);
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main();
