# 技术栈与实现约定
> Node 原生类型剥离、TypeScript ESM、依赖与验证命令。

```bash
npm test                              # 全量，node:test
node --test "test/risk.test.ts"       # 单个测试文件
node --test --test-name-pattern "管道" # 按名字筛
npm run typecheck                     # tsc --noEmit
```

Node ≥ 24。**没有构建步骤** —— 依赖 Node 原生的类型剥离（type stripping）直接跑 `.ts`。

无 lint / formatter，提交前跑 `npm test` + `npm run typecheck` 即可。



## 技术选型

- TypeScript ESM，`strict` / `verbatimModuleSyntax`，Node 原生运行 `.ts`。
- pi 扩展 API、飞书 SDK `@larksuiteoapi/node-sdk`、shell 参数解析 `shell-quote`；版本范围以 `package.json` 为准。
- 测试使用 `node:test` + `node:assert/strict`，无 mock 框架。
- 当前不使用数据库、前端构建或独立 Web 服务。

## 扩展注册自定义工具时不能 import typebox
pi 的 `registerTool` 声明 `parameters: TSchema`，官方示例写 `import { Type } from "typebox"`。
但 typebox 只在 **pi 自己的 node_modules** 里，本仓库的扩展文件按自身路径向上解析，
运行期直接 `ERR_MODULE_NOT_FOUND`（实测过）。

pi 只是把 `parameters` 原样透给模型、不做 TypeBox 校验（core 里唯一一处 `Compile()`
是给 models.json 用的），所以手写普通 JSON Schema 对象 + `as never` 即可。

## strip-only 模式的语法限制
Node 的类型剥离不做代码生成，所以**不能用构造函数参数属性**（`constructor(private x)`），
依赖要写成显式字段。同理避免 `enum`、`namespace`、装饰器。

模块间 import 必须带 `.ts` 后缀（`allowImportingTsExtensions`）。
`verbatimModuleSyntax` 开着，纯类型导入必须写 `import type`。
