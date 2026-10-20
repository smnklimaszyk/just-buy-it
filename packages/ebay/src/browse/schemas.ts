import { z } from "zod";

// Browse item_summary/search, checked against the Browse OpenAPI file in openapi/browse.lock.json
// by `pnpm --filter @ebay-sniper/ebay openapi:check`.
// z.object strips undeclared keys, so seller.username, seller.userId and sellerLegalInfo never
// get past the parse (ADR 0013). Do not make these schemas loose.

const amount = z.object({ value: z.string(), currency: z.string() });

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
  shippingOptions: z
    .array(z.object({ shippingCostType: z.string().optional(), shippingCost: amount.optional() }))
    .optional(),
  itemLocation: z.object({ country: z.string().optional() }).optional(),
  seller: z
    .object({
      feedbackPercentage: z.string().optional(),
      feedbackScore: z.number().int().optional(),
      sellerAccountType: z.string().optional(),
    })
    .optional(),
  itemCreationDate: z.iso.datetime().optional(),
  itemEndDate: z.iso.datetime().optional(),
  itemWebUrl: z.string().optional(),
  image: z.object({ imageUrl: z.string().optional() }).optional(),
  bidCount: z.number().int().optional(),
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
