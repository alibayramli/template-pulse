# Publishing

Use Node.js 24 with npm >=11.5.1 and the pinned Yarn version through Corepack. Keep the root and all five package versions aligned; the first release is `0.1.0`.

## Release checks

```sh
corepack yarn install --immutable
corepack yarn verify:release
corepack yarn check:consumer --enforce
```

- `verify:release` runs metadata checks, lint, tests, builds, and archive validation. Packages and checksums go to the ignored `artifacts/` directory.
- `check:consumer` installs those archives in a separate project, checks backend imports and frontend styles, and audits dependencies. High or critical advisories block publication; details are saved to `artifacts/consumer-audit.json`.

CI also tests Node 22/24 and PostgreSQL. Confirm those jobs pass before releasing.

## First publish: 0.1.0

Sign in to npm with an account allowed to publish under `@abayramli` and enable two-factor authentication. New packages must be published before their trusted publisher can be configured.

After the checks pass, run this from the repository root in Bash or Git Bash. Complete npm's browser login and any authentication prompts:

```sh
npm login --registry=https://registry.npmjs.org
for package in template-pulse-common template-pulse-node scaffolder-backend-module-template-pulse template-pulse-backend template-pulse; do
  npm publish "./artifacts/abayramli-backstage-plugin-${package}-0.1.0.tgz" \
    --access public --tag latest --registry=https://registry.npmjs.org || exit 1
done
```

This publishes the built archives in dependency order. Teams can then install `@0.1.0` or use the default `latest` tag. The local first publish has no CI provenance.

## npm authentication for GitHub Actions

For **each of the five packages**, open npmjs.com > package > **Settings > Trusted publishing** and select **GitHub Actions**:

- Organization or user: `alibayramli`
- Repository: `template-pulse`
- Workflow filename: `publish.yml`
- Environment name: leave blank
- Allowed actions: enable `npm publish`

Save each configuration. The workflow uses `id-token: write` for [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). No `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or custom GitHub environment is required. Keep the repository public for provenance.

## Later releases

1. Update the root and all five package versions together. On `0.x`, use patch bumps for compatible changes and minor bumps for breaking changes; use a suffix such as `0.2.0-rc.1` for previews. Move to `1.0.0` when the public API is stable, then follow [SemVer](https://semver.org/spec/v2.0.0.html).
2. Run `corepack yarn install` to update the lockfile, commit the changes to `main`, and wait for CI to pass.
3. Push a tag matching the version exactly, for example:

   ```sh
   git tag v0.1.1
   git push origin v0.1.1
   ```

**Publish npm release** checks the tag against the package version, repeats validation, then publishes with provenance. Regular versions go to `latest`; prereleases go to `next`. It can also be dispatched against a matching tag.

Published versions cannot be overwritten. For a final release after `0.2.0-rc.1`, bump all packages to `0.2.0` and push `v0.2.0` through the same cycle.
