import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Gluon",
    short_name: "Gluon",
    description: "Your home server, at a glance.",
    start_url: "/start",
    display: "standalone",
    background_color: "#111214",
    theme_color: "#111214",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
