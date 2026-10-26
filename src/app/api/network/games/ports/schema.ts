import { z } from "zod";

export const gamePortBody = z.object({
  name: z.string().trim().min(1, "Give it a name, like Valheim.").max(40, "Keep the name under 40 characters."),
  game: z.string().max(32).nullish(),
  protocol: z.enum(["tcp", "udp", "both"]),
  ports: z.string().trim().min(1, "Enter the port the game listens on.").max(16),
  publicPort: z.number().int().min(1).max(65535).nullish(),
  address: z.string().trim().max(253).nullish(),
});
