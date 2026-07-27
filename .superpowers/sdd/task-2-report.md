# Task 2 报告（v3：标志层白名单）

## 背景
本模块前两版均被审查证伪：
- v1 正则黑名单：8 处零成本绕过
- v2 命令名白名单：只看命令不看标志，`git log --output=` 可写任意文件（实测确认）

v3 把白名单下沉到标志层。

## 实施说明
子代理在替换完 `test/risk.test.ts`、尚未写入实现时被 API 错误中断（停在 RED 状态）。
剩余工作是从 brief 逐字提取 Step 3 代码块写入 `extensions/feishu/risk.ts`，由控制器直接完成。

## TDD 证据
RED（新测试 vs v2 实现）：
    $ node --test test/risk.test.ts
    ℹ tests 1  ℹ pass 0  ℹ fail 1
  测试文件因 `flagsAllowed` 未导出而整体加载失败 —— 预期内。

GREEN（写入 v3 实现后）：
    $ npm test
    ℹ tests 30  ℹ pass 30  ℹ fail 0
    $ npm run typecheck    # exit 0

## 控制器独立验证（测试套件之外）
19 条攻击全部判为 risky：
  git log/diff/show --output=、find -fprint/-fprint0/-fprintf、sort -o、tree -o、
  go build -o、npm run、git branch -D、git tag -d、git remote set-url、
  date -s、hostname、printenv、env，以及在只读命令上硬加 --output
17 条日常命令全部判为 safe：
  ls -la、ls -l --color=auto、git status --porcelain、git log --oneline -5、
  git diff HEAD~1 --stat、grep -A 3 -B 1、head -20、tail -f、npm test、
  cargo test、docker ps -a、find -name -maxdepth、date、wc -l、du -sh

## 文件变更
- extensions/feishu/risk.ts（整体替换）
- test/risk.test.ts（整体替换，30 个用例中 16 个属本模块）

## 已知残余（已写入 spec，非漏洞）
仓库内 write 是 safe、npm test 也是 safe，「改 package.json → 跑测试」链在边界内成立。
这是「让代理在仓库里无人值守干活」的固有代价；要堵用 strict 档。
