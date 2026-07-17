import { isCredentialEnvironmentName } from "@geolibre/core";

let credentialEnvironment: Record<string, string> = {};

/** Replace the desktop shell's process-private credential view. */
export function setPrivateCredentialEnvironment(
  env: Record<string, string>
): void {
  credentialEnvironment = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        isCredentialEnvironmentName(name) && Boolean(value.trim())
    )
  );
}

/** App-internal only. Never export through a package or Plugin API. */
export function readPrivateCredentialEnvironment(): Record<string, string> {
  return { ...credentialEnvironment };
}
