# Publishing (for maintainers)

Use Node.js 24 with npm >=11.5.1 and the pinned Yarn version through Corepack. Keep the root and all five package versions aligned.

## Release checks

```sh
corepack yarn install --immutable
corepack yarn verify:release
corepack yarn check:consumer --enforce
```

- `verify:release` runs metadata checks, lint, tests, builds, and archive validation. Packages and checksums go to the ignored `artifacts/` directory.
- `check:consumer` installs those archives in a separate project, checks backend imports and frontend styles, and audits dependencies. High or critical advisories block publication; details are saved to `artifacts/consumer-audit.json`.

CI also tests Node 22/24 and PostgreSQL. Confirm those jobs pass before releasing.

## First publish

Sign in to npm with an account allowed to publish under `@abayramli` and enable two-factor authentication. New packages must be published before their trusted publisher can be configured.

After the checks pass, run this from the repository root in Bash or Git Bash. Complete npm's browser login and any authentication prompts:

```sh
npm login --registry=https://registry.npmjs.org
version=$(node -p "require('./package.json').version")
for package in template-pulse-common template-pulse-node scaffolder-backend-module-template-pulse template-pulse-backend template-pulse; do
  npm publish "./artifacts/abayramli-backstage-plugin-${package}-${version}.tgz" \
    --access public --tag latest --registry=https://registry.npmjs.org || exit 1
done
```

This publishes the built archives in dependency order. Teams can then install using the default `latest` tag. The local first publish has no CI provenance.

## npm authentication for GitHub Actions

For **each of the five packages**, open npmjs.com > package > **Settings > Trusted publishing** and select **GitHub Actions**:

- Organization or user: `alibayramli`
- Repository: `template-pulse`
- Workflow filename: `publish.yml`
- Environment name: leave blank
- Allowed actions: enable `npm publish`

Save each configuration. The workflow uses `id-token: write` for [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). No `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or custom GitHub environment is required. Keep the repository public for provenance.

## Later releases

Release Please manages version bumps and tags. In the repository's **Settings > Actions > General**, enable **Allow GitHub Actions to create and approve pull requests**.

1. Push changes to a branch and open a pull request targeting `main`. Use a conventional commit title: `fix:` for fixes, `feat:` for features, or `feat!:` for breaking changes.
2. Wait for **Verify packages** to pass on Node 22 and 24, then squash and merge. Keep the conventional prefix in the final commit title. `docs:` and `chore:` changes alone do not start a release.
3. **Publish npm release** opens or updates a release PR with the root and all five package versions aligned. With the current `0.x` configuration, fixes and features get a patch bump; breaking changes get a minor bump.
4. Review the release PR. If GitHub shows **Approve workflows to run**, approve the runs and wait for CI to pass. Merge this PR when ready to publish.
5. **Publish npm release** creates the matching `v<version>` tag and GitHub release, repeats validation, and publishes all five packages with provenance through npm OIDC.

Regular versions go to `latest`; prereleases go to `next`. Published versions cannot be overwritten.
