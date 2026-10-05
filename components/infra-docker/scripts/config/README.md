# Script config

## Project root (aligned with Thonnas CLI)

**Project root** = the Thonnas project directory (monorepo root with `.thonnas` and `components/`). The CLI infers it by **walking up from the directory you run `thonnas` from** (cwd). There is no `--project-root` flag or env override in the CLI.

- **When the CLI runs these scripts** (e.g. `thonnas build`): it sets **`THONNAS_PROJECT_ROOT`** to the inferred project root and runs the script with cwd set to the component directory. Scripts use `THONNAS_PROJECT_ROOT` when set.
- **When you run scripts directly** (e.g. `./components/infra-docker/scripts/build.sh`): project root is inferred by **walking up from cwd** using the same rules as the CLI: prefer a directory with both `.thonnas` and `components/`, otherwise the first ancestor with `.thonnas` or `components/`, else cwd.

### dev-link

With **dev-link**, the intended project is the **target repo** (where the symlink lives in `components/`). You must run `thonnas` (or the scripts) **from that repo**. If you run from inside the worktree, the resolved project root will be the worktree and scope will be wrong.

### What the scripts use

- **Bash:** Scripts source `config/resolve-repo-root.sh`, which sets `REPO_ROOT` and `COMPONENT_ROOT`. It uses `THONNAS_PROJECT_ROOT` when set; else walks up from `$(pwd)` (same logic as CLI).
- **Node/TS:** `e2e-build.ts` and `generate-endpoints.ts` use `lib/resolve-repo-root.ts`: prefer `process.env.THONNAS_PROJECT_ROOT`, else walk up from `process.cwd()` with the same .thonnas/components rules, else fallback from script location.

