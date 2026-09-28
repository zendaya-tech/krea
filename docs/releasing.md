# Publishing Krea to npm

The npm package is `@ngdream/krea`; the CLI command it installs is `krea`. The GitHub repository is `zendaya-tech/krea`. npm rejected the unscoped package name `krea` because it was too similar to existing names.

## First publish

An npm package must exist before its trusted publisher can be configured. Publish the first version interactively with `npm login` and two-factor authentication. Do not push the matching tag afterward, because npm will reject a second publish of the same version.

From a clean checkout, verify the package and publish it:

```bash
npm ci
npm run build
npm run verify:package
npm publish --access public --ignore-scripts
```

The initial attempt to publish unscoped `krea@0.1.0` from GitHub Actions was rejected by npm. The token-based attempt required interactive two-factor authentication, so `@ngdream/krea@0.1.1` was published locally.

## Switch to trusted publishing

After `@ngdream/krea` appears on npm, open its npm package settings and add a GitHub Actions trusted publisher:

- Organization or user: `zendaya-tech`
- Repository: `krea`
- Workflow filename: `publish.yml`
- Environment: leave blank (the workflow does not use a GitHub environment)
- Allowed action: enable direct `npm publish`

The workflow has `id-token: write` and uses a GitHub-hosted runner with Node 24. npm detects OIDC and can publish without a static token. Once this works, remove the `NPM_TOKEN` repository secret and revoke its npm token. The public GitHub repository and matching `repository.url` allow provenance to link the package to its source.

## Later releases

On a clean `main` checkout, update the version and push the commit and tag:

```bash
npm version patch
git push origin main --follow-tags
```

Use `npm version minor` or `npm version major` as appropriate. The tag must be exactly `v` plus the stable `package.json` version. The workflow rejects mismatches and prerelease versions. Review the CI and publish jobs on GitHub, then check `npm view @ngdream/krea version` and `npx @ngdream/krea --version` after publication.
