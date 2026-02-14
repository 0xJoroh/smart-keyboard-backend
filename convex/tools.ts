import { action, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import OpenAI from "openai";

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

/**
 * Execute an AI tool using OpenRouter (non-streaming fallback).
 * The primary streaming endpoint is in http.ts.
 * This action is kept for backward compatibility.
 */
export const executeTool = action({
  args: {
    deviceId: v.string(),
    toolId: v.string(),
    systemPrompt: v.optional(v.string()),
    userInput: v.string(),
    previousResults: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    result?: string;
    metadata?: Record<string, string>;
    error?: string;
  }> => {
    // 1. Enforce 2-word minimum
    const wordCount = args.userInput.trim().split(/\s+/).length;
    if (wordCount < 2) {
      return { error: "too_short" };
    }

    // 2. Query device record
    const device = await ctx.runQuery(api.devices.getDevice, {
      deviceId: args.deviceId,
    });

    if (!device) {
      throw new Error("Device not registered. Please register first.");
    }

    // 3. Check if user has credits or is Pro
    if (!device.isPro && device.credits <= 0) {
      return { error: "no_credits" };
    }

    // 4. Rate limiting
    const recentUsage = await ctx.runQuery(api.toolUsage.getRecentUsage, {
      deviceId: args.deviceId,
      since: Date.now() - 60_000,
    });

    if (recentUsage.count > 20) {
      return { error: "rate_limited" };
    }

    // 5. Call OpenRouter via OpenAI SDK
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY not configured");
    }

    const modelName = "arcee-ai/trinity-large-preview:free";

    const openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: openRouterApiKey,
      defaultHeaders: {
        "HTTP-Referer": "https://smartkeyboard.ai",
        "X-Title": "Smart Keyboard",
      },
    });

    let promptContext = `
SYSTEM INSTRUCTION:
${args.systemPrompt || "You are a helpful writing assistant."}

${
  args.toolId === "fix-mistakes"
    ? `SPECIFIC INSTRUCTION:
For each mistake, keep the original sentence structure. 
Mark incorrect words with #wrong# and place the correction in [correct] immediately after.
Example: I #goed# [went] to school yesterday.
Only mark actual errors. Do not rewrite the sentence unless absolutely necessary.`
    : ""
}

USER TEXT:
"${args.userInput}"

TASK:
Improve or transform the 'USER TEXT' strictly following the SYSTEM INSTRUCTION. 
Provide the complete improved version of the text.
Return ONLY the improved text directly, without any JSON wrapping, markdown formatting, or extra commentary.

${
  args.previousResults && args.previousResults.length > 0
    ? `
IMPORTANT: You have already generated the following results for this text. 
DO NOT repeat or closely rephrase any of them. Generate a meaningfully different version.
PREVIOUS RESULTS:
${args.previousResults.map((r, i) => `${i + 1}. "${r}"`).join("\n")}
`
    : ""
}
`;

    try {
      const completion = await openai.chat.completions.create({
        model: modelName,
        messages: [{ role: "user", content: promptContext }],
      });

      const responseText = completion.choices[0]?.message?.content || "";

      // 6. If not Pro, deduct 1 credit
      if (!device.isPro) {
        await ctx.runMutation(internal.tools.deductCredit, {
          deviceId: args.deviceId,
        });
      }

      // 7. Log usage
      await ctx.runMutation(internal.tools.logToolUsage, {
        deviceId: args.deviceId,
        toolId: args.toolId,
      });

      return {
        result: responseText,
        metadata: {
          model: modelName,
          tool: args.toolId,
        },
      };
    } catch (error: unknown) {
      const errorString = String(error);
      console.error("OpenRouter API error:", errorString);

      if (errorString.includes("429")) {
        return { error: "ai_quota_exceeded" };
      }

      return { error: "ai_failed" };
    }
  },
});
