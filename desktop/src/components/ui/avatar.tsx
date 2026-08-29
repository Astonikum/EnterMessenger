import Avatar from "boring-avatars";
import { cn } from "../../lib/utils";
import { Icon } from "./icon";
import { AVATAR_COLORS, conversationAvatarKind, normalizeAvatarName } from "../../../../common/src/conversations.ts";

// #preview ProfileAvatar {"name":"Алексей","size":48}
export function ProfileAvatar({ name, size = 38, className }: { name: string; size?: number; className?: string }) {
  return <Avatar size={`${size / 16}rem`} name={normalizeAvatarName(name)} variant="beam" colors={AVATAR_COLORS} className={cn("common-debug shrink-0 rounded-full", className)} />;
}

// #preview ConversationAvatar {"id":"favorites","handle":"favorites","avatar":"favorites","size":42}
export function ConversationAvatar({ id, handle, avatar, size = 38, className }: { id?: string; handle?: string; avatar: string; size?: number; className?: string }) {
  const kind = conversationAvatarKind({ handle, avatar });
  if (kind === "favorites") {
    return <span className={cn("common-debug grid shrink-0 place-items-center rounded-full bg-primary text-primary-foreground", className)} style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }}><Icon name="star" className="size-6" /></span>;
  }
  if (kind === "official") {
    return <span className={cn("common-debug grid shrink-0 place-items-center rounded-full bg-primary/15 font-heading font-bold text-primary", className)} style={{ width: `${size / 16}rem`, height: `${size / 16}rem`, fontSize: `${(size * 0.52) / 16}rem` }}>E</span>;
  }
  return <ProfileAvatar name={avatar} size={size} className={className} />;
}
