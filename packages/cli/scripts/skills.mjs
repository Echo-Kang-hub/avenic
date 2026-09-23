#!/usr/bin/env node

// Two commands run on someone else's clock: starting an Agent is the command a
// user waits on, and `hook emit` runs once per turn inside the Agent's own hook,
// where every millisecond is charged to the turn. Both decide here, before the
// dispatcher's world is loaded, and load only the modules they need — the hook
// path above all never touches core's session machinery, because a notification
// is not allowed to know the conversation exists. Everything else loads the
// full dispatcher, and each command still has one implementation.
import process from "node:process";
import { isAgentId } from "#core/runtime/agents.mjs";
import { isAgentSubcommand } from "../src/cli/agent-commands.mjs";

const [command, ...argumentsList] = process.argv.slice(2);

const run = isAgentId(command) && !isAgentSubcommand(argumentsList[0] ?? "")
  ? import("../src/cli/launch.mjs").then(({ launchAgent }) => launchAgent(command, argumentsList, {}))
  : command === "hook"
    ? import("../src/cli/hooks-cli.mjs").then(({ dispatchHookCommand }) => dispatchHookCommand(argumentsList))
    : import("../src/cli/dispatcher.mjs").then(({ runCli }) => runCli({
      io: console,
      cwd: process.cwd(),
      environment: process.env,
    }));

run
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
