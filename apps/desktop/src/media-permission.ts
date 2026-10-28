// Inputs are supplied by Electron's permission handlers and the trusted owner,
// never copied from a peer packet or renderer permission claim.
export function allowMediaPermission(input: {
  consent: boolean;
  ownedContents: boolean;
  permission: string;
  mainFrame: boolean;
  requestingUrl: string | undefined;
  expectedUrl: string;
  mediaTypes: readonly string[] | undefined;
}): boolean {
  return (
    input.consent === true &&
    input.ownedContents === true &&
    input.permission === "media" &&
    input.mainFrame === true &&
    input.requestingUrl === input.expectedUrl &&
    input.mediaTypes?.length === 1 &&
    input.mediaTypes[0] === "audio"
  );
}
