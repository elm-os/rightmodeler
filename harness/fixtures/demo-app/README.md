# Demo app fixture

This mixed TypeScript and Python fixture exercises scanner coverage. Its two summarize call
sites, `src/summarize.ts` and `src/summarize-stream.ts`, share the `summarize` telemetry
`functionId`, and every call site pins `acme/large-1`, so the `support` traces cannot be tied to
one call site. Its repository metadata also covers owner resolution and host conventions:
ordered CODEOWNERS rules, root and nested agent instructions, an included convention file, an
instruction pointer, a pull request template, and Prettier configuration.
