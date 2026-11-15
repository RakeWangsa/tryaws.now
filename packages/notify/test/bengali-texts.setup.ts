import { setNotifyEnglishOnly } from "../templates/locale";

// WPU-X22: the existing tests check the Bengali templates, which stay in the code for the day Bengali
// comes back. They run with the English-only rule off; test/english-only.test.ts runs it on.
setNotifyEnglishOnly(false);
