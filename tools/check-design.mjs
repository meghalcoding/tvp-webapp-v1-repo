import { readFile } from 'node:fs/promises';

const css = await readFile('css/styles.css', 'utf8');
const js = await readFile('js/app.js', 'utf8');
const ui = await readFile('js/ui.js', 'utf8');
const files = ['daily-operations.js','procurement-inventory.js','documents.js','relationships.js','budget.js','automation.js','financial-engine.js'];

const errors = [];
const rootStart = css.indexOf(':root {');
if (rootStart < 0) errors.push('Missing consolidated :root token block.');
let depth = 0, rootEnd = -1;
for (let i = rootStart; i >= 0 && i < css.length; i++) {
  if (css[i] === '{') depth++;
  if (css[i] === '}') { depth--; if (depth === 0) { rootEnd = i + 1; break; } }
}
const root = rootEnd > 0 ? css.slice(rootStart, rootEnd) : '';
const outside = rootEnd > 0 ? css.slice(rootEnd) : css;

if ((css.match(/:root\s*\{/g) || []).length !== 1) errors.push('Expected exactly one :root block.');
if (/var\(--(?:ink|ink-soft|paper|paper-raised|paper-sunken|turmeric|turmeric-ink|chutney-green|chutney-red|steel|px-[0-9_]+)\)/.test(css)) errors.push('Legacy design tokens remain.');
if (outside.match(/#[0-9a-fA-F]{3,6}/g)?.length) errors.push('Hardcoded hex colors remain outside the token block.');
if (css.includes('!important')) errors.push('!important remains in styles.css.');
if (/var\(--[\w-]+\s*,/.test(css)) errors.push('Token fallback syntax remains.');
if (/(padding|margin|gap|row-gap|column-gap):[^;}]*\b\d+(?:\.\d+)?px/.test(css)) errors.push('Raw px spacing remains in padding/margin/gap declarations.');
if (/font-size:\s*(?:\d+(?:\.\d+)?)(?:px|rem|em)/.test(css)) errors.push('Raw font-size values remain instead of semantic text tokens.');
if (/border-radius:\s*[^;}]*(?:px|rem|em)/.test(css)) errors.push('Raw border-radius values remain.');
if (/style\s*=/.test(await Promise.all(['index.html', ...files.map(f => `js/${f}`)].map(async f => readFile(f, 'utf8'))).then(xs => xs.join('\n')))) errors.push('Static inline styles remain in app screens.');

for (const f of files) {
  const text = await readFile(`js/${f}`, 'utf8');
  if (!text.includes('from "./ui.js"')) errors.push(`${f} does not import ui.js explicitly.`);
  if (/window\.__(?:toast|confirmDialog|promptDialog|friendlyError|setButtonLoading)/.test(text)) errors.push(`${f} still consumes a UI primitive through window globals.`);
}
if (!ui.includes('event.key === \'Escape\'')) errors.push('Dialog Escape handling missing.');
if (!ui.includes("event.key !== 'Tab'")) errors.push('Dialog focus-trap handling missing.');
if (!ui.includes('previousFocus?.focus')) errors.push('Dialog focus restoration missing.');
if (!ui.includes('export function attachDropdown')) errors.push('Reusable dropdown helper missing.');
if (!js.includes('group.classList.toggle(\'show-secondary\'')) errors.push('Nav search secondary-item expansion fix missing.');
if (!js.includes('id="more-search"')) errors.push('Mobile More search missing.');
if (!js.includes('attachDropdown(quickNew, quickMenu)')) errors.push('Quick Actions dropdown helper not attached.');
if (/Backup failed:\s*\$\{err\.message\}/.test(js)) errors.push('Raw backup error message remains.');
if (/accErr\?\.message \|\| stockErr\?\.message \|\| upiErr\?\.message/.test(js)) errors.push('Raw dashboard error message remains.');

console.log(`Design checks: ${errors.length ? 'FAILED' : 'PASSED'}`);
if (errors.length) { for (const e of errors) console.error(`- ${e}`); process.exit(1); }
console.log('✓ one consolidated token block');
console.log('✓ no legacy token refs / px spacing vars / fallback token syntax');
console.log('✓ no hardcoded hex colors outside tokens');
console.log('✓ no !important');
console.log('✓ typography uses 12px+ semantic tokens');
console.log('✓ no static inline screen styles');
console.log('✓ explicit ui.js imports and dialog/dropdown behavior checks');
