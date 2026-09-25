export type BuilderProduct = {
  id: number;
  name?: string;
  attributes?: Record<string, string> | null;
};

export type BuilderConfig = Record<string, BuilderProduct | null | undefined>;
export type CompatibilityLevel = "compatible" | "incompatible" | "unknown";
export type CompatibilityIssue = { level: Exclude<CompatibilityLevel, "compatible">; code: string; message: string };

const norm = (value?: string | null) => (value || "").trim().toUpperCase().replace(/\s+/g, " ");
const attr = (p: BuilderProduct | null | undefined, ...keys: string[]) => {
  const a = p?.attributes || {};
  for (const key of keys) {
    const found = Object.entries(a).find(([k]) => k.toLowerCase() === key.toLowerCase());
    if (found?.[1]) return String(found[1]).trim();
  }
  return "";
};
const numberAttr = (p: BuilderProduct | null | undefined, ...keys: string[]) => {
  const raw = attr(p, ...keys).replace(",", ".");
  const match = raw.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};
const splitValues = (value: string) => value.split(/[,;/|]+/).map(norm).filter(Boolean);
const formFactorFits = (board: string, caseValue: string) => {
  const b = norm(board);
  const c = splitValues(caseValue);
  if (!b || !c.length) return null;
  if (c.includes(b)) return true;
  // Common case descriptions such as "ATX Mid Tower" imply ATX and smaller boards.
  const joined = c.join(" ");
  if (b === "ATX" && joined.includes("ATX")) return true;
  if ((b === "MICRO-ATX" || b === "MATX" || b === "M-ATX") && (joined.includes("ATX") || joined.includes("MATX") || joined.includes("MICRO-ATX"))) return true;
  if ((b === "MINI-ITX" || b === "ITX") && (joined.includes("ATX") || joined.includes("ITX"))) return true;
  return false;
};

export function evaluatePcCompatibility(config: BuilderConfig) {
  const issues: CompatibilityIssue[] = [];
  const checked: string[] = [];
  const cpu = config.cpu, mb = config.motherboard, ram = config.ram, gpu = config.gpu, psu = config.psu, pcCase = config.case, cooling = config.cooling;

  if (cpu && mb) {
    const a = attr(cpu, "socket", "cpuSocket");
    const b = attr(mb, "socket", "cpuSocket");
    if (!a || !b) issues.push({ level: "unknown", code: "cpu_socket_missing", message: "Socket CPU/Motherboard por confirmar: faltam especificações." });
    else if (norm(a) !== norm(b)) issues.push({ level: "incompatible", code: "cpu_socket", message: `Socket incompatível: CPU ${a} ≠ Motherboard ${b}.` });
    else checked.push("Socket CPU/Motherboard");
  }

  if (mb && ram) {
    const a = attr(mb, "memoryType", "memory_type", "ramType", "ram_type");
    const b = attr(ram, "type", "memoryType", "memory_type", "ramType", "ram_type");
    if (!a || !b) issues.push({ level: "unknown", code: "ram_type_missing", message: "Tipo de memória Motherboard/RAM por confirmar: faltam especificações." });
    else if (norm(a) !== norm(b)) issues.push({ level: "incompatible", code: "ram_type", message: `Memória incompatível: Motherboard ${a} ≠ RAM ${b}.` });
    else checked.push("Tipo de memória");
  }

  if (mb && pcCase) {
    const board = attr(mb, "formFactor", "form_factor", "motherboardFormFactor");
    const supported = attr(pcCase, "motherboardFormFactors", "motherboard_form_factors", "supportedMotherboards", "supported_motherboards", "formFactor", "form_factor");
    const fits = formFactorFits(board, supported);
    if (fits === null) issues.push({ level: "unknown", code: "case_board_missing", message: "Formato Motherboard/Caixa por confirmar: faltam especificações." });
    else if (!fits) issues.push({ level: "incompatible", code: "case_board", message: `A caixa (${supported}) não confirma suporte para motherboard ${board}.` });
    else checked.push("Formato Motherboard/Caixa");
  }

  if (gpu && pcCase) {
    const gpuMm = numberAttr(gpu, "lengthMm", "length_mm", "gpuLengthMm", "gpu_length_mm");
    const maxMm = numberAttr(pcCase, "gpuMaxLengthMm", "gpu_max_length_mm", "maxGpuLengthMm", "max_gpu_length_mm");
    if (gpuMm == null || maxMm == null) issues.push({ level: "unknown", code: "gpu_case_missing", message: "Comprimento GPU/Caixa por confirmar: faltam dimensões." });
    else if (gpuMm > maxMm) issues.push({ level: "incompatible", code: "gpu_case", message: `GPU com ${gpuMm} mm excede o limite da caixa (${maxMm} mm).` });
    else checked.push("Comprimento GPU/Caixa");
  }

  if (cooling && pcCase) {
    const coolerMm = numberAttr(cooling, "heightMm", "height_mm", "coolerHeightMm", "cooler_height_mm");
    const maxMm = numberAttr(pcCase, "coolerMaxHeightMm", "cooler_max_height_mm", "maxCoolerHeightMm", "max_cooler_height_mm");
    if (coolerMm == null || maxMm == null) issues.push({ level: "unknown", code: "cooler_case_missing", message: "Altura Cooler/Caixa por confirmar: faltam dimensões." });
    else if (coolerMm > maxMm) issues.push({ level: "incompatible", code: "cooler_case", message: `Cooler com ${coolerMm} mm excede o limite da caixa (${maxMm} mm).` });
    else checked.push("Altura Cooler/Caixa");
  }

  if (psu && (cpu || gpu)) {
    const psuW = numberAttr(psu, "wattage", "power", "potencia", "powerW", "power_w");
    const cpuW = numberAttr(cpu, "tdp", "tdpW", "tdp_w");
    const gpuW = numberAttr(gpu, "tdp", "tdpW", "tdp_w", "boardPower", "board_power");
    if (psuW == null || (cpu && cpuW == null) || (gpu && gpuW == null)) {
      issues.push({ level: "unknown", code: "psu_power_missing", message: "Potência da fonte por confirmar: faltam dados de consumo de um ou mais componentes." });
    } else {
      const minimum = Math.ceil(((cpuW || 0) + (gpuW || 0) + 100) * 1.25 / 50) * 50;
      if (psuW < minimum) issues.push({ level: "incompatible", code: "psu_power", message: `Fonte de ${psuW} W abaixo da margem recomendada calculada (${minimum} W).` });
      else checked.push("Margem de potência da fonte");
    }
  }

  const incompatible = issues.filter(i => i.level === "incompatible");
  const unknown = issues.filter(i => i.level === "unknown");
  const level: CompatibilityLevel = incompatible.length ? "incompatible" : unknown.length ? "unknown" : "compatible";
  return { level, issues, checked };
}

export function candidateCompatibility(type: string, product: BuilderProduct, config: BuilderConfig): CompatibilityLevel {
  const before = evaluatePcCompatibility(config);
  const after = evaluatePcCompatibility({ ...config, [type]: product });
  const existingIncompatibilities = new Set(before.issues.filter(i => i.level === "incompatible").map(i => i.code));
  const introducesIncompatibility = after.issues.some(i => i.level === "incompatible" && !existingIncompatibilities.has(i.code));
  if (introducesIncompatibility) return "incompatible";
  if (after.issues.some(i => i.level === "unknown")) return "unknown";
  return "compatible";
}
