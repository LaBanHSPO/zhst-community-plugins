# Contributing plugins

This public repository accepts independently developed EmDash plugin source for ZeroHostCMS review. You do not need the private hosting platform, platform secrets, customer data, or account/resource IDs. Use synthetic content and your own disposable local site. A merged PR is source acceptance, **not permission to install, execute, or deploy**.

## Fork and choose a scope

1. Fork [ZeroHostCMS/zhst-community-plugins](https://github.com/ZeroHostCMS/zhst-community-plugins) on GitHub.
2. Clone your fork into a directory outside any private platform checkout or pnpm workspace. Replace `YOUR-GITHUB-LOGIN` below with your public GitHub login.

   ```sh
   git clone https://github.com/YOUR-GITHUB-LOGIN/zhst-community-plugins.git
   cd zhst-community-plugins
   git remote add upstream https://github.com/ZeroHostCMS/zhst-community-plugins.git
   git switch -c plugin/my-plugin
   ```

3. Use one stable, unscoped, kebab-case slug and develop under `plugins/<slug>/`. Keep each plugin independently installable with its own package manifest, lockfile and tests. No dependency on private packages, private workspace aliases, or neighboring contributions is allowed.

Describe the user problem and the least authority needed to solve it. Do not copy proprietary platform runtimes, shipped curated plugins, credentials, customer exports, or design assets without redistribution rights.

## Compatibility and execution format

The review baseline is **EmDash 1.1.0**, **Astro 7.3.5**, and Node **`^22.22.2 || ^24.15.0 || >=26.0.0`**. Hosting-platform Cloudflare review uses **`@astrojs/cloudflare` 14.3.3**; a Node-only local result does not establish Cloudflare compatibility. The commands below use **pnpm 11**. Record the actual versions and lockfiles used in your evidence.

Native plugins are the primary route for hosting consideration because the platform currently uses curated native plugins. Follow the [official native tutorial](https://docs.emdashcms.com/plugins/creating-native-plugins/your-first-native-plugin/) for `PluginDescriptor`, the named `createPlugin` export and `definePlugin()`; do not invent a native generator flag. Native code has the host process's authority. Capability declarations are not a sandbox, so native execution needs a specific justification and source/dependency review.

The [official sandboxed-plugin generator](https://docs.emdashcms.com/plugins/creating-plugins/your-first-plugin/) is an optional upstream authoring route. Arbitrary sandboxed installation on the hosting platform is **unverified**, not promised. Never disable sandboxing or silently move a sandboxed contribution into native execution to make a test pass. Keep those formats and their evidence distinct.

Use released public APIs and the types in your pinned dependencies. Upstream documentation and downloaded starter templates can advance beyond this baseline; record incompatibilities rather than claiming an untested version range.

## Create a standalone local host

From the community repository root, create a sibling site, not a private workspace member:

```sh
cd ..
pnpm create emdash@1.1.0 plugin-review-host --platform node --template starter --pm pnpm --no-install --yes
cd plugin-review-host
pnpm add --save-exact emdash@1.1.0 astro@7.3.5
pnpm dev
```

Use a new directory; do not overwrite an existing site. The command's options are owned by the [released generator parser](https://github.com/emdash-cms/emdash/blob/create-emdash%401.1.0/packages/create-emdash/src/flags.ts). Pinning the generator does not pin the template it downloads, so review the generated package manifest and retain the host lockfile for reproduction. Resolve any dependency incompatibility explicitly; do not bypass it or report it as a passing baseline check.

Follow [Create your first EmDash site](https://docs.emdashcms.com/getting-started/) to complete local setup at `http://localhost:4321/_emdash/admin/` (use the port printed by Astro if different), register a local passkey and create synthetic content. This Node starter needs no cloud account. Keep its generated `.env`, encryption key, database and uploads private and out of this repository. Stop the server before changing registration, then restart it.

## Develop a native plugin

The following paths use `plugin-activity`, the working example in the official native tutorial. Substitute your chosen slug consistently for a real contribution.

From the community repository root:

```sh
mkdir -p plugins/plugin-activity/src
cd plugins/plugin-activity
```

Follow the [native tutorial's package and source instructions](https://docs.emdashcms.com/plugins/creating-native-plugins/your-first-native-plugin/#create-and-register-the-package) in this directory, rather than its example sibling directory. Use its `package.json` and native API as the starting point; implement your actual feature and tests, not just the tutorial log hook. Set the EmDash peer compatibility range to what you can demonstrate, rather than copying the tutorial's wildcard.

In the tutorial's `tsconfig.json`, add `"extends": "astro/tsconfigs/strict"` at the top level. Use Astro's strict preset for plugin-source checking: its standard declaration-file policy avoids requiring every optional database/storage driver referenced by dependency declarations. The tutorial's bare configuration traverses those unrelated declarations and fails on missing optional packages at this baseline. This does not validate dependency internals; source type-checking, the package build and real host integration remain required. Pin the same Astro version used by the host:

```sh
pnpm add -D --save-exact emdash@1.1.0 astro@7.3.5
```

If pnpm reports `ERR_PNPM_IGNORED_BUILDS`, review its listed dependency scripts and use `pnpm approve-builds` to allow only the required, reviewed builds. Astro's `esbuild` binary installation is needed for this walkthrough; do not approve every package indiscriminately. Commit the resulting project-local `pnpm-workspace.yaml` build policy with the lockfile. This file configures the independent plugin project, not the private platform workspace. Then run:

```sh
pnpm run typecheck
pnpm run build
```

Run the real feature tests owned by your package's scripts as well; the native tutorial does not supply a feature test suite. Keep install and lifecycle scripts free of deployment, credential collection, resource provisioning and unrelated side effects.

From the sibling host directory, install the built local plugin deliberately:

```sh
pnpm add file:../zhst-community-plugins/plugins/plugin-activity
```

In the host's generated `astro.config.mjs`, follow the tutorial's descriptor import and registration in `emdash({ plugins: [...] })`. Use your actual exported factory and package name. **Extend the existing integration**; retain the starter's adapter, database, storage and React setup rather than replacing the whole configuration with the tutorial fragment.

Then, from the host:

```sh
pnpm run build
pnpm dev
```

Use the admin and public site to exercise the real feature. For the unchanged upstream tutorial, saving an entry and observing its content-save hook is an initial integration check, not evidence for a different feature. Test your contribution's own routes, hooks and UI. Rebuild and reinstall the local dependency after source changes when the package manager copies rather than links its files; restart the host after descriptor or export changes.

Before submitting, follow [native package inspection](https://docs.emdashcms.com/plugins/creating-native-plugins/distributing/#inspect-the-package): run `npm pack` in the plugin, inspect its file list, install the resulting tarball into the disposable host, then rebuild and exercise every exported UI/rendering surface. A local source import alone cannot prove that the package contains its required files. No npm publication is required for a community PR.

## Optional sandboxed authoring

Choose this only when the feature fits the upstream sandboxed APIs. You need your own public Atmosphere publisher handle or DID, author identity and security contact for the generator. These are public package metadata, not platform credentials. Do not use someone else's identity or a fabricated publisher. No publisher login, registry publication or cloud deployment is required for local authoring.

From the community repository root:

```sh
mkdir -p plugins
cd plugins
pnpm dlx @emdash-cms/plugin-cli@0.13.3 init my-plugin
cd my-plugin
pnpm add -D --save-exact emdash@1.1.0
```

Answer the identity prompts with information you intend to publish. Review the summary, generated scripts and local instructions before executing them. The [released CLI](https://unpkg.com/@emdash-cms/plugin-cli@0.13.3/README.md) owns the command and the [manifest reference](https://docs.emdashcms.com/plugins/creating-plugins/manifest/) owns the schema. This CLI release generates a pre-1.0 EmDash development range; the explicit development dependency above replaces it. Also narrow the generated EmDash peer range to your demonstrated compatibility. Do not mistake successful generation for EmDash 1.1.0 compatibility.

Implement the feature and its tests using the [sandboxed tutorial](https://docs.emdashcms.com/plugins/creating-plugins/your-first-plugin/) and the package's generated scripts:

```sh
pnpm run validate
pnpm run typecheck
pnpm run test
pnpm run build
```

For actual site integration, use the same disposable Node host. Follow [Node.js sandbox setup](https://docs.emdashcms.com/deployment/plugin-sandbox/#nodejs) to install the runner and `workerd`, review the host's dependency-build policy to allow the required binary, and select the documented runner. Then install `file:../zhst-community-plugins/plugins/my-plugin` from the host and follow the sandboxed tutorial's default-export registration in `sandboxed`, preserving the rest of the host configuration. Record the runner and resolved versions. A skipped plugin or unavailable runner is a failed integration check, not a pass. Do not use `sandbox: false` as compatibility evidence.

The generator's publishing and release-setup scripts are outside this repository's contribution workflow. Do not run them to submit a PR or add generated deployment/release automation.

## What reviewers need

Keep executable declarations in the plugin's manifest, source, package metadata and tests. The plugin's own README should link to those owners and explain purpose, trust decisions, local registration, test commands and operator actions; do not duplicate the framework API reference.

- **Identity and compatibility:** keep the directory slug, runtime ID and descriptor/manifest identity aligned; distinguish the npm package name from the runtime ID. Keep package/runtime versions consistent. Native declarations follow the native tutorial; sandboxed declarations follow `emdash-plugin.jsonc` and its schema. Declare supported versions in package metadata and, where applicable, manifest release requirements. Identify Node-only assumptions and Cloudflare-specific dependencies or bindings without recording resource IDs.
- **Least authority:** justify each capability, allowed network host, public endpoint, route permission, storage collection and privileged host access. Link to the declaration, not a second hand-maintained manifest. Use the [capability reference](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/) and [API route contract](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/). Plugin capabilities do not authorize the caller; explicitly check the authenticated caller's permission and ownership for each action.
- **Data boundaries:** scope reads and mutations to the authorized user/site and plugin-owned data. Do not trust caller-supplied ownership IDs or expose drafts, other users' records, secrets or internal error details through public responses or logs. Declare external data recipients, retention and deletion decisions. Native code must not use its broader process access to bypass those boundaries.
- **Dependencies and rights:** commit the package lockfile and declare every runtime/build dependency, license and required notice. Explain new dependencies and their install scripts. Preserve [LICENSE](LICENSE); contribute only material you can distribute under it and retain compatible third-party notices. Do not commit vendored private code or unlicensed assets.
- **Configuration:** name required settings and link to their executable declarations. Use only contributor-owned test credentials if an external integration genuinely requires them; state that prerequisite and untested behavior. A sanitized `.env.example` may document names with empty or obviously non-secret values. Never include real tokens, cookies, private dashboard links, customer data or account/resource identifiers in source, fixtures, screenshots or PR evidence. Review nested ignore rules before adding an example file.
- **Lifecycle:** explain upgrade and schema-migration decisions, backup prerequisites, rollback limits and what deactivation/uninstall retains or deletes. Link to migration and cleanup code/tests. Test an upgrade from the prior supported version when applicable. Never imply removing registration undoes data changes; destructive cleanup requires explicit operator consent. State when no persisted state or migration is involved.

## Prove behavior, including failures

Build and type-check the plugin and registered host, run the package's actual tests, and exercise the admin/public integration. Supply reproducible commands and sanitized results, not just screenshots or a passing build.

Test applicable boundaries through the real host/runtime: anonymous and insufficient-permission callers, authorized callers accessing another user's records, missing capabilities, denied network hosts, invalid or oversized input, absent settings, unavailable upstream services and safe error responses. Assert both the response and the absence of unauthorized mutations/data disclosure. Explain a genuinely inapplicable case rather than marking an unrun case as passed.

For sandboxed plugins, follow the [testing guide](https://docs.emdashcms.com/plugins/creating-plugins/testing/) and use runtime-backed route checks for authentication/authorization. Direct handler invocation or mocked context cannot establish the HTTP permission boundary. For native plugins, exercise the registered plugin through the standalone host and keep pure-unit results separate from integration results. Include activation/deactivation, persistence across restart, migrations and removal as relevant. Browser-facing surfaces also need keyboard and error-state checks.

Local Node results and local sandbox transport tests do not prove deployed Cloudflare isolation, resource limits or platform support. Label each result with runtime, exact dependency versions, commands and tested source commit; list known limitations and unrun checks plainly.

## Open the community PR

Commit only the contribution's source, manifests, lockfile, tests, licensed assets and necessary instructions. Exclude generated builds, tarballs, dependencies, local host state and secrets. Review the staged diff, then commit and push your branch to your fork:

```sh
git add plugins/my-plugin
git diff --cached
git commit -m "feat: add my-plugin"
git push -u origin plugin/my-plugin
```

Use your actual slug and branch. Open a PR against **`ZeroHostCMS/zhst-community-plugins` → `main`**, not the private hosting platform. Complete the [PR template](.github/pull_request_template.md), including package path, source commit, compatibility evidence, permission/data risks, dependency/license changes and migration/removal impact. Redact local identities, secrets and customer information. Do not submit an untouched scaffold as a finished plugin.

## Review and promotion boundary

1. **Community source review:** maintainers assess purpose, code, dependency graph/install scripts, licenses, capabilities, permissions and tests. Merging accepts source only. A fetch, submodule update or merge must never trigger community dependency installation, code execution, activation or deployment.
2. **Manual ZeroHostCMS review:** a maintainer selects and records an exact immutable community commit SHA, reviews its source and locked dependencies, and manually evaluates/deploys that candidate in ZeroHostCMS using their own isolated review resources. The maintainer records compatibility, permission/error behavior, migration/rollback results and the decision. A changed source SHA or dependency set needs renewed review. Contributors do not need access to those resources.
3. **Separate private promotion:** only after that manual review/deployment may a maintainer open a private hosting-platform promotion PR recording the exact community SHA, selected plugin path, review evidence, dependency changes and rollback decision. Sensitive evidence stays in the approved restricted review record, not this public PR. Hosting-platform approval and publication remain separate actions; no credentials belong in community CI.

The platform may fetch community source as a submodule on every build without authorizing its use. No automatic installation, discovery, gallery registration or promotion is promised. Native acceptance does not establish sandbox support, and upstream registry acceptance does not replace this review boundary.
