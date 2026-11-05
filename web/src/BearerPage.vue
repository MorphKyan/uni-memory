<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ApiError, localDate, request, timestamp } from './api';

const props = defineProps<{ csrf: string }>();
const emit = defineEmits<{ error: [cause: unknown]; start: [] }>();
const busy = defineModel<boolean>('busy', { required: true });
const sensitive = defineModel<boolean>('sensitive', { required: true });
const scopeLabels = { 'memory:read': '读取', 'memory:write': '写入', 'memory:admin': '管理' };
type Scope = keyof typeof scopeLabels;
interface Bearer {
  id: string;
  client_id: string;
  scopes: Scope[];
  expires_at: string;
  revoked_at: string | null;
  version: number;
}
const bearers = ref<Bearer[]>([]);
const loading = ref(false);
const editing = ref(false);
const selected = ref<Bearer | null>(null);
const confirmAction = ref<'rotate' | 'revoke' | null>(null);
const filter = ref('');
const secret = ref('');
const copied = ref(false);
const notice = ref('');
const clientInput = ref<HTMLInputElement>();
const actionPanel = ref<HTMLElement>();
let listRequest: AbortController | undefined;
const form = ref({ client: '', scopes: ['memory:read'] as Scope[], days: 90, expires: '' });
const visible = computed(() => bearers.value.filter(item =>
  item.client_id.toLowerCase().includes(filter.value.trim().toLowerCase())));
function state(item: Bearer) {
  return item.revoked_at ? '已撤销' : Date.parse(item.expires_at) <= Date.now() ? '已过期' : '有效';
}
async function load(clearError = true) {
  if (clearError) emit('start');
  listRequest?.abort();
  listRequest = new AbortController();
  loading.value = true;
  try {
    bearers.value = await request<Bearer[]>('/ui/bearers', undefined, undefined, listRequest.signal);
  } catch (cause) {
    emit('error', cause);
  } finally {
    loading.value = false;
  }
}
function edit(item: Bearer | null = null) {
  selected.value = item;
  confirmAction.value = null;
  notice.value = '';
  form.value = { client: item?.client_id ?? '', scopes: item ? [...item.scopes] : ['memory:read'],
    days: 90, expires: localDate(item?.expires_at ?? null) };
  editing.value = true;
  void nextTick(() => clientInput.value?.focus());
}
function ask(item: Bearer, action: 'rotate' | 'revoke') {
  editing.value = false;
  notice.value = '';
  selected.value = item;
  confirmAction.value = action;
  void nextTick(() => actionPanel.value?.focus());
}
async function submit(action: 'edit' | 'rotate' | 'revoke') {
  if (busy.value || sensitive.value) return;
  emit('start');
  const item = selected.value;
  const settings = { client_id: form.value.client.trim(), scopes: form.value.scopes };
  busy.value = true;
  try {
    const result = await request<{ bearer: Bearer; token?: string }>(
      item ? `/ui/bearers/${item.id}/${action}` : '/ui/bearers',
      item
        ? { expected_version: item.version, ...(action === 'edit' ? { ...settings,
          expires_at: form.value.expires === localDate(item.expires_at) ? item.expires_at : new Date(form.value.expires).toISOString() } : {}) }
        : { ...settings, days: form.value.days },
      props.csrf,
    );
    editing.value = false;
    confirmAction.value = null;
    if (result.token) {
      secret.value = result.token;
      sensitive.value = true;
      copied.value = false;
      void nextTick(() => actionPanel.value?.focus());
    }
    notice.value = item ? { edit: '配置已保存。', rotate: '已轮换令牌，旧令牌已失效。', revoke: '令牌已撤销。' }[action] : '令牌已签发。';
    const updated = result.bearer;
    bearers.value = [updated, ...bearers.value.filter(row => row.id !== updated.id)];
  } catch (cause) {
    emit('error', cause);
    if (cause instanceof ApiError && cause.status === 409) {
      editing.value = false;
      confirmAction.value = null;
      await load(false);
    }
  } finally {
    busy.value = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(secret.value);
    copied.value = true;
  } catch {
    copied.value = false;
    notice.value = '浏览器无法访问剪贴板，请选中令牌手动复制。';
  }
}
function dismiss() {
  secret.value = '';
  sensitive.value = false;
  copied.value = false;
}
onMounted(() => load());
onUnmounted(() => listRequest?.abort());
</script>

<template>
  <div class="management-stack">
    <p v-if="notice" class="alert success" role="status">{{ notice }}</p>
    <article v-if="secret" ref="actionPanel" class="panel credential-result" tabindex="-1">
      <h2>保存新令牌</h2>
      <p>明文只在此处显示一次。复制后更新对应客户端的 Authorization 配置。</p>
      <label for="issued-bearer">Bearer 令牌</label>
      <input id="issued-bearer" class="mono" :value="secret" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" />
      <div class="actions">
        <button class="primary" @click="copy">{{ copied ? '已复制' : '复制令牌' }}</button>
        <button @click="dismiss">关闭并隐藏令牌</button>
      </div>
    </article>
    <article v-if="editing" class="panel settings-form">
      <h2>{{ selected ? `编辑 ${selected.client_id}` : '签发 Bearer 令牌' }}</h2>
      <form @submit.prevent="submit('edit')">
        <fieldset :disabled="busy">
          <label>客户端标识
            <input ref="clientInput" v-model="form.client" required maxlength="80" pattern="[A-Za-z0-9_.\-]+" placeholder="例如 codex-desktop" />
          </label>
          <p v-if="selected && form.client.trim() !== selected.client_id" class="small muted">改名后，后续写入将使用新的客户端标识和幂等键范围。</p>
          <div class="scope-field" role="group" aria-label="令牌权限">
            <span>权限</span>
            <label v-for="(label, key) in scopeLabels" :key="key" class="check">
              <input v-model="form.scopes" type="checkbox" :value="key" /> {{ label }}
            </label>
          </div>
          <p class="small muted">「管理」包含读取与写入权限。</p>
          <label v-if="selected">到期时间（本地时间）
            <input v-model="form.expires" type="datetime-local" required />
          </label>
          <label v-else>有效期（天）
            <input v-model.number="form.days" type="number" min="1" max="365" required />
          </label>
          <div class="form-actions">
            <button type="button" @click="editing = false">取消</button>
            <button class="primary" :disabled="!form.scopes.length">{{ busy ? '保存中…' : selected ? '保存配置' : '签发令牌' }}</button>
          </div>
        </fieldset>
      </form>
    </article>
    <article v-if="confirmAction && selected" ref="actionPanel" class="panel" tabindex="-1">
      <h2>{{ confirmAction === 'rotate' ? '轮换' : '撤销' }} {{ selected.client_id }}</h2>
      <p>{{ confirmAction === 'rotate' ? '新令牌继承当前配置，旧令牌立即失效。' : '撤销后令牌立即失效，记录保留以便审计。' }}</p>
      <div class="actions">
        <button :disabled="busy" @click="confirmAction = null">取消</button>
        <button class="danger" :disabled="busy" @click="submit(confirmAction)">
          {{ confirmAction === 'rotate' ? '确认轮换' : '确认撤销' }}
        </button>
      </div>
    </article>
    <section class="panel" :aria-busy="loading">
      <div class="section-toolbar">
        <h2>客户端凭据 <span class="count">{{ bearers.length }}</span></h2>
        <div class="actions">
          <button :disabled="loading || busy" @click="load()">刷新</button>
          <button class="primary" :disabled="loading || busy || sensitive" @click="edit()">＋ 新建 Bearer</button>
        </div>
      </div>
      <label class="compact-field">筛选客户端<input v-model="filter" type="search" placeholder="输入客户端标识" /></label>
      <p v-if="loading && !bearers.length" class="muted" role="status">正在读取客户端凭据…</p>
      <p v-else-if="!visible.length" class="muted">{{ filter ? '没有匹配的客户端。' : '尚无客户端凭据。' }}</p>
      <div v-else class="table-scroll">
        <table class="management-table">
          <thead><tr><th>客户端</th><th>权限</th><th>状态</th><th>到期时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="item in visible" :key="item.id">
              <td><strong>{{ item.client_id }}</strong><br /><span class="mono muted">{{ item.id }}</span></td>
              <td><span v-for="scope in item.scopes" :key="scope" class="badge">{{ scopeLabels[scope] }}</span></td>
              <td><span class="badge" :class="{ 'badge-accent': state(item) === '有效' }">{{ state(item) }}</span>
                <div v-if="item.revoked_at" class="muted">{{ timestamp(item.revoked_at) }}</div>
              </td>
              <td>{{ timestamp(item.expires_at) }}</td>
              <td v-if="!item.revoked_at" class="table-actions">
                <button :disabled="loading || busy || sensitive" @click="edit(item)">编辑</button>
                <button :disabled="loading || busy || sensitive" @click="ask(item, 'rotate')">轮换</button>
                <button class="danger-text" :disabled="loading || busy || sensitive" @click="ask(item, 'revoke')">撤销</button>
              </td>
              <td v-else>—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
