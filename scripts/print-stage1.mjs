import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/app.js', 'utf8');

const getElemRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
const missingIds = [];
let m;
while ((m = getElemRegex.exec(js)) !== null) {
  const id = m[1];
  // check if dynamic id like lim-type-${p.id} which won't be static in html
  if (id.includes('${') || id.startsWith('lim-') || id.startsWith('card-pnl-') || id.startsWith('fol-name-')) {
    continue;
  }
  if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
    if (!missingIds.includes(id)) missingIds.push(id);
  }
}
console.log('MISSING IDS:', missingIds);

const onclickRegex = /on(?:click|change|submit)=["']([a-zA-Z0-9_]+)\(/g;
const missingHandlers = [];
while ((m = onclickRegex.exec(html)) !== null) {
  const fnName = m[1];
  const hasDef =
    js.includes(`function ${fnName}`) ||
    js.includes(`window.${fnName}`) ||
    js.includes(`const ${fnName} =`) ||
    js.includes(`let ${fnName} =`);
  if (!hasDef && !missingHandlers.includes(fnName)) {
    missingHandlers.push(fnName);
  }
}
console.log('MISSING HANDLERS:', missingHandlers);
