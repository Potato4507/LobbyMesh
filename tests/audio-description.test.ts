import assert from "node:assert/strict";
import test from "node:test";
import {
  publicVoiceIceServers,
  validAudioDescription,
} from "../packages/voice/src/description.js";

const fingerprint = Array(32).fill("AB").join(":");
const audio = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
test("upstream SDP parser retains strict audio-only Opus fingerprint contract", () => {
  assert.equal(validAudioDescription(audio), true);
  for (const value of [
    audio.replace("m=audio", "m=video"),
    `${audio}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`,
    audio.replace("opus/48000", "PCMU/8000"),
    audio.replace("opus/48000/2", "opus/48000/3"),
    audio.replace(fingerprint, "invalid"),
    `${audio}a=fingerprint:sha-1 AB:CD\r\n`,
    `${audio}a=fingerprint:sha-256 ${Array(32).fill("CD").join(":")}\r\n`,
    audio.replace(`a=fingerprint:sha-256 ${fingerprint}\r\n`, ""),
    "x".repeat(12289),
    {},
    null,
  ])
    assert.equal(validAudioDescription(value), false);
});
test("production NAT helper is STUN-only, returns independent configuration and no relay credentials", () => {
  assert.deepEqual(publicVoiceIceServers(), [
    { urls: "stun:stun.l.google.com:19302" },
  ]);
  const servers = publicVoiceIceServers();
  servers.length = 0;
  assert.equal(publicVoiceIceServers().length, 1);
});
