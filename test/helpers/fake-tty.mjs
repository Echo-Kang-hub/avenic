// A fake pair of terminal streams for driving prompts in-process: stdin is a
// PassThrough that claims to be a TTY and records raw-mode changes, stdout
// captures every frame a prompt paints. Same shape for every interactive
// surface (Skills prompts, the Sessions menu), so a test drives the production
// code rather than a copy of it.
import { PassThrough } from "node:stream";

export class FakeTTY extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
    this.raw = false;
  }

  setRawMode(flag) {
    this.raw = flag;
  }
}

export function fakeStdout(options = {}) {
  const parts = [];
  return {
    isTTY: options.isTTY ?? true,
    columns: options.columns,
    write(chunk) {
      parts.push(String(chunk));
      return true;
    },
    text() {
      return parts.join("");
    },
  };
}

/** 同步驱动：先创建提示（监听器已挂），再逐键写入。 */
export async function runPrompt(factory) {
  const stdin = new FakeTTY();
  const stdout = fakeStdout();
  const promise = factory(stdin, stdout);
  return { stdin, stdout, promise };
}

export function keys(stdin, ...sequence) {
  for (const key of sequence) stdin.write(key);
}
