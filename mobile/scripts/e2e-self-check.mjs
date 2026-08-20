import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { gcm } from "@noble/ciphers/aes";
import { p256 } from "@noble/curves/p256";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";

const subtle = webcrypto.subtle;
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const jwkFor = (privateKey) => {
  const publicKey = p256.getPublicKey(privateKey, false);
  return { kty: "EC", crv: "P-256", x: b64url(publicKey.slice(1, 33)), y: b64url(publicKey.slice(33)), d: b64url(privateKey), ext: true };
};
const publicBytes = (privateKey) => p256.getPublicKey(privateKey, false);
const message = utf8ToBytes("Enter cross-platform E2E self-check");
const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
const salt = Uint8Array.from({ length: 12 }, (_, index) => index + 20);
const info = utf8ToBytes("enter/e2e/v1/check");
const aad = utf8ToBytes("associated-data");

const recipientPrivate = p256.utils.randomPrivateKey();
const ephemeralPrivate = p256.utils.randomPrivateKey();
const recipientJwk = jwkFor(recipientPrivate);
const ephemeralJwk = jwkFor(ephemeralPrivate);
const ephemeralWebPrivate = await subtle.importKey("jwk", ephemeralJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
const recipientWebPublic = await subtle.importKey("jwk", { ...recipientJwk, d: undefined }, { name: "ECDH", namedCurve: "P-256" }, false, []);
const webShared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: recipientWebPublic }, ephemeralWebPrivate, 256));
const nobleShared = p256.getSharedSecret(ephemeralPrivate, publicBytes(recipientPrivate), false).slice(1, 33);
assert.deepEqual([...webShared], [...nobleShared], "P-256 ECDH x-coordinate must match WebCrypto");

const webHkdfMaterial = await subtle.importKey("raw", webShared, "HKDF", false, ["deriveBits"]);
const webKey = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, webHkdfMaterial, 256));
const nobleKey = hkdf(sha256, nobleShared, salt, info, 32);
assert.deepEqual([...webKey], [...nobleKey], "HKDF must match WebCrypto");

const webAesKey = await subtle.importKey("raw", webKey, { name: "AES-GCM" }, false, ["encrypt"]);
const webCiphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, webAesKey, message));
const nobleCiphertext = gcm(nobleKey, nonce, aad).encrypt(message);
assert.deepEqual([...webCiphertext], [...nobleCiphertext], "AES-256-GCM must match WebCrypto");

const signingPrivate = p256.utils.randomPrivateKey();
const signingJwk = jwkFor(signingPrivate);
const signingWebPrivate = await subtle.importKey("jwk", signingJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const signingWebPublic = await subtle.importKey("jwk", { ...signingJwk, d: undefined }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
const webSignature = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingWebPrivate, message));
assert.equal(p256.verify(webSignature, sha256(message), publicBytes(signingPrivate), { lowS: false, prehash: false }), true, "Noble must verify WebCrypto ECDSA signatures");
const nobleSignature = p256.sign(message, signingPrivate, { lowS: false, prehash: true }).toCompactRawBytes();
assert.equal(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signingWebPublic, nobleSignature, message), true, "WebCrypto must verify Noble ECDSA signatures");

console.log("E2E primitives match WebCrypto: ECDH, HKDF-SHA-256, AES-256-GCM, ECDSA-P-256");
