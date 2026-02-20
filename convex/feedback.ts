import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const submitFeedback = mutation({
  args: {
    deviceId: v.string(),
    feedback: v.string(),
    email: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const feedbackId = await ctx.db.insert("feedback", {
      deviceId: args.deviceId,
      feedback: args.feedback,
      email: args.email,
      imageId: args.storageId,
      createdAt: Date.now(),
    });
    return feedbackId;
  },
});
