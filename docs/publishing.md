# Publishing

Keep the root and all five package versions aligned, then run:

```sh
corepack yarn install --immutable
corepack yarn verify:release
corepack yarn check:consumer --enforce
```

- `verify:release` runs metadata checks, lint, tests, builds, and archive validation. Packages and checksums go to the ignored `artifacts/` directory.
- `check:consumer` installs those archives in a separate project, checks backend imports and frontend styles, and audits dependencies. High or critical advisories block publication; details are saved to `artifacts/consumer-audit.json`.

CI also tests Node 22/24 and PostgreSQL. Confirm those jobs pass before releasing.

For the first release, log in with `npm login` and publish the verified archives in this order: common library, Node library, Scaffolder module, backend, frontend.

```sh
npm publish artifacts/<package>-<version>.tgz --access public --tag next --registry=https://registry.npmjs.org
```

For later releases, configure an [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) on each package: GitHub owner `alibayramli`, repository `template-pulse`, workflow `publish.yml`, with direct publishing enabled. Run **Publish npm preview** manually from `main`; it repeats validation and publishes with provenance to `next`.

After preview testing, promote the same version to `latest` using npm dist-tags.
