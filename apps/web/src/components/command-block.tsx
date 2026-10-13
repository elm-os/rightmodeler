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
