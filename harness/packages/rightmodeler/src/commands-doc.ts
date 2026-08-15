import type { Command } from "commander";

export function renderCommandsDoc(program: Command): string {
  const sections: string[] = [
    "# Commands",
    "",
    "This file is generated from the CLI definitions. Run `pnpm docs:generate` after changing a command.",
    "",
    "See [Getting started](getting-started.md) for the shortest complete workflow and [Exit codes](exit-codes.md) for automation behavior.",
  ];

  for (const command of commands(program)) {
    command.configureHelp({ helpWidth: 80 });
    sections.push(
      "",
      `## \`${commandPath(command)}\``,
      "",
      "```text",
      command.helpInformation().replaceAll(process.cwd(), ".").trimEnd(),
      "```",
    );
  }

  return `${sections.join("\n")}\n`;
}

function commands(program: Command): Command[] {
  const result: Command[] = [program];
  for (const command of program.commands) result.push(...commands(command));
  return result;
}

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current !== null) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}
