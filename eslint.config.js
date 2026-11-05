// DoboCache ESLint 9 flat config
// 目标：只做"真能抓到问题"的静态检查（类型相关的误用、未使用变量、可疑写法），
// 不引入缩进/引号/分号等纯风格规则，避免噪声淹没真实缺陷。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 不参与检查的目录：构建产物、公开发布文件、运行时数据、依赖
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'temp/**',
      'data/**',
      'archive/**',
      '**/*.d.ts',
    ],
  },

  // ESLint 内置推荐规则（核心规则集）
  js.configs.recommended,

  // typescript-eslint 推荐规则集（含 parser 与 TS 语义感知规则，不用 type-aware 编译程序，保证速度）
  ...tseslint.configs.recommended,

  // 构建 / 校验脚本（scripts/ 下的 .mjs 与 .ts）：运行在 Node 环境，
  // console、process、定时器等均为合法全局；此处补齐以免 `eslint .` 全量检查时
  // 被几十条 no-undef 噪声淹没（曾出现贡献者误以为仓库本身有问题）。
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      // 与 src/test 口径一致：脚本里的 any 提示但不阻断
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // 本项目源码与测试的落地规则
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // MCP server 以 stdio 通信，日志必须写 stderr，console 属正常用法
      'no-console': 'off',

      // 未使用变量：真问题，报 error；约定下划线前缀表示有意忽略
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],

      // any 泛滥属设计债，先以降级告警提示，不阻断 CI
      '@typescript-eslint/no-explicit-any': 'warn',

      // ts-ignore 必须显式说明原因，仅提示
      '@typescript-eslint/ban-ts-comment': 'warn',

      // 允许空接口/空对象类型的既有声明习惯，但保留空代码块检查
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-empty-function': 'warn',

      // 浮点/异步相关的常见陷阱保持默认开启（no-floating-promises 需 type-aware，暂不启用）
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
);
