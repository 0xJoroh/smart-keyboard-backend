import { action, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";

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
 * Execute an AI tool using Google Gemini.
 * Validates device, checks credits, calls Gemini, deducts credit if needed.
 */
export const executeTool = action({
  args: {
    deviceId: v.string(),
    toolId: v.string(),
    systemPrompt: v.optional(v.string()),
    userInput: v.string(),
    contextBefore: v.optional(v.string()),
    contextAfter: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    result?: string;
    variants?: string[];
    metadata?: Record<string, string>;
    error?: string;
  }> => {
    // 1. Query device record
    const device = await ctx.runQuery(api.devices.getDevice, {
      deviceId: args.deviceId,
    });

    if (!device) {
      throw new Error("Device not registered. Please register first.");
    }

    // 2. Check if user has credits or is Pro
    if (!device.isPro && device.credits <= 0) {
      return { error: "no_credits" };
    }

    // 3. Rate limiting — check recent usage (last 60 seconds)
    const recentUsage = await ctx.runQuery(api.toolUsage.getRecentUsage, {
      deviceId: args.deviceId,
      since: Date.now() - 60_000, // last 60 seconds
    });

    if (recentUsage.count > 20) {
      return { error: "rate_limited" };
    }

    // 4. Call Google Gemini API
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error("GEMINI_API_KEY not configured");
    }

    const modelName = "gemini-2.5-flash-lite";

    const fullPrompt = `
SYSTEM INSTRUCTION:
${args.systemPrompt || "You are a helpful writing assistant."}

CONTEXT BEFORE CURSOR:
"${args.contextBefore || ""}"

TEXT TO TRANSFORM:
"${args.userInput}"

CONTEXT AFTER CURSOR:
"${args.contextAfter || ""}"

TASK:
Transform the 'TEXT TO TRANSFORM' based on the system instruction. 
If the instruction asks for rephrasing, please provide 3 distinct versions.

OUTPUT FORMAT:
Return ONLY a JSON object with this structure:
{
  "result": "the primary improved version",
  "variants": ["version 1", "version 2", "version 3"]
}
`;

    try {
      // Use the Google GenAI SDK
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: geminiApiKey });

      const response = await ai.models.generateContent({
        model: modelName,
        contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      });

      const responseText = response.text ?? "";

      // Clean up JSON if Gemini wraps it in ```json ... ```
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      const cleanedJson = jsonMatch ? jsonMatch[0] : responseText;

      let finalData: {
        result?: string;
        text?: string;
        variants?: string[];
        metadata?: Record<string, string>;
      };
      try {
        finalData = JSON.parse(cleanedJson);
      } catch {
        console.error("Failed to parse Gemini output as JSON:", responseText);
        finalData = {
          result: responseText,
          variants: [responseText],
          metadata: { error: "Failed to parse structured JSON" },
        };
      }

      // 5. If not Pro, deduct 1 credit
      if (!device.isPro) {
        await ctx.runMutation(internal.tools.deductCredit, {
          deviceId: args.deviceId,
        });
      }

      // 6. Log usage
      await ctx.runMutation(internal.tools.logToolUsage, {
        deviceId: args.deviceId,
        toolId: args.toolId,
      });

      return {
        result: finalData.result || finalData.text || responseText,
        variants: finalData.variants || [],
        metadata: {
          model: modelName,
          tool: args.toolId,
        },
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Gemini API error:", errorMessage);
      throw new Error(`Failed to process AI request: ${errorMessage}`);
    }
  },
});
