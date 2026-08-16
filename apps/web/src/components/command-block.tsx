// CommandBlock — the site's one grammar for a runnable command: a fog mono caption naming what
// the command does, over the copyable command itself. Extracted from the vs and integrations
// detail pages so a third consumer cannot fork the pattern.

import { CopyCommand } from "@/components/copy-command";

export function CommandBlock({
  comment,
  command,
}: {
  comment: string;
  command: string;
}) {
  return (
    <div>
      <p className="font-mono text-caption text-fog">{comment}</p>
      <CopyCommand command={command} className="mt-2 max-w-full" />
    </div>
  );
}
