<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ApiError, request, operationId, types, timestamp, localDate } from './api';
import type { Memory, History, Status } from './api';
import AuditPage from './AuditPage.vue';
import BearerPage from './BearerPage.vue';

const ready = ref(false),
  enabled = ref(true),
  authenticated = ref(false),
  password = ref(''),
  csrf = ref('');
const error = ref(''),
  notice = ref(''),
  loggingIn = ref(false),
  busy = ref(false),
  loading = ref(false),
  detailLoading = ref(false);
const sensitive = ref(false);
const passwordForm = ref({ current: '', next: '', confirmation: '' });
const theme = ref('light');
try {
  theme.value =
    localStorage.getItem('uni-memory-theme') ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch {
  /* 私密模式仍可使用 */
}
watch(
  theme,
  (value) => {
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem('uni-memory-theme', value);
    } catch {
      /* 存储可选 */
    }
  },
  { immediate: true },
);
const namespaces = ref<{ namespace: string; count: number }[]>([]),
  namespace = ref('');
const navigation = [
  { label: '数据', items: [{ id: 'memories', label: '记忆库' }] },
  { label: '访问管理', items: [{ id: 'bearers', label: 'Bearer 凭据' }, { id: 'password', label: '管理员密码' }] },
  { label: '运行与审计', items: [{ id: 'status', label: '服务状态' }, { id: 'audit', label: '请求审计' }] },
] as const;
type Section = typeof navigation[number]['items'][number]['id'];
const section = ref<Section>('memories');
const pages = {
  memories: { label: '记忆库', title: '全部记忆', description: '检索、核对和维护跨客户端的长期记忆。' },
  status: { label: '服务状态', title: '服务状态', description: '查看数据库、模型、索引覆盖和后台任务。' },
  bearers: { label: 'Bearer 凭据', title: 'Bearer 凭据', description: '为 REST 和 MCP 客户端签发令牌，管理访问权限和有效期。' },
  password: { label: '管理员密码', title: '管理员密码', description: '更新登录此管理台使用的密码。' },
  audit: { label: '请求审计', title: '请求审计', description: '按时间、入口和结果统计请求，并查看每次请求的服务端记录。' },
};
const query = ref(''),
  tagFilter = ref(''),
  deviceFilter = ref(''),
  typeFilter = ref(''),
  descendants = ref(false);
const memories = ref<Memory[]>([]),
  cursor = ref<string | null>(null),
  degraded = ref(false);
const selected = ref<Memory | null>(null),
  history = ref<History[]>([]),
  detailTab = ref('content');
const status = ref<Status | null>(null),
  tasks = ref<{ memory_id: string; attempts: number; failed: boolean; error_code: string | null }[]>([]);
const editing = ref(false),
  conflict = ref<Memory | null>(null),
  deleteOpen = ref(false);
const blank = () => ({
  namespace: namespace.value || 'global',
  key: '',
  content: '',
  type: 'fact' as Memory['type'],
  tags: '',
  device_tags: '',
  pinned: false,
  expires: '',
  reference: 'web:manual',
  excerpt: '',
});
const form = ref(blank());
let originalForm = '',
  pendingWrite = { signature: '', id: '' },
  pendingDelete = { signature: '', id: '' };
let listSequence = 0,
  detailSequence = 0,
  statusSequence = 0;
let activeList: AbortController | undefined;
let listSignature = '';
const dirty = computed(() => editing.value && JSON.stringify(form.value) !== originalForm);
const modelStates: Record<string, string> = {
  ready: '就绪',
  loading: '加载中',
  unloaded: '尚未加载',
  disabled: '未启用',
  failed: '失败',
  unknown: '未知',
};
const total = computed(() => namespaces.value.reduce((sum, item) => sum + item.count, 0));
const page = computed(() => pages[section.value]);
const group = computed(() => navigation.find(group => group.items.some(item => item.id === section.value))?.label);
function signOut() {
  authenticated.value = false;
  csrf.value = '';
  memories.value = [];
  selected.value = null;
  editing.value = false;
  history.value = [];
  namespaces.value = [];
  status.value = null;
  tasks.value = [];
  sensitive.value = false;
  passwordForm.value = { current: '', next: '', confirmation: '' };
}
function fail(cause: unknown) {
  if (cause instanceof DOMException && cause.name === 'AbortError') return;
  if (cause instanceof ApiError) {
    if (cause.status === 401 && cause.message !== 'invalid_password') {
      signOut();
    }
    const messages: Record<string, string> = {
      invalid_password: '密码不正确，请重试。',
      password_unchanged: '新密码必须与当前密码不同。',
      password_changed: '管理员密码已被更新，请重新登录。',
      bearer_changed: '令牌已被更新或撤销，已重新读取列表。',
      authentication_required: '登录已过期，请重新登录。',
      invalid_token: '登录已过期，请重新登录。',
      admin_disabled: '管理台尚未配置登录密码。',
      invalid_csrf: '会话校验失败，请刷新页面重新登录。',
      rate_limited: '请求过于频繁，请稍后再试。',
      invalid_input: '输入格式不正确，请检查分区、标签和各字段长度。',
      possible_credentials: '内容疑似包含凭据，请移除密码或 Token 后重试。',
      memory_not_found: '这条记忆已删除或过期，请刷新列表。',
      invalid_origin: '当前访问地址未被服务允许，请检查 PUBLIC_URL / ALLOWED_ORIGINS。',
    };
    error.value =
      messages[cause.message] ??
      (cause.status === 409
        ? '记录已变化，请核对最新版本后重试。'
        : `请求失败（${cause.status}），请稍后重试。`);
  } else error.value = '无法连接服务，请检查网络后重试。';
}
async function session() {
  try {
    const result = await request<{ enabled: boolean; authenticated: boolean; csrf?: string }>('/ui/session');
    enabled.value = result.enabled;
    authenticated.value = result.authenticated;
    csrf.value = result.csrf ?? '';
    if (result.authenticated) await initialize();
  } catch (cause) {
    fail(cause);
  } finally {
    ready.value = true;
  }
}
async function login() {
  loggingIn.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await request<{ csrf: string }>('/ui/login', { password: password.value });
    password.value = '';
    csrf.value = result.csrf;
    authenticated.value = true;
    await initialize();
  } catch (cause) {
    password.value = '';
    fail(cause);
  } finally {
    loggingIn.value = false;
  }
}
function canLeave() {
  return !busy.value && (!dirty.value || window.confirm('有尚未保存的修改，确定放弃吗？'))
    && (!sensitive.value || window.confirm('离开后无法再次查看当前明文令牌。确定已经保存？'));
}
async function logout() {
  if (!canLeave()) return;
  try {
    await request('/ui/logout', {}, csrf.value);
    signOut();
    error.value = '';
    notice.value = '';
  } catch (cause) {
    fail(cause);
  }
}
async function changePassword() {
  if (busy.value) return;
  error.value = '';
  if (passwordForm.value.next !== passwordForm.value.confirmation) {
    error.value = '两次输入的新密码不一致。';
    return;
  }
  busy.value = true;
  try {
    await request('/ui/password', { current_password: passwordForm.value.current, new_password: passwordForm.value.next }, csrf.value);
    signOut();
    notice.value = '管理员密码已更新，请使用新密码登录。';
  } catch (cause) {
    passwordForm.value.current = '';
    if (cause instanceof ApiError && cause.message === 'password_changed') signOut();
    fail(cause);
  } finally {
    busy.value = false;
  }
}
async function refreshNamespaces() {
  namespaces.value = (await request<{ namespaces: typeof namespaces.value }>('/v1/namespaces')).namespaces;
}
async function initialize() {
  await refreshNamespaces();
  await reload();
}
function splitTags(value: string) {
  return value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
}
function scope() {
  const names = namespace.value ? [namespace.value] : namespaces.value.map((item) => item.namespace);
  if (names.length > 20) throw new Error('too_many_namespaces');
  return {
    namespaces: names.length ? names : ['global'],
    include_descendants: namespace.value ? descendants.value : false,
    ...(typeFilter.value ? { type: typeFilter.value } : {}),
    tags: splitTags(tagFilter.value),
    device_tags: splitTags(deviceFilter.value),
  };
}
async function loadList(more = false) {
  const sequence = ++listSequence;
  activeList?.abort();
  activeList = new AbortController();
  loading.value = true;
  error.value = '';
  try {
    if (!namespace.value && namespaces.value.length > 20) {
      error.value = '分区超过 20 个，请先选择一个分区浏览。';
      memories.value = [];
      cursor.value = null;
      return;
    }
    const filter = scope();
    const signature = JSON.stringify({ ...filter, query: query.value.trim() });
    if (signature !== listSignature) more = false;
    const result = query.value.trim()
      ? await request<{ memories: Memory[]; degraded?: boolean; next_cursor?: string | null }>(
          '/v1/memories/search',
          { ...filter, query: query.value.trim(), limit: 50 },
          csrf.value,
          activeList.signal,
        )
      : await request<{ memories: Memory[]; degraded?: boolean; next_cursor?: string | null }>(
          '/v1/memories/list',
          { ...filter, limit: 30, ...(more && cursor.value ? { cursor: cursor.value } : {}) },
          csrf.value,
          activeList.signal,
        );
    if (sequence !== listSequence) return;
    listSignature = signature;
    memories.value = more
      ? [
          ...memories.value,
          ...result.memories.filter((item) => !memories.value.some((old) => old.id === item.id)),
        ]
      : result.memories;
    cursor.value = result.next_cursor ?? null;
    degraded.value = !!result.degraded;
  } catch (cause) {
    if (sequence === listSequence) fail(cause);
  } finally {
    if (sequence === listSequence) loading.value = false;
  }
}
async function loadStatus() {
  const sequence = ++statusSequence;
  loading.value = true;
  error.value = '';
  try {
    const filter = scope(),
      params = new URLSearchParams();
    filter.namespaces.forEach((value) => params.append('namespaces', value));
    filter.tags.forEach((value) => params.append('tags', value));
    filter.device_tags.forEach((value) => params.append('device_tags', value));
    params.set('include_descendants', String(filter.include_descendants));
    if (filter.type) params.set('type', filter.type);
    const result = await request<Status>(`/v1/status?${params}`);
    const jobs = await request<typeof tasks.value>('/v1/tasks');
    if (sequence === statusSequence) {
      status.value = result;
      tasks.value = jobs;
    }
  } catch (cause) {
    if (sequence === statusSequence) fail(cause);
  } finally {
    if (sequence === statusSequence) loading.value = false;
  }
}
async function reload() {
  if (section.value === 'memories') await loadList();
  else if (section.value === 'status') await loadStatus();
}
async function navigate(nextSection: Section, nextNamespace = '') {
  if (nextSection === section.value && nextNamespace === namespace.value) return;
  if (!canLeave()) return;
  activeList?.abort();
  ++listSequence;
  ++detailSequence;
  ++statusSequence;
  section.value = nextSection;
  sensitive.value = false;
  passwordForm.value = { current: '', next: '', confirmation: '' };
  namespace.value = nextNamespace;
  selected.value = null;
  editing.value = false;
  detailLoading.value = false;
  conflict.value = null;
  deleteOpen.value = false;
  history.value = [];
  error.value = '';
  notice.value = '';
  loading.value = false;
  status.value = null;
  tasks.value = [];
  query.value = '';
  tagFilter.value = '';
  deviceFilter.value = '';
  typeFilter.value = '';
  descendants.value = false;
  memories.value = [];
  cursor.value = null;
  window.scrollTo(0, 0);
  await reload();
}
async function selectNamespace(event: Event) {
  const input = event.target as HTMLSelectElement;
  await navigate('memories', input.value);
  input.value = namespace.value;
}
async function open(memory: Memory, check = true) {
  if (check && !canLeave()) return;
  const sequence = ++detailSequence;
  selected.value = null;
  editing.value = false;
  detailLoading.value = true;
  conflict.value = null;
  deleteOpen.value = false;
  error.value = '';
  history.value = [];
  detailTab.value = 'content';
  try {
    const [record, events] = await Promise.all([
      request<Memory>(`/v1/memories?id=${encodeURIComponent(memory.id)}`),
      request<History[]>(`/v1/memories/history?id=${encodeURIComponent(memory.id)}`),
    ]);
    if (sequence !== detailSequence) return;
    selected.value = record;
    history.value = events;
  } catch (cause) {
    if (sequence === detailSequence) fail(cause);
  } finally {
    if (sequence === detailSequence) detailLoading.value = false;
  }
}
function edit(isNew = false) {
  if (isNew && !canLeave()) return;
  ++detailSequence;
  detailLoading.value = false;
  error.value = '';
  notice.value = '';
  conflict.value = null;
  deleteOpen.value = false;
  if (isNew) {
    selected.value = null;
    history.value = [];
  }
  const record = selected.value;
  form.value = record
    ? {
        namespace: record.namespace,
        key: record.key,
        content: record.content,
        type: record.type,
        tags: record.tags.join(', '),
        device_tags: record.device_tags.join(', '),
        pinned: record.pinned,
        expires: localDate(record.expires_at),
        reference: 'web:manual',
        excerpt: '',
      }
    : blank();
  originalForm = JSON.stringify(form.value);
  editing.value = true;
}
function cancelEdit() {
  if (canLeave()) {
    editing.value = false;
    conflict.value = null;
  }
}
async function save() {
  if (busy.value) return;
  error.value = '';
  notice.value = '';
  conflict.value = null;
  const value = form.value;
  let expires: string | null = null;
  if (value.expires && value.key.trim() !== 'overview') {
    const date = new Date(value.expires);
    if (!Number.isFinite(date.getTime())) {
      error.value = '有效期格式不正确。';
      return;
    }
    expires = date.toISOString();
  }
  const body = {
    namespace: value.namespace.trim(),
    key: value.key.trim(),
    content: value.content,
    type: value.type,
    tags: splitTags(value.tags),
    device_tags: splitTags(value.device_tags),
    pinned: value.key.trim() === 'overview' || value.pinned,
    expires_at: expires,
    source: { reference: value.reference, excerpt: value.excerpt },
    ...(selected.value ? { expected_version: selected.value.version } : {}),
  };
  const signature = JSON.stringify(body);
  if (signature !== pendingWrite.signature) pendingWrite = { signature, id: operationId() };
  busy.value = true;
  try {
    const result = await request<{ memory: Memory; status: string }>(
      '/v1/memories',
      { ...body, idempotency_key: pendingWrite.id },
      csrf.value,
    );
    editing.value = false;
    selected.value = null;
    pendingWrite = { signature: '', id: '' };
    notice.value = '记忆已保存。分区内容发生重要变化时，请同步维护 overview 总览。';
    await refreshNamespaces();
    await loadList();
    await open(result.memory, false);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409 && cause.data.memory) {
      conflict.value = cause.data.memory;
      pendingWrite = { signature: '', id: '' };
    }
    fail(cause);
  } finally {
    busy.value = false;
  }
}
async function latest() {
  if (!conflict.value || !window.confirm('加载最新版本会放弃当前表单修改，确定继续吗？')) return;
  await open(conflict.value, false);
}
async function remove() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  error.value = '';
  conflict.value = null;
  const body = { id: selected.value.id, expected_version: selected.value.version },
    signature = JSON.stringify(body);
  if (signature !== pendingDelete.signature) pendingDelete = { signature, id: operationId() };
  try {
    await request('/v1/memories/delete', { ...body, idempotency_key: pendingDelete.id }, csrf.value);
    selected.value = null;
    history.value = [];
    deleteOpen.value = false;
    pendingDelete = { signature: '', id: '' };
    notice.value = '记忆及其来源、历史已删除。请核对分区总览中的相关摘要。';
    await refreshNamespaces();
    await loadList();
  } catch (cause) {
    if (cause instanceof ApiError && cause.data.memory) conflict.value = cause.data.memory;
    fail(cause);
  } finally {
    busy.value = false;
  }
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value || sensitive.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => {
  void session();
  window.addEventListener('beforeunload', beforeUnload);
});
onUnmounted(() => {
  activeList?.abort();
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <div v-if="!ready" class="boot" role="status">正在连接记忆库…</div>
  <main v-else-if="!authenticated" class="login-screen">
    <div class="login-intro">
      <div class="brand-mark">u</div>
      <p class="eyebrow">YOUR SHARED MEMORY</p>
      <h1>让重要的事，<br />始终有迹可循。</h1>
      <p>一个地方，管理跨客户端的长期记忆。</p>
      <div class="intro-line"></div>
      <span>uni-memory / 个人记忆管理台</span>
    </div>
    <form class="login-card" @submit.prevent="login">
      <p class="eyebrow">WELCOME BACK</p>
      <h2>进入记忆库</h2>
      <p class="muted">使用当前管理员密码登录。</p>
      <div v-if="error" class="alert error" role="alert">{{ error }}</div>
      <div v-if="notice" class="alert success" role="status">{{ notice }}</div>
      <template v-if="enabled"
        ><label for="password">管理密码</label
        ><input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="1024"
          autofocus
          placeholder="输入管理密码"
          :disabled="loggingIn"
        /><button class="primary full" :disabled="loggingIn">
          {{ loggingIn ? '正在登录…' : '登录管理台 →' }}
        </button>
        <p class="small muted">会话有效期 12 小时，退出后立即失效。</p></template
      >
      <p v-else class="alert">
        管理台尚未启用。请在 Docker 环境变量中设置至少 16 字符的 ADMIN_PASSWORD，并重建应用容器。
      </p>
      <button type="button" class="text-button" @click="theme = theme === 'dark' ? 'light' : 'dark'">
        切换{{ theme === 'dark' ? '浅色' : '深色' }}外观
      </button>
    </form>
  </main>
  <div v-else class="shell">
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="navigate('memories')"
        ><span class="brand-mark small-mark">u</span><span>uni-memory<small>共享记忆管理台</small></span></a
      >
      <nav class="main-nav" aria-label="管理台导航">
        <div v-for="category in navigation" :key="category.label" class="nav-group">
          <p class="nav-caption">{{ category.label }}</p>
          <button
            v-for="item in category.items"
            :key="item.id"
            class="nav-item"
            :class="{ active: section === item.id }"
            :aria-current="section === item.id ? 'page' : undefined"
            @click="navigate(item.id, item.id === section ? namespace : '')"
          >
            {{ item.label }} <span v-if="item.id === 'memories'" class="count">{{ total }}</span>
          </button>
        </div>
      </nav>
      <div class="sidebar-footer">
        <span class="live-dot"></span> 私人工作空间<button class="text-button" @click="logout">退出</button>
      </div>
    </aside>
    <main class="workspace">
      <header class="topbar">
        <span
          >{{ group }} <span class="separator">/</span> {{ page.label }}</span
        ><button
          class="icon-button"
          :aria-label="theme === 'dark' ? '切换浅色' : '切换深色'"
          @click="theme = theme === 'dark' ? 'light' : 'dark'"
        >
          {{ theme === 'dark' ? '☀' : '☾' }}
        </button>
      </header>
      <div class="page-heading">
        <div>
          <h1>{{ section === 'memories' && namespace ? namespace : page.title }}</h1>
          <p class="muted">{{ page.description }}</p>
        </div>
        <div v-if="section === 'memories' || section === 'status'" class="actions">
          <button :disabled="loading || busy" @click="refreshNamespaces().then(reload).catch(fail)">
            刷新</button
          ><button v-if="section === 'memories'" class="primary" :disabled="busy" @click="edit(true)">
            ＋ 新建记忆
          </button>
        </div>
      </div>
      <div v-if="error" class="alert error" role="alert">
        {{ error }}<button class="text-button" aria-label="关闭错误提示" @click="error = ''">×</button>
      </div>
      <div v-if="notice" class="alert success" role="status">
        {{ notice }}<button class="text-button" aria-label="关闭提示" @click="notice = ''">×</button>
      </div>

      <template v-if="section === 'memories'">
        <form class="filters" @submit.prevent="loadList()">
          <div class="search-field">
            <span aria-hidden="true">⌕</span
            ><input
              v-model="query"
              aria-label="搜索记忆"
              maxlength="512"
              placeholder="搜索正文、关键词或记忆 key…"
            /><button type="submit" :disabled="loading">搜索</button>
          </div>
          <div class="filter-row">
            <select class="namespace-select" :value="namespace" aria-label="记忆分区" @change="selectNamespace">
              <option value="">全部分区（{{ namespaces.length }}）</option>
              <option v-for="item in namespaces" :key="item.namespace" :value="item.namespace">{{ item.namespace }}（{{ item.count }}）</option>
            </select>
            <select v-model="typeFilter" aria-label="筛选类型" @change="loadList()">
              <option value="">全部类型</option>
              <option v-for="(label, key) in types" :key="key" :value="key">{{ label }}</option></select
            ><input
              v-model="tagFilter"
              class="tag-filter"
              aria-label="筛选标签"
              placeholder="标签，用逗号分隔"
              @change="loadList()"
            /><input
              v-model="deviceFilter"
              class="tag-filter"
              aria-label="筛选设备标签"
              placeholder="计算机名，用逗号分隔"
              @change="loadList()"
            /><label v-if="namespace" class="check"
              ><input v-model="descendants" type="checkbox" @change="loadList()" />包含子分区</label
            ><span class="filter-hint">{{
              query.trim() ? '相关性排序 · 最多 50 条' : `已加载 ${memories.length} 条`
            }}</span>
          </div>
        </form>
        <p v-if="degraded" class="alert">向量检索暂不可用，当前显示关键词检索结果。</p>
        <div class="library" :class="{ 'with-detail': selected || editing || detailLoading }">
          <section class="memory-list" aria-label="记忆列表" :aria-busy="loading">
            <div class="list-caption"><span>记忆条目</span><span>类型 / 置顶</span></div>
            <p v-if="loading && !memories.length" class="empty">正在加载记忆…</p>
            <div v-else-if="!memories.length" class="empty">
              <div class="empty-symbol">◇</div>
              <h3>
                {{
                  query || typeFilter || tagFilter || deviceFilter ? '没有匹配的记忆' : '这里还没有记忆'
                }}
              </h3>
              <p>调整筛选条件，或新建一条值得保存的事实。</p>
            </div>
            <button
              v-for="memory in memories"
              :key="memory.id"
              class="memory-row"
              :class="{ selected: selected?.id === memory.id }"
              @click="open(memory)"
            >
              <div class="row-top">
                <span class="memory-key">{{ memory.pinned ? '◆ ' : '' }}{{ memory.key }}</span>
                <div class="badges">
                  <span class="badge">{{ types[memory.type] }}</span
                  >
                </div>
              </div>
              <p class="preview">{{ memory.content }}</p>
              <div class="row-meta">
                <span>{{ memory.namespace }}</span
                ><span v-for="tag in memory.tags.slice(0, 3)" :key="tag">#{{ tag }}</span
                ><span class="version">v{{ memory.version }}</span>
              </div>
            </button>
            <button v-if="cursor" class="load-more" :disabled="loading" @click="loadList(true)">
              {{ loading ? '加载中…' : '加载更多记忆 ↓' }}
            </button>
          </section>
          <aside
            v-if="selected || editing || detailLoading"
            class="detail"
            aria-label="记忆详情"
            :aria-busy="detailLoading"
          >
            <p v-if="detailLoading" class="empty">正在读取详情…</p>
            <template v-else
              ><div class="detail-heading">
                <span class="eyebrow">{{
                  editing ? (selected ? 'EDIT MEMORY' : 'NEW MEMORY') : 'MEMORY DETAILS'
                }}</span
                ><button
                  class="icon-button"
                  aria-label="关闭详情"
                  :disabled="busy"
                  @click="canLeave() && ((selected = null), (editing = false), (conflict = null))"
                >
                  ×
                </button>
              </div>
              <div v-if="conflict" class="alert error conflict">
                <strong>版本冲突 · 当前服务端 v{{ conflict.version }}</strong>
                <p>你的修改尚未覆盖原记录。请先核对最新内容。</p>
                <pre>{{ conflict.content }}</pre>
                <button @click="latest">加载最新版本</button>
              </div>
              <form v-if="editing" class="edit-form" @submit.prevent="save">
                <h2>{{ selected ? '编辑记忆' : '新建记忆' }}</h2>
                <fieldset :disabled="busy">
                  <label
                    >分区<input
                      v-model="form.namespace"
                      required
                      maxlength="160"
                      :disabled="!!selected"
                      placeholder="projects/your-project"
                      list="namespace-options" /></label
                  ><datalist id="namespace-options">
                    <option
                      v-for="item in namespaces"
                      :key="item.namespace"
                      :value="item.namespace"
                    /></datalist
                  ><label
                    >记忆 key<input
                      v-model="form.key"
                      required
                      maxlength="160"
                      :disabled="!!selected"
                      placeholder="user.preference.language"
                  /></label>
                  <p v-if="form.key.trim() === 'overview'" class="small muted">
                    分区总览会自动置顶，并保持长期有效。
                  </p>
                  <label
                    >正文<textarea
                      v-model="form.content"
                      required
                      maxlength="4000"
                      rows="8"
                      placeholder="记录稳定、有长期价值的信息。文件位置请用相对路径或相对位置描述。"
                    ></textarea
                    ><span class="small muted character-count">{{ form.content.length }} / 4000</span></label
                  >
                  <div class="form-grid">
                    <label
                      >类型<select v-model="form.type">
                        <option v-for="(label, key) in types" :key="key" :value="key">{{ label }}</option>
                      </select></label
                    >
                  </div>
                  <label>标签<input v-model="form.tags" placeholder="用逗号分隔，最多 20 个" /></label>
                  <label>设备标签<input v-model="form.device_tags" placeholder="填写关联的计算机名，用逗号分隔" /></label>
                  <label
                    >有效期<input
                      v-model="form.expires"
                      type="datetime-local"
                      :disabled="form.key.trim() === 'overview'"
                  /></label>
                  <p class="small muted">留空为长期有效；时间按当前设备时区填写。</p>
                  <label class="check"
                    ><input
                      v-model="form.pinned"
                      type="checkbox"
                      :disabled="form.key.trim() === 'overview'"
                    />置顶记忆</label
                  ><label
                    >本次修改的来源<input
                      v-model="form.reference"
                      required
                      maxlength="512"
                      placeholder="web:manual" /></label
                  ><label
                    >来源摘录（可选）<textarea v-model="form.excerpt" maxlength="512" rows="2"></textarea>
                  </label>
                  <div class="form-actions">
                    <button type="button" @click="cancelEdit">取消</button
                    ><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存记忆' }}</button>
                  </div>
                </fieldset>
              </form>
              <template v-else-if="selected"
                ><div class="detail-title">
                  <div class="badges">
                    <span class="badge">{{ types[selected.type] }}</span
                    ><span v-if="selected.pinned" class="badge">置顶</span>
                  </div>
                  <h2>{{ selected.key }}</h2>
                  <p class="small muted">{{ selected.namespace }} · v{{ selected.version }}</p>
                </div>
                <div class="detail-tabs" role="tablist" aria-label="详情内容">
                  <button
                    v-for="tab in [
                      { id: 'content', label: '正文' },
                      { id: 'sources', label: '来源' },
                      { id: 'history', label: '版本历史' },
                    ]"
                    :id="`tab-${tab.id}`"
                    :key="tab.id"
                    role="tab"
                    :aria-selected="detailTab === tab.id"
                    aria-controls="detail-panel"
                    @click="detailTab = tab.id"
                  >
                    {{ tab.label }}
                  </button>
                </div>
                <div
                  id="detail-panel"
                  class="detail-body"
                  role="tabpanel"
                  :aria-labelledby="`tab-${detailTab}`"
                >
                  <template v-if="detailTab === 'content'"
                    ><p class="memory-content">{{ selected.content }}</p>
                    <div class="tags">
                      <span v-for="tag in selected.tags" :key="tag" class="badge">#{{ tag }}</span>
                    </div>
                    <dl class="metadata">
                      <dt>最近更新</dt>
                      <dd>{{ timestamp(selected.updated_at) }}</dd>
                      <dt>有效期至</dt>
                      <dd>{{ selected.expires_at ? timestamp(selected.expires_at) : '长期有效' }}</dd>
                      <dt>设备标签</dt>
                      <dd>{{ selected.device_tags.join('、') || '—' }}</dd>
                      <dt>记忆 ID</dt>
                      <dd class="mono">{{ selected.id }}</dd>
                    </dl>
                    <p v-if="selected.key === 'overview'" class="alert small">
                      这是分区总览。详细事实以各自的记忆条目为准。
                    </p></template
                  ><template v-else-if="detailTab === 'sources'"
                    ><article v-for="(source, index) in selected.sources" :key="index" class="event">
                      <strong>{{ source.reference }}</strong>
                      <p class="memory-content">{{ source.excerpt || '无摘录' }}</p>
                      <small class="muted">{{ source.client_id }} · {{ timestamp(source.created_at) }}</small>
                    </article>
                    <p v-if="!selected.sources?.length" class="muted">暂无来源。</p></template
                  ><template v-else
                    ><article v-for="(event, index) in history.slice().reverse()" :key="index" class="event">
                      <div class="row-top">
                        <strong>版本 {{ event.version }}</strong
                        ><span class="badge">{{ types[event.snapshot.type] }}</span>
                      </div>
                      <p class="memory-content">{{ event.snapshot.content }}</p>
                      <details>
                        <summary>查看该版本属性</summary>
                        <pre>{{
                          JSON.stringify(
                            {
                              namespace: event.snapshot.namespace,
                              key: event.snapshot.key,
                              tags: event.snapshot.tags,
                              device_tags: event.snapshot.device_tags,
                              pinned: event.snapshot.pinned,
                              expires_at: event.snapshot.expires_at,
                              sources: event.snapshot.sources,
                            },
                            null,
                            2,
                          )
                        }}</pre>
                      </details>
                      <small class="muted">{{ event.client_id }} · {{ timestamp(event.created_at) }}</small>
                    </article>
                    <p v-if="!history.length" class="muted">暂无历史。</p></template
                  >
                </div>
                <div class="detail-footer">
                  <button class="danger-text" :disabled="busy" @click="deleteOpen = !deleteOpen">
                    删除记忆</button
                  ><button class="primary" :disabled="busy" @click="edit()">编辑记忆</button>
                </div>
                <div v-if="deleteOpen" class="delete-confirm" role="alert">
                  <strong>确定永久删除 {{ selected.key }}？</strong>
                  <p>正文、来源及全部历史将被清除，无法撤销。备份到期前可能仍保留内容。</p>
                  <div class="actions">
                    <button :disabled="busy" @click="deleteOpen = false">取消</button
                    ><button class="danger" :disabled="busy" @click="remove">
                      {{ busy ? '删除中…' : '确认永久删除' }}
                    </button>
                  </div>
                </div></template
              >
            </template>
          </aside>
        </div>
      </template>
      <section v-else-if="section === 'status'" class="status-page" :aria-busy="loading">
        <p v-if="loading" class="muted" role="status">正在读取服务状态…</p>
        <template v-if="status"
          ><div class="status-banner">
            <div>
              <span class="live-dot" :class="{ warning: status.status !== 'ok' }"></span
              ><strong>{{
                status.status === 'ok'
                  ? '服务运行正常'
                  : status.status === 'degraded'
                    ? '服务部分能力降级'
                    : '服务暂不可用'
              }}</strong>
              <p class="muted">最后检查 {{ timestamp(status.checked_at) }} · v{{ status.version }}</p>
            </div>
            <span class="badge">{{
              status.search_mode === 'hybrid'
                ? '混合检索'
                : status.search_mode === 'keyword'
                  ? '关键词检索'
                  : '检索不可用'
            }}</span>
          </div>
          <div class="stat-grid">
            <article
              v-for="item in [
                { label: '有效记忆', value: status.memories?.active },
                { label: '已置顶', value: status.memories?.pinned },
                { label: '已过期', value: status.memories?.expired },
              ]"
              :key="item.label"
              class="stat-card"
            >
              <p>{{ item.label }}</p>
              <strong>{{ item.value ?? '—' }}</strong
              ><span class="small muted">全部已发现分区</span>
            </article>
          </div>
          <div class="status-grid">
            <article class="panel">
              <h2>依赖与推理</h2>
              <dl class="status-dl">
                <dt>PostgreSQL</dt>
                <dd>{{ status.database === 'ok' ? '可用' : '不可用' }}</dd>
                <dt>Qdrant</dt>
                <dd>{{ status.qdrant === 'ok' ? '可用' : '不可用' }}</dd>
                <dt>Embedding 模型</dt>
                <dd>{{ status.embedding.model ?? '未配置' }}</dd>
                <dt>模型状态</dt>
                <dd>{{ modelStates[status.embedding.state] ?? status.embedding.state }}</dd>
                <dt>量化 / 向量维度</dt>
                <dd>{{ status.embedding.dtype ?? '—' }} / {{ status.embedding.dimensions ?? '—' }}</dd>
                <dt>进程运行时间</dt>
                <dd>
                  {{ Math.floor(status.uptime_seconds / 3600) }} 小时
                  {{ Math.floor((status.uptime_seconds % 3600) / 60) }} 分钟
                </dd>
              </dl>
              <p v-if="status.embedding.error_code" class="alert error">{{ status.embedding.error_code }}</p>
            </article>
            <article class="panel">
              <h2>索引覆盖</h2>
              <template v-if="status.index"
                ><div class="coverage">
                  {{ status.index.indexed }} <span>/ {{ status.index.total }} 条</span>
                </div>
                <progress
                  :value="status.index.indexed"
                  :max="status.index.total || 1"
                  aria-label="当前版本索引覆盖率"
                ></progress>
                <dl class="status-dl">
                  <dt>排队任务</dt>
                  <dd>{{ status.index.queued }}</dd>
                  <dt>失败任务</dt>
                  <dd>{{ status.index.failed }}</dd>
                </dl></template
              >
              <p v-else class="muted">索引统计暂不可用。</p>
              <p class="small muted">依赖、模型与索引反映整个实例；查询状态不会触发模型推理。</p>
            </article>
          </div>
          <article class="panel tasks">
            <h2>索引任务 <span class="small muted">最多显示 100 项</span></h2>
            <p v-if="!tasks.length" class="muted">没有排队或失败的任务。</p>
            <div v-else class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>记忆 ID</th>
                    <th>尝试次数</th>
                    <th>状态</th>
                    <th>错误码</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="task in tasks" :key="task.memory_id">
                    <td class="mono">{{ task.memory_id }}</td>
                    <td>{{ task.attempts }}</td>
                    <td>{{ task.failed ? '失败' : '等待处理' }}</td>
                    <td>{{ task.error_code ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </article></template
        >
      </section>
      <BearerPage v-else-if="section === 'bearers'" v-model:busy="busy" v-model:sensitive="sensitive" :csrf="csrf" @error="fail" @start="error = ''" />
      <AuditPage v-else-if="section === 'audit'" @error="fail" @start="error = ''" />
      <article v-else class="panel settings-form password-panel">
        <h2>修改管理员密码</h2>
        <p class="muted">保存后，所有管理台会话将退出。请用新密码重新登录。</p>
        <form @submit.prevent="changePassword">
          <fieldset :disabled="busy">
            <label>当前密码
              <input v-model="passwordForm.current" type="password" autocomplete="current-password" required maxlength="1024" />
            </label>
            <label>新密码
              <input v-model="passwordForm.next" type="password" autocomplete="new-password" required minlength="16" maxlength="1024" aria-describedby="password-length" />
            </label>
            <p id="password-length" class="small muted">使用 16–1024 个字符。</p>
            <label>确认新密码
              <input v-model="passwordForm.confirmation" type="password" autocomplete="new-password" required minlength="16" maxlength="1024" />
            </label>
            <div class="form-actions"><button class="primary">{{ busy ? '保存中…' : '保存新密码' }}</button></div>
          </fieldset>
        </form>
      </article>
      <footer class="page-footer">uni-memory <span>让长期记忆清晰、可查、可维护。</span></footer>
    </main>
  </div>
</template>
