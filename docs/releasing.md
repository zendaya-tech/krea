# Publishing Krea to npm

The package name is `krea` and its CLI command is also `krea`. The GitHub repository is `zendaya-tech/krea`. The release workflow is `.github/workflows/publish.yml`.

## First publish

`krea` has not been published yet. npm requires a package to exist before its trusted publisher can be configured. The first publish therefore needs npm authentication. Use a granular npm token with package publishing access and 2FA bypass as the GitHub repository secret `NPM_TOKEN`. Do not put the token in a file or commit it. The release workflow uses that secret for the initial tag. Alternatively, publish the first version interactively with `npm login` and `npm publish --access public`; in that case, do not push the matching tag because publishing the same version again will fail.

Before the first release, confirm that the npm account may publish the name `krea`, then verify the package locally:

```bash
npm ci
npm run build
npm run verify:package
```

For the GitHub workflow bootstrap, add `NPM_TOKEN` as a repository secret, then create and push a tag matching `package.json`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow checks the tag and builds and publishes `krea@0.1.0`. `npm publish` cannot replace an existing name/version pair.

## Switch to trusted publishing

After `krea` appears on npm, open its npm package settings and add a GitHub Actions trusted publisher:

- Organization/user: `zendaya-tech`
- Repository: `krea`
- Workflow filename: `publish.yml`
- Environment: leave blank (the workflow does not use a GitHub environment)
- Allowed action: enable direct `npm publish`

The workflow has `id-token: write` and uses a GitHub-hosted runner with Node 24. npm 11.5.1 or newer detects OIDC and can publish without a static token. Remove the `NPM_TOKEN` repository secret once a release succeeds through trusted publishing. The public GitHub repository and matching `repository.url` allow provenance to link the npm package to its source.

## Later releases

On a clean `main` checkout, update the version and push the commit and tag:

```bash
npm version patch
git push origin main --follow-tags
```

Use `npm version minor` or `npm version major` as appropriate. The tag must be exactly `v` plus the stable `package.json` version. The workflow rejects mismatches and prerelease versions. Review the CI and publish jobs on GitHub, then check `npm view krea version` and `npx krea --version` after publication.
