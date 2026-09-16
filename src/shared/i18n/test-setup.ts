import { i18n } from ".";

// The interface starts in the machine's language and the suite asserts
// English words, so the language is pinned before any test renders.
void i18n.changeLanguage("en");
