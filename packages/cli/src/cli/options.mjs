/**
 * Remove `--option value` from an argument list and return the value, or null
 * when the option is absent.
 *
 * Three surfaces used to parse their own flags (`avenic init`, the Skills CLI
 * and the Model CLI); they had drifted into rejecting different spellings
 * (`--` in two of them, `-` in the third) and answering "absent" with
 * different sentinels, so `avenic skills add --name --pack x` quietly took
 * `--pack` for a name on one path and errored on another. A value that looks
 * like an option is never a value.
 */
export function takeOption(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  if (index === -1) return null;
  const value = argumentsList[index + 1];
  // A bare `-` is the conventional "read it from stdin" value (`model add
  // --json -`); every other leading dash is the next flag, not a value.
  if (!value || (value.startsWith("-") && value !== "-")) throw new Error(`Missing value for ${option}`);
  argumentsList.splice(index, 2);
  return value;
}
