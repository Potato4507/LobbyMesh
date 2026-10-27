import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import type { NoiseStream } from "../../packages/app-dht/src/rpc.js";
// Synthetic channel metadata tests app authentication, not Noise encryption.
export function pair(): [NoiseStream, NoiseStream] {
  let b: Duplex;
  const a = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      b.push(chunk);
      done();
    },
    final(done) {
      b.push(null);
      done();
    },
    destroy(error, done) {
      b.push(null);
      done(error);
    },
  });
  b = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      a.push(chunk);
      done();
    },
    final(done) {
      a.push(null);
      done();
    },
    destroy(error, done) {
      a.push(null);
      done(error);
    },
  });
  const keyA = randomBytes(32),
    keyB = randomBytes(32),
    hash = randomBytes(64);
  Object.assign(a, {
    publicKey: keyA,
    remotePublicKey: keyB,
    handshakeHash: hash,
  });
  Object.assign(b, {
    publicKey: keyB,
    remotePublicKey: keyA,
    handshakeHash: hash,
  });
  return [a as unknown as NoiseStream, b as unknown as NoiseStream];
}
