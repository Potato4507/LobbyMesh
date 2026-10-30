import type { NetworkLifecycle } from "../../packages/app-dht/src/lifecycle.js";

// The worker owns permission/lifetime. Never grant a replacement instance after
// stop, failed cleanup or an unconfirmed startup, including across awaits.
export async function restartLabNetwork(
  lifecycle: Pick<NetworkLifecycle, "setEnabled" | "settled" | "status">,
  permitted: () => boolean,
): Promise<void> {
  const check = () => {
    if (permitted() !== true) throw new Error("LAB_NETWORK_UNAVAILABLE");
  };
  try {
    check();
    lifecycle.setEnabled(false);
    await lifecycle.settled();
    check();
    if (lifecycle.status().error === "STOP_FAILED")
      throw new Error("LAB_NETWORK_UNAVAILABLE");
    lifecycle.setEnabled(true);
    await lifecycle.settled();
    check();
    if (lifecycle.status().state !== "online")
      throw new Error("LAB_NETWORK_UNAVAILABLE");
  } catch {
    throw new Error("LAB_NETWORK_UNAVAILABLE");
  }
}
