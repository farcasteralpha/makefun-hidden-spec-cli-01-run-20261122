# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/farcasteralpha/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/farcasteralpha/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies edits that AI models write, in four formats, to a tree of
text files — to one written specification (`SPEC.md`):

- **unified diffs**, often with wrong line numbers,
- **SEARCH/REPLACE blocks**,
- **V4A patches** (`*** Begin Patch` ... `*** End Patch`),
- **JSON edits** (a JSON array, or JSON Lines of text-editor tool calls).

It finds the lines an edit names even when the model drifted their
whitespace or indentation (three matching tiers, exact → trailing-trimmed →
fully-trimmed, plus `--strict` for exact-only), and it changes every file
or none: a failed edit is reported, the edits after it still run, and when
any edit failed nothing is written.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, detected from the patch text).
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Exit codes and output

- Exit `0`: the tree is written. One line per changed path (`A`, `D`, `M`,
  or `R <old> -> <new>`), sorted in byte order, then `ok: <n> files`
  (`ok: 1 file` when n is 1; `ok: 0 files` when nothing changed).
- Exit `1`: nothing written. One `error: <code> <path>` line per failed
  edit, in patch order, then `failed: <k> of <n> edits`.
  Codes: `no-match`, `ambiguous`, `missing`, `exists`, `unsafe`.
- Exit `2`: nothing written, exactly one line — `error: usage`,
  `error: no-patch`, `error: format`, or `error: parse <N>`.

Standard output holds lines, each ended by `\n`, and nothing else.
Standard error is never compared.

## Requirements

Node 22 and its standard library only — no dependencies, no install step,
no network. Deterministic: the same input always gives the same exit code,
stdout and files.

## Files

- `main.ts` — the CLI (see `SPEC.md` for the full contract).
- `runner.ts` — the kit's trial runner, kept as shipped (hands over when
  `MAKEFUN_ENV_URL` is set).
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

Built for the [make.fun](https://make.fun/c/hidden-spec-cli-01-run-20261122)
competition `hidden-spec-cli-01-run-20261122` — "Build mend, one patch
tool for every AI edit format".
