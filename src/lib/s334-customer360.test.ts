import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
const service=fs.readFileSync(path.join(root,"src/lib/services/admin-customers-service.ts"),"utf8");
const page=fs.readFileSync(path.join(root,"src/app/admin/customers/page.tsx"),"utf8");
const detail=fs.readFileSync(path.join(root,"src/app/admin/customers/Customer360Detail.tsx"),"utf8");
describe("S33.4 Customer360 contract",()=>{
 it("aggregates existing loyalty and payment data",()=>{for(const x of ["listLoyaltyMovements","loyaltyVouchers","loyaltyPointReservations","payments"]) expect(service).toContain(x);});
 it("exposes coupon and loyalty snapshots",()=>{for(const x of ["couponDiscount","loyaltyDiscount","loyaltyType","loyaltyPoints"]) expect(service).toContain(`orders.${x}`);});
 it("renders the Customer360 areas",()=>{for(const x of ["Visão geral","Encomendas","Fidelização","RMA","Moradas","Notas"]) expect(detail).toContain(x);});
 it("uses the existing customer route",()=>{expect(page).toContain('import Customer360Detail from "./Customer360Detail"');expect(page).toContain("<Customer360Detail");});
});
