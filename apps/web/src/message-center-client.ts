export type MessageCenterFilter = 'all' | 'unread' | 'read';

export interface MessageCenterMessage {
  id: string;
  /** Optional stable selector for client-owned special behavior. Ordinary
   *  messages do not need one and continue through the inbox unchanged. */
  messageKey?: string | null;
  audienceType: 'global' | 'targeted';
  typeName: string;
  title: string;
  body: string;
  /** Optional cover the card reveals on expand. Only what the payload
   *  actually carries: the media slot stays empty until a message ships its
   *  own image. */
  imageUrl?: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  publishedAt: string;
  readAt: string | null;
}

/** One-off, client-owned announcement selector. The message center remains a
 * generic inbox: only slugs with this prefix opt into the preset strong dialog. */
export const GO_PLAN_SUNSET_MESSAGE_KEY_PREFIX = 'go-plan-sunset-2026-08';

export function findGoPlanSunsetMessage(
  messages: readonly MessageCenterMessage[],
): MessageCenterMessage | null {
  return messages.find((message) => (
    message.audienceType === 'targeted'
    && message.readAt == null
    && message.messageKey?.startsWith(GO_PLAN_SUNSET_MESSAGE_KEY_PREFIX)
  )) ?? null;
}

// The inbox was served by the Vela/AMR message-center proxies
// (`/api/integrations/vela/message-center*`), which the Databricks daemon no
// longer has. The network helpers below are no-network stubs (no account, an
// empty inbox, a local-only read receipt) so the Message Center never calls a
// deleted route; the local archive/read stores keep working as before.
const LEGACY_WINDOW_KEY = 'open-design.message-center.anonymous-started-at.v1';
const MESSAGES_KEY = 'open-design.message-center.anonymous-messages.v1';
const READ_KEY = 'open-design.message-center.anonymous-read-ids.v1';
/* Archived ids are LOCAL for signed-in users too: the vela message model
   carries a single state field (`readAt`) and there is no archive endpoint, so
   this store is the whole truth. Deliberately outside the anonymous mirror
   above — `clearAnonymousState` wipes that mirror the moment an account takes
   over, and an archive the user made must survive the hand-off (it would also
   have to survive it once a server field exists). Not synced across devices;
   that needs the backend field. */
const ARCHIVED_KEY = 'open-design.message-center.archived-ids.v1';

export function readAnonymousMessages(storage: Storage): MessageCenterMessage[] {
  return parseArray<MessageCenterMessage>(storage.getItem(MESSAGES_KEY));
}

export function readAnonymousReadIds(storage: Storage): Set<string> {
  return new Set(parseArray<string>(storage.getItem(READ_KEY)));
}

export function writeAnonymousState(
  storage: Storage,
  messages: MessageCenterMessage[],
  readIds: Set<string>,
): void {
  storage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  storage.setItem(READ_KEY, JSON.stringify([...readIds]));
}

export function readArchivedIds(storage: Storage): Set<string> {
  return new Set(parseArray<string>(storage.getItem(ARCHIVED_KEY)));
}

export function writeArchivedIds(storage: Storage, ids: Set<string>): void {
  storage.setItem(ARCHIVED_KEY, JSON.stringify([...ids]));
}

export function clearAnonymousState(storage: Storage): void {
  storage.removeItem(MESSAGES_KEY);
  storage.removeItem(READ_KEY);
  storage.removeItem(LEGACY_WINDOW_KEY);
}

/** Whether an AMR account is signed in. Never, on Databricks. */
export async function isAmrLoggedIn(): Promise<boolean> {
  // No AMR account exists on Databricks: always the anonymous inbox.
  return false;
}

export async function pullMessageCenter(_input: {
  locale: string;
  loggedIn: boolean;
  filter?: MessageCenterFilter;
}): Promise<MessageCenterMessage[]> {
  return [];
}

export async function markAccountMessageRead(_messageId: string): Promise<void> {
  // Nothing to sync: there is no account inbox.
}

function parseArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
