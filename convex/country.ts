"use node";

import { isIP } from "node:net";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const COUNTRY_LOOKUP_TIMEOUT_MS = 1_500;
const INVALID_COUNTRY_CODES = new Set(["XX", "T1", "A1", "A2", "AP", "EU"]);

function sanitizeCountryCode(countryCode?: string): string | undefined {
  const normalized = countryCode?.trim().toUpperCase();
  if (!normalized || !/^[A-Z]{2}$/.test(normalized)) {
    return undefined;
  }
  if (INVALID_COUNTRY_CODES.has(normalized)) {
    return undefined;
  }
  return normalized;
}

function countryNameFromCode(countryCode: string): string {
  const displayName = new Intl.DisplayNames(["en"], { type: "region" }).of(
    countryCode,
  );
  return displayName && displayName !== countryCode ? displayName : countryCode;
}

function sanitizeIpCandidate(ip?: string): string | undefined {
  const trimmed = ip?.trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;

  if (isIP(withoutBrackets)) {
    return withoutBrackets;
  }

  const ipv4PortMatch = withoutBrackets.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  if (ipv4PortMatch && isIP(ipv4PortMatch[1])) {
    return ipv4PortMatch[1];
  }

  return undefined;
}

async function lookupCountryFromIp(ip: string): Promise<
  | {
      countryName: string;
    }
  | null
> {
  const token = process.env.IPINFO_TOKEN;
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(
      `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`,
      {
        signal: AbortSignal.timeout(COUNTRY_LOOKUP_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      console.warn("IPinfo lookup failed", {
        ip,
        status: response.status,
      });
      return null;
    }

    const payload = (await response.json()) as {
      country_code?: string;
      country?: string;
    };

    const countryCode = sanitizeCountryCode(payload.country_code);
    if (!countryCode) {
      return null;
    }

    return {
      countryName: payload.country?.trim() || countryNameFromCode(countryCode),
    };
  } catch (error) {
    console.warn("IPinfo country lookup error", { ip, error });
    return null;
  }
}

export const enrichDeviceCountry = internalAction({
  args: {
    deviceId: v.string(),
    ip: v.optional(v.string()),
    countryHeader: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sanitizedIp = sanitizeIpCandidate(args.ip);
    const sanitizedCountryHeader = sanitizeCountryCode(args.countryHeader);

    let resolvedCountry:
      | {
          countryName: string;
        }
      | undefined;

    if (sanitizedCountryHeader) {
      resolvedCountry = {
        countryName: countryNameFromCode(sanitizedCountryHeader),
      };
    } else if (sanitizedIp) {
      const ipLookup = await lookupCountryFromIp(sanitizedIp);
      if (ipLookup) {
        resolvedCountry = ipLookup;
      }
    }

    if (resolvedCountry) {
      try {
        await ctx.runMutation(internal.devices.setCountry, {
          deviceId: args.deviceId,
          country: resolvedCountry.countryName,
        });
      } catch (error) {
        console.warn("Failed to apply resolved country", {
          deviceId: args.deviceId,
          error,
        });
      }
    }

    return {
      resolved: Boolean(resolvedCountry),
      countryName: resolvedCountry?.countryName,
    };
  },
});
