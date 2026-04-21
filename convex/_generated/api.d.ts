/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as country from "../country.js";
import type * as devices from "../devices.js";
import type * as feedback from "../feedback.js";
import type * as http from "../http.js";
import type * as prompts from "../prompts.js";
import type * as pushover from "../pushover.js";
import type * as toolUsage from "../toolUsage.js";
import type * as tools from "../tools.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  country: typeof country;
  devices: typeof devices;
  feedback: typeof feedback;
  http: typeof http;
  prompts: typeof prompts;
  pushover: typeof pushover;
  toolUsage: typeof toolUsage;
  tools: typeof tools;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
