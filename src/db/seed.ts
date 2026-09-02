import { db } from "./index";
import { users, categories, brands, products, banners, settings, smartShoppingProfiles, pages, shippingClasses } from "./schema";
import * as bcryptjs from "bcryptjs";
import { eq } from "drizzle-orm";

/**
 * B.5.2 — Production seed guard.
 *
 * The demo seed inserts fixture users (with well-known passwords), demo
 * catalog data and demo pages. Running it against a production database is
 * never acceptable, so we refuse BEFORE any database mutation happens.
 * Development/test behaviour is unchanged.
 */
export function assertSeedAllowed(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv === "production") {
    throw new Error(
      "Refusing to seed: NODE_ENV=production. The demo seed is for development/test only.",
    );
  }
}

async function seed() {
  // FIRST statement — must run before any DB mutation.
  assertSeedAllowed();

  console.log("🌱 Seeding database...");

  // Admin user
  const hashedPassword = await bcryptjs.hash("admin123", 12);
  await db.insert(users).values({
    email: "admin@mdtechsolutions.pt",
    password: hashedPassword,
    name: "Marco Duarte",
    role: "admin",
    phone: "+351 253 000 000",
  }).onConflictDoNothing();

  // Demo customer
  const custPass = await bcryptjs.hash("cliente123", 12);
  await db.insert(users).values({
    email: "cliente@demo.pt",
    password: custPass,
    name: "Cliente Demo",
    role: "customer",
    phone: "+351 912 345 678",
    nif: "123456789",
  }).onConflictDoNothing();

  // Brands
  const brandData = [
    { name: "AMD", slug: "amd" },
    { name: "Intel", slug: "intel" },
    { name: "NVIDIA", slug: "nvidia" },
    { name: "ASUS", slug: "asus" },
    { name: "MSI", slug: "msi" },
    { name: "Corsair", slug: "corsair" },
    { name: "Kingston", slug: "kingston" },
    { name: "Samsung", slug: "samsung" },
    { name: "Seagate", slug: "seagate" },
    { name: "Logitech", slug: "logitech" },
    { name: "Apple", slug: "apple" },
    { name: "Xiaomi", slug: "xiaomi" },
    { name: "TP-Link", slug: "tp-link" },
    { name: "Gigabyte", slug: "gigabyte" },
    { name: "Western Digital", slug: "western-digital" },
    { name: "Crucial", slug: "crucial" },
    { name: "NZXT", slug: "nzxt" },
    { name: "be quiet!", slug: "be-quiet" },
    { name: "Seasonic", slug: "seasonic" },
    { name: "Razer", slug: "razer" },
  ];
  for (const b of brandData) {
    await db.insert(brands).values(b).onConflictDoNothing();
  }

  // Categories
  const catData = [
    { name: "Computadores", slug: "computadores", icon: "💻", sortOrder: 1 },
    { name: "Componentes", slug: "componentes", icon: "🔧", sortOrder: 2 },
    { name: "Periféricos", slug: "perifericos", icon: "🖱️", sortOrder: 3 },
    { name: "Redes", slug: "redes", icon: "🌐", sortOrder: 4 },
    { name: "Smartphones", slug: "smartphones", icon: "📱", sortOrder: 5 },
    { name: "Serviços", slug: "servicos", icon: "🛠️", sortOrder: 6 },
    { name: "Armazenamento", slug: "armazenamento", icon: "💾", sortOrder: 7 },
    { name: "Gaming", slug: "gaming", icon: "🎮", sortOrder: 8 },
  ];
  for (const c of catData) {
    await db.insert(categories).values(c).onConflictDoNothing();
  }

  // Get inserted category IDs
  const cats = await db.select().from(categories);
  const catMap: Record<string, number> = {};
  for (const c of cats) catMap[c.slug] = c.id;

  // Subcategories
  const subCats = [
    { name: "Portáteis", slug: "portateis", parentId: catMap["computadores"], sortOrder: 1 },
    { name: "Desktop", slug: "desktop", parentId: catMap["computadores"], sortOrder: 2 },
    { name: "Processadores", slug: "processadores", parentId: catMap["componentes"], sortOrder: 1,
      filters: JSON.stringify([
        { key: "socket", label: "Socket", options: ["AM5", "AM4", "LGA1700", "LGA1851"] },
        { key: "cores", label: "Cores", options: ["4", "6", "8", "12", "16", "24"] },
        { key: "tdp", label: "TDP", options: ["65W", "105W", "125W", "170W"] },
      ])
    },
    { name: "Motherboards", slug: "motherboards", parentId: catMap["componentes"], sortOrder: 2 },
    { name: "Placas Gráficas", slug: "placas-graficas", parentId: catMap["componentes"], sortOrder: 3 },
    { name: "Memória RAM", slug: "memoria-ram", parentId: catMap["componentes"], sortOrder: 4 },
    { name: "SSD", slug: "ssd", parentId: catMap["armazenamento"], sortOrder: 1,
      filters: JSON.stringify([
        { key: "capacidade", label: "Capacidade", options: ["256GB", "512GB", "1TB", "2TB", "4TB"] },
        { key: "interface", label: "Interface", options: ["NVMe M.2", "SATA III", "PCIe 4.0", "PCIe 5.0"] },
      ])
    },
    { name: "Fontes de Alimentação", slug: "fontes-alimentacao", parentId: catMap["componentes"], sortOrder: 5 },
    { name: "Caixas", slug: "caixas-pc", parentId: catMap["componentes"], sortOrder: 6 },
    { name: "Cooling", slug: "cooling", parentId: catMap["componentes"], sortOrder: 7 },
    { name: "Teclados", slug: "teclados", parentId: catMap["perifericos"], sortOrder: 1 },
    { name: "Ratos", slug: "ratos", parentId: catMap["perifericos"], sortOrder: 2 },
    { name: "Monitores", slug: "monitores", parentId: catMap["perifericos"], sortOrder: 3 },
    { name: "Headsets", slug: "headsets", parentId: catMap["perifericos"], sortOrder: 4 },
    { name: "Routers", slug: "routers", parentId: catMap["redes"], sortOrder: 1 },
    { name: "Switches", slug: "switches-rede", parentId: catMap["redes"], sortOrder: 2 },
  ];
  for (const sc of subCats) {
    await db.insert(categories).values(sc).onConflictDoNothing();
  }

  const allCats = await db.select().from(categories);
  const allCatMap: Record<string, number> = {};
  for (const c of allCats) allCatMap[c.slug] = c.id;

  const allBrands = await db.select().from(brands);
  const brandMap: Record<string, number> = {};
  for (const b of allBrands) brandMap[b.slug] = b.id;

  // Products
  await db.insert(shippingClasses).values([
    { key: "small", displayName: "Pequeno", rateCents: 490, priority: 10, isActive: true, notes: "Classe inicial para produtos pequenos" },
    { key: "large", displayName: "Grande", rateCents: 790, priority: 20, isActive: true, notes: "Classe inicial para produtos grandes" },
  ]).onConflictDoNothing();
  const [smallShippingClass] = await db.select({ id: shippingClasses.id }).from(shippingClasses).where(eq(shippingClasses.key, "small")).limit(1);

  const productData = [
    {
      name: "[DEMO] AMD Ryzen 7 7800X3D",
      slug: "amd-ryzen-7-7800x3d",
      sku: "CPU-AMD-7800X3D",
      brandId: brandMap["amd"],
      categoryId: allCatMap["processadores"],
      shortDescription: "Processador AMD Ryzen 7 7800X3D, 8 Cores, 16 Threads, 4.2GHz (5.0GHz Turbo), AM5",
      description: "O AMD Ryzen 7 7800X3D é o melhor processador para gaming, com a tecnologia 3D V-Cache que proporciona desempenho excecional em jogos. Com 8 cores e 16 threads, frequência base de 4.2GHz e boost até 5.0GHz, este processador é ideal para gamers exigentes.",
      price: "389.99",
      comparePrice: "449.99",
      costPrice: "320.00",
      stock: 15,
      storeStock: 5,
      warehouseStock: 10,
      isFeatured: true,
      attributes: { socket: "AM5", cores: "8", threads: "16", frequency: "4.2GHz", boost: "5.0GHz", cache: "96MB", tdp: "120W" },
      tags: ["gaming", "processador", "amd", "ryzen", "am5"],
    },
    {
      name: "[DEMO] Intel Core i7-14700K",
      slug: "intel-core-i7-14700k",
      sku: "CPU-INTEL-14700K",
      brandId: brandMap["intel"],
      categoryId: allCatMap["processadores"],
      shortDescription: "Processador Intel Core i7-14700K, 20 Cores, 28 Threads, 3.4GHz (5.6GHz Turbo), LGA1700",
      description: "O Intel Core i7-14700K oferece desempenho excecional tanto em produtividade como em gaming.",
      price: "419.99",
      comparePrice: "469.99",
      costPrice: "350.00",
      stock: 10,
      storeStock: 3,
      warehouseStock: 7,
      isFeatured: true,
      attributes: { socket: "LGA1700", cores: "20", threads: "28", frequency: "3.4GHz", boost: "5.6GHz", tdp: "125W" },
      tags: ["gaming", "processador", "intel", "core"],
    },
    {
      name: "[DEMO] NVIDIA GeForce RTX 4070 Super",
      slug: "nvidia-rtx-4070-super",
      sku: "GPU-RTX4070S",
      brandId: brandMap["nvidia"],
      categoryId: allCatMap["placas-graficas"],
      shortDescription: "Placa Gráfica NVIDIA GeForce RTX 4070 Super 12GB GDDR6X",
      description: "A RTX 4070 Super oferece desempenho excecional em 1440p com ray tracing e DLSS 3.",
      price: "649.99",
      comparePrice: "699.99",
      costPrice: "530.00",
      stock: 8,
      storeStock: 2,
      warehouseStock: 6,
      isFeatured: true,
      attributes: { vram: "12GB", memoryType: "GDDR6X", interface: "PCIe 4.0", tdp: "220W" },
      tags: ["gaming", "placa-grafica", "nvidia", "rtx"],
    },
    {
      name: "[DEMO] Corsair Vengeance DDR5 32GB (2x16GB) 6000MHz",
      slug: "corsair-vengeance-ddr5-32gb",
      sku: "RAM-CORS-32G",
      brandId: brandMap["corsair"],
      categoryId: allCatMap["memoria-ram"],
      shortDescription: "Kit Memória RAM Corsair Vengeance DDR5 32GB (2x16GB) 6000MHz CL30",
      description: "Kit de memória DDR5 de alto desempenho com perfis Intel XMP 3.0.",
      price: "109.99",
      comparePrice: "139.99",
      costPrice: "85.00",
      stock: 25,
      storeStock: 10,
      warehouseStock: 15,
      attributes: { capacity: "32GB", type: "DDR5", speed: "6000MHz", modules: "2x16GB" },
      tags: ["ram", "memoria", "ddr5", "corsair"],
    },
    {
      name: "[DEMO] Samsung 990 Pro 2TB NVMe M.2",
      slug: "samsung-990-pro-2tb",
      sku: "SSD-SAM990-2T",
      brandId: brandMap["samsung"],
      categoryId: allCatMap["ssd"],
      shortDescription: "SSD Samsung 990 Pro 2TB NVMe M.2 PCIe 4.0",
      description: "O Samsung 990 Pro oferece velocidades de leitura até 7450 MB/s.",
      price: "179.99",
      comparePrice: "219.99",
      costPrice: "140.00",
      stock: 20,
      storeStock: 8,
      warehouseStock: 12,
      isFeatured: true,
      attributes: { capacidade: "2TB", interface: "NVMe M.2", leitura: "7450 MB/s", escrita: "6900 MB/s", formato: "M.2 2280" },
      tags: ["ssd", "nvme", "samsung", "armazenamento"],
    },
    {
      name: "[DEMO] ASUS ROG Strix B650E-F Gaming WiFi",
      slug: "asus-rog-strix-b650e",
      sku: "MB-ASUS-B650E",
      brandId: brandMap["asus"],
      categoryId: allCatMap["motherboards"],
      shortDescription: "Motherboard ASUS ROG Strix B650E-F Gaming WiFi, AM5, DDR5",
      description: "Motherboard de alto desempenho para plataforma AMD AM5.",
      price: "279.99",
      comparePrice: "319.99",
      costPrice: "230.00",
      stock: 6,
      storeStock: 2,
      warehouseStock: 4,
      attributes: { socket: "AM5", chipset: "B650E", memoryType: "DDR5", formFactor: "ATX", wifi: "Wi-Fi 6E" },
      tags: ["motherboard", "asus", "rog", "am5", "gaming"],
    },
    {
      name: "[DEMO] Corsair RM850x 850W 80+ Gold",
      slug: "corsair-rm850x",
      sku: "PSU-CORS-850",
      brandId: brandMap["corsair"],
      categoryId: allCatMap["fontes-alimentacao"],
      shortDescription: "Fonte de Alimentação Corsair RM850x 850W, 80+ Gold, Modular",
      description: "Fonte modular silenciosa e eficiente com certificação 80+ Gold.",
      price: "139.99",
      costPrice: "110.00",
      stock: 12,
      storeStock: 4,
      warehouseStock: 8,
      attributes: { potencia: "850W", certificacao: "80+ Gold", modular: "Totalmente Modular" },
      tags: ["fonte", "psu", "corsair", "modular"],
    },
    {
      name: "[DEMO] NZXT H7 Flow RGB",
      slug: "nzxt-h7-flow-rgb",
      sku: "CASE-NZXT-H7",
      brandId: brandMap["nzxt"],
      categoryId: allCatMap["caixas-pc"],
      shortDescription: "Caixa NZXT H7 Flow RGB, ATX Mid Tower, Vidro Temperado",
      description: "Caixa com excelente fluxo de ar e design premium.",
      price: "129.99",
      costPrice: "100.00",
      stock: 7,
      storeStock: 3,
      warehouseStock: 4,
      attributes: { formFactor: "ATX Mid Tower", material: "Aço + Vidro Temperado", ventoinhas: "3x 120mm RGB" },
      tags: ["caixa", "nzxt", "atx", "rgb"],
    },
    {
      name: "[DEMO] Logitech G Pro X Superlight 2",
      slug: "logitech-g-pro-x-superlight-2",
      sku: "MOUSE-LOG-GPXS2",
      brandId: brandMap["logitech"],
      categoryId: allCatMap["ratos"],
      shortDescription: "Rato Gaming Logitech G Pro X Superlight 2, 32K DPI, Wireless",
      description: "O rato gaming sem fios mais leve e preciso da Logitech.",
      price: "149.99",
      comparePrice: "169.99",
      costPrice: "115.00",
      stock: 15,
      storeStock: 6,
      warehouseStock: 9,
      isFeatured: true,
      attributes: { dpi: "32000", peso: "60g", sensor: "HERO 2", bateria: "95h" },
      tags: ["rato", "gaming", "wireless", "logitech"],
    },
    {
      name: "[DEMO] TP-Link Archer AX73",
      slug: "tp-link-archer-ax73",
      sku: "NET-TPL-AX73",
      brandId: brandMap["tp-link"],
      categoryId: allCatMap["routers"],
      shortDescription: "Router TP-Link Archer AX73, Wi-Fi 6, AX5400, Dual Band",
      description: "Router Wi-Fi 6 de alto desempenho para toda a casa.",
      price: "89.99",
      comparePrice: "109.99",
      costPrice: "65.00",
      stock: 18,
      storeStock: 7,
      warehouseStock: 11,
      attributes: { wifi: "Wi-Fi 6 (802.11ax)", velocidade: "5400 Mbps", bandas: "Dual Band" },
      tags: ["router", "wifi", "tp-link", "rede"],
    },
    // Services
    {
      name: "[DEMO] Reparação de Computador",
      slug: "reparacao-computador",
      sku: "SRV-REP-PC",
      categoryId: allCatMap["servicos"],
      shortDescription: "Diagnóstico e reparação de computadores desktop e portáteis",
      description: "Serviço completo de diagnóstico e reparação. Inclui análise do problema, orçamento e reparação.",
      price: "39.99",
      stock: 999,
      isService: true,
      isFeatured: true,
      attributes: { tipo: "Serviço", duracao: "24-48h", garantia: "90 dias" },
      tags: ["servico", "reparacao", "assistencia"],
    },
    {
      name: "[DEMO] Montagem de PC Personalizado",
      slug: "montagem-pc-personalizado",
      sku: "SRV-MONT-PC",
      categoryId: allCatMap["servicos"],
      shortDescription: "Montagem profissional do seu PC com gestão de cabos e testes",
      description: "Montagem profissional com gestão de cabos, instalação de sistema operativo, drivers e testes de estabilidade.",
      price: "49.99",
      stock: 999,
      isService: true,
      attributes: { tipo: "Serviço", duracao: "24h", garantia: "12 meses" },
      tags: ["servico", "montagem", "pc"],
    },
    {
      name: "[DEMO] Instalação Windows 11",
      slug: "instalacao-windows-11",
      sku: "SRV-WIN11",
      categoryId: allCatMap["servicos"],
      shortDescription: "Instalação limpa do Windows 11 com drivers e atualizações",
      description: "Instalação limpa do Windows 11 Pro com todos os drivers, atualizações de segurança e configuração inicial.",
      price: "29.99",
      stock: 999,
      isService: true,
      attributes: { tipo: "Serviço", duracao: "2-4h", garantia: "30 dias" },
      tags: ["servico", "windows", "instalacao"],
    },
    {
      name: "[DEMO] Razer BlackWidow V4 Pro",
      slug: "razer-blackwidow-v4-pro",
      sku: "KB-RAZ-BWV4P",
      brandId: brandMap["razer"],
      categoryId: allCatMap["teclados"],
      shortDescription: "Teclado Mecânico Razer BlackWidow V4 Pro, Green Switches, RGB",
      description: "Teclado mecânico premium com switches Razer Green e iluminação RGB por tecla.",
      price: "229.99",
      comparePrice: "259.99",
      costPrice: "180.00",
      stock: 9,
      storeStock: 3,
      warehouseStock: 6,
      attributes: { switches: "Razer Green", layout: "PT", retroiluminacao: "RGB por tecla", conectividade: "USB-C" },
      tags: ["teclado", "gaming", "razer", "mecanico"],
    },
    {
      name: "[DEMO] ASUS ROG Swift PG27AQN 27\" 360Hz",
      slug: "asus-rog-swift-pg27aqn",
      sku: "MON-ASUS-PG27",
      brandId: brandMap["asus"],
      categoryId: allCatMap["monitores"],
      shortDescription: "Monitor ASUS ROG Swift 27\" 1440p 360Hz IPS G-Sync",
      description: "Monitor de gaming de elite com taxa de atualização de 360Hz em 1440p.",
      price: "899.99",
      comparePrice: "999.99",
      costPrice: "720.00",
      stock: 3,
      storeStock: 1,
      warehouseStock: 2,
      isFeatured: true,
      attributes: { tamanho: "27\"", resolucao: "2560x1440", painel: "IPS", refreshRate: "360Hz", tempoResposta: "1ms" },
      tags: ["monitor", "gaming", "asus", "360hz"],
    },
  ];

  for (const p of productData) {
    await db.insert(products).values({ ...p, shippingClassId: (p as any).isService ? null : smallShippingClass?.id } as any).onConflictDoNothing();
  }

  // Banners
  await db.insert(banners).values([
    {
      title: "Tecnologia ao teu alcance",
      subtitle: "Descobre as melhores soluções em informática com assistência técnica especializada em Esposende.",
      buttonText: "Ver Produtos",
      link: "/produtos",
      sortOrder: 1,
      isActive: true,
    },
    {
      title: "Constrói o teu PC",
      subtitle: "Usa o nosso configurador e monta o computador perfeito com verificação de compatibilidade.",
      buttonText: "Configurador PC",
      link: "/configurador",
      sortOrder: 2,
      isActive: true,
    },
    {
      title: "Assistência Técnica Profissional",
      subtitle: "Reparação, manutenção e suporte técnico para particulares e empresas.",
      buttonText: "Ver Serviços",
      link: "/produtos?cat=servicos",
      sortOrder: 3,
      isActive: true,
    },
  ]).onConflictDoNothing();

  // Smart Shopping Profiles
  await db.insert(smartShoppingProfiles).values([
    {
      name: "Quero um PC para Gaming",
      icon: "🎮",
      description: "Encontra o setup ideal para jogar com o melhor desempenho.",
      sortOrder: 1,
    },
    {
      name: "Quero trabalhar em casa",
      icon: "🏠",
      description: "Soluções para teletrabalho produtivo e confortável.",
      sortOrder: 2,
    },
    {
      name: "Quero melhorar o meu PC",
      icon: "⚡",
      description: "Upgrades para dar nova vida ao teu computador.",
      sortOrder: 3,
    },
    {
      name: "Preciso de Wi-Fi melhor",
      icon: "📶",
      description: "Melhora a cobertura e velocidade da tua rede.",
      sortOrder: 4,
    },
    {
      name: "Preciso de armazenamento",
      icon: "💾",
      description: "SSDs e discos para guardar tudo o que precisas.",
      sortOrder: 5,
    },
    {
      name: "PC para empresa",
      icon: "🏢",
      description: "Soluções empresariais fiáveis e escaláveis.",
      sortOrder: 6,
    },
  ]).onConflictDoNothing();

  // Settings
  const settingsData = [
    { key: "site_name", value: "MD Tech Solutions", group: "general" },
    { key: "site_tagline", value: "Reparação Rápida. Soluções Completas.", group: "general" },
    { key: "company_name", value: "Marco Duarte Tech Solutions, Unipessoal Lda.", group: "general" },
    { key: "company_address", value: "Esposende, Portugal", group: "general" },
    { key: "company_phone", value: "+351 253 000 000", group: "general" },
    { key: "company_email", value: "info@mdtechsolutions.pt", group: "general" },
    { key: "company_nif", value: "", group: "general" },
    { key: "store_address", value: "Esposende, Braga, Portugal", group: "store" },
    { key: "store_hours", value: "Seg-Sex: 9:00-18:30 | Sáb: 9:00-13:00", group: "store" },
    { key: "store_pickup", value: "true", group: "store" },
    { key: "shipping_free_threshold_enabled", value: "true", group: "shipping" },
    { key: "shipping_free_threshold_cents", value: "10000", group: "shipping" },
    { key: "invoice_mode", value: "manual", group: "invoicing" },
    { key: "vat_rate", value: "23", group: "tax" },
    { key: "google_analytics_id", value: "", group: "analytics" },
    { key: "meta_pixel_id", value: "", group: "analytics" },
    { key: "smtp_host", value: "", group: "email" },
    { key: "smtp_port", value: "587", group: "email" },
    { key: "smtp_user", value: "", group: "email" },
    { key: "primary_color", value: "#0ea5e9", group: "theme" },
    { key: "accent_color", value: "#84cc16", group: "theme" },
  ];
  for (const s of settingsData) {
    await db.insert(settings).values(s).onConflictDoNothing();
  }

  // Legal Pages
  await db.insert(pages).values([
    { title: "Política de Privacidade", slug: "politica-privacidade", content: "Conteúdo da política de privacidade a definir pela empresa.", isPublished: true },
    { title: "Termos e Condições", slug: "termos-condicoes", content: "Conteúdo dos termos e condições a definir pela empresa.", isPublished: true },
    { title: "Política de Cookies", slug: "politica-cookies", content: "Conteúdo da política de cookies a definir pela empresa.", isPublished: true },
    { title: "Política de Devoluções", slug: "politica-devolucoes", content: "Conteúdo da política de devoluções a definir pela empresa.", isPublished: true },
    { title: "Garantias", slug: "garantias", content: "Informações sobre garantias a definir pela empresa.", isPublished: true },
    { title: "Sobre Nós", slug: "sobre-nos", content: "A Marco Duarte Tech Solutions é uma empresa de informática sediada em Esposende, dedicada à venda de tecnologia, reparação e assistência técnica.", isPublished: true },
  ]).onConflictDoNothing();

  console.log("✅ Seed completed!");
  process.exit(0);
}

// Only run when this file is executed directly (npm run db:seed / tsx),
// never when imported (e.g. by tests importing `assertSeedAllowed`).
const invokedDirectly = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("src/db/seed.ts");
if (invokedDirectly) {
  seed().catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  });
}
