"use client";
import { useState, useEffect } from "react";

const statusOptions = ["open", "received", "analyzing", "repairing", "waiting_part", "waiting_client", "completed", "cancelled"];
const statusLabels: Record<string, string> = { open: "Aberto", received: "Recebido", analyzing: "Em análise", repairing: "Em reparação", waiting_part: "A aguardar peça", waiting_client: "A aguardar cliente", completed: "Concluído", cancelled: "Cancelado" };

export default function AdminRmaPage() {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/admin/rma").then(r => r.json()).then(d => setItems(d.rmaRequests || []));
  }, []);

  const updateStatus = async (id: number, status: string) => {
    await fetch("/api/admin/rma", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }) });
    setItems(items.map(i => i.id === id ? { ...i, status } : i));
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-800 mb-6">RMA / Assistência</h2>
      <div className="space-y-3">
        {items.length === 0 ? <p className="text-slate-500">Sem pedidos RMA.</p> : items.map(r => (
          <div key={r.id} className="bg-white border rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="font-bold text-slate-800">RMA #{r.id}</span>
                <span className="text-xs text-slate-400 ml-3">{r.type}</span>
              </div>
              <select value={r.status} onChange={e => updateStatus(r.id, e.target.value)}
                className="text-xs font-medium rounded px-2 py-1 border bg-slate-50">
                {statusOptions.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}
              </select>
            </div>
            <p className="text-sm text-slate-600 mb-2">{r.description}</p>
            <div className="text-xs text-slate-400">
              {r.userName && <span>Cliente: {r.userName} ({r.userEmail})</span>}
              <span className="ml-3">{new Date(r.createdAt).toLocaleDateString("pt-PT")}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
