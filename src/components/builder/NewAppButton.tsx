"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { NavArrowDown, Box3dPoint, Page, Github, Terminal, ChatBubble, Headset } from "iconoir-react";
import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";

const ChatInstallFlow = dynamic(() => import("@/components/chat/ChatInstallFlow").then((m) => m.ChatInstallFlow), { ssr: false });
const VoiceInstallFlow = dynamic(() => import("@/components/voice/VoiceInstallFlow").then((m) => m.VoiceInstallFlow), { ssr: false });

/**
 * "Make an app" for the Your apps header: the four ways to start, plus the servers Gluon sets up
 * and manages itself (chat and voice). `variant` lets a header keep one primary button.
 */
export function NewAppButton({ variant = "secondary", label = "Make an app" }: { variant?: "primary" | "secondary" | "ghost"; label?: string }) {
  const router = useRouter();
  const [flow, setFlow] = React.useState<"chat" | "voice" | null>(null);
  return (
    <>
      <Menu
        trigger={
          <Button variant={variant} iconEnd={<NavArrowDown />}>
            {label}
          </Button>
        }
        items={[
          { label: "From a Docker image", description: "One container, set up with a form", icon: <Box3dPoint />, onSelect: () => router.push("/apps/new?from=image") },
          { label: "From a docker run command", description: "Paste one from an app's instructions", icon: <Terminal />, onSelect: () => router.push("/apps/new?from=run") },
          { label: "From a compose file", description: "Paste or write docker-compose.yml", icon: <Page />, onSelect: () => router.push("/apps/new?from=compose") },
          { label: "From a GitHub repository", description: "Gluon builds it on this server", icon: <Github />, onSelect: () => router.push("/apps/new?from=github") },
          "separator",
          { kind: "label", label: "Set up and managed by Gluon" },
          { label: "Chat server", description: "Prosody, for XMPP chat apps", icon: <ChatBubble />, onSelect: () => setFlow("chat") },
          { label: "Voice chat server", description: "Mumble, for group voice calls", icon: <Headset />, onSelect: () => setFlow("voice") },
        ]}
      />
      {flow === "chat" && <ChatInstallFlow open onOpenChange={(o) => !o && setFlow(null)} />}
      {flow === "voice" && <VoiceInstallFlow open onOpenChange={(o) => !o && setFlow(null)} />}
    </>
  );
}
