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
const publicJwkFor = (privateKey) => {
  const { d: _private, ...publicJwk } = jwkFor(privateKey);
  return publicJwk;
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

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (value) => new Uint8Array(Buffer.from(value, "base64"));
const encryptedMessageData = (encryptedMessage) => JSON.stringify({
  protocol: encryptedMessage.protocol,
  message_id: encryptedMessage.message_id,
  conversation_id: encryptedMessage.conversation_id,
  sender: encryptedMessage.sender,
  recipient: encryptedMessage.recipient,
  sender_device: encryptedMessage.sender_device,
  key_id: encryptedMessage.key_id,
  created_at: encryptedMessage.created_at,
  nonce: encryptedMessage.nonce,
  ephemeral_public_key: encryptedMessage.ephemeral_public_key,
  associated_data: encryptedMessage.associated_data,
  ciphertext: encryptedMessage.ciphertext,
});
const recipientPrivateForMessage = p256.utils.randomPrivateKey();
const ephemeralPrivateForMessage = p256.utils.randomPrivateKey();
const senderPrivateForMessage = p256.utils.randomPrivateKey();
const encryptedMessageNonce = webcrypto.getRandomValues(new Uint8Array(12));
const encryptedMessageMetadata = {
  protocol: "enter/0.2",
  message_id: "message-round-trip",
  conversation_id: "conversation-round-trip",
  sender: "alice@example.test",
  recipient: "bob@example.test",
  sender_device: "device-round-trip",
  key_id: "key-round-trip",
  created_at: "2026-08-29T00:00:00.000Z",
  nonce: b64(encryptedMessageNonce),
  ephemeral_public_key: b64(utf8ToBytes(JSON.stringify(publicJwkFor(ephemeralPrivateForMessage)))),
};
const encryptedMessage = {
  ...encryptedMessageMetadata,
  associated_data: "",
  ciphertext: "",
};
encryptedMessage.associated_data = b64(utf8ToBytes(JSON.stringify(encryptedMessageMetadata)));
const encryptedMessageShared = p256.getSharedSecret(ephemeralPrivateForMessage, publicBytes(recipientPrivateForMessage), false).slice(1, 33);
const encryptedMessageKey = hkdf(sha256, encryptedMessageShared, encryptedMessageNonce, utf8ToBytes("enter/e2e/v1/conversation-round-trip"), 32);
const encryptedMessagePlaintext = utf8ToBytes("round-trip payload");
encryptedMessage.ciphertext = b64(gcm(encryptedMessageKey, encryptedMessageNonce, unb64(encryptedMessage.associated_data)).encrypt(encryptedMessagePlaintext));
const encryptedMessageSignature = p256.sign(utf8ToBytes(encryptedMessageData(encryptedMessage)), senderPrivateForMessage, { lowS: false, prehash: true }).toCompactRawBytes();
const signedMessage = { ...encryptedMessage, signature: b64(encryptedMessageSignature) };
assert.equal(p256.verify(unb64(signedMessage.signature), sha256(utf8ToBytes(encryptedMessageData(signedMessage))), publicBytes(senderPrivateForMessage), { lowS: false, prehash: false }), true, "Complete encrypted message signature must verify");
assert.deepEqual([...gcm(encryptedMessageKey, encryptedMessageNonce, unb64(signedMessage.associated_data)).decrypt(unb64(signedMessage.ciphertext))], [...encryptedMessagePlaintext], "Complete encrypted message must decrypt");
const tamperedMessage = { ...signedMessage, ciphertext: `${signedMessage.ciphertext[0] === "A" ? "B" : "A"}${signedMessage.ciphertext.slice(1)}` };
assert.equal(p256.verify(unb64(tamperedMessage.signature), sha256(utf8ToBytes(encryptedMessageData(tamperedMessage))), publicBytes(senderPrivateForMessage), { lowS: false, prehash: false }), false, "Ciphertext tampering must invalidate the signature");
const resignedTamperedMessage = { ...tamperedMessage, signature: b64(p256.sign(utf8ToBytes(encryptedMessageData(tamperedMessage)), senderPrivateForMessage, { lowS: false, prehash: true }).toCompactRawBytes()) };
assert.throws(() => gcm(encryptedMessageKey, encryptedMessageNonce, unb64(resignedTamperedMessage.associated_data)).decrypt(unb64(resignedTamperedMessage.ciphertext)), "Ciphertext tampering must fail AES-GCM authentication");
const wrongRecipientKey = hkdf(sha256, p256.getSharedSecret(p256.utils.randomPrivateKey(), publicBytes(recipientPrivateForMessage), false).slice(1, 33), encryptedMessageNonce, utf8ToBytes("enter/e2e/v1/conversation-round-trip"), 32);
assert.throws(() => gcm(wrongRecipientKey, encryptedMessageNonce, unb64(signedMessage.associated_data)).decrypt(unb64(signedMessage.ciphertext)), "Wrong recipient key must not decrypt");

console.log("E2E checks passed: primitives, full encrypted message round-trip, signature/AES-GCM tamper rejection");
