// The tester's own model. Per the spec (§3.2), a peer network runs on the caller's model,
// so the tester runs every network on one fixed, recorded model, whatever the network asks for.

import { LlmClient } from "../vendor/runtime/llm.js";
import { judgeClient, pickPanel } from "./judge.js";

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
 * :return: {llm, model: {name, routerHost}, client}.
 * :raises Error: When no API key is set.
 */
export function modelFromEnv(env = process.env) {
  const baseUrl = (env.CRASHTEST_ROUTER || DEFAULT_ROUTER).replace(/\/$/, "");
  const apiKey = env.CRASHTEST_API_KEY || "";
  const name = env.CRASHTEST_MODEL || DEFAULT_MODEL;
  if (!apiKey) throw new Error("Set CRASHTEST_API_KEY (and optionally CRASHTEST_ROUTER, CRASHTEST_MODEL), for example in a .env file next to package.json.");
  const client = new LlmClient({ baseUrl, apiKey });
  return { llm: fixedModel(client, name), model: { name, routerHost: new URL(baseUrl).host }, client };
}

/** Judge candidates, in order of preference. The first one that is not under test is used. */
/**
 * Judge candidates in order of preference, all checked to answer through Otari at
 * temperature 0 (18 Nov 2026). A panel takes the first two from families other than the
 * tested model's.
 */
export const DEFAULT_JUDGES = ["deepseek/deepseek-v4.1-flash", "mistralai/mistral-medium-3.5", "google/gemma-4-31b-it", "alibaba/qwen3.8-flash"];

/**
 * The judge panel for inconclusive runs (FINDINGS F22, F37), on the same router as the tester.
 *
 * CRASHTEST_JUDGE_MODELS  Comma-separated candidates (default DEFAULT_JUDGES); "off" disables.
 *
 * :param client: The router client (from modelFromEnv): its baseUrl and apiKey are reused.
 * :param testedModel: The model under test; no judge shares its family.
 * :param env: The environment.
 * :return: [{llm, model}] (two judges, temperature 0), or [] when judging is off.
 */
export function judgesFromEnv(client, testedModel, env = process.env) {
  const raw = (env.CRASHTEST_JUDGE_MODELS ?? "").trim();
  if (raw.toLowerCase() === "off") return [];
  const candidates = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_JUDGES;
  return pickPanel(candidates, testedModel).map((model) => judgeClient({ baseUrl: client.baseUrl, apiKey: client.apiKey, model }));
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
