import { action, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import OpenAI from "openai";
import { buildFullPrompt } from "./prompts";
/**
 * Internal mutation: deduct 1 credit from a device.
 */
export const deductCredit = internalMutation({
  args: {
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (device && device.credits > 0) {
      await ctx.db.patch(device._id, {
        credits: device.credits - 1,
      });
    }
  },
});

/**
 * Internal mutation: log a tool usage entry.
 */
export const logToolUsage = internalMutation({
  args: {
    deviceId: v.string(),
    toolId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("toolUsage", {
      deviceId: args.deviceId,
      toolId: args.toolId,
      createdAt: Date.now(),
    });
  },
});
