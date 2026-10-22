import { mkdir, cp, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json')));
const destination = resolve(root, 'dist/dia-command-bar');
const files = ['manifest.json', 'newtab.html', 'app.js', 'core.js', 'background.js', 'autocomplete.js', 'newtab-router.js', 'styles.css', 'icons', 'README.md'];
await mkdir(destination, { recursive: true });
for (const file of files) { await stat(resolve(root, file)); await cp(resolve(root, file), resolve(destination, file), { recursive: true }); }
const archive = resolve(root, `dist/dia-command-bar-${manifest.version}.zip`);
execFileSync('zip', ['-qr', archive, 'dia-command-bar'], { cwd: resolve(root, 'dist') });
console.log(`Load unpacked: ${destination}\nArchive: ${archive}`);
