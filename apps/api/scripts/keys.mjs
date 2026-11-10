// Prints a fresh Ed25519 key pair for signing customers' handoff QR codes.
//   npm run keys
// Then: npx wrangler secret put HANDOFF_PRIVATE_KEY   (paste the private key)
//       npx wrangler secret put HANDOFF_PUBLIC_KEY    (paste the public key)
import { ed25519 } from '@noble/curves/ed25519';
const b64url = (u) => Buffer.from(u).toString('base64url');
const priv = ed25519.utils.randomPrivateKey();
console.log('HANDOFF_PRIVATE_KEY=' + b64url(priv));
console.log('HANDOFF_PUBLIC_KEY=' + b64url(ed25519.getPublicKey(priv)));
console.log('SESSION_SECRET=' + b64url(crypto.getRandomValues(new Uint8Array(32))));
