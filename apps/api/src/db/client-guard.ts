import type { PoolClient } from 'pg';

// pg emits errors on checked-out clients; the pool's idle-client listener cannot catch them.
export function guardClient(client: PoolClient): () => void {
  let connectionError: Error | undefined;
  const onError = (error: Error) => {
    connectionError = error;
  };
  client.on('error', onError);
  return () => {
    client.release(connectionError);
    client.off('error', onError);
  };
}
