import process from "node:process";

// What a detached launch helper still needs once the launching process is gone:
// where the agents keep their native storage, where this machine keeps home and
// temp, and how an executable is found on PATH.
const DURABLE = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "AVENIC_LAUNCH_TIMING",
];

// The launch state file is written to the temp directory and read back by a
// background process minutes later: an environment variable that reaches it is
// that variable copied onto disk. No reader there wants a credential, so a name
// that looks like one is refused even if an earlier rule would have kept it —
// a task runner's token is worth nothing to a session capture and everything to
// whoever reads the temp directory next.
const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|_KEY\b|KEY_|AUTH|COOKIE|ASKPASS|SESSION/i;

/**
 * The part of an environment a launch must keep in order to find an agent's
 * native storage from a detached process — with anything credential-shaped
 * left behind. Callers write the result to disk, so the list is an allow-list
 * that refuses secrets twice over rather than a deny-list that tries to guess
 * every vendor's spelling.
 */
export function durableEnvironment(environment = process.env) {
  const kept = {};
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    if (SECRET.test(name)) continue;
    if (!DURABLE.some((key) => key.toLowerCase() === name.toLowerCase())) continue;
    kept[name] = value;
  }
  return kept;
}
