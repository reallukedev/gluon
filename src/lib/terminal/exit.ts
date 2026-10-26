/** What an exit code usually means, in words. Null when there's nothing useful to add. */
const MEANING: Record<number, string> = {
  1: "it reported an error",
  2: "it didn't understand the options or arguments",
  124: "it ran out of time",
  125: "the command around it failed",
  126: "it couldn't be run (not executable, or no permission)",
  127: "the program wasn't found",
  128: "it gave an exit code that isn't valid",
  130: "it was stopped with Ctrl-C",
  131: "it was stopped with Ctrl-\\",
  137: "it was killed (out of memory, or force-stopped)",
  139: "it crashed (segmentation fault)",
  141: "the program reading its output stopped first",
  143: "it was asked to stop",
};

export function exitMeaning(code: number | null): string | null {
  if (code === null || code === 0) return null;
  if (MEANING[code]) return MEANING[code]!;
  if (code > 128 && code < 160) return `it was ended by signal ${code - 128}`;
  return null;
}
