# Releases

Use semantic versions: patches for compatible fixes, minor versions for compatible features, major versions for incompatible interfaces or state formats. Before 1.0, document incompatible changes explicitly. Runtime dependency upgrades must preserve or migrate existing homes and pass recovery tests.

## Development

Work on a feature branch and open a pull request against main. CI runs typecheck, runtime/recovery tests, and a clean package installation/API check on Linux (Node 22.19 and 24) and macOS (Node 24). The package smoke test installs in a temporary directory and makes no paid model calls.

Dependencies are exactly pinned at the direct level and locked transitively in npm-shrinkwrap.json. Use npm ci --ignore-scripts for normal installs. To update dependencies, update the lock intentionally and review its diff. Lifecycle scripts are not required for this runtime.

## Cut a version

1. Run `npm run release:prepare -- 0.1.1` with the intended new version. This updates package.json and npm-shrinkwrap.json and creates a changelog section and release notes.
2. Complete CHANGELOG.md and releases/v0.1.1.md. Include state-format changes, migration steps, and known limitations. Release validation rejects TODO placeholders and version mismatches.
3. Run `npm run check` and `npm run release:check -- --tag v0.1.1`.
4. Commit and merge the release preparation into main. Wait for CI to pass.
5. From a clean, current main checkout, create and push the tag:

   ```sh
   git tag -a v0.1.1 -m 'Donjon Agent 0.1.1'
   git push origin v0.1.1
   ```

The tag workflow reruns the full CI matrix. Only when it passes does it validate the tag/version/lock/notes, build the package, generate SHA-256 checksums, and create a GitHub release with both files attached. Hyphenated versions are marked prerelease. Releases use the repository's built-in GitHub token; no public registry token is needed. Each version must be new; published releases are not silently overwritten.

The initial v0.1.0 already has complete release notes and does not need release:prepare.

## Install or roll back

Download the release archive and SHA256SUMS, then:

```sh
shasum -a 256 -c SHA256SUMS
npm install -g ./donjon-agent-0.1.0.tgz
```

A rollback means installing the prior archive. Back up an agent home before upgrading a version with state changes. Do not open a newer state format with an older runtime unless the release explicitly supports it. An app rollback and a memory rollback are separate operations.

## Local packaging

```sh
npm run build
mkdir -p artifacts
npm pack --ignore-scripts --pack-destination artifacts
```

No signing, desktop installer, or automatic application updater is provided yet. Those belong to the later desktop-app release process.
