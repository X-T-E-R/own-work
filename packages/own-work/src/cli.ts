#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { runCli } from "./program.js";

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  return runCli(argv, {
    output: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      setExitCode: (code) => {
        process.exitCode = code;
      },
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
