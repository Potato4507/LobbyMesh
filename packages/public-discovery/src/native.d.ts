declare module "hyperdht" {
  // Pinned upstream 6.35.0 ships no TypeScript declarations. The adapter narrows
  // this value to the installed API; native implementation remains external.
  const HyperDHT: unknown;
  export default HyperDHT;
}
