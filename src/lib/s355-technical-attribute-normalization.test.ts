import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeTechnicalAttributes } from "@/lib/catalog-enrichment/normalize-technical-attributes";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("S35.5 technical attribute normalization", () => {
  it("keeps source attributes and adds canonical CPU/RAM keys", () => {
    const result = normalizeTechnicalAttributes({ "Processor socket": " Socket AM5 ", "Memory technology": "DDR 5", VendorNote: "keep me" });
    expect(result["Processor socket"]).toBe(" Socket AM5 ");
    expect(result.VendorNote).toBe("keep me");
    expect(result.cpuSocket).toBe("AM5");
    expect(result.memoryType).toBe("DDR5");
  });

  it("normalizes builder dimensions to millimetres", () => {
    const result = normalizeTechnicalAttributes({
      "Graphics card length": "30.4 cm", "Maximum graphics card length": "360 mm",
      "CPU cooler height": "165 mm", "Maximum CPU cooler height": "17 cm",
    });
    expect(result.gpuLengthMm).toBe("304");
    expect(result.gpuMaxLengthMm).toBe("360");
    expect(result.coolerHeightMm).toBe("165");
    expect(result.coolerMaxHeightMm).toBe("170");
  });

  it("normalizes board/case form factors without guessing unrelated keys", () => {
    const result = normalizeTechnicalAttributes({ "Motherboard form factor": "Micro ATX", "Supported motherboard form factors": "ATX, Micro ATX, Mini ITX", Length: "304 mm" });
    expect(result.formFactor).toBe("Micro-ATX");
    expect(result.motherboardFormFactors).toContain("ATX");
    expect(result.gpuLengthMm).toBeUndefined();
  });

  it("normalizes PSU, CPU and GPU power fields", () => {
    const result = normalizeTechnicalAttributes({ "PSU wattage": "750 W", "Processor Base Power": "125 W", "Total Board Power": "285 W" });
    expect(result.wattage).toBe("750");
    expect(result.tdpW).toBe("125");
    expect(result.boardPower).toBe("285");
  });

  it("never overwrites an explicit canonical value", () => {
    const result = normalizeTechnicalAttributes({ cpuSocket: "AM5", Socket: "LGA1700", gpuLengthMm: "300", "Graphics card length": "340 mm" });
    expect(result.cpuSocket).toBe("AM5");
    expect(result.gpuLengthMm).toBe("300");
  });

  it("feeds normalization into the existing staged snapshot and preserves the S35.2 apply boundary", () => {
    const service = read("src/lib/services/catalog-enrichment-service.ts");
    expect(service).toContain("normalizeTechnicalAttributes(cleanAttributes(input.attributes ?? {}))");
    expect(service).toContain("applyAttributes");
    expect(service).toContain("protectedFields.attributeKeys.push(key)");
  });

  it("does not touch protected commercial, stock, identity or GPSR fields", () => {
    const normalizer = read("src/lib/catalog-enrichment/normalize-technical-attributes.ts");
    for (const forbidden of ["costPrice", "priceMode", "supplierStock", "manufacturerPartNumber", "supplierSku", "gpsrManufacturerName"]) {
      expect(normalizer).not.toContain(forbidden);
    }
  });
});
