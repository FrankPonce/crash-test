// The tester's own model. Per the spec (§3.2), a peer network runs on the caller's model,
// so the tester runs every network on one fixed, recorded model, whatever the network asks for.

import { LlmClient } from "../vendor/runtime/llm.js";

export const DEFAULT_ROUTER = "https://api.otari.ai/api/v1";
export const DEFAULT_MODEL = "alibaba/qwen3.8-flash";

/**
 * Build the tester's model client from environment variables.
 *
 * CRASHTEST_ROUTER  OpenAI-compatible base URL (default: hosted Otari)
 * CRASHTEST_API_KEY API key for that router (never logged)
 * CRASHTEST_MODEL   Model name (default: alibaba/qwen3.8-flash)
 *
 * :param env: The environment (process.env).
 * :return: {llm, model: {name, routerHost}}.
 * :raises Error: When no API key is set.
 */
export function modelFromEnv(env = process.env) {
  const baseUrl = (env.CRASHTEST_ROUTER || DEFAULT_ROUTER).replace(/\/$/, "");
  const apiKey = env.CRASHTEST_API_KEY || "";
  const name = env.CRASHTEST_MODEL || DEFAULT_MODEL;
  if (!apiKey) throw new Error("Set CRASHTEST_API_KEY (and optionally CRASHTEST_ROUTER, CRASHTEST_MODEL), for example in a .env file next to package.json.");
  const client = new LlmClient({ baseUrl, apiKey });
  return { llm: fixedModel(client, name), model: { name, routerHost: new URL(baseUrl).host } };
}

/**
 * Wrap a client so every call uses one model, regardless of the network's llm_config.
 *
 * :param client: Anything with chat(request).
 * :param name: The model name.
 * :return: A client with the same chat() interface.
 */
export function fixedModel(client, name) {
  return { chat: (request) => client.chat({ ...request, model: name }) };
}
