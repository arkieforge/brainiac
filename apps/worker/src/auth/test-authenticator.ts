// A software passkey for tests: produces real WebAuthn registration and assertion responses (ES256, "none"
// attestation) that SimpleWebAuthn verifies exactly as it would a browser's.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

const head = (major: number, n: number) => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
};

/** The CBOR subset WebAuthn needs: small ints, byte and text strings, maps. */
function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string")
    return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

export function createAuthenticator(origin: string) {
  const rpIdHash = sha256(new URL(origin).hostname);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  let counter = 0;
  const coseKey = new Map<Cbor, Cbor>([
    [1, 2], // EC2
    [3, -7], // ES256
    [-1, 1], // P-256
    [-2, Buffer.from(jwk.x ?? "", "base64url")],
    [-3, Buffer.from(jwk.y ?? "", "base64url")],
  ]);

  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const flagsAndCount = (flags: number) => {
    const out = Buffer.alloc(5);
    out[0] = flags;
    out.writeUInt32BE(++counter, 1);
    return out;
  };

  return {
    id: b64url(credentialId),
    /** The COSE public key, base64, as Better Auth stores it in the passkey table. */
    publicKey: cbor(coseKey).toString("base64"),
    /** Answers `/passkey/generate-register-options`. */
    register(options: { challenge: string }) {
      const credentialLength = Buffer.alloc(2);
      credentialLength.writeUInt16BE(credentialId.length);
      // Flags: user present, user verified, attested credential data.
      const authData = Buffer.concat([
        rpIdHash,
        flagsAndCount(0x45),
        Buffer.alloc(16),
        credentialLength,
        credentialId,
        cbor(coseKey),
      ]);
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64url(clientData("webauthn.create", options.challenge)),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform" as const,
      };
    },
    /** Answers `/passkey/generate-authenticate-options`. */
    authenticate(options: { challenge: string }) {
      const authenticatorData = Buffer.concat([rpIdHash, flagsAndCount(0x05)]);
      const clientDataJSON = clientData("webauthn.get", options.challenge);
      const signature = sign(
        "sha256",
        Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(signature),
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform" as const,
      };
    },
  };
}
