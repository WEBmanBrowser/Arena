// B.3.1 — Shipping provider foundation tests (real PostgreSQL, real production service)

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { orders, shipments } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createShipmentRecord,
  updateShipment,
  getShipment,
  listShipmentsForOrder,
  findShipmentByProviderId,
  getShippingAdapter,
  isStorePickup,
  assertCarrierEligible,
  isShipmentStatus,
} from "@/lib/providers/shipping-provider";
import { ProviderError } from "@/lib/providers/errors";

async function createTestOrder(deliveryType: "shipping" | "pickup" = "shipping") {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B31S-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      status: "processing",
      paymentStatus: "paid",
      subtotal: "80.00",
      total: "80.00",
      deliveryType,
    })
    .returning();
  return order;
}

beforeEach(async () => {
  await db.delete(shipments);
});

describe("B.3.1 — shipping: carriers and capabilities", () => {
  it("accepts MRW and CTT as allowlisted carriers", async () => {
    const order = await createTestOrder();
    const mrw = await createShipmentRecord({ orderId: order.id, provider: "mrw", service: "24h" });
    const ctt = await createShipmentRecord({ orderId: order.id, provider: "ctt", service: "expresso" });

    expect(mrw.provider).toBe("mrw");
    expect(ctt.provider).toBe("ctt");
    expect(mrw.status).toBe("pending");
    expect(await listShipmentsForOrder(order.id)).toHaveLength(2);
  });

  it("rejects unsupported carriers with UNSUPPORTED_PROVIDER", async () => {
    const order = await createTestOrder();
    await expect(
      createShipmentRecord({ orderId: order.id, provider: "dhl" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
    expect(() => getShippingAdapter("dhl")).toThrow(ProviderError);
  });

  it("is capability aware and never performs live carrier calls", () => {
    // Known carrier, unsupported capability
    try {
      getShippingAdapter("ctt", "cancelShipment");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ProviderError).code).toBe("OPERATION_NOT_SUPPORTED");
    }
    // Known carrier + supported capability, but no adapter exists in B.3.1
    try {
      getShippingAdapter("mrw", "createShipment");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ProviderError).code).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("validates normalized shipment states", async () => {
    const order = await createTestOrder();
    for (const status of ["pending", "created", "label_ready", "in_transit", "delivered", "exception", "cancelled"] as const) {
      expect(isShipmentStatus(status)).toBe(true);
      const record = await createShipmentRecord({ orderId: order.id, provider: "mrw", status });
      expect(record.status).toBe(status);
    }
    expect(isShipmentStatus("ready_for_pickup")).toBe(false);
    expect(isShipmentStatus("shipped")).toBe(false);
  });
});

describe("B.3.1 — shipping: persistence", () => {
  it("stores carrier references, tracking and label reference", async () => {
    const order = await createTestOrder();
    const created = await createShipmentRecord({
      orderId: order.id,
      provider: "ctt",
      service: "expresso",
      providerShipmentId: "CTT-SHP-1",
      trackingNumber: "CTT123456789PT",
      status: "created",
      labelReference: "labels/ctt/CTT-SHP-1.pdf",
    });

    expect(created.orderId).toBe(order.id);
    expect(created.providerShipmentId).toBe("CTT-SHP-1");
    expect(created.trackingNumber).toBe("CTT123456789PT");
    expect(created.labelReference).toBe("labels/ctt/CTT-SHP-1.pdf");
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const found = await findShipmentByProviderId("ctt", "CTT-SHP-1");
    expect(found!.id).toBe(created.id);
  });

  it("progresses shipment status without touching the order", async () => {
    const order = await createTestOrder();
    const created = await createShipmentRecord({ orderId: order.id, provider: "mrw" });

    const labelled = await updateShipment(created.id, { status: "label_ready", labelReference: "labels/mrw/1.pdf" });
    expect(labelled.status).toBe("label_ready");
    const transit = await updateShipment(created.id, { status: "in_transit", trackingNumber: "MRW-TRACK-1" });
    expect(transit.trackingNumber).toBe("MRW-TRACK-1");
    const delivered = await updateShipment(created.id, { status: "delivered" });
    expect(delivered.status).toBe("delivered");

    const [reloadedOrder] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(reloadedOrder.status).toBe("processing"); // unchanged by the shipping module
    expect(reloadedOrder.trackingNumber).toBeNull();
  });

  it("enforces database constraints", async () => {
    const order = await createTestOrder();
    await createShipmentRecord({ orderId: order.id, provider: "mrw", providerShipmentId: "SHP-DUP" });
    await expect(
      createShipmentRecord({ orderId: order.id, provider: "mrw", providerShipmentId: "SHP-DUP" })
    ).rejects.toThrow();
    // Same id from a different carrier is legitimate
    const other = await createShipmentRecord({ orderId: order.id, provider: "ctt", providerShipmentId: "SHP-DUP" });
    expect(other.provider).toBe("ctt");

    await expect(createShipmentRecord({ orderId: 999_999_999, provider: "mrw" })).rejects.toThrow();
  });

  it("reports SHIPMENT_NOT_FOUND for unknown shipments", async () => {
    expect(await getShipment(999_999_999)).toBeNull();
    await expect(updateShipment(999_999_999, { status: "created" })).rejects.toMatchObject({
      code: "SHIPMENT_NOT_FOUND",
    });
  });

  it("rejects invalid shipment states", async () => {
    const order = await createTestOrder();
    const created = await createShipmentRecord({ orderId: order.id, provider: "mrw" });
    await expect(
      updateShipment(created.id, { status: "ready_for_pickup" as never })
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });
});

describe("B.3.1 — shipping: store pickup stays internal", () => {
  it("recognizes store pickup as an internal delivery type", () => {
    expect(isStorePickup("pickup")).toBe(true);
    expect(isStorePickup("shipping")).toBe(false);
  });

  it("never routes store pickup through a carrier adapter", async () => {
    const order = await createTestOrder("pickup");
    expect(() => assertCarrierEligible("pickup")).toThrow(ProviderError);
    await expect(
      createShipmentRecord({ orderId: order.id, provider: "mrw", deliveryType: order.deliveryType })
    ).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(await listShipmentsForOrder(order.id)).toHaveLength(0);
  });

  it("leaves the ready_for_pickup order lifecycle untouched", async () => {
    const order = await createTestOrder("pickup");
    await db.update(orders).set({ status: "ready_for_pickup" }).where(eq(orders.id, order.id));
    const [reloaded] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(reloaded.status).toBe("ready_for_pickup");
    expect(await listShipmentsForOrder(order.id)).toHaveLength(0);
  });
});
