---
name: colmeia-floors
description: Trabalho isolado em floors do colmeia — cópias do repositório (git worktree) numa branch própria, para experimentos arriscados ou vários agentes mexendo no mesmo projeto em paralelo sem se atropelar. Use quando o usuário pedir algo isolado/experimental, quando for dividir trabalho de código entre recrutas, ao publicar o andamento de um floor, ou para trazer (land) ou apagar um floor.
---

# colmeia: floors (trabalho isolado)

Um **floor** é uma cópia de trabalho do repositório (um `git worktree`) numa branch `floor/<nome>`,
numa pasta separada ao lado do projeto. O "ground" é o checkout original do usuário. Quem trabalha
num floor não toca no ground; quando o trabalho fica pronto, o floor é **aterrissado** (land): a
branch volta por merge.

O floor já nasce pronto para rodar: `.env*` e dependências (`node_modules`, `.venv`…) são trazidos do
ground, e o terminal recebe variáveis próprias:

- `COLMEIA_FLOOR` / `COLMEIA_BRANCH` — onde você está.
- `COLMEIA_PORT_BASE` — início de uma faixa de 100 portas só deste floor. **Suba servidores de dev
  nessa faixa** (ex.: `PORT=$COLMEIA_PORT_BASE`), para dois floors não brigarem pela mesma porta.
  Bind sempre em `127.0.0.1`.
- `COMPOSE_PROJECT_NAME` — distinto por floor, para containers não colidirem.

## Quando usar

- O usuário pediu algo experimental, arriscado ou "sem mexer no que está funcionando".
- Dois ou mais recrutas vão editar o mesmo repositório ao mesmo tempo: um floor por recruta.
- Não use para uma mudança pequena e sequencial — o ground basta.

## Comandos

```
colmeia floor list
colmeia floor create "<nome>" [--branch <branch>] [--existing-branch] [--deps copy|link|skip]
colmeia floor status ["<texto>"] [--state working|blocked|review|done] [--clear]
colmeia floor land "<nome>" [--into <branch>] [--delete-branch] [--keep-floor]
colmeia floor delete "<nome>" [--keep-branch]
```

- `create`, `land` e `delete` são do orquestrador e rodam **do ground** (um agente dentro de um floor
  não aterrissa nem apaga floors).
- `--deps link` compartilha `node_modules` com o ground em vez de copiar — mais rápido, mas instalar
  pacotes no floor muda o ground também. O padrão (`copy`) é o seguro.

## Fluxo com recrutas

1. Do ground: `colmeia floor create "busca-nova" --branch feat/busca-nova`.
2. Recrute apontando para a pasta do floor (a resposta do `create` mostra o caminho):
   `colmeia recruit "<codinome>" --role "Engenheiro" --dir "<pasta do floor>"`.
3. Na tarefa, peça ao recruta para manter o status do floor em dia e responder com ask-back:
   - `colmeia floor status "lendo o código" --state working` no início e a cada etapa;
   - `--state blocked` quando precisar do usuário (isso notifica o usuário);
   - `--state review` com commit feito, quando estiver pronto para revisão.
4. Acompanhe pelo `colmeia floor list` (mostra o status de todos) em vez de checar cada recruta.
5. Pronto e revisado: `colmeia floor land "busca-nova"`.

## Aterrissar (land) — o que esperar

O land **recusa** se o floor tiver mudanças não commitadas ou uma operação git em andamento, ou se o
ground tiver mudanças em arquivos rastreados. Antes do merge ele mostra uma prévia: commits à frente,
arquivos e **conflitos**. Com conflito, nada é alterado — resolva no floor (rebase/merge da branch de
destino lá dentro, commit) e tente de novo. Não force.

## Apagar — nunca perca trabalho

`delete` recusa se houver mudanças não commitadas ou commits que só existem na branch do floor, e
lista o que seria perdido. **Não contorne isso.** Mostre a lista ao usuário e deixe que ele decida
(no painel de Floors ele pode confirmar a exclusão). Preferir `land` a `delete` quando há trabalho útil.
