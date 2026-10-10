// Compiles the Osen admin template (Bootstrap 5) with Credoc's design tokens.
//
//   OSEN_DIR=/path/to/Osen/src/assets npm run osen
//
// Osen's SCSS declares its variables without !default and builds Bootstrap's maps in the same file,
// so tokens cannot be overridden from outside: the sources are copied to a temp folder, the tokens
// patched there, then compiled. Only the compiled CSS and the icon fonts land in this repo, never the
// template's SCSS sources (licensed template).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as sass from "sass";

const web = resolve(import.meta.dirname, "..");
const osen = resolve(process.env.OSEN_DIR ?? "/home/anonnaes/Documents/Admin/src/assets");
if (!existsSync(join(osen, "scss/app.scss"))) throw new Error(`Osen sources not found in ${osen} (set OSEN_DIR)`);

const tmp = mkdtempSync(join(tmpdir(), "osen-"));
cpSync(join(osen, "scss"), join(tmp, "scss"), { recursive: true });
symlinkSync(join(web, "node_modules"), join(tmp, "scss/node_modules"));

// Credoc tokens: ink #191919, warm grays shared with the landing (#F4F3F3), calm semantic colors.
const tokens = {
  "$gray-100": "#f7f6f5",
  "$gray-200": "#f4f3f3",
  "$gray-300": "#e7e5e4",
  "$gray-400": "#d6d3d1",
  "$gray-500": "#a8a29e",
  "$gray-600": "#78716c",
  "$gray-700": "#57534e",
  "$gray-800": "#292524",
  "$gray-900": "#191919",
  "$primary": "#191919",
  "$secondary": "#78716c",
  "$success": "#2f7d4f",
  "$info": "#3d5a80",
  "$warning": "#b7791f",
  "$danger": "#b42318",
  "$dark": "#191919",
  "$body-bg": "#fafaf9",
  "$body-color": "#3a3836",
  "$border-radius": ".5rem",
  "$box-shadow": "0 1px 2px 0 rgba(25, 25, 25, .05)",
  "$font-size-base": "0.875rem",
};
const varsFile = join(tmp, "scss/_variables.scss");
let vars = readFileSync(varsFile, "utf8");
for (const [name, value] of Object.entries(tokens)) {
  const re = new RegExp(`^(\\${name}:\\s*)[^;]+;`, "m");
  if (!re.test(vars)) throw new Error(`token ${name} not found in Osen _variables.scss`);
  vars = vars.replace(re, `$1${value};`);
}
writeFileSync(varsFile, vars);

// The brand gradient menus/topbars are replaced by ink so every Osen preset stays on-brand.
const themeFile = join(tmp, "scss/_theme-default.scss");
writeFileSync(
  themeFile,
  readFileSync(themeFile, "utf8")
    .replaceAll("linear-gradient(135deg, #6379c3 0%, #546ee5 60%)", "#191919")
    .replace(/@import url\('https:\/\/fonts\.googleapis\.com[^']+'\);/, ""), // fonts are loaded by the page
);

const out = join(web, "src/dashboard/osen");
mkdirSync(out, { recursive: true });
const opts = {
  style: "compressed",
  quietDeps: true,
  silenceDeprecations: ["global-builtin", "color-functions"],
  loadPaths: [join(tmp, "scss"), join(web, "node_modules")],
};
writeFileSync(join(out, "app.css"), sass.compile(join(tmp, "scss/app.scss"), opts).css);
writeFileSync(
  join(out, "icons.css"),
  sass
    .compileString(`$ti-font-path: "/fonts/tabler";\n@import "icons";`, opts)
    // only woff2 is shipped: every browser that runs the dashboard supports it
    .css.replace(/,url\("\/fonts\/tabler\/tabler-icons\.woff\?"\) format\("woff"\),url\("[^"]+\.ttf[^"]*"\) format\("truetype"\)/, ""),
);

const fonts = join(web, "public/fonts/tabler");
mkdirSync(fonts, { recursive: true });
for (const f of ["tabler-icons.woff2"]) cpSync(join(osen, "fonts", f), join(fonts, f));

rmSync(tmp, { recursive: true, force: true });
console.log(`Osen compiled with Credoc tokens -> ${out}`);
