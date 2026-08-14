// dist の中だけを見て、内部リンクとアンカーの行き先が実在するか確かめる。
// 外部 URL には接続しない(CI を軽く保つため形式チェックのみ)。
//
//   node scripts/check.mjs   ※先に npm run build が要る
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BASE = "/youjitsu-portal/"; // astro.config.mjs の base と揃える
const ORIGIN = "https://izenmi.github.io";

if (!existsSync(DIST)) {
  console.error("dist/ がありません。先に npm run build を実行してください。");
  process.exit(1);
}

const htmlFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith(".html")) htmlFiles.push(full);
  }
})(DIST);

// dist にあるファイルを先に索引しておく(1本ずつ existsSync を呼ぶと遅い)。
const files = new Set();
(function walk(dir, prefix) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, `${prefix}/${entry}`);
    else files.add(`${prefix}/${entry}`);
  }
})(DIST, "");

const pages = new Map();
const idsByPage = new Map();
for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const rel = "/" + relative(DIST, file).split("\\").join("/");
  pages.set(rel, html);
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  idsByPage.set(rel, ids);
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** base 起点の URL を dist 内のファイルパスへ変換する。 */
function resolve(pathname) {
  if (!pathname.startsWith(BASE)) return null;
  const rel = pathname.slice(BASE.length);
  const candidates =
    rel === "" || rel.endsWith("/")
      ? [posix.join("/", rel, "index.html")]
      : [posix.join("/", rel), posix.join("/", rel, "index.html")];
  return candidates.map(decode).find((c) => files.has(c)) ?? null;
}

const problems = [];
const externalHosts = new Set();
let internalLinks = 0;

for (const [page, html] of pages) {
  // ── 1. リンク ──────────────────────────────────────
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = m[1];
    if (raw.startsWith("#")) continue;
    // インラインスクリプトが実行時に組み立てる URL。静的には追えない。
    if (raw.includes("${")) continue;
    // http(s) 以外のスキーム(tel: mailto: data: …)は対象外。
    if (/^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(raw)) continue;

    if (/^https?:\/\//.test(raw)) {
      const url = new URL(raw);
      if (url.origin === ORIGIN && url.pathname.startsWith(BASE)) {
        if (!resolve(url.pathname)) problems.push(`${page}: 絶対URLの行き先が dist にありません → ${raw}`);
      } else {
        externalHosts.add(url.host);
      }
      continue;
    }

    if (!raw.startsWith("/")) {
      problems.push(`${page}: base 起点でない相対リンク → ${raw}`);
      continue;
    }

    const [beforeHash, hash] = raw.split("#");
    const pathname = beforeHash.split("?")[0];
    // 同一オリジンだが base の外(姉妹サイト)は dist に無いので存在確認しない。
    if (!pathname.startsWith(BASE)) continue;

    internalLinks++;
    const target = resolve(pathname);
    if (!target) {
      problems.push(`${page}: リンク切れ → ${raw}`);
      continue;
    }
    if (hash && idsByPage.has(target) && !idsByPage.get(target).has(hash)) {
      problems.push(`${page}: アンカーの行き先がありません → ${raw}`);
    }
  }

  // ── 2. メタ情報 ────────────────────────────────────
  const title = /<title>([^<]*)<\/title>/.exec(html);
  if (!title || !title[1].trim()) problems.push(`${page}: <title> が空です`);
  const desc = /<meta name="description" content="([^"]*)"/.exec(html);
  if (!desc || !desc[1].trim()) problems.push(`${page}: description が空です`);
}

if (problems.length) {
  console.error(`リンクチェック NG (${problems.length}件):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `リンクチェック OK: ${pages.size}ページ / 内部リンク ${internalLinks}本 / ` +
    `外部ホスト ${[...externalHosts].join(", ") || "なし"}`,
);
