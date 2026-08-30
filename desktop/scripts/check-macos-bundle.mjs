import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.log("macOS bundle self-check: skipped on non-macOS");
  process.exit(0);
}

const projectDir = resolve(import.meta.dirname, "..");
const appPath = resolve(
  process.argv[2] ?? join(projectDir, "src-tauri/target/release/bundle/macos/Enter Messenger.app"),
);
const infoPlist = join(appPath, "Contents/Info.plist");
const packageManifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));

assert.ok(existsSync(appPath), `missing app bundle: ${appPath}`);
assert.ok(existsSync(infoPlist), `missing bundle metadata: ${infoPlist}`);
execFileSync("plutil", ["-lint", infoPlist], { stdio: "inherit" });

const plistValue = (key) => execFileSync("plutil", ["-extract", key, "raw", "-o", "-", infoPlist], { encoding: "utf8" }).trim();
const expectedVersion = packageManifest.version;

assert.equal(plistValue("CFBundleIdentifier"), "com.enter.messenger");
assert.equal(plistValue("CFBundleName"), "Enter Messenger");
assert.equal(plistValue("CFBundleDisplayName"), "Enter Messenger");
assert.equal(plistValue("CFBundleShortVersionString"), expectedVersion);
assert.equal(plistValue("CFBundleVersion"), expectedVersion);
assert.equal(plistValue("CFBundlePackageType"), "APPL");
assert.equal(plistValue("LSApplicationCategoryType"), "public.app-category.social-networking");
assert.equal(plistValue("CFBundleIconFile"), "icon.icns");
assert.equal(plistValue("LSMinimumSystemVersion"), "10.13");

const executableName = plistValue("CFBundleExecutable");
assert.match(executableName, /^[A-Za-z0-9._-]+$/);
const executablePath = join(appPath, "Contents/MacOS", executableName);
assert.ok(existsSync(executablePath), `missing bundle executable: ${executablePath}`);
const iconPath = join(appPath, "Contents/Resources/icon.icns");
assert.ok(existsSync(iconPath), "missing macOS icon resource");
assert.match(execFileSync("file", [iconPath], { encoding: "utf8" }), /icon/i);

const fileDescription = execFileSync("file", [executablePath], { encoding: "utf8" });
assert.match(fileDescription, /Mach-O/);
const architectures = execFileSync("lipo", ["-info", executablePath], { encoding: "utf8" });
assert.match(architectures, /(arm64|x86_64)/);
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });

console.log(`macOS bundle self-check: ok (${appPath})`);
