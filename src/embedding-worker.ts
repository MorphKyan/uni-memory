import { parentPort, workerData } from 'node:worker_threads';
import { AutoConfig, AutoModel, AutoTokenizer, env, pipeline } from '@huggingface/transformers';
import { models, type ModelName } from './embedding.js';

const { name, dtype, cache } = workerData as { name: ModelName; dtype: 'q8' | 'q4' | 'fp32'; cache: string };
env.cacheDir = cache;
env.allowLocalModels = false;
// ONNX 内部线程受限，防止个人服务器被单次推理占满。
const session_options = { intraOpNumThreads: 2, interOpNumThreads: 1 };
let extractor: Awaited<ReturnType<typeof pipeline<'feature-extraction'>>> | undefined;
let gemma: { model: Awaited<ReturnType<typeof AutoModel.from_pretrained>>; tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> } | undefined;
async function embed(texts: string[], query: boolean) {
  const spec = models[name];
  const prefixed = texts.map(text => name === 'e5' ? `${query ? 'query' : 'passage'}: ${text}`
    : name === 'bge' ? `${query ? '为这个句子生成表示以用于检索相关文章：' : ''}${text}`
    : `${query ? 'task: search result | query: ' : 'title: none | text: '}${text}`);
  if (name === 'gemma2') {
    if (!gemma) {
      const config = await AutoConfig.from_pretrained(spec.repo) as Awaited<ReturnType<typeof AutoConfig.from_pretrained>> & { vision_config: unknown; audio_config: unknown };
      config.vision_config = config.audio_config = null;
      const model = await AutoModel.from_pretrained(spec.repo, { config, device: 'cpu', dtype, session_options });
      const tokenizer = await AutoTokenizer.from_pretrained(spec.repo);
      gemma = { model, tokenizer };
    }
    const output = await gemma.model(await gemma.tokenizer(prefixed, { padding: true, truncation: true, max_length: 512 }));
    return output.sentence_embedding.normalize(2, -1).tolist() as number[][];
  }
  extractor ??= await pipeline('feature-extraction', spec.repo, { device: 'cpu', dtype, session_options });
  const output = await extractor(prefixed, { pooling: name === 'bge' ? 'cls' : 'mean', normalize: true });
  return output.tolist() as number[][];
}
let queue = Promise.resolve();
parentPort!.on('message', (message: { id: number; texts: string[]; query: boolean }) => {
  queue = queue.then(async () => {
    try { parentPort!.postMessage({ id: message.id, vectors: await embed(message.texts, message.query) }); }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      const code = /unsupported|unrecognized|unknown model type/i.test(errorMessage) ? 'unsupported_model_architecture'
        : /fetch|download|network|connect|timed? ?out|status.?code/i.test(errorMessage) ? 'model_download_failed'
        : /not found|404|no such file/i.test(errorMessage) ? 'model_files_not_found' : 'model_load_or_inference_failed';
      parentPort!.postMessage({ id: message.id, error: code });
    }
  });
});
