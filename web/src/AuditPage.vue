<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { request, timestamp } from './api';

const emit = defineEmits<{ error: [cause: unknown]; start: [] }>();
const channelLabels = { rest: 'REST', mcp: 'MCP', oauth: 'OAuth', admin: '管理台', other: '其他' };
const outcomeLabels = { success: '成功', error: '失败', disconnected: '断开' };
type Outcome = keyof typeof outcomeLabels;
interface Entry {
  id: string;
  request_id: string;
  started_at: string;
  channel: keyof typeof channelLabels;
  route: string;
  method: string;
  status: number | null;
  duration_ms: number;
  client_id: string | null;
  token_id: string | null;
  rpc_method: string | null;
  tool: string | null;
  outcome: Outcome;
  details: Record<string, unknown>;
}
interface Summary {
  buckets: { time: string; outcome: Outcome; count: number }[];
  unit: 'hour' | 'day';
  since: string;
  until: string;
}
const days = ref('1'), channel = ref(''), outcome = ref(''), client = ref('');
const entries = ref<Entry[]>([]), next = ref<string | null>(null), summary = ref<Summary | null>(null);
const loading = ref(false);
const detail = ref<Entry | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
function openDetail(entry: Entry) {
  detail.value = entry;
  dialog.value?.showModal();
}
const detailLabels: Record<string, string> = {
  http_version: 'HTTP 版本', protocol: '连接协议', mcp_version: 'MCP 版本', auth: '鉴权方式',
  request_bytes: '请求声明字节数', response_bytes: '响应声明字节数', error: '错误码',
  target_token_id: '管理操作目标令牌', target_client_id: '目标客户端', target_scopes: '操作后的权限',
  target_expires_at: '操作后的到期时间', target_version: '操作后的配置版本', input: '查询与请求参数概况',
  rpc_batch: '批量 MCP 调用', rpc_batch_size: '批量调用数量',
  memory_id: '目标记忆 ID', mutation_result: '变更结果', memory_version: '返回的记忆版本',
  idempotent_replay: '幂等重试', returned_count: '返回条数', source_count: '返回来源条数', has_more: '还有下一页',
  search_degraded: '检索降级', search_timings_ms: '检索分段耗时', tool_duration_ms: 'MCP 工具耗时',
};
const mutationLabels: Record<string, string> = { created: '新建', updated: '更新', merged: '合并', deleted: '删除', conflict: '版本冲突' };
const searchStageLabels: Record<string, string> = { postgresql: 'PostgreSQL', embedding: 'Embedding', qdrant: 'Qdrant' };
let applied = new URLSearchParams();
let active: AbortController | undefined;

const totals = computed(() => {
  const counts = { success: 0, error: 0, disconnected: 0 };
  for (const bucket of summary.value?.buckets ?? []) counts[bucket.outcome] += bucket.count;
  return { ...counts, all: counts.success + counts.error + counts.disconnected };
});
const trend = computed(() => {
  if (!summary.value) return [];
  const { unit, since, until, buckets } = summary.value;
  const step = (unit === 'hour' ? 1 : 24) * 3600_000;
  const start = Math.floor(Date.parse(since) / step) * step;
  const counts = new Map<number, number>();
  for (const bucket of buckets) {
    const time = Date.parse(bucket.time);
    counts.set(time, (counts.get(time) ?? 0) + bucket.count);
  }
  return Array.from({ length: Math.floor((Date.parse(until) - start) / step) + 1 },
    (_, index) => {
      const time = start + index * step;
      return { time, count: counts.get(time) ?? 0 };
    });
});
const peak = computed(() => Math.max(1, ...trend.value.map(item => item.count)));
const width = computed(() => 720 / Math.max(1, trend.value.length));
const axis = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function describe(value: unknown, key?: string) {
  if (key === 'mutation_result' && typeof value === 'string') return mutationLabels[value] ?? value;
  if (key === 'tool_duration_ms') return `${value} ms`;
  if (key === 'search_timings_ms' && value && typeof value === 'object') {
    return Object.entries(value).map(([stage, ms]) => `${searchStageLabels[stage] ?? stage} ${ms} ms`).join(' · ');
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
async function load(more = false) {
  if (loading.value || (more && !next.value)) return;
  emit('start');
  const params = more ? new URLSearchParams(applied) : new URLSearchParams({
    days: days.value,
    ...(channel.value ? { channel: channel.value } : {}),
    ...(outcome.value ? { outcome: outcome.value } : {}),
    ...(client.value.trim() ? { client: client.value.trim() } : {}),
  });
  if (more && next.value && summary.value) {
    params.set('before', next.value);
    params.set('until', summary.value.until);
  }
  active = new AbortController();
  loading.value = true;
  try {
    const result = await request<{ entries: Entry[]; next: string | null } & Partial<Summary>>(
      `/ui/audit?${params}`, undefined, undefined, active.signal,
    );
    if (!more) {
      applied = params;
      summary.value = { buckets: result.buckets ?? [], since: result.since!, until: result.until!, unit: result.unit! };
    }
    entries.value = more ? [...entries.value, ...result.entries] : result.entries;
    next.value = result.next;
  } catch (cause) {
    emit('error', cause);
  } finally {
    loading.value = false;
  }
}
onMounted(() => load());
onUnmounted(() => active?.abort());
</script>

<template>
  <div class="management-stack" :aria-busy="loading">
    <form class="panel audit-filters" @submit.prevent="load()">
      <fieldset :disabled="loading">
        <label>时间范围
          <select v-model="days">
            <option value="1">最近 24 小时</option><option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option><option value="90">最近 90 天</option>
            <option value="365">最近 365 天</option>
          </select>
        </label>
        <label>入口
          <select v-model="channel">
            <option value="">全部入口</option>
            <option v-for="(label, value) in channelLabels" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
        <label>结果
          <select v-model="outcome">
            <option value="">全部结果</option>
            <option v-for="(label, value) in outcomeLabels" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
        <label>客户端
          <input v-model="client" type="search" placeholder="精确匹配客户端标识" maxlength="256" />
        </label>
        <button class="primary">{{ loading ? '读取中…' : '应用筛选' }}</button>
      </fieldset>
    </form>
    <template v-if="summary">
      <div class="stat-grid audit-stat-grid">
        <article class="stat-card"><p>请求总量</p><strong>{{ totals.all.toLocaleString() }}</strong></article>
        <article class="stat-card" v-for="(label, value) in outcomeLabels" :key="value">
          <p>{{ label }}</p><strong>{{ totals[value].toLocaleString() }}</strong>
        </article>
      </div>
      <div class="audit-charts">
        <article class="panel">
          <h2>请求趋势 <span class="small muted">{{ summary.unit === 'hour' ? '按小时' : '按天 · UTC 分桶' }}</span></h2>
          <template v-if="totals.all">
            <div class="chart-scale small muted"><span>峰值 {{ peak }} 次</span><span>每格 {{ summary.unit === 'hour' ? '1 小时' : '1 天' }}</span></div>
            <svg class="trend-chart" viewBox="0 0 720 132" preserveAspectRatio="none" role="img" :aria-label="`请求量趋势，总计 ${totals.all} 次，峰值 ${peak} 次`">
              <path d="M0 1H720 M0 65H720 M0 130H720" class="chart-grid" />
              <rect v-for="(item, index) in trend" :key="item.time" :x="index * width"
                :y="130 - item.count / peak * 129" :width="width * 0.83" :height="item.count / peak * 129">
                <title>{{ timestamp(new Date(item.time).toISOString()) }} · {{ item.count }} 次</title>
              </rect>
            </svg>
            <div class="chart-scale small muted"><span>{{ axis.format(trend[0]?.time) }}</span><span>{{ axis.format(trend.at(-1)?.time) }}</span></div>
          </template>
          <p v-else class="muted">这个时间范围内暂无匹配请求。</p>
        </article>
        <article class="panel">
          <h2>请求结果</h2>
          <div v-for="(label, value) in outcomeLabels" :key="value" class="outcome-bar" :class="value">
            <div><span>{{ label }}</span><strong>{{ totals[value].toLocaleString() }} 次</strong></div>
            <progress :value="totals[value]" :max="totals.all || 1" :aria-label="label"></progress>
          </div>
        </article>
      </div>
    </template>
    <section class="panel">
      <div class="section-toolbar"><h2>请求明细</h2><button :disabled="loading" @click="load()">刷新</button></div>
      <p v-if="!entries.length" class="muted" role="status">{{ loading ? '正在读取审计记录…' : '暂无匹配记录。' }}</p>
      <div v-else class="table-scroll">
        <table class="management-table audit-table">
          <thead><tr><th>时间</th><th>请求</th><th>客户端</th><th>来源 IP</th><th>结果</th><th>耗时</th><th>详情</th></tr></thead>
          <tbody>
            <tr v-for="item in entries" :key="item.id">
              <td>{{ timestamp(item.started_at) }}</td>
              <td><strong>{{ channelLabels[item.channel] }} · {{ item.method }}</strong> <span class="mono">{{ item.route }}</span>
                <div v-if="item.rpc_method" class="muted">{{ item.rpc_method }}{{ item.tool ? ` · ${item.tool}` : '' }}</div>
              </td>
              <td>{{ item.client_id ?? '—' }}</td>
              <td class="mono">{{ item.details.source_ip ?? '—' }}</td>
              <td><span class="badge" :class="{ 'badge-accent': item.outcome === 'success', 'badge-error': item.outcome === 'error' }">
                {{ outcomeLabels[item.outcome] }}{{ item.status ? ` · ${item.status}` : '' }}
              </span></td>
              <td>{{ item.duration_ms }} ms</td>
              <td><button type="button" @click="openDetail(item)">查看详情</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <button v-if="next" class="load-more" :disabled="loading" @click="load(true)">{{ loading ? '读取中…' : '加载更早的记录' }}</button>
    </section>
    <dialog ref="dialog" class="audit-dialog" aria-labelledby="audit-dialog-title" @close="detail = null">
      <div class="section-toolbar">
        <h2 id="audit-dialog-title">请求详情</h2>
        <form method="dialog"><button autofocus>关闭</button></form>
      </div>
      <dl v-if="detail" class="audit-details">
        <dt>请求 ID</dt><dd>{{ detail.request_id }}</dd>
        <template v-if="detail.token_id"><dt>凭据 ID</dt><dd>{{ detail.token_id }}</dd></template>
        <template v-for="(value, key) in detail.details" :key="key">
          <template v-if="value != null && describe(value, key) && describe(value, key) !== '{}'">
            <dt>{{ key === 'source_ip' ? '来源 IP' : (detailLabels[key] ?? key) }}</dt><dd>{{ describe(value, key) }}</dd>
          </template>
        </template>
      </dl>
    </dialog>
  </div>
</template>
