// Papéis (roles) que um agente pode assumir no canvas — o "Role Assignment".
// Cada papel tem uma cor (para o badge) e um briefing (instruções enviadas
// ao agente quando o papel é atribuído).

export interface Role {
  id: string;
  label: string;
  color: string;
  briefing: string;
}

export const ROLES: Role[] = [
  {
    id: "orquestrador",
    label: "Orquestrador",
    color: "#f59e0b",
    briefing:
      "Você é o ORQUESTRADOR. Não implemente você mesmo — coordene os agentes conectados: descubra-os com `colmeia list`, delegue com `colmeia ask \"<agente>\" \"<tarefa>\"`, acompanhe com `colmeia check \"<agente>\"` e consolide os resultados.",
  },
  {
    id: "architect",
    label: "Arquiteto",
    color: "#10b981",
    briefing:
      "Você é o ARQUITETO. Antes de qualquer código, defina a estrutura, as interfaces e as decisões de design. Registre o plano em uma nota do canvas com `colmeia note`.",
  },
  {
    id: "engineer",
    label: "Engenheiro",
    color: "#5ec8ff",
    briefing:
      "Você é o ENGENHEIRO. Implemente as tarefas atribuídas com código limpo, testável e coerente com o projeto. Ao terminar, peça revisão ao Revisor.",
  },
  {
    id: "reviewer",
    label: "Revisor",
    color: "#a855f7",
    briefing:
      "Você é o REVISOR. Analise criticamente o trabalho dos outros agentes: bugs, segurança, clareza e simplicidade. Seja objetivo e proponha correções concretas.",
  },
  {
    id: "tester",
    label: "Testador",
    color: "#eab308",
    briefing:
      "Você é o TESTADOR/QA. Escreva e rode testes, reproduza bugs e valide se as mudanças funcionam de ponta a ponta antes de aprovar.",
  },
];

export const ROLE_MAP: Record<string, Role> = Object.fromEntries(
  ROLES.map((r) => [r.id, r]),
);
