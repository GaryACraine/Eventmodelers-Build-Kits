import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto"

/**
 * A passkey in software, for tests: what a browser and an authenticator do in WebAuthn's two ceremonies, with
 * "none" attestation and an ES256 key. `userVerified` says whether the device checked it was you (biometric or PIN):
 * the flag ADR-056 requires.
 */
export function softwarePasskey(origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const jwk = publicKey.export({ format: "jwk" })
    const credentialId = randomBytes(16)
    const rpIdHash = createHash("sha256").update(new URL(origin).hostname).digest()
    let counter = 0

    const clientData = (type: string, challenge: string) =>
        Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

    /** UP (user present), UV (user verified), AT (attested credential data follows) */
    const flags = (userVerified: boolean, attested: boolean) => 0x01 | (userVerified ? 0x04 : 0) | (attested ? 0x40 : 0)

    const counterBytes = () => {
        const b = Buffer.alloc(4)
        b.writeUInt32BE(++counter)
        return b
    }

    return {
        id: credentialId.toString("base64url"),

        /** The browser's answer to `navigator.credentials.create` with the server's options */
        register(options: { challenge: string }, { userVerified = true } = {}) {
            const coseKey = cbor(
                new Map<number, Cbor>([
                    [1, 2], // kty: EC2
                    [3, -7], // alg: ES256
                    [-1, 1], // crv: P-256
                    [-2, Buffer.from(jwk.x!, "base64url")],
                    [-3, Buffer.from(jwk.y!, "base64url")]
                ])
            )
            const idLength = Buffer.alloc(2)
            idLength.writeUInt16BE(credentialId.length)
            const authData = Buffer.concat([
                rpIdHash,
                Buffer.from([flags(userVerified, true)]),
                counterBytes(),
                Buffer.alloc(16), // AAGUID: none
                idLength,
                credentialId,
                coseKey
            ])
            const attestationObject = cbor(
                new Map<string, Cbor>([
                    ["fmt", "none"],
                    ["attStmt", new Map()],
                    ["authData", authData]
                ])
            )
            return {
                id: this.id,
                rawId: this.id,
                type: "public-key",
                response: {
                    clientDataJSON: clientData("webauthn.create", options.challenge).toString("base64url"),
                    attestationObject: attestationObject.toString("base64url"),
                    transports: ["internal"]
                },
                clientExtensionResults: {}
            }
        },

        /** The browser's answer to `navigator.credentials.get` with the server's options */
        authenticate(options: { challenge: string }, { userVerified = true } = {}) {
            const authData = Buffer.concat([rpIdHash, Buffer.from([flags(userVerified, false)]), counterBytes()])
            const clientDataJSON = clientData("webauthn.get", options.challenge)
            const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]), privateKey)
            return {
                id: this.id,
                rawId: this.id,
                type: "public-key",
                response: {
                    clientDataJSON: clientDataJSON.toString("base64url"),
                    authenticatorData: authData.toString("base64url"),
                    signature: signature.toString("base64url")
                },
                clientExtensionResults: {}
            }
        }
    }
}

/** The current code of an authenticator app for a TOTP secret (RFC 6238: SHA-1, 6 digits, 30 seconds) */
export function totpCode(base32Secret: string, at = Date.now()): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    let bits = ""
    for (const c of base32Secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0")
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)))
    const step = Buffer.alloc(8)
    step.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
    const mac = createHmac("sha1", key).update(step).digest()
    const offset = mac[mac.length - 1]! & 0x0f
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
}

type Cbor = number | string | Buffer | Map<number | string, Cbor>

/** Just enough CBOR (RFC 8949) for a COSE key and an attestation object */
function cbor(value: Cbor): Buffer {
    const head = (major: number, n: number) =>
        n < 24
            ? Buffer.from([(major << 5) | n])
            : n < 256
              ? Buffer.from([(major << 5) | 24, n])
              : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff])
    if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value)
    if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
    if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
}
