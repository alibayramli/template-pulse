# Publishing

Use Node.js 24, npm 11.5.1 or newer, and the project's Yarn version through Corepack. Release Please updates versions and tags for you.

## Check your changes

```sh
corepack yarn install --immutable
corepack yarn verify:release
corepack yarn check:consumer --enforce
```

These commands check, test, build, and pack all five packages, then try installing them in a separate app. High or critical dependency vulnerabilities block the release. Packages and check results are saved in the ignored `artifacts/` folder.

GitHub also checks Node.js 22 and 24 and PostgreSQL. Wait for those checks to pass.

## Set up publishing once

In GitHub, open **Settings > Actions > General** and enable **Allow GitHub Actions to create and approve pull requests**.

For **each of the five npm packages**, open **Settings > Trusted publishing** and choose **GitHub Actions**:

- User: `alibayramli`
- Repository: `template-pulse`
- Workflow filename: `publish.yml`
- Environment: leave blank
- **Allow npm publish**: enabled
- **Allow npm dist-tag**: disabled

Click **Set up connection**. Under **Publishing access**, select **Require two-factor authentication and disallow bypass 2FA tokens**, then click **Update Package Settings**.

GitHub signs in to npm automatically using [trusted publishing](https://docs.npmjs.com/trusted-publishers/). No saved npm token is needed. Keep the repository public so npm can show where each release was built.

## Publish an update

1. Push a branch and open a pull request to `main`. Start the title with `fix:` for fixes, `feat:` for features, or `feat!:` for breaking changes.
2. Wait for **Verify packages** to pass, then squash and merge. Keep that prefix in the final commit title.
3. Release Please opens a release pull request with the new version. Review it, run its checks, and merge it when ready.
4. **Publish npm release** creates the tag and GitHub release, checks the packages again, and uploads all five to npm.

If the release pull request has no checks, run **Verify packages** on its branch from the **Actions** tab.

`docs:` and `chore:` changes alone do not start a release. While versions are below `1.0`, fixes and features get a patch update; breaking changes get a minor update. Regular releases use `latest`; preview releases use `next`. Published versions cannot be replaced.
