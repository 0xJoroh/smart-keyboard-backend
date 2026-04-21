import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

function generateApiToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function isPushoverEnabled(): boolean {
  return process.env.PUSHOVER_ENABLED === "true";
}

function normalizeCountry(country?: string): string | undefined {
  const trimmed = country?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 100) {
    throw new Error("Invalid country length");
  }
  return trimmed;
}

function buildDeviceResponse(
  device: {
    deviceId: string;
    apiToken?: string;
    credits: number;
    isPro: boolean;
    revenueCatId?: string;
    country?: string;
    lastCreditClaimDate?: string;
    lastCreditClaimTimestamp?: number;
    hasClaimedKeyboardSetupReward?: boolean;
    adWatchSessionsToday?: number;
    lastAdWatchResetTimestamp?: number;
    bonusAdClaimsToday?: number;
    lastBonusAdResetTimestamp?: number;
    hasClaimedReviewReward?: boolean;
    hasClaimedQuickActionGift?: boolean;
    createdAt?: number;
  },
  overrides?: {
    revenueCatId?: string;
  },
) {
  return {
    deviceId: device.deviceId,
    apiToken: device.apiToken,
    credits: device.credits,
    isPro: device.isPro,
    revenueCatId: overrides?.revenueCatId ?? device.revenueCatId,
    country: device.country,
    lastCreditClaimDate: device.lastCreditClaimDate,
    lastCreditClaimTimestamp: device.lastCreditClaimTimestamp,
    hasClaimedKeyboardSetupReward:
      device.hasClaimedKeyboardSetupReward ?? false,
    adWatchSessionsToday: device.adWatchSessionsToday ?? 0,
    lastAdWatchResetTimestamp: device.lastAdWatchResetTimestamp,
    bonusAdClaimsToday: device.bonusAdClaimsToday ?? 0,
    lastBonusAdResetTimestamp: device.lastBonusAdResetTimestamp,
    hasClaimedReviewReward: device.hasClaimedReviewReward ?? false,
    hasClaimedQuickActionGift: device.hasClaimedQuickActionGift ?? false,
    createdAt: device.createdAt,
  };
}

const MAX_NOTIFICATION_ATTEMPTS = 4;
const NOTIFICATION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];

type PushoverSendResult = {
  sent: boolean;
  reason?:
    | "disabled"
    | "missing_credentials"
    | "api_error"
    | "timeout"
    | "network_error";
};

type NotificationProcessResult = {
  processed: boolean;
  sent?: boolean;
  reason?: string;
  retrying?: boolean;
  attempt?: number;
};

function isRetryableNotificationFailure(reason: string | undefined): boolean {
  return (
    reason === "api_error" ||
    reason === "network_error" ||
    reason === "timeout"
  );
}

function notificationRetryDelayMs(attempt: number): number {
  const index = Math.min(
    Math.max(0, attempt - 1),
    NOTIFICATION_RETRY_DELAYS_MS.length - 1,
  );
  return NOTIFICATION_RETRY_DELAYS_MS[index];
}

/**
 * Register a device. If the device already exists, return it.
 * Otherwise, create a new device record with 0 credits and isPro = false.
 */
export const registerDevice = mutation({
  args: {
    deviceId: v.string(),
    revenueCatId: v.optional(v.string()),
    country: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedCountry = normalizeCountry(args.country);
    const now = Date.now();

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
      const apiToken = existing.apiToken || generateApiToken();

      // If revenueCatId is provided and different, update it
      if (
        (args.revenueCatId && existing.revenueCatId !== args.revenueCatId) ||
        !existing.apiToken ||
        (normalizedCountry && existing.country !== normalizedCountry)
      ) {
        await ctx.db.patch(existing._id, {
          revenueCatId: args.revenueCatId,
          apiToken,
          country: normalizedCountry ?? existing.country,
        });
      }
      // Return normalized record with defaults for optional fields
      return buildDeviceResponse(
        {
          ...existing,
          apiToken,
          country: normalizedCountry ?? existing.country,
        },
        {
          revenueCatId: args.revenueCatId ?? existing.revenueCatId,
        },
      );
    }

    // Create new device record
    const apiToken = generateApiToken();
    const newId = await ctx.db.insert("devices", {
      deviceId: args.deviceId,
      apiToken,
      revenueCatId: args.revenueCatId,
      country: normalizedCountry,
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
      hasClaimedQuickActionGift: false,
      createdAt: now,
    });

    const device = await ctx.db.get(newId);
    if (!device) {
      throw new Error("Failed to create device record");
    }

    if (isPushoverEnabled()) {
      try {
        await ctx.scheduler.runAfter(
          30_000,
          (internal.devices as any).processNewUserNotification,
          {
            deviceId: device.deviceId,
            attempt: 0,
          },
        );
      } catch (error) {
        console.warn("Failed to schedule new-user notification fallback", {
          deviceId: device.deviceId,
          error,
        });
      }
    }

    return buildDeviceResponse(device);
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
 * Claim quick action gift (one-time only, 10 credits).
 */
export const claimQuickActionGift = mutation({
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
    if (device.hasClaimedQuickActionGift) {
      return {
        credits: device.credits,
        claimed: false,
        message: "Quick action gift already claimed",
      };
    }

    const newCredits = device.credits + 10;
    await ctx.db.patch(device._id, {
      credits: newCredits,
      hasClaimedQuickActionGift: true,
    });

    return {
      credits: newCredits,
      claimed: true,
      message: "10 credits claimed! Enjoy your gift! 🎁",
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
 * Synchronize Pro status from the client app.
 * Called when the client's RevenueCat SDK detects a change in Pro entitlements to ensure
 * instantaneous access without waiting for webhooks.
 */
export const syncProState = internalMutation({
  args: {
    deviceId: v.string(),
    isPro: v.boolean(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) {
      throw new Error("Device not found. Please register first.");
    }

    if (device.isPro !== args.isPro) {
      await ctx.db.patch(device._id, { isPro: args.isPro });
    }

    return { success: true, isPro: args.isPro };
  },
});

export const setCountry = internalMutation({
  args: {
    deviceId: v.string(),
    country: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) {
      return { updated: false };
    }

    if (device.country === args.country) {
      return { updated: false };
    }

    await ctx.db.patch(device._id, {
      country: args.country,
    });

    return { updated: true };
  },
});

export const processNewUserNotification = internalAction({
  args: {
    deviceId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<NotificationProcessResult> => {
    if (!isPushoverEnabled()) {
      return { processed: false, reason: "disabled" as const };
    }

    const device = await ctx.runQuery(
      internal.devices.getDeviceInternal as any,
      {
        deviceId: args.deviceId,
      },
    );

    if (!device) {
      return { processed: false, reason: "device_not_found" as const };
    }

    const notificationResult: PushoverSendResult = await ctx.runAction(
      internal.pushover.sendUserActionNotification,
      {
        action: "New User",
        deviceId: args.deviceId,
        country: device.country ?? "Unknown",
      },
    );

    if (notificationResult.sent) {
      return { processed: true, sent: true };
    }

    const attempt = args.attempt ?? 0;
    const shouldRetry =
      isRetryableNotificationFailure(notificationResult.reason) &&
      attempt + 1 < MAX_NOTIFICATION_ATTEMPTS;

    if (shouldRetry) {
      const nextAttempt = attempt + 1;
      try {
        await ctx.scheduler.runAfter(
          notificationRetryDelayMs(nextAttempt),
          (internal.devices as any).processNewUserNotification,
          {
            deviceId: args.deviceId,
            attempt: nextAttempt,
          },
        );
      } catch (error) {
        console.warn("Failed to schedule notification retry", {
          deviceId: args.deviceId,
          error,
        });
      }
    }

    return {
      processed: true,
      sent: false,
      reason: notificationResult.reason,
      retrying: shouldRetry,
      attempt,
    };
  },
}) as unknown as FunctionReference<
  "action",
  "internal",
  { deviceId: string; attempt?: number },
  NotificationProcessResult,
  string | undefined
>;

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

    return buildDeviceResponse(device);
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

    return buildDeviceResponse(device);
  },
});
