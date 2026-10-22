import { z } from "zod";

// Browse item_summary/search and getItem, checked against the Browse OpenAPI file in openapi/browse.lock.json
// by `pnpm --filter @ebay-sniper/ebay openapi:check`.
// z.object strips undeclared keys, so seller.username, seller.userId and sellerLegalInfo never
// get past the parse (ADR 0013). Do not make these schemas loose.

const amount = z.object({ value: z.string(), currency: z.string() });
const shippingOptions = z.array(
  z.object({ shippingCostType: z.string().optional(), shippingCost: amount.optional() }),
);
// Country only: the postal code and city are never kept.
const itemLocation = z.object({ country: z.string().optional() });
// No username, userId or sellerLegalInfo (A23).
const seller = z.object({
  feedbackPercentage: z.string().optional(),
  feedbackScore: z.number().int().optional(),
  sellerAccountType: z.string().optional(),
});

// errorId is optional so one odd warning cannot fail a page whose unit is already spent.
export const errorDetailSchema = z.object({
  errorId: z.number().int().optional(),
  category: z.string().optional(),
  domain: z.string().optional(),
});

export const itemSummarySchema = z.object({
  itemId: z.string(),
  legacyItemId: z.string().optional(),
  title: z.string().optional(),
  price: amount.optional(),
  currentBidPrice: amount.optional(),
  buyingOptions: z.array(z.string()).optional(),
  itemGroupType: z.string().optional(),
  itemGroupHref: z.string().optional(),
  leafCategoryIds: z.array(z.string()).optional(),
  categories: z.array(z.object({ categoryId: z.string(), categoryName: z.string().optional() })).optional(),
  condition: z.string().optional(),
  conditionId: z.string().optional(),
  shippingOptions: shippingOptions.optional(),
  itemLocation: itemLocation.optional(),
  seller: seller.optional(),
  itemCreationDate: z.iso.datetime().optional(),
  itemEndDate: z.iso.datetime().optional(),
  itemWebUrl: z.string().optional(),
  image: z.object({ imageUrl: z.string().optional() }).optional(),
  bidCount: z.number().int().optional(),
});

// Browse getItem. responsiblePersons, the seller's identity and the manufacturer address are not
// declared, so the parse drops them.
export const itemSchema = z.object({
  itemId: z.string(),
  legacyItemId: z.string().optional(),
  title: z.string().optional(),
  price: amount.optional(),
  buyingOptions: z.array(z.string()).optional(),
  categoryId: z.string().optional(),
  condition: z.string().optional(),
  conditionId: z.string().optional(),
  conditionDescription: z.string().optional(),
  // Seller HTML; cleaned and masked in the domain before it is stored or sent anywhere.
  description: z.string().optional(),
  localizedAspects: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  shippingOptions: shippingOptions.optional(),
  itemLocation: itemLocation.optional(),
  seller: seller.optional(),
  returnTerms: z
    .object({
      returnsAccepted: z.boolean().optional(),
      returnPeriod: z.object({ value: z.number().int(), unit: z.string() }).optional(),
    })
    .optional(),
  image: z.object({ imageUrl: z.string().optional() }).optional(),
  additionalImages: z.array(z.object({ imageUrl: z.string().optional() })).optional(),
  itemCreationDate: z.iso.datetime().optional(),
  itemEndDate: z.iso.datetime().optional(),
});

export const searchPageSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  next: z.string().optional(),
  warnings: z.array(errorDetailSchema).optional(),
  // Each item is parsed on its own, so one bad item does not fail the page.
  itemSummaries: z.array(z.unknown()).optional(),
});

export type EbayErrorDetail = z.infer<typeof errorDetailSchema>;
export type ItemSummary = z.infer<typeof itemSummarySchema>;
export type Item = z.infer<typeof itemSchema>;
