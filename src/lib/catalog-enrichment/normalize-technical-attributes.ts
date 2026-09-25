/**
 * S35.5 — conservative technical-attribute normalization.
 *
 * Keeps every source attribute untouched and adds canonical keys only when a
 * source key has an unambiguous technical meaning. Values are normalized only
 * where the PC builder needs a stable representation.
 */
export type TechnicalAttributes = Record<string, string>;

const keyToken = (value: string) => value
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const compact = (value: string) => value.trim().replace(/\s+/g, " ");
const upperCompact = (value: string) => compact(value).toUpperCase();
const normalizeSocket = (value: string) => upperCompact(value).replace(/^(?:CPU|PROCESSOR)?\s*SOCKET\s+/i, "").trim();

const numeric = (value: string) => {
  const match = value.replace(",", ".").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};
const millimetres = (value: string) => {
  const n = numeric(value);
  if (n == null) return null;
  return /\bcm\b/i.test(value) && !/\bmm\b/i.test(value) ? n * 10 : n;
};
const watts = (value: string) => numeric(value);
const numberString = (n: number) => Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));

const SOCKET_KEYS = new Set(["socket", "cpu socket", "processor socket", "processor socket type", "socket type", "soquete", "soquete cpu"]);
const MEMORY_KEYS = new Set(["memory type", "memory technology", "memory standard", "ram type", "tipo de memoria", "tipo memoria", "tecnologia de memoria"]);
const BOARD_FORM_KEYS = new Set(["form factor", "motherboard form factor", "motherboard format", "formato motherboard", "formato da motherboard"]);
const CASE_BOARD_KEYS = new Set(["supported motherboard form factors", "motherboard form factors supported", "supported motherboards", "motherboard support", "formatos motherboard suportados", "motherboard form factors"]);
const GPU_LENGTH_KEYS = new Set(["graphics card length", "gpu length", "video card length", "comprimento gpu", "comprimento placa grafica"]);
const CASE_GPU_KEYS = new Set(["maximum graphics card length", "max graphics card length", "maximum gpu length", "max gpu length", "gpu clearance", "comprimento maximo gpu", "comprimento maximo placa grafica"]);
const COOLER_HEIGHT_KEYS = new Set(["cpu cooler height", "cooler height", "air cooler height", "altura cooler", "altura dissipador"]);
const CASE_COOLER_KEYS = new Set(["maximum cpu cooler height", "max cpu cooler height", "maximum cooler height", "max cooler height", "cpu cooler clearance", "altura maxima cooler", "altura maxima dissipador"]);
const PSU_POWER_KEYS = new Set(["power supply wattage", "psu wattage", "power supply power", "psu power", "potencia fonte", "potencia fonte alimentacao"]);
const CPU_TDP_KEYS = new Set(["processor base power", "cpu tdp", "processor tdp", "thermal design power", "tdp cpu"]);
const GPU_POWER_KEYS = new Set(["total board power", "graphics card power", "gpu power", "board power", "typical board power", "potencia gpu", "potencia placa grafica"]);

function setIfMissing(out: TechnicalAttributes, key: string, value: string | null) {
  if (value && out[key] === undefined) out[key] = value;
}

function normalizeMemory(value: string) {
  const match = upperCompact(value).match(/DDR\s*([2-9])/);
  return match ? `DDR${match[1]}` : upperCompact(value);
}
function normalizeFormFactors(value: string) {
  return compact(value)
    .replace(/micro[ -]?atx/gi, "Micro-ATX")
    .replace(/mini[ -]?itx/gi, "Mini-ITX")
    .replace(/\bm[ -]?atx\b/gi, "Micro-ATX")
    .replace(/\batx\b/gi, "ATX");
}

export function normalizeTechnicalAttributes(source: TechnicalAttributes): TechnicalAttributes {
  const out: TechnicalAttributes = { ...source };
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = keyToken(rawKey);
    const value = compact(String(rawValue ?? ""));
    if (!value) continue;

    if (SOCKET_KEYS.has(key)) setIfMissing(out, "cpuSocket", normalizeSocket(value));
    if (MEMORY_KEYS.has(key)) setIfMissing(out, "memoryType", normalizeMemory(value));
    if (BOARD_FORM_KEYS.has(key)) setIfMissing(out, "formFactor", normalizeFormFactors(value));
    if (CASE_BOARD_KEYS.has(key)) setIfMissing(out, "motherboardFormFactors", normalizeFormFactors(value));

    const mm = millimetres(value);
    if (GPU_LENGTH_KEYS.has(key) && mm != null) setIfMissing(out, "gpuLengthMm", numberString(mm));
    if (CASE_GPU_KEYS.has(key) && mm != null) setIfMissing(out, "gpuMaxLengthMm", numberString(mm));
    if (COOLER_HEIGHT_KEYS.has(key) && mm != null) setIfMissing(out, "coolerHeightMm", numberString(mm));
    if (CASE_COOLER_KEYS.has(key) && mm != null) setIfMissing(out, "coolerMaxHeightMm", numberString(mm));

    const w = watts(value);
    if (PSU_POWER_KEYS.has(key) && w != null) setIfMissing(out, "wattage", numberString(w));
    if (CPU_TDP_KEYS.has(key) && w != null) setIfMissing(out, "tdpW", numberString(w));
    if (GPU_POWER_KEYS.has(key) && w != null) setIfMissing(out, "boardPower", numberString(w));
  }
  return out;
}
