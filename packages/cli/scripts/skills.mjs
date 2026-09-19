#!/usr/bin/env node

// Starting an Agent is the command a user waits on, so this entry decides what
// the command is before it loads the CLI: naming an Agent without one of that
// Agent's subcommands is a launch, and a launch loads only the modules a
// launch needs. Every other command loads the full dispatcher. Both go through
// one implementation of each command.
import process from "node:process";
import { isAgentId } from "#core/runtime/agents.mjs";
import { isAgentSubcommand } from "../src/cli/agent-commands.mjs";

const [command, ...argumentsList] = process.argv.slice(2);

const run = isAgentId(command) && !isAgentSubcommand(argumentsList[0] ?? "")
  ? import("../src/cli/launch.mjs").then(({ launchAgent }) => launchAgent(command, argumentsList, {}))
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
