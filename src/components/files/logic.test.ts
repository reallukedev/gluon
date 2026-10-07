import { describe, expect, it } from "vitest";
import type { Place, Places } from "@/lib/files-types";
import { columnsFor, commandIds, fullness, groupPlaces, matches, parseCommand, planUpload, rangeOf, rankCompletions, rememberView, sortItems, splitTypedPath, timeKind, toggleWord, uploadTops, viewFor, type CommandContext } from "./logic";

describe("parseCommand", () => {
  it("reads a path, actions and an empty bar", () => {
    expect(parseCommand("", false)).toEqual({ mode: "empty" });
    expect(parseCommand("/home/lu", false)).toEqual({ mode: "path", text: "/home/lu" });
    expect(parseCommand("~/Pictures", false, "/home/luke")).toEqual({ mode: "path", text: "/home/luke/Pictures" });
    expect(parseCommand(">  rename", true)).toEqual({ mode: "action", text: "rename" });
  });

  it("only offers a destination when something is selected", () => {
    expect(parseCommand("move to mov", true)).toEqual({ mode: "dest", verb: "move", text: "mov" });
    expect(parseCommand("cp films", true)).toEqual({ mode: "dest", verb: "copy", text: "films" });
    expect(parseCommand("move to ", true)).toEqual({ mode: "dest", verb: "move", text: "" });
    expect(parseCommand("cp films", false).mode).toBe("find");
  });

  it("reads move to … as a destination, never as a search for the words", () => {
    expect(parseCommand("move to Movies", false)).toEqual({ mode: "dest", verb: "move", text: "Movies" });
    expect(parseCommand("copy to backup", true)).toEqual({ mode: "dest", verb: "copy", text: "backup" });
    expect(parseCommand("move to", false)).toEqual({ mode: "dest", verb: "move", text: "" });
  });

  it("turns everyday words into filters and keeps the rest as the name", () => {
    const p = parseCommand("lisbon photos from this week", false);
    expect(p).toMatchObject({ mode: "find", name: "lisbon", kinds: ["image"], days: 7, minSize: null });
    expect(parseCommand("big videos", false)).toMatchObject({ name: "", kinds: ["video"], minSize: 1e9 });
    expect(parseCommand("logs >500mb", false)).toMatchObject({ name: "logs", minSize: 500e6 });
  });

  it("leaves plain words alone when nothing was recognised", () => {
    expect(parseCommand("the compose file", false)).toMatchObject({ name: "the compose file", tokens: [] });
  });
});

describe("toggleWord", () => {
  it("adds and removes a filter word", () => {
    expect(toggleWord("lisbon", "photos")).toBe("lisbon photos ");
    expect(toggleWord("lisbon Photos ", "photos")).toBe("lisbon ");
    expect(toggleWord("", "week")).toBe("week ");
  });
});

describe("path completion", () => {
  it("splits what's typed into the folder and the stem", () => {
    expect(splitTypedPath("/home/luke/Pi")).toEqual({ dir: "/home/luke", stem: "pi" });
    expect(splitTypedPath("/home/luke/")).toEqual({ dir: "/home/luke", stem: "" });
    expect(splitTypedPath("/ho")).toEqual({ dir: "/", stem: "ho" });
    expect(splitTypedPath("/")).toEqual({ dir: "/", stem: "" });
  });

  it("ranks names that start with the stem before names that contain it", () => {
    const names = ["Downloads", "Documents", "Music", "Old docs", "docker"];
    expect(rankCompletions(names, "do")).toEqual(["Downloads", "Documents", "docker", "Old docs"]);
    expect(rankCompletions(names, "doc")).toEqual(["Documents", "docker", "Old docs"]);
    expect(rankCompletions(names, "", 2)).toEqual(["Downloads", "Documents"]);
  });
});

describe("columnsFor", () => {
  const places = { places: [{ path: "/", kind: "root" }, { path: "/home/luke", kind: "home" }, { path: "/DATA", kind: "drive" }] as Place[] };
  it("starts the columns at the place the path is in", () => {
    expect(columnsFor("/home/luke/Pictures/Lisbon", places, true)).toEqual(["/home/luke", "/home/luke/Pictures", "/home/luke/Pictures/Lisbon"]);
    expect(columnsFor("/DATA", places, true)).toEqual(["/DATA"]);
  });
  it("falls back to the computer for admins and to the folder itself for members", () => {
    expect(columnsFor("/srv/x", places, true)).toEqual(["/", "/srv", "/srv/x"]);
    expect(columnsFor("/srv/x", places, false)).toEqual(["/srv/x"]);
  });
});

describe("matches", () => {
  const now = Date.UTC(2026, 9, 7);
  const photo = { name: "Tram 28.jpg", path: "/home/luke/Pictures/Lisbon 2025/Tram 28.jpg", kind: "image" as const, mtime: now - 3 * 86_400_000, size: 400_000 };
  it("applies kind, age and size", () => {
    expect(matches(photo, { name: "", kinds: ["image"], days: 7, minSize: null }, now)).toBe(true);
    expect(matches(photo, { name: "", kinds: ["video"], days: null, minSize: null }, now)).toBe(false);
    expect(matches(photo, { name: "", kinds: [], days: 1, minSize: null }, now)).toBe(false);
    expect(matches(photo, { name: "", kinds: [], days: null, minSize: 1024 ** 2 }, now)).toBe(false);
  });
  it("lets a name match a folder on the way only alongside a filter", () => {
    expect(matches(photo, { name: "lisbon", kinds: ["image"], days: null, minSize: null }, now, "/home/luke")).toBe(true);
    expect(matches(photo, { name: "lisbon", kinds: [], days: null, minSize: null }, now, "/home/luke")).toBe(false);
    expect(matches(photo, { name: "tram", kinds: [], days: null, minSize: null }, now)).toBe(true);
  });
});

describe("sortItems", () => {
  const items = [
    { name: "b.mkv", kind: "video" as const, mtime: 3, size: 10 },
    { name: "Folder", kind: "folder" as const, mtime: 1, size: null },
    { name: "a10.jpg", kind: "image" as const, mtime: 2, size: 30 },
    { name: "a9.jpg", kind: "image" as const, mtime: 2, size: 20 },
  ];
  it("keeps folders first and sorts names naturally", () => {
    expect(sortItems(items, "name", "asc").map((i) => i.name)).toEqual(["Folder", "a9.jpg", "a10.jpg", "b.mkv"]);
  });
  it("sorts by date and size, ties by name", () => {
    expect(sortItems(items, "mtime", "desc").map((i) => i.name)).toEqual(["Folder", "b.mkv", "a9.jpg", "a10.jpg"]);
    expect(sortItems(items, "size", "desc").map((i) => i.name)).toEqual(["Folder", "a10.jpg", "a9.jpg", "b.mkv"]);
  });
});

describe("commandIds", () => {
  const base: CommandContext = { count: 0, oneIsDir: false, oneIsArchive: false, writable: true, admin: true, inFolder: true, hasParent: true, clipboard: false };
  it("never offers changes in a folder you can only view", () => {
    const ids = commandIds({ ...base, count: 2, writable: false });
    for (const id of ["move", "rename", "trash", "duplicate", "cut", "new-folder", "upload", "paste", "extract"] as const) expect(ids).not.toContain(id);
    expect(ids).toEqual(expect.arrayContaining(["zip", "copy", "copy-clip"]));
  });
  it("keeps admin tools from members", () => {
    const member = commandIds({ ...base, count: 1, oneIsDir: true, admin: false });
    expect(member).not.toContain("ownership");
    expect(member).not.toContain("used-by");
    expect(commandIds({ ...base, count: 1, oneIsDir: true })).toEqual(expect.arrayContaining(["ownership", "used-by", "pin"]));
  });
  it("offers rename and extract only for one item, and paste only with something cut or copied", () => {
    expect(commandIds({ ...base, count: 2 })).not.toContain("rename");
    expect(commandIds({ ...base, count: 1, oneIsArchive: true })).toContain("extract");
    expect(commandIds(base)).not.toContain("paste");
    expect(commandIds({ ...base, clipboard: true })).toContain("paste");
  });
});

describe("groupPlaces", () => {
  const pl = (kind: Place["kind"], path: string, extra: Partial<Place> = {}): Place => ({ id: path, label: path, path, kind, access: "write", ...extra });
  const all: Places = { admin: true, places: [pl("root", "/"), pl("drive", "/DATA"), pl("home", "/home/luke"), pl("media", "/DATA/media"), pl("grant", "/DATA/photos")], pins: [pl("pin", "/home/luke/Pictures")], recent: [] };
  it("shows admins everything", () => {
    expect(groupPlaces(all).map(([g]) => g)).toEqual(["shared", "pins", "drives", "people", "apps"]);
  });
  it("shows members only what's shared with them and their own pins", () => {
    expect(groupPlaces({ ...all, admin: false }).map(([g]) => g)).toEqual(["shared", "pins"]);
  });
});

describe("small rules", () => {
  it("colours a drive only when it fills up", () => {
    expect(fullness(50, 100)).toBe("normal");
    expect(fullness(86, 100)).toBe("attention");
    expect(fullness(96, 100)).toBe("fault");
  });
  it("opens photo folders as a grid unless told otherwise", () => {
    const photos = Array.from({ length: 30 }, () => ({ kind: "image" as const }));
    expect(viewFor(undefined, photos)).toBe("grid");
    expect(viewFor("list", photos)).toBe("list");
    expect(viewFor(undefined, photos.slice(0, 5))).toBe("columns");
  });
  it("remembers the newest views only", () => {
    let m = {};
    for (let i = 0; i < 5; i++) m = rememberView(m, `/f${i}`, "grid", 3);
    expect(Object.keys(m)).toEqual(["/f2", "/f3", "/f4"]);
  });
  it("shows future times as dates", () => {
    expect(timeKind(1000 + 3_600_000, 1000)).toBe("dateTime");
    expect(timeKind(1000, 1000)).toBe("relative");
  });
});

describe("planUpload", () => {
  const files = [
    { rel: "Photos", name: "a.jpg", size: 1 },
    { rel: "Photos/2024", name: "b.jpg", size: 1 },
    { rel: "", name: "notes.txt", size: 5 },
  ];
  const dirs = ["Photos", "Photos/2024", "Empty"];

  it("counts dropped folders, even empty ones, among what might clash", () => {
    expect([...uploadTops(files, dirs).keys()]).toEqual(["Photos", "notes.txt", "Empty"]);
  });

  it("keeps both by uploading the folder beside the old one, without replacing anything", () => {
    const p = planUpload(files, dirs, new Set(["Photos", "Photos (2)"]), new Map([["Photos", "rename"]]));
    expect(p.dirs).toEqual(["Photos (3)", "Empty", "Photos (3)/2024"]);
    expect(p.files.filter((f) => f.dir.startsWith("Photos"))).toEqual([
      { index: 0, dir: "Photos (3)", conflict: "rename" },
      { index: 1, dir: "Photos (3)/2024", conflict: "rename" },
    ]);
  });

  it("merges into the old folder when asked, replacing same-named files", () => {
    const p = planUpload(files, dirs, new Set(["Photos"]), new Map([["Photos", "overwrite"]]));
    expect(p.files[0]).toEqual({ index: 0, dir: "Photos", conflict: "overwrite" });
  });

  it("skips a folder and everything in it, and gives loose files their own answer", () => {
    const p = planUpload(files, dirs, new Set(["Photos", "notes.txt"]), new Map<string, "skip" | "overwrite">([["Photos", "skip"], ["notes.txt", "overwrite"]]));
    expect(p.dirs).toEqual(["Empty"]);
    expect(p.files).toEqual([{ index: 2, dir: "", conflict: "overwrite" }]);
  });
});

describe("size words", () => {
  it("reads the quick filter's word and >1gb as a size, not as actions", () => {
    expect(parseCommand("over1gb ", false)).toMatchObject({ mode: "find", minSize: 1e9 });
    expect(parseCommand(">1gb photos", false)).toMatchObject({ mode: "find", minSize: 1e9, kinds: ["image"] });
    expect(parseCommand(">rename", true).mode).toBe("action");
  });
});

describe("rangeOf", () => {
  it("covers both ends either way round", () => {
    expect(rangeOf(5, 2)).toEqual([2, 3, 4, 5]);
    expect(rangeOf(3, 3)).toEqual([3]);
  });
});
