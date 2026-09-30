import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * The single producer of the `scheduled_messages_updated` delta.
 *
 * A schedule is owned by the server (the timer runs here), so a client cannot
 * derive it from anything it does locally: a message scheduled on the phone
 * used to stay invisible on the desktop until that session was reopened, and a
 * message that fired or failed left its "pending" banner on screen everywhere
 * until the next reload. This delta says only "this session's list changed" —
 * clients refetch the list, so the payload never has to stay in sync with the
 * REST shape.
 */
export function broadcastScheduledMessagesUpdated(sessionId: string): void {
  if (!sessionId) {
    return;
  }

  const payload = JSON.stringify({
    kind: 'scheduled_messages_updated',
    sessionId,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}
