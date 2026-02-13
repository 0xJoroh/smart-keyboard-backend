import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

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
