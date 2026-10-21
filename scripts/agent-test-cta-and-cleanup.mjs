import fs from 'node:fs';

console.log('================================================================');
console.log('🤖 AGENT TEST: UI CLEANUP & CTA BUTTON ENHANCEMENT AUDIT');
console.log(`Target: http://localhost:3400 | Time: ${new Date().toISOString()}`);
console.log('================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`❌ [FAIL] ${message}`);
    failCount++;
  }
}

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const js = fs.readFileSync('public/app.js', 'utf8');

// 1. Verify "remove that point on live" (nav tab Web Terminal)
const webTerminalTabRegex = /<button[^>]*data-view=["']terminal["'][^>]*>([\s\S]*?)<\/button>/;
const match = html.match(webTerminalTabRegex);
assert(match !== null, 'Web Terminal nav tab exists in index.html');
if (match) {
  const content = match[1];
  assert(!content.includes('live-dot'), 'Web Terminal tab does NOT have .live-dot point');
  assert(content.includes('Web Terminal'), 'Web Terminal text is preserved');
}

// 2. Verify "remove the selected on the card" (hero pills row removed)
assert(!html.includes('hero-pills-row'), 'Hero banner card has NO hero-pills-row');
assert(!html.includes('Smart Risk Management'), 'Hero banner has removed "Smart Risk Management" pill');
assert(!html.includes('Instant Execution'), 'Hero banner has removed "Instant Execution" pill');
assert(!html.includes('class="hero-banner-card"'), 'Hero banner removed from the terminal (requested 2026-10-18)');
assert(html.indexOf('kpi-grid') < html.indexOf('kpi-toolbar-header'), 'Paper mode & date filter sit below the analytics cards');

// 3. Verify "enhance the + Copy a Trader from Leaderboard text section"
assert(js.includes('empty-state-card'), 'app.js defines .empty-state-card');
assert(js.includes('btn-cta-copy'), 'app.js defines .btn-cta-copy');
assert(js.includes('Copy a wallet'), 'app.js has "Copy a wallet" label');
assert(js.includes('btn-cta-icon'), 'app.js renders inline SVG icon for CTA button');
assert(!js.includes('empty-features-pills'), 'Empty state no longer renders the feature pills (removed 2026-10-18)');

// 4. Verify CSS rules for .btn-cta-copy and empty state
assert(css.includes('.btn-cta-copy {'), 'styles.css has .btn-cta-copy rule');
assert(css.includes('.btn-cta-copy:hover'), 'styles.css has .btn-cta-copy:hover state with glow');
assert(css.includes('.btn-cta-copy:active'), 'styles.css has .btn-cta-copy:active state');
assert(css.includes('.empty-features-pills'), 'styles.css has .empty-features-pills rule');
assert(css.includes('.empty-pill'), 'styles.css has .empty-pill rule');
assert(css.includes('radial-gradient'), 'styles.css empty-state-card has radial-gradient backdrop');

console.log('\n================================================================');
console.log(`RESULTS: ${passCount} Passed, ${failCount} Failed`);
console.log('================================================================');

if (failCount > 0) {
  process.exit(1);
}
