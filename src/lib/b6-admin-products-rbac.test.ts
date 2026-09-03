/**
 * B.6 — RBAC contract for the admin surfaces newly exposed in the backoffice UI.
 *
 * The new UI (image manager, supplier manager, bulk price modal) only *hides*
 * controls. These route-level tests prove the server still enforces
 * authorization, so a customer calling the API directly is refused regardless
 * of what the browser renders.
 *
 * getCurrentUser is mocked to impersonate roles; every route otherwise runs for
 * real against the real database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { GET as imagesGET, POST as imagesPOST, PUT as imagesPUT, DELETE as imagesDELETE } from "@/app/api/admin/products/[id]/images/route";
import { GET as suppliersGET, POST as suppliersPOST, PUT as suppliersPUT, DELETE as suppliersDELETE } from "@/app/api/admin/products/[id]/suppliers/route";
import { POST as bulkPOST } from "@/app/api/admin/bulk/route";

type Role = "customer" | "staff" | "manager" | "admin";

function user(role: Role | null) {
  if (!role) return null;
  return { id: 9601, email: `b6-${role}@test.local`, name: `B6 ${role}`, role, phone: null, nif: null, company: null };
}

const params = Promise.resolve({ id: "1" });

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/admin/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function formReq() {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }));
  return new Request("http://localhost/api/admin/test", { method: "POST", body: fd }) as never;
}

beforeEach(() => getCurrentUserMock.mockReset());

describe("B.6 — product images RBAC", () => {
  it("refuses anonymous and customer on GET (read requires staff+)", async () => {
    for (const role of [null, "customer"] as const) {
      getCurrentUserMock.mockResolvedValue(user(role));
      const res = await imagesGET({} as never, { params });
      expect(res.status).toBe(403);
    }
  });

  it("refuses customer on upload, mutate and delete", async () => {
    getCurrentUserMock.mockResolvedValue(user("customer"));
    expect((await imagesPOST(formReq(), { params })).status).toBe(403);
    expect((await imagesPUT(jsonReq({ action: "setPrimary", imageId: 1 }), { params })).status).toBe(403);
    expect((await imagesDELETE(jsonReq({ imageId: 1 }), { params })).status).toBe(403);
  });

  it("refuses staff on write operations (manager+ required)", async () => {
    getCurrentUserMock.mockResolvedValue(user("staff"));
    expect((await imagesPOST(formReq(), { params })).status).toBe(403);
    expect((await imagesPUT(jsonReq({ action: "setPrimary", imageId: 1 }), { params })).status).toBe(403);
    expect((await imagesDELETE(jsonReq({ imageId: 1 }), { params })).status).toBe(403);
  });

  it("allows staff to read the gallery", async () => {
    getCurrentUserMock.mockResolvedValue(user("staff"));
    const res = await imagesGET({} as never, { params });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).images)).toBe(true);
  });

  it("lets manager past the auth gate on writes (not a 403)", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    const res = await imagesPUT(jsonReq({ action: "setPrimary", imageId: 999999 }), { params });
    expect(res.status).not.toBe(403);
  });
});

describe("B.6 — product suppliers RBAC", () => {
  it("refuses anonymous and customer on GET", async () => {
    for (const role of [null, "customer"] as const) {
      getCurrentUserMock.mockResolvedValue(user(role));
      expect((await suppliersGET({} as never, { params })).status).toBe(403);
    }
  });

  it("refuses customer and staff on write operations", async () => {
    for (const role of ["customer", "staff"] as const) {
      getCurrentUserMock.mockResolvedValue(user(role));
      expect((await suppliersPOST(jsonReq({ supplierId: 1 }), { params })).status).toBe(403);
      expect((await suppliersPUT(jsonReq({ psId: 1 }), { params })).status).toBe(403);
      expect((await suppliersDELETE(jsonReq({ psId: 1 }), { params })).status).toBe(403);
    }
  });

  it("allows staff to read the supplier list", async () => {
    getCurrentUserMock.mockResolvedValue(user("staff"));
    const res = await suppliersGET({} as never, { params });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).suppliers)).toBe(true);
  });

  it("validates the payload for managers instead of silently accepting it", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    const res = await suppliersPOST(jsonReq({ supplierSku: "no-supplier-id" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");
  });
});

describe("B.6 — bulk pricing RBAC", () => {
  it("refuses anonymous, customer and staff (manager+ required)", async () => {
    for (const role of [null, "customer", "staff"] as const) {
      getCurrentUserMock.mockResolvedValue(user(role));
      const res = await bulkPOST(jsonReq({ action: "price_update", mode: "preview", target: { type: "selection", productIds: [1] }, operation: "percent_increase", value: 5 }));
      expect(res.status).toBe(403);
    }
  });

  it("rejects an unsigned/forged apply token for a manager", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    const res = await bulkPOST(jsonReq({ action: "price_update", mode: "apply", previewToken: "forged.token.value" }));
    expect(res.status).not.toBe(200);
    expect(["BULK_PREVIEW_INVALID", "BULK_PREVIEW_SECRET_NOT_CONFIGURED"]).toContain((await res.json()).error);
  });
});
