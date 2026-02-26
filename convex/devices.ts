import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
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
    if (
      args.deviceId.length > 255 ||
      (args.revenueCatId && args.revenueCatId.length > 255)
    ) {
      throw new Error("Invalid id length");
    }
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
      }
      // Return normalized record with defaults for optional fields
      return {
        deviceId: existing.deviceId,
        credits: existing.credits,
        isPro: existing.isPro,
        revenueCatId: args.revenueCatId ?? existing.revenueCatId,
        lastCreditClaimDate: existing.lastCreditClaimDate,
        lastCreditClaimTimestamp: existing.lastCreditClaimTimestamp,
        hasClaimedKeyboardSetupReward:
          existing.hasClaimedKeyboardSetupReward ?? false,
        adWatchSessionsToday: existing.adWatchSessionsToday ?? 0,
        lastAdWatchResetTimestamp: existing.lastAdWatchResetTimestamp,
        bonusAdClaimsToday: existing.bonusAdClaimsToday ?? 0,
        lastBonusAdResetTimestamp: existing.lastBonusAdResetTimestamp,
        hasClaimedReviewReward: existing.hasClaimedReviewReward ?? false,
        createdAt: existing.createdAt,
      };
    }

    // Create new device record
    const newId = await ctx.db.insert("devices", {
      deviceId: args.deviceId,
      revenueCatId: args.revenueCatId,
      credits: 0,
      isPro: false,
      lastCreditClaimDate: undefined,
      lastCreditClaimTimestamp: undefined,
      hasClaimedKeyboardSetupReward: false,
      adWatchSessionsToday: 0,
      lastAdWatchResetTimestamp: undefined,
      bonusAdClaimsToday: 0,
      lastBonusAdResetTimestamp: undefined,
      hasClaimedReviewReward: false,
      createdAt: Date.now(),
    });

    const device = await ctx.db.get(newId);
    if (!device) {
      throw new Error("Failed to create device record");
    }
    return {
      deviceId: device.deviceId,
      credits: device.credits,
      isPro: device.isPro,
      revenueCatId: device.revenueCatId,
      lastCreditClaimDate: device.lastCreditClaimDate,
      lastCreditClaimTimestamp: device.lastCreditClaimTimestamp,
      hasClaimedKeyboardSetupReward:
        device.hasClaimedKeyboardSetupReward ?? false,
      adWatchSessionsToday: device.adWatchSessionsToday ?? 0,
      lastAdWatchResetTimestamp: device.lastAdWatchResetTimestamp,
      bonusAdClaimsToday: device.bonusAdClaimsToday ?? 0,
      lastBonusAdResetTimestamp: device.lastBonusAdResetTimestamp,
      hasClaimedReviewReward: device.hasClaimedReviewReward ?? false,
      createdAt: device.createdAt,
    };
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

    // Check if 24 hours (86400000 ms) have passed since the last claim
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    if (
      device.lastCreditClaimTimestamp &&
      now - device.lastCreditClaimTimestamp < TWENTY_FOUR_HOURS
    ) {
      return {
        credits: device.credits,
        claimed: false,
        message: "You must wait 24 hours between claims",
        lastCreditClaimTimestamp: device.lastCreditClaimTimestamp,
      };
    }

    // Grant 5 credits (no accumulation — reset to 5)
    // You can decide if you want to simply add 5: const newCredits = device.credits + 5;
    // or reset to 5. The previous code says "add 5: newCredits = device.credits + 5"
    const newCredits = device.credits + 5;

    await ctx.db.patch(device._id, {
      credits: newCredits,
      lastCreditClaimDate: args.todayDate,
      lastCreditClaimTimestamp: now,
    });

    return {
      credits: newCredits,
      claimed: true,
      message: "5 credits claimed!",
      lastCreditClaimTimestamp: now,
    };
  },
});

/**
 * Claim keyboard setup reward (one-time only, 20 credits).
 * Even if the keyboard is disabled and re-enabled, this only rewards once.
 */
export const claimKeyboardSetupReward = mutation({
  args: {
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) {
      throw new Error("Device not found. Please register first.");
    }

    // Strict one-time enforcement
    if (device.hasClaimedKeyboardSetupReward) {
      return {
        credits: device.credits,
        claimed: false,
        message: "Keyboard setup reward already claimed",
      };
    }

    const newCredits = device.credits + 20;
    await ctx.db.patch(device._id, {
      credits: newCredits,
      hasClaimedKeyboardSetupReward: true,
    });

    return {
      credits: newCredits,
      claimed: true,
      message: "20 credits claimed for keyboard setup!",
    };
  },
});

/**
 * Claim ad watch reward (5 credits per session, up to 5 sessions per 24h).
 * Uses 24-hour timestamp-based reset like daily credits.
 */
export const claimAdWatchReward = mutation({
  args: {
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) {
      throw new Error("Device not found. Please register first.");
    }

    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    let sessionsToday = device.adWatchSessionsToday ?? 0;
    const lastResetTimestamp = device.lastAdWatchResetTimestamp;

    // Reset counter if 24 hours have passed
    if (!lastResetTimestamp || now - lastResetTimestamp >= TWENTY_FOUR_HOURS) {
      sessionsToday = 0;
    }

    if (sessionsToday >= 5) {
      return {
        credits: device.credits,
        claimed: false,
        sessionsCompleted: sessionsToday,
        message: "Daily ad watch limit reached (5/5)",
      };
    }

    const newSessions = sessionsToday + 1;
    const newCredits = device.credits + 5;
    const resetTimestamp =
      sessionsToday === 0 ? now : (lastResetTimestamp ?? now);

    await ctx.db.patch(device._id, {
      credits: newCredits,
      adWatchSessionsToday: newSessions,
      lastAdWatchResetTimestamp: resetTimestamp,
    });

    return {
      credits: newCredits,
      claimed: true,
      sessionsCompleted: newSessions,
      message: `5 credits claimed! (${newSessions}/5 sessions)`,
    };
  },
});

/**
 * Claim bonus ad reward (10 credits, up to 3 times per 24h).
 * Triggered after completing any task, as an optional extra.
 */
export const claimBonusAdReward = mutation({
  args: {
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) {
      throw new Error("Device not found. Please register first.");
    }

    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    let bonusToday = device.bonusAdClaimsToday ?? 0;
    const lastResetTimestamp = device.lastBonusAdResetTimestamp;

    // Reset counter if 24 hours have passed
    if (!lastResetTimestamp || now - lastResetTimestamp >= TWENTY_FOUR_HOURS) {
      bonusToday = 0;
    }

    if (bonusToday >= 3) {
      return {
        credits: device.credits,
        claimed: false,
        bonusClaimsToday: bonusToday,
        message: "Daily bonus ad limit reached (3/3)",
      };
    }

    const newBonus = bonusToday + 1;
    const newCredits = device.credits + 10;
    const resetTimestamp = bonusToday === 0 ? now : (lastResetTimestamp ?? now);

    await ctx.db.patch(device._id, {
      credits: newCredits,
      bonusAdClaimsToday: newBonus,
      lastBonusAdResetTimestamp: resetTimestamp,
    });

    return {
      credits: newCredits,
      claimed: true,
      bonusClaimsToday: newBonus,
      message: `10 bonus credits claimed! (${newBonus}/3 today)`,
    };
  },
});

/**
 * Claim app review reward (one-time only, 20 credits).
 * Granted after the user taps the review button.
 */
export const claimReviewReward = mutation({
  args: {
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) {
      throw new Error("Device not found. Please register first.");
    }

    // Strict one-time enforcement
    if (device.hasClaimedReviewReward) {
      return {
        credits: device.credits,
        claimed: false,
        message: "Review reward already claimed",
      };
    }

    const newCredits = device.credits + 20;
    await ctx.db.patch(device._id, {
      credits: newCredits,
      hasClaimedReviewReward: true,
    });

    return {
      credits: newCredits,
      claimed: true,
      message: "20 credits claimed for app review!",
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
      lastCreditClaimTimestamp: device.lastCreditClaimTimestamp,
      hasClaimedKeyboardSetupReward:
        device.hasClaimedKeyboardSetupReward ?? false,
      adWatchSessionsToday: device.adWatchSessionsToday ?? 0,
      lastAdWatchResetTimestamp: device.lastAdWatchResetTimestamp,
      bonusAdClaimsToday: device.bonusAdClaimsToday ?? 0,
      lastBonusAdResetTimestamp: device.lastBonusAdResetTimestamp,
      hasClaimedReviewReward: device.hasClaimedReviewReward ?? false,
    };
  },
});

/**
 * Internal variant of getDevice for use by HTTP actions.
 */
export const getDeviceInternal = internalQuery({
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
      lastCreditClaimTimestamp: device.lastCreditClaimTimestamp,
      hasClaimedKeyboardSetupReward:
        device.hasClaimedKeyboardSetupReward ?? false,
      adWatchSessionsToday: device.adWatchSessionsToday ?? 0,
      lastAdWatchResetTimestamp: device.lastAdWatchResetTimestamp,
      bonusAdClaimsToday: device.bonusAdClaimsToday ?? 0,
      lastBonusAdResetTimestamp: device.lastBonusAdResetTimestamp,
      hasClaimedReviewReward: device.hasClaimedReviewReward ?? false,
    };
  },
});
