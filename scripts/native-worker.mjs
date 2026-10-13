import { NativeClient } from './native-client.mjs';
import { NativeOperations } from './native-operations.mjs';

export async function connectNativeWorker({ descriptor, targets, persist, history, ordinaryUsageAllowed }) {
  if (!descriptor?.pipe || !descriptor?.token) return null;
  const target = Object.keys(targets ?? {})[0];
  if (!target) return null;
  const client = new NativeClient(descriptor);
  // An authenticated, authorized snapshot response is required before exposing adapters.
  await client.command('snapshot', target);
  const operations = new NativeOperations({ snapshot: id => client.command('snapshot', id), persist,
    ordinaryUsageAllowed, request: (method, params, context) => client.command(
      method === 'thread/compact/start' ? 'compact' : 'interrupt', params.threadId, context.turnId) });
  operations.restore(history ?? []);
  return { verified: true, snapshot: id => client.command('snapshot', id), perform: operation => operations.perform(operation) };
}
