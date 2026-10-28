import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

export const models = {
  e5: { repo: 'Xenova/multilingual-e5-small', dimensions: 384, dtype: 'q8' },
  bge: { repo: 'onnx-community/bge-small-zh-v1.5-ONNX', dimensions: 512, dtype: 'q8' },
  gemma2: { repo: 'onnx-community/embeddinggemma-2-ONNX', dimensions: 768, dtype: 'q4' },
} as const;
export type ModelName = keyof typeof models;
export interface EmbeddingStatus {
  state: 'unloaded' | 'loading' | 'ready' | 'failed';
  error_code: string | null;
}
export interface Embedder {
  model: string; dtype: string; dimensions: number;
  readonly status?: EmbeddingStatus;
  embed(texts: string[], query?: boolean): Promise<number[][]>;
}
export function collectionName(embedder: Pick<Embedder, 'model' | 'dtype' | 'dimensions'>) {
  return `uni_mem_${createHash('sha256').update(`${embedder.model}:${embedder.dtype}:${embedder.dimensions}`).digest('hex').slice(0, 20)}`;
}
export class EmbeddingWorker implements Embedder {
  private readonly worker: Worker;
  readonly model: string;
  readonly dimensions: number;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: number[][]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  failure?: string;
  status: EmbeddingStatus = { state: 'unloaded', error_code: null };
  constructor(name: ModelName, public dtype: string = models[name]?.dtype, cache = './.cache/models') {
    if (!Object.hasOwn(models, name) || !['q8', 'q4', 'fp32'].includes(dtype)) throw new Error('未知 embedding 模型或精度');
    const spec = models[name];
    this.model = spec.repo;
    this.dimensions = spec.dimensions;
    this.worker = new Worker(new URL('./embedding-worker.js', import.meta.url), { workerData: { name, dtype, cache } });
    this.worker.on('message', (message: { state: EmbeddingStatus['state']; error?: string } | { id: number; vectors?: number[][]; error?: string }) => {
      if ('state' in message) {
        if (!this.failure) this.status = { state: message.state, error_code: message.error ?? null };
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error || !message.vectors?.every(vector => vector.length === this.dimensions && vector.every(Number.isFinite))) {
        pending.reject(new Error(message.error ?? 'invalid_embedding_dimensions'));
      } else pending.resolve(message.vectors);
    });
    const fail = (error: Error) => {
      this.status = { state: 'failed', error_code: 'embedding_worker_closed' };
      this.failure ??= `${error.name}: ${error.message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300)}`;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('embedding_worker_closed')); }
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', code => fail(new Error(`worker_exit_${code}`)));
  }
  embed(texts: string[], query = false) {
    if (this.failure || this.pending.size >= 16 || !texts.length || texts.length > 64) return Promise.reject(new Error('embedding_unavailable'));
    const id = ++this.sequence;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('embedding_timeout')); }, 1200000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, texts, query });
    });
  }
  close() { return this.worker.terminate(); }
}
