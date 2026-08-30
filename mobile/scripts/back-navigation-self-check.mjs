import assert from "node:assert/strict";
import { createBackActionRegistry } from "../../common/src/navigation.ts";

const registry = createBackActionRegistry();
const handled = [];
const removeRoot = registry.register(() => {
  handled.push("root");
  return true;
});
const removeNested = registry.register(() => {
  handled.push("nested");
  return true;
});

assert.equal(registry.handle(), true);
assert.deepEqual(handled, ["nested"]);
removeNested();
assert.equal(registry.handle(), true);
assert.deepEqual(handled, ["nested", "root"]);
removeRoot();
assert.equal(registry.handle(), false);

console.log("Back navigation self-check passed: LIFO and clean root exit");
