---
name: colmeia-rotinas
description: Rotinas agendadas do colmeia — mandar um comando ou prompt a um terminal num horário ou intervalo (uma vez, a cada N minutos, todo dia, em dias da semana) e lembretes que só notificam o usuário. Use quando pedirem para agendar, repetir, lembrar, checar periodicamente, rodar algo toda manhã, ou para listar, editar, pausar ou remover rotinas.
---

# colmeia: rotinas agendadas

Uma rotina entrega um texto (comando de shell ou prompt para um agente) a um terminal do canvas
numa agenda, ou só dispara uma notificação (lembrete). Rotinas ficam salvas: sobrevivem a reiniciar
o app, e disparos perdidos com o app fechado viram **um** disparo ao abrir (não uma rajada).

## Criar

```
colmeia routine create "<nome>" --command "<texto>" <agenda> [--terminal "<agente>" | --reminder]
                       [--no-skip-if-busy] [--notify] [--count N] [--disabled]
```

Agenda (uma delas):

| Flag | Exemplo | Significado |
|---|---|---|
| `--every` | `--every 30m`, `--every 1h30m` | a cada intervalo |
| `--daily` | `--daily 09:00` | todo dia, horário local |
| `--weekly` | `--weekly mon,fri@09:00`, `--weekly seg-sex@18:30` | dias da semana |
| `--once` | `--once "2026-06-20 15:00"`, `--once 15:00`, `--once +45m` | uma vez |

- **Alvo:** sem `--terminal` e sem `--reminder`, o alvo é **você mesmo** — útil para "me lembre de
  rodar os testes a cada hora". Agendar para outro terminal é coisa do orquestrador.
- **`--reminder`:** sem alvo; só notifica o usuário com o texto.
- **Ocupado:** por padrão, se o alvo estiver trabalhando ou esperando aprovação, a rotina **espera**
  (até alguns minutos) e, se continuar ocupado, pula esse disparo — nunca digita por cima de um agente
  no meio de um turno. `--no-skip-if-busy` só para comandos que podem mesmo interromper.
- **`--count N`:** para depois de N disparos. **`--notify`:** também notifica o usuário a cada disparo.

Escreva o `--command` como se você o estivesse digitando no terminal alvo: um prompt completo e
autocontido para um agente (ele não lembra da conversa em que a rotina foi criada), ou um comando de
shell exato.

## Gerenciar

```
colmeia routine list
colmeia routine show "<nome>"
colmeia routine run "<nome>"            # dispara agora
colmeia routine disable|enable "<nome>"
colmeia routine edit "<nome>" [--name "<novo>"] [--command "…"] [agenda] [--terminal X | --reminder]
colmeia routine delete "<nome>"
```

Nomes repetidos: a resposta lista os ids — use `--id <prefixo>`. Mudar a agenda zera os contadores;
religar uma rotina não dispara o que ela perdeu enquanto estava desligada.

## Boas práticas

- Confirme com o usuário antes de criar rotinas frequentes que gastam modelo (ex.: um prompt a cada
  5 minutos) — cada disparo é uma sessão de trabalho de um agente.
- Para "me avise quando X acontecer", prefira uma rotina que checa e só age se precisar, e
  `colmeia notify` dentro do prompt, em vez de notificar sempre.
- Ao terminar um trabalho temporário, remova as rotinas que você criou para ele.
