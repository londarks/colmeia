---
name: colmeia-navegador
description: Portal do colmeia — um navegador de verdade (Chromium) num nó do canvas ligado a você, que você controla pela CLI. Use quando pedirem para abrir/visitar uma URL, testar uma interface web (inclusive um servidor local), conferir como uma página renderiza, ler a documentação de um site, clicar em botões ou preencher formulários.
---

# colmeia: portal (navegador no canvas)

O portal é um Chromium headless de verdade, com perfil próprio (isolado do navegador do usuário),
mostrado ao vivo num nó do canvas. O usuário vê tudo o que você faz e pode clicar/digitar no quadro
também. Você só alcança portais **ligados a você por aresta**.

## O ciclo: olhar → agir por ref → olhar de novo

```
colmeia portal open "https://exemplo.com"   # abre (ou reaproveita) o portal ligado a você
colmeia portal snapshot                     # elementos interativos com refs @eN + texto da página
colmeia portal click @e4                    # age pelo ref
colmeia portal snapshot                     # a página mudou: refs novos
```

O `snapshot` é a sua visão da página. Ele traz título, URL, viewport e posição de rolagem, uma linha
por elemento interativo visível e o texto legível:

```
@e3 link "Preços" → /pricing
@e7 input[email] "E-mail" = ""
@e8 input[password] "Senha" (senha)
@e9 button "Entrar"
@e12 checkbox "Lembrar de mim" [ ]
@e15 select "País" = "Brasil" opções="Brasil | Portugal | …"
@e21 button "Carregar mais" ↓        (↓/↑ = fora da área visível; role ou clique direto)
```

- Os refs valem enquanto a página (o documento) for a mesma; depois de navegar, rode `snapshot` de novo.
  Se um ref sumir, o comando avisa — não chute, tire outro snapshot.
- Leia o snapshot em vez de pedir screenshot para "ver" texto. `--chars N` aumenta o texto (padrão 4000).

## Agir

```
colmeia portal click @eN | x,y              # clique nativo (mouse de verdade) no centro do elemento
colmeia portal fill @eN "texto"             # foca, limpa e digita; num <select>, escolhe a opção
colmeia portal type "texto"                 # digita no campo que já está com foco
colmeia portal press Enter                  # Tab, Escape, Backspace, ArrowDown, Ctrl+A, Shift+Tab…
colmeia portal scroll down|up|top|bottom|@eN [--px N]
colmeia portal back | forward | reload
colmeia portal wait "texto" | @eN | --selector "<css>" [--timeout s] [--gone]
```

- Prefira `fill` a `click` + `type` para campos. Depois de enviar um formulário, `wait` pelo texto que
  deve aparecer (ou `--gone` pelo spinner que deve sumir) antes do próximo `snapshot`.
- Se a resposta começar com `aviso:` (ex.: havia outro elemento por cima do alvo, o campo mostra um
  valor diferente do que você digitou), confira com `snapshot` antes de seguir.
- Com mais de um portal ligado a você, diga qual: `--portal "<nome>"`. `colmeia portal list` mostra os seus.

## Ver o visual

```
colmeia portal screenshot [--full] [--png]
```

Salva a imagem num arquivo temporário e devolve o caminho — abra-o com a sua ferramenta de ler
imagens. Use para checar layout, cores, sobreposição, estados visuais; não para ler texto.
`--full` captura a página inteira (até ~12 mil px de altura).

## Atalhos antigos

`colmeia browse "<url>"` = `portal open` + `snapshot`. `colmeia click "<@eN|seletor CSS>"` e
`colmeia type "<@eN|seletor CSS>" "<texto>"` continuam funcionando no portal ligado a você.

## Limites (seja honesto com o usuário)

- **Senhas:** o portal recusa preencher campos de senha. Não tente contornar (digitar com `type` num
  campo de senha também é recusado). Peça ao usuário para digitar ele mesmo no quadro do portal — e
  nunca digite tokens ou dados de pagamento, mesmo que peçam.
- **Uma aba só:** links que abririam outra aba abrem na mesma. Popups de login (OAuth em janela
  separada) ainda não funcionam.
- **Diálogos** (`alert`/`confirm`/`prompt`) são aceitos sozinhos; o próximo `snapshot` diz o que apareceu.
- **Iframes de outra origem** (anúncios, alguns widgets de pagamento/captcha) não aparecem no
  snapshot; use `screenshot` e, se precisar, clique por coordenada `x,y` (px da página, do canto
  superior esquerdo do viewport).
- **Captcha e verificações anti-robô:** pare e peça ao usuário.
- `colmeia portal eval "<js>"` (rodar JavaScript na página) é só para o orquestrador.
- Para testar um servidor local, use `http://127.0.0.1:<porta>` (num floor, a faixa começa em
  `$COLMEIA_PORT_BASE`).
