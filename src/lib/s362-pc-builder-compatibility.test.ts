import { describe, expect, it } from "vitest";
import { candidateCompatibility, evaluatePcCompatibility } from "./pc-builder-compatibility";

const p = (id: number, attributes: Record<string, string>) => ({ id, attributes });

describe("S36.2 — PC Builder compatibility", () => {
  it("rejects CPU and motherboard with different sockets", () => {
    const r = evaluatePcCompatibility({ cpu: p(1, { socket: "AM5" }), motherboard: p(2, { socket: "LGA1700" }) });
    expect(r.level).toBe("incompatible");
    expect(r.issues.some(i => i.code === "cpu_socket")).toBe(true);
  });

  it("does not claim compatibility when required technical data is missing", () => {
    const r = evaluatePcCompatibility({ cpu: p(1, {}), motherboard: p(2, { socket: "AM5" }) });
    expect(r.level).toBe("unknown");
    expect(r.issues.some(i => i.code === "cpu_socket_missing")).toBe(true);
  });

  it("checks RAM type, case clearances and PSU headroom", () => {
    const r = evaluatePcCompatibility({
      cpu: p(1, { socket: "AM5", tdp: "120W" }),
      motherboard: p(2, { socket: "AM5", memoryType: "DDR5", formFactor: "ATX" }),
      ram: p(3, { type: "DDR5" }),
      gpu: p(4, { lengthMm: "300", tdp: "220W" }),
      case: p(5, { motherboardFormFactors: "ATX, Micro-ATX, Mini-ITX", gpuMaxLengthMm: "360", coolerMaxHeightMm: "170" }),
      cooling: p(6, { heightMm: "160" }),
      psu: p(7, { wattage: "850W" }),
    });
    expect(r.level).toBe("compatible");
    expect(r.checked).toContain("Margem de potência da fonte");
  });

  it("filters a known incompatible socket candidate", () => {
    const config = { cpu: p(1, { socket: "AM5" }) };
    expect(candidateCompatibility("motherboard", p(2, { socket: "LGA1700" }), config)).toBe("incompatible");
    expect(candidateCompatibility("motherboard", p(3, { socket: "AM5" }), config)).toBe("compatible");
  });

  it("keeps candidates with incomplete data visible instead of inventing incompatibility", () => {
    const config = { cpu: p(1, { socket: "AM5" }) };
    expect(candidateCompatibility("motherboard", p(2, {}), config)).toBe("unknown");
  });

  it("does not hide every candidate because of an unrelated existing incompatibility", () => {
    const config = {
      cpu: p(1, { socket: "AM5" }),
      motherboard: p(2, { socket: "LGA1700" }),
    };
    expect(candidateCompatibility("gpu", p(3, { lengthMm: "300" }), config)).not.toBe("incompatible");
  });
});
