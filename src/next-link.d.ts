// The App Router's Link takes unstable_dynamicOnHover (see next.config.ts), but `next/link` types the
// Pages Router's Link, which doesn't.
import "next/dist/client/link";

declare module "next/dist/client/link" {
  interface LinkProps {
    unstable_dynamicOnHover?: boolean;
  }
}
