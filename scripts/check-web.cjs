// vue-tsc 尚不兼容 TypeScript 7 的编译器接口；仅前端类型检查使用锁定的 TS 6。
require('vue-tsc').run(require.resolve('typescript-vue/lib/tsc'));
