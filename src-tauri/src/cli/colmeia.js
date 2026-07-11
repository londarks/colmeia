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
  console.log("  colmeia context                     lê as notas conectadas a você (instruções)");
  console.log('  colmeia recruit "<papel>"           cria um agente (claude) com esse papel, conectado a você');
  console.log("                                      papeis: engenheiro, revisor, arquiteto, testador, orquestrador");
  console.log('  colmeia dismiss "<título>"          remove um agente do canvas');
  console.log('  colmeia routine create "<t>" <s> "<cmd>"  agenda um comando a cada <s>s');
  console.log("  colmeia routine list                lista as rotinas ativas");
  console.log('  colmeia routine delete "<id>"       remove uma rotina');
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
    } else if (command === "context") {
      console.log(await request("/context", "GET"));
    } else if (command === "recruit") {
      const agent = args[1];
      const role = args[2] || "";
      if (!agent) return fail('Uso: colmeia recruit "<papel>"  (ex: engenheiro, revisor)');
      console.log(await request("/recruit", "POST", { agent, role }));
    } else if (command === "dismiss") {
      const title = args[1];
      if (!title) return fail('Uso: colmeia dismiss "<título>"');
      console.log(await request("/dismiss", "POST", { title }));
    } else if (command === "routine") {
      const sub = args[1];
      if (sub === "create") {
        const target = args[2];
        const interval = Number(args[3]);
        const cmd = args[4];
        if (!target || !interval || !cmd)
          return fail('Uso: colmeia routine create "<terminal>" <segundos> "<comando>"');
        console.log(await request("/routine", "POST", { action: "create", target, interval, command: cmd }));
      } else if (sub === "list") {
        console.log(await request("/routine", "POST", { action: "list" }));
      } else if (sub === "delete") {
        const id = args[2];
        if (!id) return fail('Uso: colmeia routine delete "<id>"');
        console.log(await request("/routine", "POST", { action: "delete", id }));
      } else {
        fail("Uso: colmeia routine [create|list|delete]");
      }
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
