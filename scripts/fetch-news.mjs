// Google ニュース検索RSSから「組織・人事」関連ニュースを収集し、
// 全国/静岡 × カテゴリ別に振り分けて data/news.json に書き出す。
import { XMLParser } from "fast-xml-parser";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "news.json");

const CATEGORIES = [
  {
    key: "personnel",
    label: "企業の人事異動・組織改編",
    keywords: ["人事異動", "組織改編", "役員人事", "昇格 昇進", "経営体制", "社長交代"],
  },
  {
    key: "employment",
    label: "採用・雇用動向",
    keywords: ["採用強化", "雇用調整", "賃上げ", "求人倍率", "労働条件"],
  },
  {
    key: "labor-policy",
    label: "労働法制・行政の人事政策",
    keywords: ["労働法改正", "働き方改革", "厚生労働省 人事", "公務員 人事制度"],
  },
];

const REGIONS = [
  { key: "nationwide", label: "全国", locationTerm: null },
  { key: "shizuoka", label: "静岡", locationTerm: "静岡" },
];

const REQUEST_INTERVAL_MS = 700;
const parser = new XMLParser({ ignoreAttributes: false });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQuery(keywords, locationTerm) {
  const keywordPart = `(${keywords.join(" OR ")})`;
  return locationTerm ? `${locationTerm} ${keywordPart}` : keywordPart;
}

async function fetchRssItems(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=ja&gl=JP&ceid=JP:ja`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (news-aggregator-bot)" },
  });
  if (!res.ok) {
    throw new Error(`RSS fetch failed (${res.status}) for query: ${query}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item ?? [];
  return Array.isArray(items) ? items : [items];
}

function toSourceName(item) {
  const source = item.source;
  if (!source) return "";
  return typeof source === "string" ? source : source["#text"] ?? "";
}

// Google News のタイトルは "見出し - 媒体名" の形式なので媒体名を切り離す
function splitTitle(rawTitle, sourceName) {
  if (sourceName && rawTitle.endsWith(` - ${sourceName}`)) {
    return rawTitle.slice(0, -(sourceName.length + 3));
  }
  return rawTitle;
}

function isToday(pubDate, todayStr) {
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return false;
  const jstStr = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
  }).format(d);
  return jstStr === todayStr;
}

async function collectCategoryForRegion(category, region, todayStr) {
  const query = buildQuery(category.keywords, region.locationTerm);
  const rawItems = await fetchRssItems(query);
  const items = rawItems
    .filter((item) => item?.pubDate && isToday(item.pubDate, todayStr))
    .map((item) => {
      const sourceName = toSourceName(item);
      return {
        title: splitTitle(item.title ?? "", sourceName),
        link: item.link ?? "",
        source: sourceName,
        pubDate: item.pubDate,
      };
    });
  return items;
}

function dedupeAcrossCategories(regionResult) {
  const seenLinks = new Set();
  for (const category of regionResult.categories) {
    category.items = category.items.filter((item) => {
      if (seenLinks.has(item.link)) return false;
      seenLinks.add(item.link);
      return true;
    });
  }
  return regionResult;
}

async function main() {
  const todayStr = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
  }).format(new Date());

  const regions = {};
  for (const region of REGIONS) {
    const categories = [];
    for (const category of CATEGORIES) {
      const items = await collectCategoryForRegion(category, region, todayStr);
      items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      categories.push({ key: category.key, label: category.label, items });
      await sleep(REQUEST_INTERVAL_MS);
    }
    regions[region.key] = dedupeAcrossCategories({
      label: region.label,
      categories,
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    targetDate: todayStr,
    regions,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");

  const totalCount = Object.values(regions).reduce(
    (sum, r) =>
      sum + r.categories.reduce((s, c) => s + c.items.length, 0),
    0
  );
  console.log(`Wrote ${totalCount} articles to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
