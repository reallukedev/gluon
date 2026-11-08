import { FilesSkeleton } from "@/components/files/FilesSkeleton";

/** While the server gets Files ready: the front page's shape, so arriving at Files isn't blank. */
export default function FilesLoading() {
  return <FilesSkeleton screen="front" />;
}
