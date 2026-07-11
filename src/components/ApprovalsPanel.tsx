import { Check, X, ShieldAlert } from "lucide-react";
import { approvalResolve, type ApprovalRequest } from "../lib/pty";

interface Props {
  approvals: ApprovalRequest[];
  onResolved: (id: string) => void;
}

export function ApprovalsPanel({ approvals, onResolved }: Props) {
  if (approvals.length === 0) return null;

  const decide = (id: string, allow: boolean) => {
    approvalResolve(id, allow).catch(() => {});
    onResolved(id);
  };

  return (
    <div className="approvals">
      <div className="approvals-header">
        <ShieldAlert size={15} strokeWidth={2} />
        <b>Aprovações pendentes</b>
        <span className="approvals-count">{approvals.length}</span>
      </div>
      <div className="approvals-list">
        {approvals.map((a) => (
          <div key={a.id} className="approval-card">
            <div className="approval-meta">
              <span className="approval-agent">{a.title}</span>
              <span className="approval-tool">{a.tool}</span>
            </div>
            <code className="approval-summary" title={a.summary}>
              {a.summary || "(sem detalhes)"}
            </code>
            <div className="approval-actions">
              <button
                className="approve-btn deny"
                onClick={() => decide(a.id, false)}
              >
                <X size={14} strokeWidth={2.2} /> Recusar
              </button>
              <button
                className="approve-btn allow"
                onClick={() => decide(a.id, true)}
              >
                <Check size={14} strokeWidth={2.2} /> Aprovar
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
