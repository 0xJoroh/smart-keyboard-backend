import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import OpenAI from "openai";

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

      case "CANCELLATION":
      case "EXPIRATION":
      case "BILLING_ISSUE":
        isPro = false;
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
      systemPrompt?: string;
      userInput: string;
      previousResults?: string[];
    };

    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { deviceId, toolId, systemPrompt, userInput, previousResults } = body;

    if (!deviceId || !toolId || !userInput) {
      return new Response(JSON.stringify({ error: "missing_fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Enforce 2-word minimum
    const wordCount = userInput.trim().split(/\s+/).length;
    if (wordCount < 2) {
      return new Response(JSON.stringify({ error: "too_short" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Query device record
    const device = await ctx.runQuery(internal.devices.getDeviceInternal, {
      deviceId,
    });

    if (!device) {
      return new Response(JSON.stringify({ error: "device_not_found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Check if user has credits or is Pro
    if (!device.isPro && device.credits <= 0) {
      return new Response(JSON.stringify({ error: "no_credits" }), {
        status: 200,
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

    if (recentUsage.count > 20) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Prepare OpenRouter streaming call
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      return new Response(JSON.stringify({ error: "ai_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const modelName = "arcee-ai/trinity-large-preview:free";

    const promptContent = buildPrompt({
      systemPrompt: systemPrompt || "You are a helpful writing assistant.",
      toolId,
      userInput,
      previousResults,
    });

    // Create OpenAI client pointed at OpenRouter
    const openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: openRouterApiKey,
      defaultHeaders: {
        "HTTP-Referer": "https://smartkeyboard.ai",
        "X-Title": "Smart Keyboard",
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

// Helper: build the prompt context
function buildPrompt(opts: {
  systemPrompt: string;
  toolId: string;
  userInput: string;
  previousResults?: string[];
}): string {
  return `
SYSTEM INSTRUCTION:
${opts.systemPrompt}

${
  opts.toolId === "fix-mistakes"
    ? `SPECIFIC INSTRUCTION:
For each mistake, keep the original sentence structure. 
Mark incorrect words with #wrong# and place the correction in [correct] immediately after.
Example: I #goed# [went] to school yesterday.
Only mark actual errors. Do not rewrite the sentence unless absolutely necessary.`
    : ""
}

USER TEXT:
"${opts.userInput}"

TASK:
Improve or transform the 'USER TEXT' strictly following the SYSTEM INSTRUCTION. 
Provide the complete improved version of the text.
Return ONLY the improved text directly, without any JSON wrapping, markdown formatting, or extra commentary.

${
  opts.previousResults && opts.previousResults.length > 0
    ? `
IMPORTANT: You have already generated the following results for this text. 
DO NOT repeat or closely rephrase any of them. Generate a meaningfully different version.
PREVIOUS RESULTS:
${opts.previousResults.map((r, i) => `${i + 1}. "${r}"`).join("\n")}
`
    : ""
}
`;
}

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
