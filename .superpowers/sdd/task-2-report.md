# Task 2 报告（v4：真正的 shell 解析器）

## 演进
| 版本 | 做法 | 被什么打穿 |
|---|---|---|
| v1 | 正则黑名单 | 8 处零成本绕过；find -delete 不含关键字 |
| v2 | 命令名白名单 | git log --output= 写任意文件（实测） |
| v3 | 标志白名单 | 引号一包就绕过；uniq IN OUT 位置参数即输出 |
| v4 | shell-quote 解析 | 当前 |

共同教训：字符串匹配一门没有解析的语言，每轮都会冒出新的绕过类别。

## 实施说明
由控制器直接实现（前一个子代理在 v3 阶段被 API 错误中断）。

## 关键设计
- `parseCommand` 用 shell-quote 得到 shell 实际执行的 argv；operator 对象一律放弃判定
- 原始串仍需先拒反引号和 `$`：shell-quote 不把它们报成 operator
  （反引号变普通 token；`cat $SECRET` 解析成 ["cat",""]，路径凭空消失）
- glob 视为位置参数（只是文件名模式，展开不出命令）
- 标志检查保留大小写；尾部数字只在 numeric 开启时剥离（否则 -L5 会伪装成 -L）

## 测试与验证
    $ npm test        → ℹ tests 34  ℹ pass 34  ℹ fail 0
    $ npm run typecheck → exit 0

控制器独立对抗验证（测试套件之外，覆盖全部四代绕过）：
  36 条攻击全部 risky —— 含 v1 的 8 处、v2 的写文件标志、v3 的引号绕过与
  uniq 位置参数、docker inspect / kubectl secret 泄密、变量展开与反引号
  33 条日常命令全部 safe —— ls/cat/grep/head/tail/wc/du/df/git status/
  git log/git diff/git show/npm test/cargo test/go test/docker ps/
  docker logs/find/date/pwd/whoami/which/file/glob/diff/realpath/basename

## 文件变更
- extensions/feishu/risk.ts（整体重写）
- test/risk.test.ts（整体重写，34 个用例中 22 个属本模块）
- package.json / package-lock.json（新增 shell-quote + @types/shell-quote）

## 已知残余（已写入 spec，是取舍不是漏洞）
仓库内 write 是 safe、npm test 也是 safe，「改 package.json → 跑测试」链在边界内成立。
这是「让代理在仓库里无人值守干活」的固有代价；要堵用 strict 档。

## 第 4 轮审查后的修复
审查报出一个可复现的越界写入，已核实并修复：

    $ bash -c 'set -- find / {-delete,}; printf "[%s] " "$@"'
    [find] [/] [-delete]        ← bash 展开后的真实 argv
    判定结果: safe               ← shell-quote 完全不做花括号展开

修复：
1. RAW_FORBIDDEN 加入 `{` `}`（花括号展开）
2. glob 也放弃判定 —— 只看得到未展开的模式串，看不到实际 argv
3. cargo fmt 移出（`cargo fmt -- <path>` 经位置参数就地改写文件，与 uniq 同类）
4. go 改 style:"word" —— Go 用单横杠长标志，原配置下 long 表根本查不到，全部误判危险
5. du 去掉无依据的 numeric

    $ npm test → 38/38 pass    $ npm run typecheck → exit 0
    对抗验证：24 条攻击全拦（含花括号类）、25 条日常命令零误伤
