import { Page, PageHeader, Skeleton } from "@/components/ui/Surface";

export function FilesSkeleton({ screen }: { screen: "front" | "browse" | "trash" }) {
  const title = screen === "front" ? "Files" : screen === "trash" ? "Trash" : <Skeleton width={220} height={30} radius={6} />;
  return (
    <Page pending>
      <PageHeader title={title} summary={<Skeleton width={260} height={12} />} />
      <div aria-busy aria-label="Loading Files" style={{ display: "grid", gap: 28 }}>
        <Skeleton height={46} radius={8} />
        {screen === "front" ? (
          <>
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
          </>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} width={`${42 + ((i * 29) % 40)}%`} height={14} />
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}
