"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 2_000;

function isPushoverEnabled(): boolean {
  return process.env.PUSHOVER_ENABLED === "true";
}

function normalizeCountry(country?: string): string {
  const trimmed = country?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Unknown";
}

function toDevicePreview(deviceId: string): string {
  return deviceId.slice(0, 5);
}

export const sendUserActionNotification = internalAction({
  args: {
    action: v.string(),
    deviceId: v.string(),
    country: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    if (!isPushoverEnabled()) {
      return { sent: false, reason: "disabled" as const };
    }

    const appToken = process.env.PUSHOVER_APP_TOKEN;
    const userKey = process.env.PUSHOVER_USER_KEY;

    if (!appToken || !userKey) {
      console.warn("Pushover is enabled but credentials are missing");
      return { sent: false, reason: "missing_credentials" as const };
    }

    const title = args.action;
    const message = `Device: ${toDevicePreview(args.deviceId)}... From: ${normalizeCountry(args.country)}`;

    try {
      const response = await fetch(PUSHOVER_API_URL, {
        method: "POST",
        signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: appToken,
          user: userKey,
          title,
          message,
        }),
      });

      const rawPayload = await response.text();
      const payload = (rawPayload ? JSON.parse(rawPayload) : {}) as {
        status?: number;
        request?: string;
        errors?: string[];
      };

      if (!response.ok || payload.status !== 1) {
        console.warn("Pushover notification failed", {
          httpStatus: response.status,
          request: payload.request,
          errors: payload.errors,
        });
        return { sent: false, reason: "api_error" as const };
      }

      return {
        sent: true,
        request: payload.request,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        console.error("Pushover notification timed out");
        return { sent: false, reason: "timeout" as const };
      }
      console.error("Pushover notification error", error);
      return { sent: false, reason: "network_error" as const };
    }
  },
});
