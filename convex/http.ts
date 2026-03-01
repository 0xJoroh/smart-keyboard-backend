import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import OpenAI from "openai";
import { buildFullPrompt } from "./prompts";

const http = httpRouter();

/**
 * RevenueCat Webhook Handler
 *
 * Receives webhook events from RevenueCat and updates device Pro status.
 * Validates the authorization header against the stored secret.
 *
 * RevenueCat webhook events reference:
 * https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
 */
http.route({
  path: "/webhooks/revenuecat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Validate authorization header
    const webhookSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("REVENUECAT_WEBHOOK_SECRET not configured");
      return new Response("Server configuration error", { status: 500 });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${webhookSecret}`) {
      console.warn("Invalid webhook authorization header");
      return new Response("Unauthorized", { status: 401 });
    }

    // Parse the webhook body
    let body: RevenueCatWebhookEvent;
    try {
      body = (await request.json()) as RevenueCatWebhookEvent;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const event = body.event;
    if (!event) {
      return new Response("Missing event in body", { status: 400 });
    }

    const eventType = event.type;
    const appUserId = event.app_user_id; // This is our device UUID

    if (!appUserId) {
      console.warn("Webhook event missing app_user_id:", eventType);
      return new Response("Missing app_user_id", { status: 400 });
    }

    console.log(`RevenueCat webhook: ${eventType} for user ${appUserId}`);

    // Determine Pro status based on event type
    let isPro: boolean | null = null;

    switch (eventType) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "PRODUCT_CHANGE":
      case "UNCANCELLATION":
        isPro = true;
        break;

      case "EXPIRATION": // User loses access only at expiration
        isPro = false;
        break;

      case "CANCELLATION":
      case "BILLING_ISSUE":
        // DO NOT change `isPro` status here!
        // CANCELLATION means they disabled auto-renew but still have access until EXPIRATION.
        // BILLING_ISSUE usually means they are in a grace period where access is maintained.
        console.log(
          `User ${appUserId} had ${eventType}. We wait for EXPIRATION to strip Pro status.`,
        );
        break;

      case "TRANSFER":
        // On transfer, the new user gets Pro
        // The app_user_id in the event is the new owner
        isPro = true;
        break;

      default:
        // For events we don't handle (e.g., NON_RENEWING_PURCHASE, SUBSCRIBER_ALIAS, TEST)
        console.log(`Unhandled RevenueCat event type: ${eventType}`);
        return new Response("OK", { status: 200 });
    }

    if (isPro !== null) {
      // Update Pro status in the database
      await ctx.runMutation(internal.devices.updateProStatus, {
        revenueCatId: appUserId,
        isPro,
      });
    }

    return new Response("OK", { status: 200 });
  }),
});

/**
 * Streaming AI Tool Execution Endpoint
 *
 * This HTTP endpoint handles streaming AI responses via OpenRouter.
 * It validates the device, checks credits, streams the response as SSE,
 * and deducts credits + logs usage after successful completion.
 *
 * Protocol: Server-Sent Events (SSE)
 * Events:
 *   - data: {"chunk": "text"} — a streamed text chunk
 *   - data: {"done": true, "fullText": "..."} — stream complete
 *   - data: {"error": "error_code"} — an error occurred
 */
http.route({
  path: "/api/executeTool",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Parse request body
    let body: {
      deviceId: string;
      toolId: string;
      userInput: string;
      previousResults?: string[];
      metadata?: Record<string, string>;
    };

    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { deviceId, toolId, userInput, previousResults, metadata } = body;

    if (!deviceId || !toolId || !userInput) {
      return new Response(JSON.stringify({ error: "missing_fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 0. Emergency Kill Switch
    if (process.env.KILL_SWITCH === "true") {
      return new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 0.5 Maximum Input / Context Length Safeguards
    const MAX_INPUT_LENGTH = 6000; // About ~1500 tokens
    if (userInput.length > MAX_INPUT_LENGTH) {
      return new Response(JSON.stringify({ error: "input_too_long" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Limit previousResults to prevent huge arrays or massive text
    if (previousResults) {
      if (previousResults.length > 5) {
        return new Response(
          JSON.stringify({ error: "too_many_previous_results" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      for (const res of previousResults) {
        if (typeof res !== "string" || res.length > 2000) {
          return new Response(
            JSON.stringify({ error: "previous_result_too_long" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
    }

    // 1. Enforce 2-word minimum (except for find-synonyms which requires exactly 1 word)
    const wordCount = userInput.trim().split(/\s+/).length;
    if (toolId === "find-synonyms") {
      if (wordCount !== 1) {
        return new Response(JSON.stringify({ error: "too_short" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    } else {
      if (wordCount < 2) {
        return new Response(JSON.stringify({ error: "too_short" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 2. Query device record
    const device = await ctx.runQuery(internal.devices.getDeviceInternal, {
      deviceId,
    });

    if (!device) {
      return new Response(JSON.stringify({ error: "device_not_found" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Check if user has credits or is Pro
    if (!device.isPro && device.credits <= 0) {
      return new Response(JSON.stringify({ error: "no_credits" }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Rate limiting — check recent usage (last 60 seconds)
    const recentUsage = await ctx.runQuery(
      internal.toolUsage.getRecentUsageInternal,
      {
        deviceId,
        since: Date.now() - 60_000,
      },
    );

    if (recentUsage.count > 15) {
      // Adjusted from 20 for stricter control
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4.5. Daily Usage Limit for Paid Users
    if (device.isPro) {
      const dailyUsage = await ctx.runQuery(
        internal.toolUsage.getRecentUsageInternal,
        {
          deviceId,
          since: Date.now() - 24 * 60 * 60 * 1000,
        },
      );

      const PRO_DAILY_LIMIT = 500; // Generous but bounded daily usage
      if (dailyUsage.count > PRO_DAILY_LIMIT) {
        console.warn(
          `[Abuse Prevented] Pro user ${deviceId} hit daily limit (${dailyUsage.count} requests).`,
        );
        return new Response(JSON.stringify({ error: "daily_limit_exceeded" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 5. Prepare OpenRouter streaming call
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      return new Response(JSON.stringify({ error: "ai_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const modelName = "google/gemma-3-27b-it:free";

    const promptContent = buildFullPrompt({
      toolId,
      userInput,
      previousResults,
      metadata,
    });

    console.log(
      `[Usage] Device: ${deviceId}, IsPro: ${device.isPro}, Tool: ${toolId}, Input Length: ${userInput.length}`,
    );

    // Create OpenAI client pointed at OpenRouter
    const openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: openRouterApiKey,
      defaultHeaders: {
        "X-Title": "Smart Keyboard App",
      },
    });

    // 6. Stream response via SSE
    const encoder = new TextEncoder();
    let fullText = "";

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const completion = await openai.chat.completions.create({
            model: modelName,
            messages: [{ role: "user", content: promptContent }],
            stream: true,
            max_tokens: 600, // Limit AI response length to prevent huge token costs
            stream_options: { include_usage: true },
          });

          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ chunk: delta })}\n\n`),
              );
            }
          }

          // Extract the actual result from JSON if the model wrapped it
          let finalResult = fullText;
          try {
            const jsonMatch = fullText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.result) {
                finalResult = parsed.result;
              }
            }
          } catch {
            // If JSON parsing fails, use the raw text
          }

          // Truncate response if it's too long
          if (finalResult.length > 5000) {
            console.warn(
              `[Cost Control] Response from ${toolId} exceeded length expectation. Truncating.`,
            );
            finalResult = finalResult.substring(0, 5000) + "...";
          }

          // Send completion event
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ done: true, fullText: finalResult })}\n\n`,
            ),
          );

          // 7. Deduct credits + log usage (after successful stream)
          if (!device.isPro) {
            await ctx.runMutation(internal.tools.deductCredit, {
              deviceId,
            });
          }
          await ctx.runMutation(internal.tools.logToolUsage, {
            deviceId,
            toolId,
          });

          controller.close();
        } catch (error) {
          const errorString = String(error);
          console.error("OpenRouter streaming error:", errorString);

          let errorCode = "ai_failed";
          if (errorString.includes("429")) {
            errorCode = "ai_quota_exceeded";
          }

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: errorCode })}\n\n`),
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }),
});

// CORS preflight for the streaming endpoint
http.route({
  path: "/api/executeTool",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

/**
 * Check Credits Endpoint
 *
 * Lightweight endpoint to verify if a user has remaining credits or is Pro.
 * Called by the keyboard extension before starting text extraction.
 */
http.route({
  path: "/api/checkCredits",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let body: { deviceId: string };
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Emergency Kill Switch
    if (process.env.KILL_SWITCH === "true") {
      return new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { deviceId } = body;
    if (!deviceId) {
      return new Response(JSON.stringify({ error: "missing_deviceId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const device = await ctx.runQuery(internal.devices.getDeviceInternal, {
      deviceId,
    });

    if (!device) {
      return new Response(JSON.stringify({ error: "device_not_found" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!device.isPro && device.credits <= 0) {
      return new Response(JSON.stringify({ error: "no_credits" }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// CORS preflight for the checkCredits endpoint
http.route({
  path: "/api/checkCredits",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// Type definitions for RevenueCat webhook events
interface RevenueCatWebhookEvent {
  api_version: string;
  event: {
    type: string;
    app_user_id: string;
    original_app_user_id?: string;
    aliases?: string[];
    product_id?: string;
    entitlement_ids?: string[];
    period_type?: string;
    purchased_at_ms?: number;
    expiration_at_ms?: number;
    environment?: string;
    store?: string;
    is_trial_conversion?: boolean;
    cancel_reason?: string;
    price_in_purchased_currency?: number;
    currency?: string;
    subscriber_attributes?: Record<
      string,
      { value: string; updated_at_ms: number }
    >;
  };
}

export default http;
