export function formatPrice(price: number | string): string {
  const num = typeof price === "string" ? parseFloat(price) : price;
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(num);
}

export function generateOrderNumber(): string {
  const date = new Date();
  const y = date.getFullYear().toString().slice(-2);
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const rand = Math.floor(Math.random() * 100000).toString().padStart(5, "0");
  return `MD${y}${m}${rand}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function getAvailableStock(product: { stock: number; reservedStock: number }): number {
  return Math.max(0, product.stock - product.reservedStock);
}

export function getStockStatus(product: { stock: number; reservedStock: number; allowPreorder: boolean }): string {
  const available = getAvailableStock(product);
  if (available > 5) return "Em stock";
  if (available > 0) return `Últimas ${available} unidades`;
  if (product.allowPreorder) return "Pré-encomenda";
  return "Esgotado";
}

export function getStockColor(product: { stock: number; reservedStock: number }): string {
  const available = getAvailableStock(product);
  if (available > 5) return "text-green-600";
  if (available > 0) return "text-amber-600";
  return "text-red-600";
}
