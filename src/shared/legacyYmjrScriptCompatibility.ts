import CryptoJS from "crypto-js";

const YMJR_SCRIPT_MARKER = "//ymjr";

// The legacy format uses a fixed client-side compatibility key. It is not a
// security boundary: every YMJR plugin installation contains the same key.
// Keeping the protocol here allows a user to carry their existing local script
// library forward without copying the closed-source ScriptEngine.
const YMJR_SCRIPT_KEY = "ymjrymjrymjr0001";

const YMJR_I18N_PROLOGUE = String.raw`
const __current_lang = window.localStorage.getItem("language")?.toLowerCase() || "en";
const t = (key, args = {}) => {
  try {
    if (typeof locales !== "undefined" && locales) {
      let str = locales[__current_lang]?.[key] || locales["en"]?.[key] || key;
      Object.keys(args).forEach((k) => {
        str = str.replace(new RegExp("{" + k + "}", "g"), args[k]);
      });
      return str;
    }
  } catch (error) {
    console.warn("[i18n] Translation error:", error);
  }
  return key;
};
`;

export const isLegacyYmjrScript = (script: string): boolean =>
  script.trimStart().startsWith(YMJR_SCRIPT_MARKER);

/**
 * Decodes the legacy local `//ymjr` script envelope.
 *
 * YMJR serialized scripts as Base64 AES-128-CBC ciphertext with the UTF-8 key
 * reused as the IV and zero padding. This function intentionally implements
 * only that exact local compatibility format; it does not fetch or evaluate
 * remote content.
 */
export const decodeLegacyYmjrScript = (script: string): string => {
  const normalizedScript = script.trimStart();
  if (!normalizedScript.startsWith(YMJR_SCRIPT_MARKER)) {
    return script;
  }

  const payload = normalizedScript.slice(YMJR_SCRIPT_MARKER.length).trim();
  if (!payload || !/^[A-Za-z0-9+/=\s]+$/.test(payload)) {
    throw new Error("The //ymjr script payload is not valid Base64 data.");
  }

  try {
    const key = CryptoJS.enc.Utf8.parse(YMJR_SCRIPT_KEY);
    const ciphertext = CryptoJS.enc.Base64.stringify(
      CryptoJS.enc.Base64.parse(payload),
    );
    const plaintext = CryptoJS.AES.decrypt(ciphertext, key, {
      iv: key,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.ZeroPadding,
    })
      .toString(CryptoJS.enc.Utf8)
      .replace(/\0+$/g, "");

    if (!plaintext.trim()) {
      throw new Error("The decrypted script is empty.");
    }
    return plaintext;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not decode the legacy //ymjr script: ${message}`);
  }
};

/**
 * Prepares a local script for the existing public Excalidraw Automate runner.
 * Plain JavaScript is returned unchanged. Legacy encrypted scripts receive the
 * small translation helper that the YMJR runner supplied before execution.
 */
export const prepareLegacyYmjrScript = (script: string): string => {
  if (!isLegacyYmjrScript(script)) {
    return script;
  }
  const decodedScript = decodeLegacyYmjrScript(script);
  // A number of historical minified scripts use `t` as their own top-level
  // identifier. The original unconditional prologue makes those scripts fail
  // to parse. Translation-aware scripts do not declare their own `t`, so the
  // declaration check preserves both formats.
  const declaresOwnT =
    /\bfunction\s+t\b/.test(decodedScript) ||
    /\bt\s*=/.test(decodedScript);
  return declaresOwnT
    ? decodedScript
    : `${YMJR_I18N_PROLOGUE}\n${decodedScript}`;
};
