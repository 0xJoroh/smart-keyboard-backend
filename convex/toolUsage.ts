import { query } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Get recent tool usage count for a device (for rate limiting).
 */
export const getRecentUsage = query({
  args: {
    deviceId: v.string(),
    since: v.number(), // timestamp in ms
  },
  handler: async (ctx, args) => {
    const usages = await ctx.db
      .query("toolUsage")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .filter((q) => q.gte(q.field("createdAt"), args.since))
      .collect();

    return { count: usages.length };
  },
});
