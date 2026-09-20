# @myharness/agent-sqlite-node

Node SQLite storage backend for `@myharness/agent-core` sessions. It provides the
`node:sqlite` adapter (`SqliteDatabase` implementation), `SqliteSessionRepo`, migrations and
materialized session state. The package is intentionally separate from Agent Core so the core
package does not pull Node runtime builtins or a Node-specific database implementation.

## Documentation

- [Package index](docs/index.md)
- [Maintenance](docs/maintenance.md)
- [Future development](docs/roadmap.md)

## Current implementation

- `src/index.ts` adapts Node `DatabaseSync` to the small `SqliteDatabase` contract.
- `src/sqlite/migrations.ts` applies the migration files and records applied timestamps.
- `src/sqlite/repo.ts` opens/configures the database and exposes create/list/open/delete/fork.
- `src/sqlite/storage/` stores session tree entries, branches, leaves, sequences and materialized state.
- The migration currently present is `src/sqlite/migrations/001_initial.sql`.

The primary tests are in `packages/agent/test/harness`, because the harness tests the backend through
the Agent Core session contract. This README and the package build do not prove that the product's
default runtime has switched to SQLite.

## License

Apache-2.0. See [the repository license](../../../LICENSE) and
[third-party notices](../../../THIRD_PARTY_NOTICES.md).
