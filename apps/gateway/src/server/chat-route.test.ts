import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseChatRouteJson,
  refineResponseLocaleFromUserMessage,
  refineChatIntentFromUserMessage,
} from "./chat-route.js";
import { taskTextHasNamedUrl } from "../browser/controller.js";
import type { BeeTask } from "@beebridge/core";

test("parseChatRouteJson fills intent defaults for legacy topic-only JSON", () => {
  const raw = `{"topics":["general"],"primary":"general","reason":"test"}`;
  const r = parseChatRouteJson(raw);
  assert.equal(r.responseLocale, "und");
  assert.equal(r.needsLiveBrowser, false);
  assert.equal(r.needsWaggleSupervisor, false);
});

test("parseChatRouteJson parses extended intent fields", () => {
  const raw = `{"topics":["graph"],"primary":"graph","reason":"x","responseLocale":"ko","needsLiveBrowser":true,"needsWaggleSupervisor":false}`;
  const r = parseChatRouteJson(raw);
  assert.equal(r.responseLocale, "ko");
  assert.equal(r.needsLiveBrowser, true);
  assert.equal(r.needsWaggleSupervisor, false);
});

test("refineResponseLocaleFromUserMessage upgrades und to ko for Hangul", () => {
  const r = refineResponseLocaleFromUserMessage("안녕 분석해줘", "und");
  assert.equal(r, "ko");
});

test("refineChatIntentFromUserMessage preserves explicit locale", () => {
  const route = parseChatRouteJson(
    `{"topics":["general"],"primary":"general","reason":"","responseLocale":"en","needsLiveBrowser":false,"needsWaggleSupervisor":false}`,
  );
  const refined = refineChatIntentFromUserMessage("hello", route);
  assert.equal(refined.responseLocale, "en");
});

test("taskTextHasNamedUrl detects https URL in description", () => {
  const task = {
    id: "t1",
    title: "Test",
    description: "Open https://example.com/page",
  } as BeeTask;
  assert.equal(taskTextHasNamedUrl(task), true);
});

test("taskTextHasNamedUrl false without URL", () => {
  const task = {
    id: "t2",
    title: "Local",
    description: "read file only",
  } as BeeTask;
  assert.equal(taskTextHasNamedUrl(task), false);
});
