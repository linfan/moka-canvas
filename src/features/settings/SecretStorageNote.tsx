import { useTranslation } from "react-i18next";
import type { SecretStorageTier } from "../../api";

/**
 * What protects the credentials in this deployment.
 *
 * The tier is not a detail: the file tier means anything able to read the
 * metadata directory can read the key that seals these credentials, which is
 * worth saying next to the field where someone types one.
 */
const NOTES: Record<SecretStorageTier, string> = {
  keyring: "settings:secretNotes.keyring",
  env: "settings:secretNotes.env",
  file: "settings:secretNotes.file",
  unset: "settings:secretNotes.unset",
};

export function SecretStorageNote({ tier }: { tier: SecretStorageTier }) {
  const { t } = useTranslation();
  return (
    <p className="settings-hint" data-testid="secret-storage-note">
      {t(NOTES[tier])}
    </p>
  );
}
