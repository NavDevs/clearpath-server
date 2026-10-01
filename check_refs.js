// Rough static check: find identifiers called in the dashboard script that are
// never defined inside it (dead references left by feature removal).
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(process.argv[2], 'public', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('no script block'); process.exit(1); }
const js = m[1];

const defs = new Set();
for (const d of js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defs.add(d[1]);
for (const d of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/g)) defs.add(d[1]);

const builtins = new Set(`
if for while switch catch return function typeof new delete void throw case do else
JSON Number String Boolean Array Object Math Date RegExp Set Map Promise Int8Array Uint8Array
parseInt parseFloat isNaN isFinite setTimeout setInterval clearTimeout clearInterval
requestAnimationFrame requestIdleCallback alert confirm prompt encodeURIComponent
decodeURIComponent encodeURI decodeURI fetch console Promise Proxy Symbol BigInt
structuredClone queueMicrotask atob btoa TextEncoder TextDecoder AbortController
localStorage sessionStorage performance screen crypto
getComputedStyle matchMedia requestFullscreen
`.split(/\s+/).filter(Boolean));

// DOM / common methods and globals we don't care about
const known = new Set(`
$ esc badge empty toast fmtTime relative lifecycle lifecycleLabel typeChip locationOf
countUp setCount token api scheduleRefresh closeModal showPhoto
addEventListener removeEventListener getElementById querySelector querySelectorAll
appendChild removeChild insertBefore cloneNode remove preventDefault stopPropagation
focus blur select submit click submit
map filter find findIndex findLast forEach join split slice splice concat push pop shift
unshift reduce reduceRight some every includes indexOf lastIndexOf at keys values entries
sort reverse flat flatMap from of isArray assign create defineProperty freeze seal
toString toFixed toLocaleString startsWith endsWith replace replaceAll match matchAll
test exec toUpperCase toLowerCase trim padStart padEnd repeat charAt charCodeAt
substring substr length get set has delete add clear keys values size entries forEach
now parse stringify apply call bind catch finally then resolve reject all allSettled race
floor ceil round min max abs pow sqrt trunc sign random log exp hypot
getItem setItem removeItem dispatchEvent addEventListener removeEventListener
querySelector querySelectorAll matches closest getBoundingClientRect
scrollIntoView scrollTo scrollBy getAttribute setAttribute removeAttribute hasAttribute
dataset classList toggle contains createElement createTextNode createDocumentFragment
innerHTML textContent value disabled checked style offsetWidth clientWidth
toast showModal close open
setTimeout clearTimeout setInterval clearInterval
Number isFinite isNaN parseInt parseFloat
Object keys values entries assign fromEntries create getOwnPropertyNames
Promise
String fromCharCode charCodeAt
Array
Date now parse
JSON parse stringify
encodeURI decodeURI encodeURIComponent decodeURIComponent
fetch Headers Request Response FormData Blob File
URL URLSearchParams
crypto getRandomValues
history back forward pushState replaceState
location reload assign href search pathname origin
navigator clipboard geolocation userAgent language
confirm alert prompt
console log warn error info debug
encodeURIComponent decodeURIComponent
`.split(/\s+/).filter(Boolean));

const calls = new Map();
for (const c of js.matchAll(/(?<![.\w$'"`])([a-z_$][\w$]*)\s*\(/g)) {
  const name = c[1];
  if (builtins.has(name) || known.has(name)) continue;
  if (!calls.has(name)) calls.set(name, []);
  const line = js.slice(0, c.index).split('\n').length;
  calls.get(name).push(line);
}

const missing = [...calls.entries()].filter(([n]) => !defs.has(n));
if (!missing.length) console.log('OK: every called identifier is defined in-script.');
else for (const [n, lines] of missing) console.log(`MISSING: ${n}() called at script-lines ${lines.join(', ')}`);
