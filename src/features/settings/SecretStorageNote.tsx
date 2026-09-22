import { useTranslation } from "react-i18next";
import type { SecretStorageTier } from "../../api";

/**
 * What protects the credentials in this deployment.
 *
 * The file tier gets no note: where its key sits is a deployment matter, so
 * nothing is said next to the field where a key is typed.
 */
const NOTES: Partial<Record<SecretStorageTier, string>> = {
  keyring: "settings:secretNotes.keyring",
  env: "settings:secretNotes.env",
  unset: "settings:secretNotes.unset",
};

export function SecretStorageNote({ tier }: { tier: SecretStorageTier }) {
  const { t } = useTranslation();
  const note = NOTES[tier];
  if (!note) return null;
  return (
    <p className="settings-hint" data-testid="secret-storage-note">
      {t(note)}
    </p>
  );
}
