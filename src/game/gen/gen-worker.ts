/// <reference lib="webworker" />
import { createBuildHandler } from '../../core/gen/build-handler.ts';

/** Chunk-generation worker: builds certified chunks off the main thread. Messages: see worker-source.ts. */
const handler = createBuildHandler();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<{ run: number; index: number; buf: ArrayBuffer }>) => {
  const { run, index, buf } = e.data;
  const t0 = performance.now();
  handler.handle(buf);
  scope.postMessage({ run, index, buf, ms: performance.now() - t0 }, [buf]);
};
