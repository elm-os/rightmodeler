# contracts

JSON Schema contracts shared between the TypeScript workspace and the Python
pipeline.

Schema versions are monotonically increasing decimal strings (`"1"`, `"2"`,
and so on). Increment the version for any change that can alter validation or
interpretation for a consumer, including adding, removing, or renaming a field,
changing a type or meaning, or changing whether a field is required. Consumers
must select the matching schema, migrate or regenerate stored artifacts when the
version increments, and reject unsupported versions rather than guessing.

The benchmark `snapshot_id` is a content digest over the entire snapshot
payload. Adding a field to the benchmark snapshot therefore changes every
stored snapshot identifier when snapshots are regenerated, even if their inputs
and metrics are otherwise unchanged.
