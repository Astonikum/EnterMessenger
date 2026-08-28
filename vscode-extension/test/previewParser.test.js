const assert = require("assert");
const { parsePreviews } = require("../previewParser");

const source = `
const url = "// #preview Ignored {}";
const pattern = /\\/\\/ #preview Ignored {}/;

export function Button({ label, disabled }) {
  return <button disabled={disabled}>{label}</button>;
}

// #preview "Primary" Button {"label":"Continue","disabled":false}
// #preview("JSX body") { <Button label="From JSX" disabled={true} /> }
/* #preview default {} */
/* #preview-module("Component gallery")
const items = [<Button label="A" />, <Button label="B" />];
return <div>{items}</div>;
*/
/* #preview Broken Button {not-json} */
`;

const result = parsePreviews(source);
assert.strictEqual(result.previews.length, 4);
assert.strictEqual(result.errors.length, 1);

assert.strictEqual(result.previews[0].label, "Primary");
assert.strictEqual(result.previews[0].kind, "props");
assert.strictEqual(result.previews[0].target, "Button");
assert.deepStrictEqual(result.previews[0].props, { label: "Continue", disabled: false });

assert.strictEqual(result.previews[1].label, "JSX body");
assert.strictEqual(result.previews[1].kind, "expression");
assert.match(result.previews[1].expression, /From JSX/);

assert.strictEqual(result.previews[2].target, "default");
assert.strictEqual(result.previews[2].index, 2);
assert.strictEqual(result.previews[3].kind, "module");
assert.strictEqual(result.previews[3].label, "Component gallery");
assert.match(result.previews[3].module, /const items/);

const noPreview = parsePreviews("const value = 'plain text';");
assert.deepStrictEqual(noPreview, { previews: [], errors: [] });

const malformed = parsePreviews('// #preview("Unclosed) { <Button /> }');
assert.strictEqual(malformed.previews.length, 0);
assert.strictEqual(malformed.errors.length, 1);
assert.match(malformed.errors[0].message, /Блок|строк|кавыч/);

const regexBody = parsePreviews('// #preview { /}/ }');
assert.strictEqual(regexBody.errors.length, 0);
assert.strictEqual(regexBody.previews[0].expression, "/}/");

const identifierStartingWithDefault = parsePreviews('// #preview defaultButton {}');
assert.strictEqual(identifierStartingWithDefault.errors.length, 0);
assert.strictEqual(identifierStartingWithDefault.previews[0].target, "defaultButton");

console.log("previewParser: ok");
