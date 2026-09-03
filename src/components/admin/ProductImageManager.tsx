"use client";
import { useState, useEffect, useCallback } from "react";

interface Img { id: number; storageKey: string; publicUrl: string | null; altText: string | null; sortOrder: number; isPrimary: boolean; mimeType: string | null; fileSize: number | null; }

/**
 * `onChanged` lets the parent list refresh immediately after a mutation:
 * uploading or deleting an image changes what the products table shows.
 */
export default function ProductImageManager({ productId, onChanged }: { productId: number; onChanged?: () => void | Promise<void> }) {
  const [images, setImages] = useState<Img[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState<Array<{ name: string; ok: boolean; error?: string }>>([]);
  const [editingAlt, setEditingAlt] = useState<number | null>(null);
  const [altValue, setAltValue] = useState("");

  const load = useCallback(() => {
    fetch(`/api/admin/products/${productId}/images`).then(r => r.json()).then(d => setImages(d.images || []));
  }, [productId]);

  useEffect(() => { if (productId) load(); }, [productId, load]);

  const upload = async (files: FileList) => {
    setUploading(true);
    const results: typeof uploadResults = [];
    for (const file of Array.from(files)) {
      const fd = new FormData(); fd.append("file", file);
      try {
        const res = await fetch(`/api/admin/products/${productId}/images`, { method: "POST", body: fd });
        const data = await res.json();
        results.push({ name: file.name, ok: res.ok, error: res.ok ? undefined : (data.error || data.message) });
      } catch { results.push({ name: file.name, ok: false, error: "Erro de rede" }); }
    }
    setUploadResults(results);
    setUploading(false);
    load();
    if (results.some(r => r.ok)) await onChanged?.();
  };

  const setPrimary = async (imageId: number) => {
    await fetch(`/api/admin/products/${productId}/images`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "setPrimary", imageId }) });
    load();
    await onChanged?.();
  };

  const saveAlt = async (imageId: number) => {
    await fetch(`/api/admin/products/${productId}/images`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "updateAlt", imageId, altText: altValue }) });
    setEditingAlt(null);
    load();
  };

  const moveImage = async (imageId: number, direction: number) => {
    const sorted = [...images].sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex(i => i.id === imageId);
    if ((direction < 0 && idx <= 0) || (direction > 0 && idx >= sorted.length - 1)) return;
    const items = sorted.map((img, i) => ({ imageId: img.id, sortOrder: i }));
    const swapIdx = idx + direction;
    [items[idx].sortOrder, items[swapIdx].sortOrder] = [items[swapIdx].sortOrder, items[idx].sortOrder];
    await fetch(`/api/admin/products/${productId}/images`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reorder", items }) });
    load();
  };

  const deleteImage = async (imageId: number, isPrimary: boolean) => {
    const msg = isPrimary ? "Esta é a imagem principal. Se a eliminar, a imagem seguinte será definida automaticamente como principal. Continuar?" : "Eliminar esta imagem?";
    if (!confirm(msg)) return;
    const res = await fetch(`/api/admin/products/${productId}/images`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageId }) });
    if (!res.ok) { const d = await res.json(); alert(d.error || d.message || "Erro"); }
    load();
    await onChanged?.();
  };

  if (!productId) return null;

  const sorted = [...images].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="border rounded-xl p-4 mt-4">
      <h4 className="font-medium text-slate-800 mb-3">Imagens do produto</h4>

      {/* Upload */}
      <div className="mb-4">
        <label className="inline-flex items-center gap-2 px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium cursor-pointer hover:bg-sky-700">
          {uploading ? "A enviar..." : "Adicionar imagens"}
          <input type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" disabled={uploading}
            onChange={e => e.target.files && upload(e.target.files)} />
        </label>
        <p className="text-xs text-slate-400 mt-1">JPEG, PNG ou WebP — máximo 5 MB por imagem</p>
      </div>

      {/* Upload results */}
      {uploadResults.length > 0 && (
        <div className="mb-3 space-y-1">
          {uploadResults.map((r, i) => (
            <p key={i} className={`text-xs ${r.ok ? "text-green-600" : "text-red-500"}`}>
              {r.ok ? "✓" : "✕"} {r.name} {r.error ? `— ${r.error}` : ""}
            </p>
          ))}
          <button onClick={() => setUploadResults([])} className="text-xs text-slate-400 underline">Limpar</button>
        </div>
      )}

      {/* Gallery */}
      {sorted.length === 0 ? (
        <p className="text-sm text-slate-400">Sem imagens.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {sorted.map((img) => (
            <div key={img.id} className="border rounded-lg p-2 relative group">
              <div className="aspect-square bg-slate-50 rounded mb-2 flex items-center justify-center overflow-hidden">
                {img.publicUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img.publicUrl} alt={img.altText || ""} className="w-full h-full object-contain" />
                ) : (
                  <span className="text-xs text-slate-400 text-center px-1">URL pública não configurada</span>
                )}
              </div>
              {img.isPrimary && <span className="absolute top-1 left-1 bg-sky-600 text-white text-[10px] px-1.5 py-0.5 rounded font-medium">Principal</span>}
              <div className="space-y-1">
                {!img.isPrimary && <button onClick={() => setPrimary(img.id)} className="block w-full text-xs text-sky-600 hover:text-sky-800">Definir como principal</button>}
                {editingAlt === img.id ? (
                  <div className="flex gap-1"><input value={altValue} onChange={e => setAltValue(e.target.value)} className="flex-1 border rounded px-1 py-0.5 text-xs" placeholder="Texto alternativo" /><button onClick={() => saveAlt(img.id)} className="text-xs text-sky-600">✓</button></div>
                ) : (
                  <button onClick={() => { setEditingAlt(img.id); setAltValue(img.altText || ""); }} className="block w-full text-xs text-slate-500 truncate hover:text-sky-600">{img.altText || "Editar alt text"}</button>
                )}
                <div className="flex justify-between">
                  <div className="flex gap-1">
                    <button onClick={() => moveImage(img.id, -1)} className="text-xs text-slate-400 hover:text-slate-700">↑</button>
                    <button onClick={() => moveImage(img.id, 1)} className="text-xs text-slate-400 hover:text-slate-700">↓</button>
                  </div>
                  <button onClick={() => deleteImage(img.id, img.isPrimary)} className="text-xs text-red-400 hover:text-red-600">Eliminar</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
