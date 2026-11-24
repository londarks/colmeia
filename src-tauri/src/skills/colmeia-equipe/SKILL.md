---
name: colmeia-equipe
description: Montar e coordenar uma equipe de agentes no canvas do colmeia — recrutar com codinome e papel, criar e ajustar papéis, conectar recrutas, trocar o agente de um nó e dispensar. Use quando você for o orquestrador (ou o usuário pedir para montar uma equipe, dividir trabalho em paralelo, chamar mais agentes, revisar com outro agente) e sempre antes de `colmeia recruit`.
---

# colmeia: montar e coordenar a equipe

Este é o manual de quem coordena. A comunicação do dia a dia (`ask`, `check`, notas) está na skill
`colmeia`. Os comandos estruturais abaixo (`recruit`, `dismiss`, `role create/edit/write/assign`,
`partitura insert`, `floor create/land/delete`, rotinas para outros terminais, `connect` fora do seu
alcance direto) só funcionam se o seu nó estiver em
**modo Maestro** ou com o papel **Orquestrador**. Se o colmeia recusar, peça ao usuário para ligar
o Maestro no seu nó — não tente contornar.

## Antes de recrutar: veja quem já existe

```
colmeia list
```

Se alguém conectado já cobre a função, delegue a ele com `colmeia ask`. Cada recruta é um terminal
e uma sessão de modelo de verdade, pagos pelo usuário. Recrutar uma segunda cópia de alguém que você
já tem é o erro mais comum. Recrute só quando nenhuma pessoa da equipe cobre o trabalho **e** ele
pede uma perspectiva própria (por exemplo, um revisor que não foi quem implementou).

### Um time pronto pode já existir

```
colmeia partitura list
colmeia partitura insert "<nome>"
```

Partituras são times que o usuário salvou (agentes com papel, notas e linhas). Se uma delas encaixa
no trabalho, insira-a em vez de recrutar o mesmo time à mão: ela entra ligada a você, na sua pasta,
e a resposta traz os nomes exatos para o `ask`. Os agentes levam alguns segundos para subir.

## Recrutar

```
colmeia recruit "<codinome>" --role "<papel>" [--agent claude|codex|ollama|shell] [--dir "<pasta>"]
```

- **Codinome:** invente um nome curto e próprio para cada recruta — que sugira o jeito dele de
  trabalhar — em vez do nome do papel ou de uma lista fixa. O papel diz o que ele faz; o nome é a
  identidade com que você vai falar com ele. Nomes repetidos no canvas são recusados.
- **--role:** um papel existente (`colmeia role list`). O papel entra uma vez no contexto do recruta,
  na inicialização — você não precisa repeti-lo a cada pedido.
- **--agent:** qual CLI roda no nó (`colmeia preset list`). Sem a flag, o recruta é do mesmo tipo que você.
- **--dir:** outra pasta de trabalho. Sem a flag, ele herda a sua.

O recruta nasce ligado a você (topologia em estrela). Ele leva alguns segundos para subir; o
primeiro `ask` espera o boot sozinho.

### Trocar o agente ou o papel de um nó sem perder as conexões

```
colmeia recruit ["<novo nome>"] --replace "<nome atual>" [--agent codex] [--role "<papel>"] [--dir "<pasta>"]
colmeia role assign "<agente>" "<papel>"        # só troca o papel
colmeia role assign "<agente>" --none           # volta a ser um agente sem papel
```

O nó, a posição e as linhas continuam; o processo reinicia e a conversa anterior se perde —
mande um `ask` com o contexto depois.

### Dispensar

`colmeia dismiss "<nome>"` encerra o processo e remove o nó (só de quem está ligado a você). Notas
ligadas só a ele ficam soltas. Para trocar de agente, prefira `--replace`.

## Papéis

- `colmeia role list` / `colmeia role show "<papel>"` — os papéis disponíveis e o prompt completo.
- `colmeia role create "<nome>" "<prompt>"` (ou `--file papel.md`) — cria um papel.
- `colmeia role edit "<papel>" "<trecho antigo>" "<trecho novo>"` — troca um trecho do prompt.
- `colmeia role write "<papel>" "<prompt completo>"` — reescreve.

Mudanças de prompt valem para quem for iniciado depois; para aplicar num recruta existente, use
`role assign` de novo (reinicia o processo).

Ao escrever o prompt de um papel, diga ao recruta **com quem ele trabalha**: os codinomes dos colegas
com quem deve falar (`colmeia ask "<colega>" "…"`), quais notas ler e onde registrar progresso, e para
responder a você com `colmeia ask "<seu nome>" "<resultado>"`. Um recruta não descobre a equipe sozinho
além do que o `colmeia list` mostra.

## Ligar recrutas entre si

```
colmeia connect "<A>" "<B>"
```

Sem isso, recrutas só falam com você. Os dois lados precisam estar na sua árvore (você, seus
recrutas diretos e o que está ligado a eles). Conectar não basta: avise cada um de que pode falar com
o outro e quando (ou coloque isso no papel). Para compartilhar contexto, ligue uma nota a vários
agentes, ou crie com `colmeia note create "<título>" "<texto>" --to "<agente>"`.

## Delegar bem

1. Uma tarefa por pedido, com: o objetivo, onde mexer, o critério de pronto e restrições ("não toque em X").
2. Termine **sempre** com a linha de ask-back:
   `Quando terminar, responda com colmeia ask "<seu nome>" "<resultado>".`
   Seu nome está em `Você:` no `colmeia list`.
3. Trabalho independente em paralelo:
   `colmeia ask --batch '{"Ana":"…","Rui":"…"}'` — volta quando todos terminarem (ou quando cada um
   responder por ask-back). Ajuste o timeout da sua ferramenta de shell ao mais lento.
4. Trabalho dependente em sequência: espere o resultado de um antes de mandar o próximo.
5. Se um ask estourar o tempo, não reenvie: `colmeia check "<nome>"` e espere.
6. Peça verificação proporcional ao risco: revisão por outro agente, testes rodados, evidência.
7. Publique o andamento com `colmeia status working "<etapa>"` e feche com `colmeia status done "<resumo>"`.

## Fluxo típico

1. `colmeia context` e `colmeia list` — objetivo e equipe atual.
2. Planeje as lacunas. Veja `colmeia partitura list` (um time pronto?) e só então `colmeia role list`
   e, se faltar papel, `colmeia role create`. Trabalho arriscado ou paralelo no mesmo repo: um floor
   por recruta (skill `colmeia-floors`).
3. `colmeia recruit` para cada lacuna, com codinome e `--role`.
4. Contexto comum numa nota; `colmeia connect` onde a colaboração direta ajudar.
5. Delegue (com ask-back), em paralelo quando der.
6. Junte os resultados, peça revisão/teste, e entregue ao usuário um resumo do que foi feito, por quem, e o que ficou pendente.
