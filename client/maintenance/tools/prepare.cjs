'use strict';
// Build/verify only. This file never deploys into the installed application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const adapters = require('./adapters.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const compat = JSON.parse(fs.readFileSync(path.join(__dirname, 'compatibility.json'))).versions;
const layout = fs.readFileSync(path.join(__dirname, 'layout.js'));

function entries(node, prefix = '', inherited = false) {
    return Object.entries(node.files).flatMap(([name, e]) => {
        if (!name || name === '.' || name === '..' || /[\\/:]/.test(name)) throw Error('Unsafe archive path');
        const file = prefix + name;
        const unpacked = inherited || !!e.unpacked;
        if (e.link) throw Error('Links require a reviewed packaging adapter');
        return e.files ? entries(e, file + '/', unpacked) : [{ file, e, unpacked }];
    });
}
function payload(asar, archive, item) {
    return item.unpacked ? fs.readFileSync(path.join(archive + '.unpacked', item.file)) : asar.extractFile(archive, path.normalize(item.file));
}
function inventory(asar, archive, issues) {
    return entries(asar.getRawHeader(archive).header).map(item => {
        const bytes = payload(asar, archive, item);
        if (bytes.length !== item.e.size) throw Error('Size mismatch: ' + item.file);
        const hash = sha(bytes);
        const integrity = item.e.integrity;
        if (integrity) {
            if (integrity.algorithm !== 'SHA256' || integrity.hash !== hash || !(integrity.blockSize > 0)) issues.push('Integrity mismatch: ' + item.file);
            const blocks = [];
            if (integrity.blockSize > 0) for (let i = 0; i < bytes.length; i += integrity.blockSize) blocks.push(sha(bytes.subarray(i, i + integrity.blockSize)));
            if (!bytes.length) blocks.push(sha(bytes));
            if (JSON.stringify(blocks) !== JSON.stringify(integrity.blocks)) issues.push('Integrity block mismatch: ' + item.file);
        }
        return { path: item.file, sha256: hash, size: bytes.length, unpacked: item.unpacked, executable: !!item.e.executable };
    });
}
async function inspect(asar, archive) {
    const integrityIssues = [];
    const files = inventory(asar, archive, integrityIssues);
    const packageInfo = JSON.parse(asar.extractFile(archive, 'package.json'));
    const known = compat[packageInfo.version];
    const getHash = file => files.find(e => e.path === file)?.sha256;
    const patched = !!known && getHash('dist/utils.js') === known.patchedUtils && getHash('dist/tray.js') === known.patchedTray && getHash('dist/codex-layout.js') === sha(layout);
    const profile = require('./profiles.cjs').forVersion(packageInfo.version);
    const unified = packageInfo.version === profile?.version && patched &&
        Object.entries(profile.targetModules).every(([file, hash]) => getHash(file) === hash);
    return { version: packageInfo.version, supported: !!profile, sha256: sha(fs.readFileSync(archive)), patched, unified, integrityIssues, files };
}
async function prepare(asar, archive, out) {
    if (fs.existsSync(out)) throw Error('Output must be a new directory');
    const before = await inspect(asar, archive);
    if (require('./profiles.cjs').forVersion(before.version)) {
        if (before.unified && !before.integrityIssues.length) return { status: 'already-installed', version: before.version, sha256: before.sha256, unified: true };
        return require('./unified-build.cjs').buildUnified(asar, archive, out);
    }
    if (before.patched && !before.integrityIssues.length) return { status: 'already-installed', version: before.version, sha256: before.sha256 };
    const known = compat[before.version];
    const oldUtils = asar.extractFile(archive, path.normalize('dist/utils.js'));
    const oldTray = asar.extractFile(archive, path.normalize('dist/tray.js'));
    if (!before.patched && (!known || sha(oldUtils) !== known.utils || sha(oldTray) !== known.tray)) throw Error(`Unreviewed source (${before.version}); no installed files changed`);
    if (!before.patched && before.files.some(e => e.path === 'dist/codex-layout.js')) throw Error('Partial/different policy requires review');
    if (before.files.some(e => e.executable)) throw Error('Executable entries require reviewed packing');
    const transform = before.version === '2.18.1' ? adapters.transform2181 : before.version === '2.17.0' ? adapters.transform2170 : null;
    if (!transform) throw Error('No adapter');
    const transformed = before.patched ? { utils: oldUtils.toString(), tray: oldTray.toString() } : transform(oldUtils.toString().replace(/\r\n/g, '\n'), oldTray.toString().replace(/\r\n/g, '\n'));
    const changes = new Map([['dist/utils.js', Buffer.from(transformed.utils)], ['dist/tray.js', Buffer.from(transformed.tray)], ['dist/codex-layout.js', layout]]);
    for (const [filename, bytes] of changes) new vm.Script(bytes.toString(), { filename });
    // Check the adapter output against the independently captured deployed source.
    if (sha(changes.get('dist/utils.js')) !== known.patchedUtils || sha(changes.get('dist/tray.js')) !== known.patchedTray) throw Error('Adapter output differs from reviewed policy');
    const originalEntries = entries(asar.getRawHeader(archive).header);
    const streams = originalEntries.map(item => {
        const bytes = changes.get(item.file) || payload(asar, archive, item);
        return { path: item.file, type: 'file', unpacked: item.unpacked,
                 stat: { size: bytes.length, mode: 0o644 }, streamGenerator: () => Readable.from(bytes) };
    });
    for (const [file, bytes] of changes) if (!originalEntries.some(e => e.file === file)) streams.push({
        path: file, type: 'file', unpacked: false, stat: { size: bytes.length, mode: 0o644 }, streamGenerator: () => Readable.from(bytes)
    });
    fs.mkdirSync(out, { recursive: true });
    const candidate = path.join(out, 'app.asar');
    await asar.createPackageFromStreams(candidate, streams);
    const after = await inspect(asar, candidate);
    if (!after.patched || after.integrityIssues.length || after.files.length !== before.files.length + (before.patched ? 0 : 1)) throw Error('Candidate policy/integrity/file count mismatch');
    const originalByPath = new Map(before.files.map(e => [e.path, e]));
    for (const file of after.files) {
        const original = originalByPath.get(file.path);
        if (!original && file.path !== 'dist/codex-layout.js') throw Error('Unexpected new file');
        if (original && (original.unpacked !== file.unpacked || original.executable !== file.executable)) throw Error('Metadata changed: ' + file.path);
        const expected = changes.has(file.path) ? sha(changes.get(file.path)) : original?.sha256;
        if (file.sha256 !== expected) throw Error('Payload changed unexpectedly: ' + file.path);
    }
    const current = await inspect(asar, archive);
    if (current.sha256 !== before.sha256 || JSON.stringify(current.files) !== JSON.stringify(before.files)) throw Error('Source changed during preparation');
    const result = { schema: 2, status: 'prepared', version: before.version,
        sourceArchive: path.resolve(archive), before: before.sha256, after: after.sha256,
        unpacked: before.files.filter(e => e.unpacked), changes: before.patched ? [] : [...changes.keys()],
        repairedMetadata: before.integrityIssues,
        preparedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(out, 'prepared.json'), JSON.stringify(result, null, 2));
    return result;
}
async function main() {
    const asar = await import('@electron/asar');
    const [mode, source, dest] = process.argv.slice(2);
    if (!source || !['--inspect', '--prepare'].includes(mode)) throw Error('Use --inspect ARCHIVE or --prepare ARCHIVE NEW_OUTPUT_DIRECTORY');
    const result = mode === '--inspect' ? await inspect(asar, path.resolve(source)) : await prepare(asar, path.resolve(source), path.resolve(dest));
    if (mode === '--inspect') { const { files, ...summary } = result; console.log(JSON.stringify({ ...summary, entries: files.length, unpacked: files.filter(e => e.unpacked).length })); }
    else console.log(JSON.stringify(result.status === 'prepared' ? { ...result, unpacked: result.unpacked.length } : result));
}
module.exports = { entries, payload, inventory, inspect, prepare, sha };
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
