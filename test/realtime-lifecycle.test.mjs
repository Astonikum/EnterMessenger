import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeLifecycle } from "../mobile/src/realtime-lifecycle.ts";

test("mobile realtime pauses outside foreground and resumes on active", () => {
  const calls = [];
  const lifecycle = createRealtimeLifecycle("active", {
    onActive: () => calls.push("active"),
    onInactive: () => calls.push("inactive"),
  });

  lifecycle.start();
  lifecycle.change("background");
  lifecycle.change("inactive");
  lifecycle.change("active");
  lifecycle.stop();
  lifecycle.change("active");

  assert.deepEqual(calls, ["active", "inactive", "active", "inactive"]);
  assert.equal(lifecycle.isActive(), false);
});

test("mobile realtime does not start while initially backgrounded", () => {
  const calls = [];
  const lifecycle = createRealtimeLifecycle("background", {
    onActive: () => calls.push("active"),
    onInactive: () => calls.push("inactive"),
  });

  lifecycle.start();
  assert.deepEqual(calls, []);
  lifecycle.change("active");

  assert.deepEqual(calls, ["active"]);
});
