import type { SecretStorageTier } from "../../api";

/**
 * What protects the credentials in this deployment.
 *
 * The tier is not a detail: the file tier means anything able to read the
 * metadata directory can read the key that seals these credentials, which is
 * worth saying next to the field where someone types one.
 */
const NOTES: Record<SecretStorageTier, string> = {
  keyring:
    "Stored keys are sealed with a master key held in the operating system's keychain.",
  env: "Stored keys are sealed with the master key this server was started with (MOKA_METADATA_KEY).",
  file: "Stored keys are sealed with a master key kept in master.key inside the metadata directory. Anything that can read that directory can read it; start the server with MOKA_METADATA_KEY for a key that is not on disk. `moka-server --generate-key` prints a value.",
  unset:
    "No key has been stored yet, so there is no master key protecting anything so far.",
};

export function SecretStorageNote({ tier }: { tier: SecretStorageTier }) {
  return (
    <p className="settings-hint" data-testid="secret-storage-note">
      {NOTES[tier]}
    </p>
  );
}
