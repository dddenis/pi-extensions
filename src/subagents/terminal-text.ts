const character = (code: number): string => String.fromCharCode(code);

const ESC = character(0x1b);
const BEL = character(0x07);
const C1_DCS = character(0x90);
const C1_SOS = character(0x98);
const C1_CSI = character(0x9b);
const C1_ST = character(0x9c);
const C1_OSC = character(0x9d);
const C1_PM = character(0x9e);
const C1_APC = character(0x9f);

const OSC_PATTERN = new RegExp(
  `(?:${ESC}\\]|${C1_OSC})[\\s\\S]*?(?:${BEL}|${ESC}\\\\|${C1_ST}|$)`,
  "gu",
);

const CONTROL_STRING_PATTERN = new RegExp(
  `(?:${ESC}(?:P|X|\\^|_)|[${C1_DCS}${C1_SOS}${C1_PM}${C1_APC}])[\\s\\S]*?(?:${ESC}\\\\|${C1_ST}|$)`,
  "gu",
);

const CSI_PATTERN = new RegExp(
  `(?:${ESC}\\[|${C1_CSI})[0-?]*[ -/]*[@-~]`,
  "gu",
);

const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}[ -/]*[@-~]`, "gu");

const isTerminalControl = (value: string): boolean => {
  const code = value.codePointAt(0);
  return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
};

/** Removes terminal-active sequences and control bytes from display text. */
export const sanitizeTerminalText = (value: string): string =>
  Array.from(
    value
      .replace(OSC_PATTERN, "")
      .replace(CONTROL_STRING_PATTERN, "")
      .replace(CSI_PATTERN, "")
      .replace(ANSI_ESCAPE_PATTERN, ""),
  )
    .filter((codePoint) => !isTerminalControl(codePoint))
    .join("");
