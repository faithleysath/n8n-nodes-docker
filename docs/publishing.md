# Publishing to npm

This project is ready for self-hosted n8n usage, but there are still a few
owner-specific values to set before the first public npm release.

## 1. Pick a package name

`n8n-nodes-docker` is already taken on npm, so this repository uses:

- `@faithleysath/n8n-nodes-docker`

Alternative:

- `n8n-nodes-docker-<suffix>`

For n8n community nodes, the name must still match one of these formats:

- `n8n-nodes-<name>`
- `@<scope>/n8n-nodes-<name>`

## 2. Create the public GitHub repository

This repo already points to:

- `https://github.com/faithleysath/n8n-nodes-docker`

Before publishing, make sure the GitHub repository is pushed and publicly
accessible.

## 3. Create or log in to your npm account

On this machine you are not logged in yet.

Run:

```bash
npm login
npm whoami
```

This package uses the `@faithleysath` scope, so the npm account must own that
scope.

## 4. Configure GitHub Actions publishing

This repository includes `.github/workflows/publish.yml`, which is the
recommended path for publishing n8n community nodes.

Preferred setup: npm Trusted Publishing

1. Push the repository to GitHub.
2. On npmjs.com, open the package settings.
3. Add a Trusted Publisher for:
   - your GitHub owner/org
   - your repository name
   - workflow `publish.yml`
4. Do not add `NPM_TOKEN` if Trusted Publishing is enabled.

Fallback setup: npm token

1. Create an npm automation token with publish permission.
2. In GitHub, add it as the `NPM_TOKEN` repository secret.

## 5. Run local checks before release

```bash
pnpm lint
pnpm test
pnpm build
npm pack --dry-run
```

`npm pack --dry-run` is useful for confirming exactly what files will ship.

## 6. Recommended first release flow

For a first release, use the simplest path:

1. Update `package.json` fields and version.
2. Update `CHANGELOG.md`.
3. Commit and push your branch to GitHub.
4. Create and push a semver tag such as `0.2.1`.
5. Let GitHub Actions publish the package to npm.

Example:

```bash
git add .
git commit -m "Prepare first npm release"
git push origin main
git tag 0.2.1
git push origin 0.2.1
```

## 7. Optional release helper

This project also has:

```bash
pnpm release
```

That command runs `n8n-node release`, which can help with versioning, changelog,
tagging, and GitHub release creation. It is convenient once your GitHub remote,
authentication, and npm publishing setup are already working.
