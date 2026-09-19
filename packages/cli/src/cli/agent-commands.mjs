// The words `avenic <agent>` answers with something other than a launch. The
// process entry asks this before it decides which half of the CLI to load, so
// it stays free of imports: whichever module needs the answer, loading this
// one costs nothing.
export const AGENT_SUBCOMMANDS = new Set(["help", "--help", "-h", "init", "deinit", "auth", "status", "sessions"]);

export function isAgentSubcommand(word) {
  return AGENT_SUBCOMMANDS.has(word);
}
