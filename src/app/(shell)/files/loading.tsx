import { Page, PageHeader, Skeleton } from "@/components/ui/Surface";

/** While the server reads your places: the front page's shape, so arriving at Files isn't blank. */
export default function FilesLoading() {
  return (
    <Page>
      <PageHeader title="Files" summary={<Skeleton width={260} height={12} />} />
      <div aria-busy aria-label="Loading Files" style={{ display: "grid", gap: 28 }}>
        <Skeleton height={46} radius={8} />
        <div style={{ display: "flex", gap: 12, overflow: "hidden" }}>
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} width={168} height={172} radius={10} style={{ flex: "none" }} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} width={228} height={70} radius={10} />
          ))}
        </div>
      </div>
    </Page>
  );
}
