// Fills /DATA (or the folder given) with made-up photos, documents, films and music for the demo.
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.argv[2] ?? "/DATA";
const DAY = 86_400_000;
let n = 0;

async function put(rel, body, { size, daysAgo = 3 + (n % 40) } = {}) {
  n++;
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body ?? "");
  if (size) await fs.truncate(file, size);
  const t = new Date(Date.now() - daysAgo * DAY - (n % 7) * 3_600_000);
  await fs.utimes(file, t, t);
}

const skies = [["#ffb36b", "#ff6f61", "#5b3a70"], ["#9ad4f5", "#4b8ec8", "#1d3d6b"], ["#fde7a9", "#f6a85b", "#c2543b"], ["#c9e9f2", "#86c5d8", "#2f6f8a"], ["#f7d6e0", "#c79ad6", "#4a3b7a"], ["#d8f0c8", "#8cc084", "#2e5e3a"]];
function photo(i) {
  const [a, b, c] = skies[i % skies.length];
  const hill = (y, h, col) => `<path d="M0 ${y} C 400 ${y - h} 800 ${y + h} 1200 ${y - h / 2} S 1600 ${y} 1600 ${y} V 1200 H 0 Z" fill="${col}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="1600" height="1200" fill="url(#s)"/><circle cx="${300 + ((i * 230) % 1000)}" cy="${380 + ((i * 70) % 200)}" r="110" fill="#fff8e7" opacity=".85"/>
    ${hill(820 + (i % 3) * 30, 120, c)}${hill(960, 80, "#00000033")}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

const albums = { "2026/10 Lake weekend": 9, "2026/09 Garden": 6, "2026/08 Coast trip": 8 };
let i = 0;
for (const [album, count] of Object.entries(albums)) {
  for (let k = 0; k < count; k++, i++) await put(`photos/${album}/IMG_${4100 + i}.jpg`, await photo(i), { daysAgo: 1 + i });
}

const docs = ["Home/Boiler manual.pdf", "Home/Dishwasher manual.pdf", "Home/Floor plan.pdf", "Insurance/Home insurance 2026.pdf", "Insurance/Car insurance 2026.pdf", "Receipts/2026-10 Bike service.pdf", "Receipts/2026-09 Laptop.pdf", "Recipes/Pancakes.md", "Recipes/Lentil soup.md", "Garden plan.ods", "Packing list.txt"];
for (const d of docs) await put(`documents/${d}`, d.endsWith(".pdf") ? "%PDF-1.4\n%demo\n" : `# ${path.basename(d, path.extname(d))}\n\nMade-up demo file.\n`, { size: d.endsWith(".pdf") ? 180_000 + docs.indexOf(d) * 41_000 : undefined });

const films = [["Big Buck Bunny (2008)", 1.4], ["Sintel (2010)", 2.1], ["Tears of Steel (2012)", 3.2], ["Elephants Dream (2006)", 1.1]];
for (const [f, gb] of films) await put(`media/Movies/${f}/${f}.mkv`, null, { size: Math.round(gb * 1e9), daysAgo: 20 + films.length });
for (let e = 1; e <= 6; e++) await put(`media/Shows/Nature Walks/Season 1/Nature Walks S01E0${e}.mkv`, null, { size: 6e8 + e * 3e7, daysAgo: 9 + e });

const tracks = ["Morning Light", "Harbour", "Paper Boats", "Slow River", "Lanterns", "Northbound", "Quiet Hours", "Last Ferry"];
for (const [t, title] of tracks.entries()) await put(`music/Northern Lights Quartet/Winter Sessions/0${t + 1} ${title}.flac`, null, { size: 2.4e7 + t * 3e6, daysAgo: 30 });
for (const [t, title] of tracks.slice(0, 5).entries()) await put(`music/The Lamplighters/Small Town Radio/0${t + 1} ${title}.mp3`, null, { size: 8e6 + t * 7e5, daysAgo: 45 });

console.log(`Made ${n} files in ${root}`);
