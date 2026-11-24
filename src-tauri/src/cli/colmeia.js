#!/usr/bin/env node
// CLI `colmeia` — injetada no PATH de cada terminal do canvas.
// Fala com o servidor loopback do app (127.0.0.1:COLMEIA_PORT) usando o token
// DESTE terminal no header X-Colmeia-Token (o servidor deriva quem chama dele).
//
// Saída: sucesso → stdout, exit 0 · aviso (terminou mas pede atenção) → stdout,
// exit 2 · erro → stderr "colmeia: …", exit 1.

const http = require("http");
const fs = require("fs");

const PORT = process.env.COLMEIA_PORT || "0";
const TOKEN = process.env.COLMEIA_TOKEN || "";
const NODE_ID = process.env.COLMEIA_NODE_ID || "";

// ── Ajuda ────────────────────────────────────────────────────────────────

const HELP = {
  list: "colmeia list\n  Você, os agentes, notas e navegadores ligados a você (com estado).",
  check:
    'colmeia check "<agente>" [--bytes N]\n  Texto renderizado da tela do agente (últimos ~6 KB por padrão).',
  wait: 'colmeia wait "<agente>" [--timeout segundos]\n  Bloqueia até o agente terminar o turno atual (padrão 300 s).',
  ask:
    'colmeia ask "<agente>" "<prompt>" [--timeout s] [--no-wait]\n' +
    'colmeia ask "<agente>" --file prompt.md     (prompt de um arquivo)\n' +
    'colmeia ask "<agente>" -                    (prompt pelo stdin)\n' +
    "colmeia ask --batch '{\"A\":\"…\",\"B\":\"…\"}'  (paralelo; devolve JSON)\n" +
    'colmeia ask "<agente>" --raw "1\\n"          (teclas: \\n Enter, \\t Tab, \\e ESC, \\xNN byte)\n' +
    "  Por padrão espera o turno do agente terminar e devolve o texto produzido desde a entrega.",
  note:
    'colmeia note list\n' +
    'colmeia note read "<nota>" [início] [quantidade]\n' +
    'colmeia note write "<nota>" "<texto>"   (ou --file arq.md, ou - para stdin)\n' +
    'colmeia note edit "<nota>" "<trecho antigo>" "<trecho novo>"\n' +
    'colmeia note create "<título>" ["<texto>"] [--to "<agente>"]\n' +
    'colmeia note "<título>" "<texto>" ["<agente>"]   (forma antiga de create)',
  context: "colmeia context\n  Lê todas as notas ligadas a você (as instruções do usuário).",
  notify: 'colmeia notify "<título>" "<texto>"\n  Notificação ao usuário (só quando ele pediu ou algo exige atenção).',
  status:
    'colmeia status <working|blocked|review|done|clear> "<texto>"\n  Publica uma linha de status no seu nó.',
  recruit:
    'colmeia recruit "<codinome>" [--agent claude|codex|ollama|shell] [--role "<papel>"] [--dir "<pasta>"]\n' +
    'colmeia recruit ["<novo nome>"] --replace "<nome>" [--agent …] [--role …] [--dir …]\n' +
    "  (orquestrador) Cria um agente ligado a você, ou troca o agente/papel de um nó mantendo as conexões.",
  dismiss: 'colmeia dismiss "<nome>"\n  (orquestrador) Encerra e remove um agente ligado a você.',
  connect: 'colmeia connect "<a>" "<b>"\n  Liga dois nós ao seu alcance (orquestrador: na árvore do time).',
  role:
    "colmeia role list\n" +
    'colmeia role show "<papel>"\n' +
    'colmeia role create "<nome>" "<prompt>"     (ou --file papel.md)\n' +
    'colmeia role edit "<papel>" "<trecho antigo>" "<trecho novo>"\n' +
    'colmeia role write "<papel>" "<prompt>"     (ou --file papel.md)\n' +
    'colmeia role assign "<agente>" "<papel>" | --none\n' +
    "  create/edit/write/assign exigem orquestrador.",
  preset: "colmeia preset list\n  Tipos de agente disponíveis para --agent.",
  routine:
    'colmeia routine create "<nome>" --command "<comando/prompt>" (--every 30m | --daily 09:00 | --weekly mon,fri@09:00 | --once "2026-06-20 15:00")\n' +
    '        [--terminal "<agente>" | --reminder] [--no-skip-if-busy] [--notify] [--count N] [--disabled]\n' +
    "  Sem --terminal/--reminder o alvo é você mesmo. Alvo ocupado → a rotina espera (ou pula).\n" +
    "colmeia routine list\n" +
    'colmeia routine show|delete|enable|disable|run "<nome>" [--id <prefixo>]\n' +
    'colmeia routine edit "<nome>" [--name "<novo>"] [--command "..."] [agenda] [--terminal X | --reminder]',
  floor:
    "colmeia floor list\n" +
    'colmeia floor create "<nome>" [--branch B] [--existing-branch] [--deps copy|link|skip]   (orquestrador)\n' +
    'colmeia floor status ["<texto>"] [--state working|blocked|review|done] [--floor "<nome>"] [--clear]\n' +
    'colmeia floor land "<nome>" [--into B] [--delete-branch] [--keep-floor]   (orquestrador, do ground)\n' +
    'colmeia floor delete "<nome>" [--keep-branch] [--force <impressão>]   (orquestrador, do ground)\n' +
    "  Floor = cópia isolada do repo (git worktree) numa branch floor/<nome>.",
  partitura:
    "colmeia partitura list\n" +
    'colmeia partitura insert "<nome>"\n' +
    "  Coloca no canvas um time salvo pelo usuário, ligado a você. A resposta lista os agentes para ask.",
  portal:
    'colmeia portal open "<url>" [--portal "<nome>"]   (abre ou reaproveita o portal ligado a você)\n' +
    'colmeia portal snapshot ["<portal>"] [--chars N]   (elementos @eN + texto da página)\n' +
    "colmeia portal click @eN | x,y                    (clique nativo no centro do elemento)\n" +
    'colmeia portal fill @eN "<texto>"                 (foca, limpa e digita; em <select> escolhe a opção)\n' +
    'colmeia portal type "<texto>"                     (digita no campo que está com foco)\n' +
    "colmeia portal press Enter|Tab|Escape|ArrowDown|Ctrl+A|…\n" +
    "colmeia portal scroll down|up|top|bottom|@eN [--px N]\n" +
    "colmeia portal back | forward | reload\n" +
    "colmeia portal screenshot [--full] [--png]        (salva a imagem e devolve o caminho)\n" +
    'colmeia portal wait "<texto>" | @eN | --selector "<css>" [--timeout s] [--gone]\n' +
    "colmeia portal list\n" +
    'colmeia portal eval "<js>"                        (só orquestrador)\n' +
    '  Com mais de um portal ligado, diga qual com --portal "<nome>". Campos de senha são recusados.',
  browse:
    'colmeia browse "<url>"   ·   colmeia click "<@eN|seletor>"   ·   colmeia type "<@eN|seletor>" "<texto>"\n' +
    "  Atalhos antigos: browse = portal open + snapshot; click/type agem no portal ligado a você.",
  debug: "colmeia debug\n  Diagnóstico: variáveis do terminal, app no ar, token aceito.",
};

function usage() {
  console.log("colmeia — falar com os agentes e notas ligados a você no canvas\n");
  for (const k of Object.keys(HELP)) console.log(HELP[k].split("\n")[0]);
  console.log('\nDetalhes: colmeia help <comando>  ·  problemas de conexão: colmeia debug');
}

// ── Argumentos ───────────────────────────────────────────────────────────

const BOOL_FLAGS = new Set([
  "no-wait",
  "raw",
  "none",
  "help",
  "json",
  // routine
  "reminder",
  "no-skip-if-busy",
  "notify",
  "disabled",
  // floor
  "existing-branch",
  "delete-branch",
  "keep-floor",
  "keep-branch",
  "clear",
  // portal
  "full",
  "png",
  "gone",
]);

/** `--no-skip-if-busy` → `noSkipIfBusy` (formato do JSON das rotas de rotina/floor). */
function camelFlags(flags) {
  const out = {};
  for (const [k, v] of Object.entries(flags)) {
    out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-") {
      pos.push(a);
    } else if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        if (BOOL_FLAGS.has(name) || i + 1 >= argv.length) flags[name] = true;
        else flags[name] = argv[++i];
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Texto vindo de: --file, "-" (stdin) ou o argumento posicional. */
function textArg(value, flags) {
  if (typeof flags.file === "string") {
    try {
      return fs.readFileSync(flags.file, "utf8");
    } catch (e) {
      fail(`não consegui ler ${flags.file}: ${e.message}`);
    }
  }
  if (value === "-") return readStdin();
  return value;
}

// ── Transporte ───────────────────────────────────────────────────────────

function request(path, data, method = "POST", withToken = true) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : "";
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (withToken) headers["X-Colmeia-Token"] = TOKEN;
    const req = http.request(
      { hostname: "127.0.0.1", port: Number(PORT), path, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            code: res.statusCode || 0,
            warn: res.headers["x-colmeia-warning"] === "1",
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function call(path, data) {
  let res;
  try {
    res = await request(path, data);
  } catch (err) {
    console.error(
      `colmeia: não consegui falar com o app (${err.code || err.message}). ` +
        "Se a conexão caiu no meio, o comando pode ter rodado — confira (ex.: colmeia check) antes de repetir. " +
        "Rode `colmeia debug` para diagnosticar.",
    );
    process.exit(1);
  }
  if (res.code >= 200 && res.code < 300) {
    if (res.body) console.log(res.body);
    process.exit(res.warn ? 2 : 0);
  }
  console.error(`colmeia: ${res.body || `HTTP ${res.code}`}`);
  process.exit(1);
}

function fail(msg) {
  console.error(`colmeia: ${msg}`);
  process.exit(1);
}

function needs(cond, cmd) {
  if (!cond) fail(`uso:\n${HELP[cmd]}`);
}

// ── Comandos ─────────────────────────────────────────────────────────────

async function debug() {
  const cli = process.env.COLMEIA_CLI || "(não definido)";
  console.log("colmeia debug");
  console.log(`  COLMEIA_NODE_ID = ${NODE_ID || "(vazio!)"}`);
  console.log(`  COLMEIA_PORT    = ${PORT}`);
  console.log(`  COLMEIA_TOKEN   = ${TOKEN ? `definido (${TOKEN.length} caracteres)` : "(vazio!)"}`);
  console.log(`  COLMEIA_CLI     = ${cli}`);
  console.log(`  script          = ${__filename}`);
  console.log(`  node            = ${process.version}`);
  if (!TOKEN || !NODE_ID || PORT === "0") {
    console.log("\n→ Este terminal não foi aberto pelo colmeia (variáveis ausentes). Abra-o pelo canvas.");
    process.exit(1);
  }
  try {
    const h = await request("/health", null, "GET", false);
    console.log(`  /health         = HTTP ${h.code} ${h.body}`);
  } catch (e) {
    console.log(`  /health         = falhou (${e.code || e.message})`);
    console.log("\n→ O app não responde nessa porta. Se o colmeia foi reiniciado, reabra este terminal pelo canvas.");
    process.exit(1);
  }
  try {
    const w = await request("/whoami", {});
    console.log(`  /whoami         = HTTP ${w.code} ${w.body}`);
    if (w.code === 403) {
      console.log("\n→ O app está no ar mas não reconhece o token deste terminal (ele foi reiniciado ou fechado). Reabra o terminal.");
      process.exit(1);
    }
  } catch (e) {
    console.log(`  /whoami         = falhou (${e.code || e.message})`);
    process.exit(1);
  }
  console.log("\n→ Tudo certo. Se um comando falha, a mensagem dele diz o próximo passo; `colmeia list` mostra os nomes exatos.");
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const command = pos[0];
  const a = pos.slice(1);

  if (!command || command === "help") {
    if (a[0] && HELP[a[0]]) console.log(HELP[a[0]]);
    else usage();
    return;
  }
  if (flags.help) {
    console.log(HELP[command] || "Comando desconhecido. Rode `colmeia help`.");
    return;
  }

  switch (command) {
    case "debug":
      return debug();
    case "list":
      return call("/list", {});
    case "whoami":
      return call("/whoami", {});
    case "context":
      return call("/context", {});
    case "check":
      needs(a[0], "check");
      return call("/check", { agent: a[0], bytes: flags.bytes ? Number(flags.bytes) : undefined });
    case "wait": {
      needs(a[0], "wait");
      // O 2º argumento antigo (segundos de silêncio) é ignorado: o fim do turno
      // agora vem do estado do agente. Só `--timeout` muda a espera máxima.
      const timeout = flags.timeout;
      return call("/wait", { agent: a[0], timeout: timeout ? Number(timeout) : undefined });
    }
    case "ask": {
      const timeout = flags.timeout ? Number(flags.timeout) : undefined;
      if (flags.batch !== undefined) {
        const raw = flags.batch === "-" || flags.batch === true ? readStdin() : String(flags.batch);
        let map;
        try {
          map = JSON.parse(raw);
        } catch {
          fail("--batch espera um JSON {\"Agente\": \"prompt\", …}.");
        }
        if (!map || typeof map !== "object" || Array.isArray(map)) fail("--batch espera um objeto JSON {\"Agente\": \"prompt\"}.");
        const batch = Object.entries(map).map(([agent, prompt]) => ({ agent, prompt: String(prompt) }));
        return call("/ask", { batch, timeout });
      }
      needs(a[0], "ask");
      const prompt = textArg(a[1], flags);
      needs(prompt, "ask");
      return call("/ask", {
        agent: a[0],
        prompt,
        raw: !!flags.raw,
        wait: !flags["no-wait"],
        timeout,
      });
    }
    case "note": {
      const sub = a[0];
      if (sub === "list") return call("/note", { action: "list" });
      if (sub === "read") {
        needs(a[1], "note");
        return call("/note", {
          action: "read",
          name: a[1],
          offset: a[2] ? Number(a[2]) : undefined,
          limit: a[3] ? Number(a[3]) : undefined,
        });
      }
      if (sub === "write") {
        needs(a[1], "note");
        const content = textArg(a[2], flags);
        needs(content !== undefined, "note");
        return call("/note", { action: "write", name: a[1], content });
      }
      if (sub === "edit") {
        needs(a[1] && a[2] !== undefined && a[3] !== undefined, "note");
        return call("/note", { action: "edit", name: a[1], old: a[2], new: a[3] });
      }
      if (sub === "create") {
        needs(a[1], "note");
        const content = textArg(a[2] || "", flags) || "";
        return call("/note", { action: "create", title: a[1], content, target: flags.to || "" });
      }
      // Forma antiga: note "<título>" "<texto>" ["<destino>"]
      needs(sub, "note");
      return call("/note", { action: "create", title: sub, content: a[1] || "", target: flags.to || a[2] || "" });
    }
    case "notify": {
      needs(a[0], "notify");
      const [title, body] = a.length >= 2 ? [a[0], a[1]] : ["", a[0]];
      return call("/notify", { title, body });
    }
    case "status":
      needs(a[0], "status");
      return call("/status", { state: a[0], text: a[1] || "" });
    case "recruit": {
      const replace = typeof flags.replace === "string" ? flags.replace : "";
      needs(a[0] || replace, "recruit");
      // Compat: `recruit "<nome>" "<papel>"` (papel posicional).
      const role = typeof flags.role === "string" ? flags.role : a[1] || "";
      return call("/recruit", {
        name: a[0] || "",
        agent: typeof flags.agent === "string" ? flags.agent : "",
        role,
        dir: typeof flags.dir === "string" ? flags.dir : "",
        replace,
      });
    }
    case "dismiss":
      needs(a[0], "dismiss");
      return call("/dismiss", { title: a[0] });
    case "connect":
      needs(a[0] && a[1], "connect");
      return call("/connect", { source: a[0], target: a[1] });
    case "preset":
      return call("/preset", { action: a[0] || "list" });
    case "role": {
      const sub = a[0] || "list";
      if (sub === "list") return call("/role", { action: "list" });
      if (sub === "show") {
        needs(a[1], "role");
        return call("/role", { action: "show", name: a[1] });
      }
      if (sub === "create" || sub === "write") {
        needs(a[1], "role");
        const prompt = textArg(a[2], flags);
        needs(prompt, "role");
        return call("/role", { action: sub, name: a[1], prompt });
      }
      if (sub === "edit") {
        needs(a[1] && a[2] !== undefined && a[3] !== undefined, "role");
        return call("/role", { action: "edit", name: a[1], old: a[2], new: a[3] });
      }
      if (sub === "assign") {
        needs(a[1] && (a[2] || flags.none), "role");
        return call("/role", { action: "assign", agent: a[1], name: a[2] || "", none: !!flags.none });
      }
      return fail(`uso:\n${HELP.role}`);
    }
    case "routine": {
      const sub = a[0] || "list";
      const known = ["create", "list", "show", "delete", "enable", "disable", "run", "edit"];
      if (!known.includes(sub)) return fail(`uso:\n${HELP.routine}`);
      const body = { ...camelFlags(flags), action: sub };
      if (a[1]) body.name = a[1];
      if (sub === "create") needs(body.name && body.command, "routine");
      if (sub === "edit" && typeof flags.name === "string") {
        // `--name` no edit é o NOVO nome; o posicional identifica a rotina.
        body.newName = flags.name;
        body.name = a[1];
      }
      if (["show", "delete", "enable", "disable", "run", "edit"].includes(sub)) {
        needs(body.name || body.id, "routine");
      }
      return call("/routine", body);
    }
    case "floor": {
      const sub = a[0] || "list";
      const known = ["list", "create", "status", "land", "delete"];
      if (!known.includes(sub)) return fail(`uso:\n${HELP.floor}`);
      const body = { ...camelFlags(flags), action: sub };
      if (sub === "status") {
        if (a[1]) body.text = a[1];
      } else if (a[1]) {
        body.name = a[1];
      }
      if (["create", "land", "delete"].includes(sub)) needs(body.name, "floor");
      return call("/floor", body);
    }
    case "partitura": {
      const sub = a[0] || "list";
      if (sub === "list") return call("/partitura", { action: "list" });
      if (sub === "insert") {
        needs(a[1], "partitura");
        return call("/partitura", { action: "insert", name: a[1] });
      }
      return fail(`uso:\n${HELP.partitura}`);
    }
    case "portal": {
      const sub = a[0] || "list";
      const body = { action: sub, portal: typeof flags.portal === "string" ? flags.portal : "" };
      // Ações sem outro argumento aceitam o nome do portal como posicional.
      const portalPos = () => {
        if (!body.portal && a[1]) body.portal = a[1];
      };
      switch (sub) {
        case "list":
          break;
        case "open":
          needs(a[1], "portal");
          body.url = a[1];
          break;
        case "snapshot":
          portalPos();
          if (flags.chars) body.chars = Number(flags.chars);
          break;
        case "click":
          needs(a[1], "portal");
          body.target = a[1];
          break;
        case "fill":
          needs(a[1] && (a[2] !== undefined || typeof flags.file === "string"), "portal");
          body.target = a[1];
          body.text = textArg(a[2], flags) ?? "";
          break;
        case "type": {
          const text = textArg(a[1], flags);
          needs(text, "portal");
          body.text = text;
          break;
        }
        case "press":
          needs(a[1], "portal");
          body.key = a[1];
          break;
        case "scroll":
          body.target = a[1] || "down";
          if (flags.px) body.px = Number(flags.px);
          break;
        case "back":
        case "forward":
        case "reload":
          portalPos();
          break;
        case "screenshot":
          portalPos();
          body.full = !!flags.full;
          body.png = !!flags.png;
          break;
        case "wait":
          if (typeof flags.selector === "string") {
            body.target = flags.selector;
            body.selector = true;
          } else {
            needs(a[1], "portal");
            body.target = a[1];
          }
          if (flags.timeout) body.timeout = Number(flags.timeout);
          body.gone = !!flags.gone;
          break;
        case "eval": {
          const code = textArg(a[1], flags);
          needs(code, "portal");
          body.code = code;
          break;
        }
        default:
          return fail(`uso:\n${HELP.portal}`);
      }
      return call("/portal", body);
    }
    // Atalhos antigos (agora sobre o portal CDP).
    case "browse":
      needs(a[0], "browse");
      return call("/browse", { url: a[0], portal: typeof flags.portal === "string" ? flags.portal : "" });
    case "click":
      needs(a[0], "browse");
      return call("/click", { selector: a[0], portal: typeof flags.portal === "string" ? flags.portal : "" });
    case "type":
      needs(a[0], "browse");
      return call("/type", {
        selector: a[0],
        text: a[1] || "",
        portal: typeof flags.portal === "string" ? flags.portal : "",
      });
    default:
      fail(`comando desconhecido: ${command}. Rode \`colmeia help\`.`);
  }
}

main();
