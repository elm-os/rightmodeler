import { PassThrough } from "node:stream";

export function promptAnswers(answers: readonly string[]): {
  readonly input: PassThrough;
  observe(text: string): void;
} {
  const pending = [...answers];
  const input = new PassThrough();
  return {
    input,
    observe(text) {
      if (!/: (?:\u001b\[\d+G)?$/u.test(text)) return;
      const next = pending.shift();
      setImmediate(() => {
        if (next === undefined) input.end();
        else input.write(`${next}\n`);
      });
    },
  };
}
