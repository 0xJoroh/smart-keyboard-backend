import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Register a device. If the device already exists, return it.
 * Otherwise, create a new device record with 0 credits and isPro = false.
 */
export const registerDevice = mutation({
  args: {
    deviceId: v.string(),
    revenueCatId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check if device already exists
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (existing) {
      // If revenueCatId is provided and different, update it
      if (args.revenueCatId && existing.revenueCatId !== args.revenueCatId) {
        await ctx.db.patch(existing._id, {
          revenueCatId: args.revenueCatId,
        });
        return { ...existing, revenueCatId: args.revenueCatId };
      }
      return existing;
    }

    // Create new device record
    const deviceId = await ctx.db.insert("devices", {
      deviceId: args.deviceId,
      revenueCatId: args.revenueCatId,
      credits: 0,
      isPro: false,
      lastCreditClaimDate: undefined,
      createdAt: Date.now(),
    });

    const device = await ctx.db.get(deviceId);
    return device;
  },
});

/**
 * Claim daily credits. Adds 5 credits if not already claimed today.
 * The client sends the current date in their timezone as an ISO date string.
 */
export const claimDailyCredits = mutation({
  args: {
    deviceId: v.string(),
    todayDate: v.string(), // ISO date string e.g. "2026-02-13"
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) {
      throw new Error("Device not found. Please register first.");
    }

    // Check if credits were already claimed today
    if (device.lastCreditClaimDate === args.todayDate) {
      return {
        credits: device.credits,
        claimed: false,
        message: "Credits already claimed today",
      };
    }

    // Grant 5 credits (no accumulation — reset to 5)
    const newCredits = device.credits + 5;
    await ctx.db.patch(device._id, {
      credits: newCredits,
      lastCreditClaimDate: args.todayDate,
    });

    return {
      credits: newCredits,
      claimed: true,
      message: "5 credits claimed!",
    };
  },
});

/**
 * Internal mutation to update Pro status from RevenueCat webhook.
 * Not exposed to clients — only callable from other Convex functions.
 */
export const updateProStatus = internalMutation({
  args: {
    revenueCatId: v.string(),
    isPro: v.boolean(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_revenueCatId", (q) =>
        q.eq("revenueCatId", args.revenueCatId),
      )
      .unique();

    if (!device) {
      // Also try matching by deviceId since we use deviceId as revenueCatId
      const deviceById = await ctx.db
        .query("devices")
        .withIndex("by_deviceId", (q) => q.eq("deviceId", args.revenueCatId))
        .unique();

      if (!deviceById) {
        console.warn(`Device not found for revenueCatId: ${args.revenueCatId}`);
        return;
      }

      await ctx.db.patch(deviceById._id, { isPro: args.isPro });
      return;
    }

    await ctx.db.patch(device._id, { isPro: args.isPro });
  },
});

/**
 * Get device record by deviceId.
 * Used by the iOS app to display credit count and Pro status.
 */
export const getDevice = query({
  args: {
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) {
      return null;
    }

    return {
      deviceId: device.deviceId,
      credits: device.credits,
      isPro: device.isPro,
      revenueCatId: device.revenueCatId,
      lastCreditClaimDate: device.lastCreditClaimDate,
    };
  },
});
