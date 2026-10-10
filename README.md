# ZeroHostCMS community plugins

Public, independently developed EmDash plugins proposed for ZeroHostCMS review. This repository is a source contribution project, not an installer, plugin registry, or copy of the private hosting platform.

## Contribute

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for the complete fork-to-PR workflow, a standalone local EmDash host, official authoring references, and review requirements. Put each contribution under `plugins/<slug>/`; each plugin owns its package, lockfile, source, tests, and contributor-facing instructions.

No private hosting-platform checkout, platform credentials, customer data, or cloud account is required for the local native-plugin workflow. Existing proprietary runtimes and curated plugins remain private; do not copy them here.

## Acceptance is not deployment

A merged community PR accepts source only. Fetching this repository as a hosting-platform build submodule must not install dependencies, execute plugin code, activate plugins, or deploy them.

Maintainers must select an exact source commit, manually review and evaluate/deploy it in ZeroHostCMS using their own isolated review resources, and only then propose a separate private hosting-platform promotion PR before hosting-platform publication. The [review and promotion boundary](CONTRIBUTING.md#review-and-promotion-boundary) owns that process.

The hosting platform currently uses curated **native** plugins. That is not blanket approval of community native code. Arbitrary sandboxed-plugin installation on the hosting platform is unverified; upstream sandbox support is not a ZeroHostCMS support promise. Neither merging nor promotion implies automatic discovery or gallery registration.

## License

[MIT](LICENSE). Preserve the license and all required third-party notices. Contributions must disclose dependency and asset provenance as described in the contribution guide.
