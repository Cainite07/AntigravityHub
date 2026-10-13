# AntigravityHub maintenance

- Hub versions follow the supported client's major/minor version; Hub fixes increment the patch version.
- Program cleanup and updates must preserve `%USERPROFILE%\.antigravity_hub`, independent history backups, development source and required tools. Treat usage history as user data, never as disposable cache. Clearing history requires an explicit request to clear history.
- Before changes to installed software or usage storage, create a consistent SQLite snapshot and compare historical date coverage, event identities and token totals afterward. Checking account/settings files alone is insufficient.
- Recover by merging missing event identities and historical residuals while keeping current rows and cursors. Do not replace a live usage database with an older backup. Verify idempotence and aggregation integrity.
- Private data, official ASAR bases, history databases, accounts and credentials must never be included in source commits or public packages.
- Adapt client components with reviewed versions/hashes and normal client exit; never force-stop Antigravity tasks.
