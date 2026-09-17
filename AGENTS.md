# Avenic release notes

## npm publishing

- The publishable packages are `@avenic/core` and `avenic`.
- Publish from each package directory after running the root regression and
  `npm run sync-core` so the CLI vendor copy matches `packages/core`.
- Use a temporary npm user config or an injected environment credential. Never
  commit tokens, credentials, `.npmrc` files, or real session data.
- VS Code extension publishing is intentionally handled separately by the
  project owner.

## Release safety

- Do not place npm tokens in this file or any tracked file.
- Verify package name/version and `npm pack --dry-run` before publishing.
- Remove temporary npm authentication files immediately after publishing.
