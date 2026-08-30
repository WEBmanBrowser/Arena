"use client";
import { useState, useEffect } from "react";

const componentTypes = [
  { key: "cpu", label: "Processador", icon: "🔲", category: "processadores" },
  { key: "motherboard", label: "Motherboard", icon: "🟩", category: "motherboards" },
  { key: "ram", label: "Memória RAM", icon: "📏", category: "memoria-ram" },
  { key: "gpu", label: "Placa Gráfica", icon: "🎮", category: "placas-graficas" },
  { key: "ssd", label: "SSD", icon: "💾", category: "ssd" },
  { key: "psu", label: "Fonte de Alimentação", icon: "⚡", category: "fontes-alimentacao" },
  { key: "case", label: "Caixa", icon: "🖥️", category: "caixas-pc" },
  { key: "cooling", label: "Cooling", icon: "❄️", category: "cooling" },
];

export default function ConfiguradorPage() {
  const [config, setConfig] = useState<Record<string, any>>({});
  const [products, setProducts] = useState<Record<string, any[]>>({});
  const [selecting, setSelecting] = useState<string | null>(null);

  useEffect(() => {
    for (const ct of componentTypes) {
      fetch(`/api/products?cat=${ct.category}&limit=50`).then(r => r.json()).then(d => {
        setProducts(p => ({ ...p, [ct.key]: d.products || [] }));
      });
    }
  }, []);

  const totalPrice = Object.values(config).reduce((acc: number, p: any) => acc + (p ? parseFloat(p.price) : 0), 0);
  const selectedCount = Object.values(config).filter(Boolean).length;

  const checkCompatibility = () => {
    const warnings: string[] = [];
    const cpu = config.cpu;
    const mb = config.motherboard;
    if (cpu && mb) {
      const cpuSocket = cpu.attributes?.socket;
      const mbSocket = mb.attributes?.socket;
      if (cpuSocket && mbSocket && cpuSocket !== mbSocket) {
        warnings.push(`Socket incompatível: CPU ${cpuSocket} ≠ Motherboard ${mbSocket}`);
      }
    }
    if (mb && config.ram) {
      const mbMem = mb.attributes?.memoryType;
      const ramType = config.ram.attributes?.type;
      if (mbMem && ramType && mbMem !== ramType) {
        warnings.push(`Memória incompatível: Motherboard suporta ${mbMem}, RAM selecionada é ${ramType}`);
      }
    }
    return warnings;
  };

  const warnings = checkCompatibility();

  const addAllToCart = () => {
    const stored = localStorage.getItem("mdtech_cart");
    const cart = stored ? JSON.parse(stored) : [];
    for (const item of Object.values(config)) {
      if (!item) continue;
      const existing = cart.find((c: any) => c.productId === item.id);
      if (existing) { existing.quantity += 1; }
      else { cart.push({ productId: item.id, name: item.name, slug: item.slug, price: parseFloat(item.price), quantity: 1 }); }
    }
    localStorage.setItem("mdtech_cart", JSON.stringify(cart));
    window.dispatchEvent(new Event("cart-updated"));
    alert("Configuração adicionada ao carrinho!");
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-slate-800 mb-2">🖥️ Configurador de PC</h1>
      <p className="text-slate-500 text-sm mb-6">Seleciona cada componente e monta o teu PC personalizado com verificação de compatibilidade.</p>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-3">
          {componentTypes.map(ct => {
            const selected = config[ct.key];
            return (
              <div key={ct.key} className={`bg-white border rounded-xl p-4 transition ${selected ? "border-sky-200" : ""}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{ct.icon}</span>
                    <div>
                      <p className="font-medium text-sm text-slate-800">{ct.label}</p>
                      {selected ? (
                        <p className="text-xs text-sky-600">{selected.name} — {parseFloat(selected.price).toFixed(2)}€</p>
                      ) : (
                        <p className="text-xs text-slate-400">Não selecionado</p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setSelecting(selecting === ct.key ? null : ct.key)}
                      className="px-3 py-1.5 text-xs border rounded-lg text-sky-600 hover:bg-sky-50 transition">
                      {selected ? "Alterar" : "Selecionar"}
                    </button>
                    {selected && (
                      <button onClick={() => setConfig(c => ({ ...c, [ct.key]: null }))}
                        className="px-2 py-1.5 text-xs text-red-500 hover:bg-red-50 rounded-lg transition">✕</button>
                    )}
                  </div>
                </div>

                {selecting === ct.key && (
                  <div className="mt-4 border-t pt-4 space-y-2 max-h-60 overflow-y-auto animate-fade-in">
                    {(products[ct.key] || []).length === 0 ? (
                      <p className="text-xs text-slate-400">Sem produtos disponíveis nesta categoria.</p>
                    ) : (
                      (products[ct.key] || []).map((p: any) => (
                        <button key={p.id} onClick={() => { setConfig(c => ({ ...c, [ct.key]: p })); setSelecting(null); }}
                          className="w-full flex items-center justify-between p-3 rounded-lg border hover:border-sky-300 hover:bg-sky-50 transition text-left">
                          <div>
                            <p className="text-sm font-medium text-slate-800">{p.name}</p>
                            <p className="text-xs text-slate-500">{p.shortDescription}</p>
                          </div>
                          <span className="text-sm font-bold text-sky-600 whitespace-nowrap ml-4">{parseFloat(p.price).toFixed(2)}€</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="sticky top-24 h-fit space-y-4">
          <div className="bg-white border rounded-xl p-6">
            <h3 className="font-bold text-slate-800 mb-4">Resumo da Configuração</h3>
            <div className="space-y-2 mb-4">
              {componentTypes.map(ct => (
                <div key={ct.key} className="flex justify-between text-sm">
                  <span className="text-slate-500">{ct.icon} {ct.label}</span>
                  <span className={config[ct.key] ? "text-slate-800 font-medium" : "text-slate-300"}>
                    {config[ct.key] ? `${parseFloat(config[ct.key].price).toFixed(2)}€` : "—"}
                  </span>
                </div>
              ))}
            </div>
            <hr className="mb-3" />
            <div className="flex justify-between font-bold text-lg text-slate-900">
              <span>Total</span>
              <span>{totalPrice.toFixed(2)}€</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">{selectedCount} componente{selectedCount !== 1 ? "s" : ""} selecionado{selectedCount !== 1 ? "s" : ""}</p>
          </div>

          {warnings.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm font-semibold text-red-700 mb-2">⚠️ Incompatibilidades</p>
              {warnings.map((w, i) => (
                <p key={i} className="text-xs text-red-600">{w}</p>
              ))}
            </div>
          )}

          {warnings.length === 0 && selectedCount > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4">
              <p className="text-sm text-green-700 font-medium">✅ Configuração compatível</p>
            </div>
          )}

          {selectedCount > 0 && (
            <button onClick={addAllToCart} disabled={warnings.length > 0}
              className="w-full py-3 bg-lime-600 hover:bg-lime-700 disabled:bg-slate-300 text-white font-bold rounded-xl transition">
              Adicionar tudo ao Carrinho
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
