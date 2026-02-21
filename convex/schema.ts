import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  devices: defineTable({
    deviceId: v.string(),
    revenueCatId: v.optional(v.string()),
    credits: v.number(),
    isPro: v.boolean(),
    lastCreditClaimDate: v.optional(v.string()), // ISO date string e.g. "2026-02-13"
    lastCreditClaimTimestamp: v.optional(v.number()), // Unix timestamp in ms
    createdAt: v.number(),
  })
    .index("by_deviceId", ["deviceId"])
    .index("by_revenueCatId", ["revenueCatId"]),

  toolUsage: defineTable({
    deviceId: v.string(),
    toolId: v.string(),
    createdAt: v.number(),
  })
    .index("by_deviceId", ["deviceId"])
    .index("by_deviceId_and_time", ["deviceId", "createdAt"]),

  feedback: defineTable({
    deviceId: v.string(),
    feedback: v.string(),
    email: v.optional(v.string()),
    imageId: v.optional(v.id("_storage")),
    createdAt: v.number(),
  }).index("by_deviceId", ["deviceId"]),
});
