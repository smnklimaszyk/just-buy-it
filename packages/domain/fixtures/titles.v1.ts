import type { ListingFlag, RejectReason } from "../src/classify/classify.js";
import type { FeedId, Segment } from "../src/segments.js";

// Golden titles for the classifier, version 1. Every title is synthetic: written for this repo,
// every detail invented. Change an expectation only together with the rule it covers.

export type GoldenTitle = {
  feed: FeedId;
  title: string;
  expected: { segment: Segment; flags?: ListingFlag[] } | { reason: RejectReason };
  // Listing fields other than the title; the test fills the rest with plain defaults
  // (fixed price, condition 3000 "Gebraucht", 100 ratings, shipping known).
  listing?: {
    buyingOptions?: string[];
    conditionId?: string;
    conditionText?: string;
    feedbackScore?: number;
    itemGroup?: boolean;
    shippingKnown?: boolean;
  };
};

type Opts = GoldenTitle["listing"];

const keep = (feed: FeedId, title: string, segment: Segment, flags?: ListingFlag[], listing?: Opts): GoldenTitle => ({
  feed,
  title,
  expected: flags ? { segment, flags } : { segment },
  ...(listing ? { listing } : {}),
});

const reject = (feed: FeedId, title: string, reason: RejectReason, listing?: Opts): GoldenTitle => ({
  feed,
  title,
  expected: { reason },
  ...(listing ? { listing } : {}),
});

export const GOLDEN_TITLES: GoldenTitle[] = [
  // GPU candidates and segment assignment
  keep("gpu", "NVIDIA GeForce RTX 3090 Founders Edition 24GB", "gpu_3090"),
  keep("gpu", "MSI RTX 3090 Gaming X Trio 24GB GDDR6X", "gpu_3090"),
  keep("gpu", "ASUS ROG Strix RTX 3090 Ti OC 24GB", "gpu_3090ti"),
  keep("gpu", "Zotac RTX 3090Ti AMP Extreme Holo", "gpu_3090ti"),
  keep("gpu", "Gigabyte RTX 4090 Gaming OC 24G", "gpu_4090"),
  keep("gpu", "RTX 4090 Founders Edition", "gpu_4090"),
  keep("gpu", "Palit GeForce RTX4090 GameRock OC", "gpu_4090"),
  keep("gpu", "Palit RTX 4090 Dual", "gpu_4090"),
  keep("gpu", "RTX 4090 DLSS 3 Grafikkarte", "gpu_4090"),
  keep("gpu", "R​TX 30​90 Founders", "gpu_3090"),
  keep("gpu", "RTX 3‍090 T​i 24GB", "gpu_3090ti"),
  keep("gpu", "Gainward RTX 3090 Phantom GS, Rechnung vorhanden", "gpu_3090"),
  keep("gpu", "Verkaufe meine RTX 3090 24GB", "gpu_3090"),
  keep("gpu", "RTX 3090 Ti 24 GB, Kaufbeleg liegt bei", "gpu_3090ti"),
  keep("gpu", "RTX 4090 Gaming OC, Garantie bis 2027", "gpu_4090"),
  // rule 8 must not fire
  keep("gpu", "RTX 3090 mit OVP und Rechnung", "gpu_3090"),
  keep("gpu", "RTX 4090 OVP vorhanden, 24GB", "gpu_4090"),
  keep("gpu", "RTX 3090 OVP nur kurz benutzt", "gpu_3090"),
  // rule 7 must not fire
  keep("gpu", "RTX 3090 nicht defekt, voll funktionsfähig", "gpu_3090"),
  keep("gpu", "RTX 3090 not broken, works fine", "gpu_3090"),
  keep("gpu", "RTX 4090 nicht beschädigt, 24GB", "gpu_4090"),
  keep("gpu", "RTX 3090 unbeschädigt mit OVP", "gpu_3090"),
  keep("gpu", "RTX 3090 keine Artefakte, 24GB", "gpu_3090"),
  keep("gpu", "RTX 4090 ohne Defekte, Founders", "gpu_4090"),
  // rule 10 must not fire
  keep("gpu", "RTX 4090 mit Wasserkühlung, Grafikkarte", "gpu_4090", ["custom_cooling"]),
  keep("gpu", "Inno3D RTX 4090 X3 OC mit EK Wasserblock, Grafikkarte", "gpu_4090", ["custom_cooling"]),
  keep("gpu", "Asus RTX 3090 TUF mit Backplate", "gpu_3090"),
  keep("gpu", "RTX 3090 FE inkl. Halterung (Anti-Sag)", "gpu_3090"),
  keep("gpu", "KFA2 RTX 3090 SG, Gehäuse nicht enthalten", "gpu_3090"),
  keep("gpu", "RTX 3090 Founders, Lüfter leise", "gpu_3090"),
  keep("gpu", "Zotac RTX 3090 Trinity mit Kühler", "gpu_3090"),
  keep("gpu", "RTX 3090 inkl. 2x 8-Pin Kabel", "gpu_3090"),
  // rule 11 must not fire
  keep("gpu", "RTX 3090 aus Gaming PC ausgebaut", "gpu_3090"),
  keep("gpu", "RTX 4090 für PC", "gpu_4090"),
  keep("gpu", "RTX 3090 PCIe 4.0", "gpu_3090"),
  keep("gpu", "RTX 3090 aus meinem Gaming PC, Ryzen System", "gpu_3090"),
  keep("gpu", "RTX 3090 ausgebaut aus Workstation, Xeon", "gpu_3090"),
  keep("gpu", "RTX 4090 from my gaming PC, 32GB RAM upgrade", "gpu_4090"),
  keep("gpu", "RTX 3090 Gaming PC Tower ausgebaut", "gpu_3090"),
  // rule 12 must not fire
  keep("gpu", "RTX 3090 2x HDMI 3x DP", "gpu_3090"),
  keep("gpu", "RTX 4090 versichert als DHL Paket", "gpu_4090"),
  keep("gpu", "RTX 3090 Slot Blende", "gpu_3090"),
  keep("gpu", "RTX 3090 aus Rig ausgebaut, 24GB", "gpu_3090"),
  keep("gpu", "RTX 4090 24GB, 1x benutzt", "gpu_4090"),
  // rule 14 must not fire
  keep("gpu", "RTX 3090 24GB GDDR6X", "gpu_3090"),
  // flags
  keep("gpu", "EVGA RTX 3090 FTW3 Ultra ungetestet", "gpu_3090", ["untested"]),
  keep("gpu", "RTX 3090 nicht getestet, 24GB", "gpu_3090", ["untested"]),
  keep("gpu", "RTX 3090 24GB, lief im Mining", "gpu_3090", ["mining_history"]),
  keep("gpu", "RTX 3090 Ti Ex-Miner Karte", "gpu_3090ti", ["mining_history"]),
  keep("gpu", "RTX 3090 Turbo nur Abholung", "gpu_3090", ["pickup_only"]),
  keep("gpu", "Nvidia RTX 3090, Abholung oder Versand", "gpu_3090", ["pickup_only"]),
  keep("gpu", "RTX 4090 Finanzierung möglich", "gpu_4090", ["financing"]),
  keep("gpu", "RTX 4090 auch auf Raten", "gpu_4090", ["financing"]),
  keep("gpu", "RTX 4090 Ratenkauf", "gpu_4090", ["financing"]),
  keep("gpu", "RTX 4090 Gaming OC, Preisvorschlag", "gpu_4090", ["best_offer"], { buyingOptions: ["FIXED_PRICE", "BEST_OFFER"] }),
  keep("gpu", "RTX 3090 Founders, B-Ware", "gpu_3090", ["open_box_or_refurbished"], { conditionId: "1500", conditionText: "Neu: Sonstige" }),
  keep("gpu", "RTX 3090 generalüberholt", "gpu_3090", ["open_box_or_refurbished"], { conditionId: "2500", conditionText: "Vom Verkäufer generalüberholt" }),
  keep("gpu", "RTX 4090 neues Konto", "gpu_4090", ["low_feedback"], { feedbackScore: 9 }),
  keep("gpu", "RTX 4090 zehn Bewertungen", "gpu_4090", [], { feedbackScore: 10 }),
  keep("gpu", "RTX 3090 Versand unklar", "gpu_3090", ["shipping_unknown"], { shippingKnown: false }),
  keep("gpu", "RTX 3090 Founders, Best Offer", "gpu_3090", ["best_offer"], { buyingOptions: ["BEST_OFFER"] }),
  keep("gpu", "RTX 3090 Mining, ungetestet, nur Abholung", "gpu_3090", ["untested", "mining_history", "pickup_only"]),

  // rules 1 to 4 (listing fields)
  reject("gpu", "RTX 3090 Founders Auktion", "auction", { buyingOptions: ["AUCTION"] }),
  keep("gpu", "RTX 3090 Founders Auktion mit Preisvorschlag", "gpu_3090", ["best_offer"], { buyingOptions: ["AUCTION", "BEST_OFFER"] }),
  reject("gpu", "RTX 3090 verschiedene Modelle", "item_group", { itemGroup: true }),
  reject("gpu", "", "no_title"),
  reject("gpu", "   ", "no_title"),
  reject("gpu", "​​", "no_title"),

  // rule 5 wanted_ad
  reject("gpu", "Suche RTX 4090", "wanted_ad"),
  reject("gpu", "Gesucht: RTX 3090", "wanted_ad"),
  reject("gpu", "WTB RTX 3090 Ti", "wanted_ad"),
  reject("gpu", "Ankauf RTX 4090 zu fairen Preisen", "wanted_ad"),
  reject("gpu", "Kaufe RTX 3090 sofort", "wanted_ad"),
  reject("gpu", "Suche RTX 4090 defekt", "wanted_ad"),

  // rule 6 rental
  reject("gpu", "RTX 4090 zur Miete", "rental"),
  reject("gpu", "RTX 4090 mieten pro Woche", "rental"),
  reject("gpu", "Vermiete RTX 3090", "rental"),
  reject("gpu", "RTX 4090 for rent", "rental"),
  reject("gpu", "RTX 4090 Leihe für Events", "rental"),

  // rule 7 defective
  reject("gpu", "RTX 3090 defekt", "defective"),
  reject("gpu", "RTX 3090 Defekter Speicher", "defective"),
  reject("gpu", "RTX 4090 für Bastler", "defective"),
  reject("gpu", "RTX 3090 Bastlerware", "defective"),
  reject("gpu", "RTX 3090 kein Bild", "defective"),
  reject("gpu", "RTX 3090 Artefakte", "defective"),
  reject("gpu", "RTX 3090 shows artifacts", "defective"),
  reject("gpu", "RTX 4090 not working", "defective"),
  reject("gpu", "RTX 3090 broken fan", "defective"),
  reject("gpu", "RTX 3090 funktioniert nicht", "defective"),
  reject("gpu", "RTX 3090 ohne Funktion", "defective"),
  reject("gpu", "RTX 3090 als Ersatzteil", "defective"),
  reject("gpu", "RTX 3090 for parts", "defective"),
  reject("gpu", "RTX 4090 beschädigt", "defective"),
  reject("gpu", "RTX 4090 damaged connector", "defective"),
  reject("gpu", "RTX 4090 kaputt", "defective"),
  reject("gpu", "RTX 4090 no signal", "defective"),
  reject("gpu", "RTX 3090 Founders", "defective", { conditionId: "7000", conditionText: "Als Ersatzteil / defekt" }),
  reject("gpu", "RTX 3090 Founders Edition", "defective", { conditionText: "Gebraucht, defekt" }),

  // rule 8 box_or_picture_only
  reject("gpu", "RTX 3090 nur OVP", "box_or_picture_only"),
  reject("gpu", "Nur die OVP RTX 4090", "box_or_picture_only"),
  reject("gpu", "RTX 3090 nur Verpackung", "box_or_picture_only"),
  reject("gpu", "RTX 4090 Box only", "box_or_picture_only"),
  reject("gpu", "RTX 4090 leere OVP", "box_or_picture_only"),
  reject("gpu", "RTX 3090 Karton ohne Inhalt", "box_or_picture_only"),
  reject("gpu", "RTX 4090 Empty Box", "box_or_picture_only"),
  reject("gpu", "RTX 4090 nur Foto", "box_or_picture_only"),
  reject("gpu", "Photo of RTX 4090", "box_or_picture_only"),

  // rule 9 laptop
  reject("gpu", "RTX 4090 Laptop GPU", "laptop"),
  reject("gpu", "Notebook RTX 4090 17 Zoll", "laptop"),
  reject("gpu", "RTX 3090 Max-Q", "laptop"),
  reject("gpu", "RTX 4090 Mobile GPU 16GB", "laptop"),

  // rule 10 accessory
  reject("gpu", "Wasserkühler für RTX 4090", "accessory"),
  reject("gpu", "EK Waterblock RTX 3090", "accessory"),
  reject("gpu", "Backplate für RTX 3090 FE", "accessory"),
  reject("gpu", "Kühlblock passend für RTX 4090", "accessory"),
  reject("gpu", "RTX 4090 Backplate", "accessory"),
  reject("gpu", "Lüfter für RTX 3090", "accessory"),
  reject("gpu", "Anti Sag Halterung RTX 4090", "accessory"),
  reject("gpu", "RTX 4090 Adapter Kabel 12VHPWR", "accessory"),
  reject("gpu", "Thermal Pad Set RTX 3090", "accessory"),
  reject("gpu", "Riser Kabel PCIe 4.0 RTX 4090", "accessory"),
  reject("gpu", "Gehäuse kompatibel RTX 4090", "accessory"),
  reject("gpu", "GPU Stütze für RTX 4090 Grafikkarte", "accessory"),
  reject("gpu", "Fan Shroud for RTX 3090", "accessory"),

  // rule 11 whole_pc_in_gpu_feed
  reject("gpu", "Gaming PC RTX 3090 Ryzen 7 5800X 32GB RAM 1TB SSD", "whole_pc_in_gpu_feed"),
  reject("gpu", "Komplett-PC RTX 4090 i9 13900K", "whole_pc_in_gpu_feed"),
  reject("gpu", "Workstation RTX 3090 Xeon 64 GB RAM", "whole_pc_in_gpu_feed"),
  reject("gpu", "Rechner mit RTX 4090, Intel Core i7, 2TB NVMe", "whole_pc_in_gpu_feed"),
  reject("gpu", "Gaming Tower RTX 3090 Ryzen 9", "whole_pc_in_gpu_feed"),
  reject("gpu", "Komplettsystem RTX 4090 mit SSD", "whole_pc_in_gpu_feed"),

  // rule 12 bundle
  reject("gpu", "2x RTX 3090", "bundle"),
  reject("gpu", "Konvolut 3x RTX 3090", "bundle"),
  reject("gpu", "Mining Rig 6x 3090", "bundle"),
  reject("gpu", "2 Stück RTX 4090 Founders", "bundle"),
  reject("gpu", "3 Stk. RTX 3090 Gaming", "bundle"),
  reject("gpu", "Bundle of RTX 3090 cards", "bundle"),
  reject("gpu", "Lot of 4 RTX 3090", "bundle"),
  reject("gpu", "10x RTX3090 Gaming", "bundle"),

  // rule 13 wrong_model
  reject("gpu", "RTX 3080 Ti 12GB", "wrong_model"),
  reject("gpu", "Grafikkarte NVIDIA 24GB", "wrong_model"),
  reject("gpu", "RTX 3090 oder 4090", "wrong_model"),
  reject("gpu", "RTX 4090D 24GB", "wrong_model"),
  reject("gpu", "RTX 4090 D China Version", "wrong_model"),
  reject("gpu", "RTX 4080 Super nicht 4090", "wrong_model"),
  reject("gpu", "Titan RTX 24GB wie 3090", "wrong_model"),
  reject("gpu", "AMD RX 7900 XTX statt RTX 4090", "wrong_model"),
  reject("gpu", "RTX 5090 32GB", "wrong_model"),
  reject("gpu", "RTX A6000 48GB", "wrong_model"),

  // rule 14 modded
  reject("gpu", "RTX 4090 48GB VRAM", "modded"),
  reject("gpu", "RTX 3090 BIOS Mod", "modded"),
  reject("gpu", "RTX 3090 VRAM Mod", "modded"),
  reject("gpu", "RTX 4090 umgelötet", "modded"),

  // RAM candidates
  keep("ram", "Corsair Vengeance LPX DDR4 32GB (2x16GB) 3200MHz", "ram_ddr4"),
  keep("ram", "G.Skill Trident Z5 DDR5 64GB 2x32GB 6000", "ram_ddr5"),
  keep("ram", "DDR4 32GB Non-ECC Unbuffered", "ram_ddr4"),
  keep("ram", "2x16GB DDR5 ohne ECC", "ram_ddr5"),
  keep("ram", "DDR4 64GB kein ECC", "ram_ddr4"),
  keep("ram", "Kingston Fury DDR5 Kit of 2 16GB 5600", "ram_ddr5"),
  keep("ram", "DDR4 128GB 4x32GB Desktop RAM", "ram_ddr4"),
  keep("ram", "DDR5 32GB 6000 nicht für Server", "ram_ddr5"),
  keep("ram", "DDR5 32GB 2x16 GB on-die ECC", "ram_ddr5"),
  keep("ram", "DDR4 32GB UDIMM Desktop", "ram_ddr4"),
  keep("ram", "DDR4 32GB Un-buffered 3600", "ram_ddr4"),
  keep("ram", "DDR5 32GB RGB, nur Abholung", "ram_ddr5", ["pickup_only"]),

  // rule 15 ram_laptop
  reject("ram", "SO-DIMM DDR4 32GB 2x16GB", "ram_laptop"),
  reject("ram", "DDR5 SODIMM 32GB", "ram_laptop"),
  reject("ram", "DDR4 32GB Laptop RAM", "ram_laptop"),
  reject("ram", "Notebook Speicher DDR5 32GB", "ram_laptop"),

  // rule 16 ram_server
  reject("ram", "DDR4 32GB ECC Registered", "ram_server"),
  reject("ram", "64GB DDR4 RDIMM", "ram_server"),
  reject("ram", "DDR5 ECC 2x16GB", "ram_server"),
  reject("ram", "DDR4 LRDIMM 128GB", "ram_server"),
  reject("ram", "DDR4 32GB REG ECC", "ram_server"),
  reject("ram", "DDR4 32GB Buffered", "ram_server"),
  reject("ram", "DDR4 64GB Server RAM", "ram_server"),
  reject("ram", "DDR5 32GB ECC UDIMM", "ram_server"),

  // rule 17 ram_capacity_unknown
  reject("ram", "DDR4 3200MHz CL16 Kit", "ram_capacity_unknown"),
  reject("ram", "DDR5 6000 RGB Arbeitsspeicher", "ram_capacity_unknown"),

  // rule 18 ram_too_small
  reject("ram", "DDR4 16GB 3200", "ram_too_small"),
  reject("ram", "DDR5 2x8GB 5600", "ram_too_small"),
  reject("ram", "Crucial DDR4 8GB", "ram_too_small"),

  // RAM, other rules
  reject("ram", "LRDIMM 128GB", "wrong_model"),
  reject("ram", "Arbeitsspeicher 32GB 3200MHz", "wrong_model"),
  reject("ram", "DDR3 32GB 1600", "wrong_model"),
  reject("ram", "DDR4 und DDR5 32GB Paket", "wrong_model"),
  reject("ram", "Suche DDR5 64GB", "wanted_ad"),
  reject("ram", "DDR4 32GB defekt", "defective"),
  reject("ram", "DDR5 32GB nur OVP", "box_or_picture_only"),

  // PC candidates
  keep("pc", "Gaming PC RTX 4090 Ryzen 7 7800X3D 32GB DDR5 2TB SSD", "pc_4090"),
  keep("pc", "Gaming PC RTX 4090 1000W Netzteil Lian Li Gehäuse AIO Kühler", "pc_4090"),
  keep("pc", "High End PC i9 13900K RTX4090 64GB", "pc_4090"),
  keep("pc", "Gaming PC RTX 4090 48GB DDR5 RAM", "pc_4090"),
  keep("pc", "Workstation mit RTX 4090 und Xeon", "pc_4090"),
  keep("pc", "Gaming PC RTX 4090 mit Wasserkühlung", "pc_4090"),
  keep("pc", "Gaming PC RTX 4090, Finanzierung möglich", "pc_4090", ["financing"]),

  // PC rejections
  reject("pc", "Gaming PC ohne Grafikkarte", "wrong_model"),
  reject("pc", "Gaming PC Ryzen 9 RTX 4090 ohne GPU", "wrong_model"),
  reject("pc", "Gaming PC RTX 4090 without GPU", "wrong_model"),
  reject("pc", "Gaming PC RTX 4090, no GPU", "wrong_model"),
  reject("pc", "Gaming PC RTX 3090 Ryzen 9", "wrong_model"),
  reject("pc", "Gaming Laptop RTX 4090 17 Zoll", "laptop"),
  reject("pc", "MSI Notebook RTX 4090", "laptop"),
  reject("pc", "Gaming PC RTX 4090 48GB VRAM", "modded"),
  reject("pc", "Gaming PC RTX 4090 BIOS Mod", "modded"),
  reject("pc", "Suche Gaming PC mit RTX 4090", "wanted_ad"),
  reject("pc", "Gaming PC RTX 4090 mieten", "rental"),
  reject("pc", "Gaming PC RTX 4090 defekt, startet nicht", "defective"),
  reject("pc", "Gaming PC RTX 4090 nur Foto", "box_or_picture_only"),
];
