"use client";
import { useState, useEffect } from "react";

export default function AdminCustomersPage() {
  const [customers, setCustomers] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/admin/customers").then(r => r.json()).then(d => setCustomers(d.customers || []));
  }, []);

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-800 mb-6">Clientes</h2>
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="text-left p-3 font-medium text-slate-600">Nome</th>
              <th className="text-left p-3 font-medium text-slate-600">Email</th>
              <th className="text-left p-3 font-medium text-slate-600 hidden md:table-cell">Telefone</th>
              <th className="text-left p-3 font-medium text-slate-600 hidden md:table-cell">NIF</th>
              <th className="text-left p-3 font-medium text-slate-600 hidden lg:table-cell">Registo</th>
            </tr>
          </thead>
          <tbody>
            {customers.map(c => (
              <tr key={c.id} className="border-t hover:bg-slate-50">
                <td className="p-3 font-medium text-slate-800">{c.name}</td>
                <td className="p-3 text-slate-600">{c.email}</td>
                <td className="p-3 text-slate-500 hidden md:table-cell">{c.phone || "—"}</td>
                <td className="p-3 text-slate-500 hidden md:table-cell">{c.nif || "—"}</td>
                <td className="p-3 text-slate-500 hidden lg:table-cell">{new Date(c.createdAt).toLocaleDateString("pt-PT")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
