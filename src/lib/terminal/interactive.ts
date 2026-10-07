import { commandStart } from "./tokenize";

/**
 * Programs that take over the whole screen or wait for typing, which a one-off command block can't
 * show well. Commands mode offers to open them in the terminal instead of hanging.
 */

/** Always full-screen. */
const SCREEN = new Set([
  "vi", "vim", "nvim", "view", "vimdiff", "nano", "pico", "micro", "emacs", "joe", "mcedit",
  "htop", "btop", "bpytop", "atop", "nmon", "glances", "iftop", "iotop", "nethogs", "bmon", "nload", "ctop", "lazydocker", "lazygit", "tig",
  "less", "more", "most", "man", "info",
  "tmux", "screen", "byobu", "zellij",
  "mc", "ranger", "nnn", "lf", "vifm", "ncdu",
  "nmtui", "alsamixer", "whiptail", "dialog", "raspi-config", "mutt", "neomutt", "w3m", "lynx", "links",
  "telnet", "minicom", "mosh",
]);

/** Shells and interpreters: interactive unless they're given something to run. */
const REPL = new Set(["bash", "sh", "zsh", "fish", "ash", "dash", "ksh", "python", "python3", "node", "irb", "lua", "bc", "php", "perl", "ghci", "R", "sqlite3", "mysql", "mariadb", "psql", "redis-cli", "mongosh", "mongo", "valkey-cli", "ftp", "sftp", "nslookup"]);

export interface Interactive {
  program: string;
  reason: "screen" | "prompt";
}

function base(word: string): string {
  return word.replace(/^.*\//, "");
}

function splitCommands(line: string): string[][] {
  // Good enough for this check: split on separators outside quotes, then on spaces.
  const parts: string[][] = [];
  let cur: string[] = [];
  let word = "";
  let quote: string | null = null;
  const push = () => {
    if (word) cur.push(word);
    word = "";
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      word += line[++i];
      continue;
    }
    if (/[|;&()\n]/.test(ch)) {
      push();
      if (cur.length) parts.push(cur);
      cur = [];
      continue;
    }
    if (/\s/.test(ch)) push();
    else word += ch;
  }
  push();
  if (cur.length) parts.push(cur);
  return parts;
}

function check(words: string[]): Interactive | null {
  const start = commandStart(words);
  const w = words.slice(start);
  // `watch docker ps` redraws the screen every two seconds.
  if (words.slice(0, start).some((x) => base(x) === "watch")) return { program: "watch", reason: "screen" };
  // `sudo -i`, `sudo -s`, `sudo su`: a new interactive shell.
  if (!w.length) return words[0] === "sudo" && words.slice(1).some((x) => x === "-i" || x === "-s") ? { program: "sudo", reason: "prompt" } : null;
  const prog = base(w[0]!);
  const args = w.slice(1);
  const has = (...f: string[]) => args.some((a) => f.includes(a) || f.some((x) => x.startsWith("--") && a.startsWith(`${x}=`)));
  const positional = args.filter((a) => !a.startsWith("-"));

  if (prog === "top") return args.some((a) => /^-\w*b/.test(a)) ? null : { program: "top", reason: "screen" };
  if (prog === "emacs" && has("--batch", "--script")) return null;
  if (SCREEN.has(prog)) return { program: prog, reason: "screen" };
  if (prog === "watch") return { program: "watch", reason: "screen" };
  if (prog === "su") return has("-c", "--command") ? null : { program: "su", reason: "prompt" };
  if (prog === "ssh") {
    // ssh host → a remote shell; ssh host uptime → one command.
    const takesValue = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (takesValue.has(args[i]!)) i++;
      else if (!args[i]!.startsWith("-")) rest.push(args[i]!);
    }
    return rest.length <= 1 || has("-t", "-tt") ? { program: "ssh", reason: "prompt" } : null;
  }
  if (prog === "docker" || prog === "podman" || prog === "kubectl" || prog === "nerdctl") {
    const sub = positional[0];
    const flags = args.filter((a) => a.startsWith("-"));
    const tty = flags.some((f) => f === "-it" || f === "-ti" || f === "-t" || f === "--tty" || f === "--interactive" || f === "-i");
    if ((sub === "exec" || sub === "run") && tty) return { program: `${prog} ${sub}`, reason: "prompt" };
    if (sub === "attach") return { program: `${prog} attach`, reason: "prompt" };
    if (sub === "compose" && positional[1] === "exec" && !args.includes("-T")) return { program: `${prog} compose exec`, reason: "prompt" };
    return null;
  }
  if (REPL.has(prog)) {
    if (args.length === 0) return { program: prog, reason: "prompt" };
    if (["bash", "sh", "zsh", "fish", "ash", "dash", "ksh"].includes(prog)) return has("-c") || positional.length ? null : has("-i", "-l", "--login") ? { program: prog, reason: "prompt" } : null;
    if (["python", "python3", "node", "php", "perl", "lua", "irb", "R"].includes(prog)) return has("-i") ? { program: prog, reason: "prompt" } : null;
    if (["mysql", "mariadb"].includes(prog)) return has("-e", "--execute") ? null : { program: prog, reason: "prompt" };
    if (prog === "psql") return has("-c", "--command", "-f", "--file", "-l", "--list") ? null : { program: prog, reason: "prompt" };
    if (prog === "sqlite3") return positional.length >= 2 ? null : { program: prog, reason: "prompt" };
    if (prog === "redis-cli" || prog === "valkey-cli") return positional.length ? null : { program: prog, reason: "prompt" };
    if (prog === "mongosh" || prog === "mongo") return has("--eval", "-f", "--file") ? null : { program: prog, reason: "prompt" };
    return null;
  }
  return null;
}

/** The first program in the line that needs a real terminal, or null when a command block is fine. */
export function interactiveProgram(line: string): Interactive | null {
  const parts = splitCommands(line);
  // A pager at the end of a pipe (`journalctl | less`) still takes the screen, so check every part.
  for (const words of parts) {
    const hit = check(words);
    if (hit) return hit;
  }
  return null;
}
