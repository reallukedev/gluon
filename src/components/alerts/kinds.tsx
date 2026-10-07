import type * as React from "react";
import { Bell, ChatLines, Link as LinkIcon, Mail, Phone } from "iconoir-react";
import type { ChannelKind } from "@/lib/alerts-types";

/** Each channel kind's glyph. Kept apart from ChannelDialog so lists can show it without loading the dialog. */
export const KIND_ICON: Record<ChannelKind, React.ReactNode> = { ntfy: <Bell />, pushover: <Phone />, email: <Mail />, webhook: <LinkIcon />, xmpp: <ChatLines /> };
