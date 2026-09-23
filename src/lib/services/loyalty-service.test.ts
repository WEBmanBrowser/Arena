import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { loyaltyPointMovements, orders, payments, refundAttempts, users } from "@/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { getLoyaltySummary, pointsForEligibleCents, reconcileLoyaltyForOrder, redemptionValueCents } from "@/lib/services/loyalty-service";

async function cleanup() {
  const os = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "S324-%"));
  const ids=os.map(x=>x.id);
  if(ids.length){
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId,ids));
    await db.delete(payments).where(inArray(payments.orderId,ids));
    await db.delete(loyaltyPointMovements).where(inArray(loyaltyPointMovements.orderId,ids));
    await db.delete(orders).where(inArray(orders.id,ids));
  }
  await db.delete(users).where(like(users.email,"s324-%@test.local"));
}
async function fixture(total:string, amounts:string[]=[total]){
  const [user]=await db.insert(users).values({email:`s324-${Date.now()}-${Math.random()}@test.local`,password:"x",name:"S324",role:"customer"}).returning();
  const [order]=await db.insert(orders).values({orderNumber:`S324-${Date.now()}-${Math.random()}`,userId:user.id,status:"paid",paymentStatus:"paid",subtotal:total,shipping:"0.00",discount:"0.00",vat:"0.00",total,deliveryType:"shipping",paymentMethod:"bank_transfer"}).returning();
  for(const amount of amounts) await db.insert(payments).values({orderId:order.id,provider:"manual",method:"bank_transfer",amount,currency:"EUR",status:"paid",paidAt:new Date()});
  return {user,order};
}
async function refund(orderId:number, amountCents:number, status:string, requestedBy:number){
  const [p]=await db.select({id:payments.id}).from(payments).where(eq(payments.orderId,orderId)).limit(1);
  await db.insert(refundAttempts).values({orderId,paymentId:p.id,provider:"manual",idempotencyKey:`s324-${orderId}-${status}-${amountCents}-${Date.now()}-${Math.random()}`,amountCents,currency:"EUR",status,requestedBy});
}
beforeEach(cleanup); afterEach(cleanup);

describe("S32.4 loyalty",()=>{
  it("uses complete euros",()=>{ expect(pointsForEligibleCents(99)).toBe(0); expect(pointsForEligibleCents(100)).toBe(1); expect(pointsForEligibleCents(50000)).toBe(500); });
  it("keeps linear redemption conversion",()=>{ expect(redemptionValueCents(500)).toBe(500); expect(redemptionValueCents(1000)).toBe(1000); expect(redemptionValueCents(1500)).toBe(1500); });
  it("0.99 earns zero",async()=>{const {user,order}=await fixture("0.99"); expect(await reconcileLoyaltyForOrder(order.id)).toEqual({changed:false,targetPoints:0,delta:0}); expect((await getLoyaltySummary(user.id)).balancePoints).toBe(0);});
  it("1 EUR and 500 EUR earn 1 and 500",async()=>{const a=await fixture("1.00"),b=await fixture("500.00"); expect((await reconcileLoyaltyForOrder(a.order.id)).targetPoints).toBe(1); expect((await reconcileLoyaltyForOrder(b.order.id)).targetPoints).toBe(500);});
  it("repeated settlement is idempotent",async()=>{const {user,order}=await fixture("100.00"); expect(await reconcileLoyaltyForOrder(order.id)).toMatchObject({changed:true,targetPoints:100,delta:100}); expect(await reconcileLoyaltyForOrder(order.id)).toEqual({changed:false,targetPoints:100,delta:0}); expect((await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.orderId,order.id)))).toHaveLength(1); expect((await getLoyaltySummary(user.id)).balancePoints).toBe(100);});
  it("pending and failed refunds do not reverse",async()=>{const {user,order}=await fixture("100.00"); await reconcileLoyaltyForOrder(order.id); await refund(order.id,2500,"pending",user.id); await refund(order.id,1000,"failed",user.id); expect(await reconcileLoyaltyForOrder(order.id)).toEqual({changed:false,targetPoints:100,delta:0}); expect((await getLoyaltySummary(user.id)).balancePoints).toBe(100);});
  it("succeeded partial refund reverses once",async()=>{const {user,order}=await fixture("100.00"); await reconcileLoyaltyForOrder(order.id); await refund(order.id,2500,"succeeded",user.id); expect(await reconcileLoyaltyForOrder(order.id)).toMatchObject({changed:true,targetPoints:75,delta:-25}); expect(await reconcileLoyaltyForOrder(order.id)).toEqual({changed:false,targetPoints:75,delta:0}); expect((await getLoyaltySummary(user.id))).toMatchObject({balancePoints:75,earnedPoints:100,reversedPoints:25});});
  it("caps multiple paid rows at order total",async()=>{const {user,order}=await fixture("100.00",["100.00","100.00"]); expect(await reconcileLoyaltyForOrder(order.id)).toMatchObject({changed:true,targetPoints:100,delta:100}); expect((await getLoyaltySummary(user.id)).balancePoints).toBe(100);});
});
