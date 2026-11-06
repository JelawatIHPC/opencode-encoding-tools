# opencode-encoding-tools

在 OpenCode 原生 `read / write / grep / edit / patch`（以及 `apply_patch`、`shell`）之上的**兼容编码**替换实现。

原生工具只按 UTF-8 处理，在中文 Windows 下遇到 GBK / GB2312 / GB18030 / Big5 / 带 BOM 的文件会读错或直接报错。本插件在保持参数与语义与原生一致的前提下，按文件实际编码读写、搜索和编辑，并接管 `shell` 的输出解码。

## 环境要求

- OpenCode 2.x（在 2.2.5 上验证）
- Git（Git 直装需要）
- 运行时依赖由 OpenCode 安装插件时自动拉取，无需单独构建

## 安装

通过 Git 安装并 pin 到 tag：

```bash
opencode plugin add 'github:JelawatIHPC/opencode-encoding-tools#0.1.0'
```

或直接写入 `opencode.jsonc`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-encoding-tools@git+https://github.com/JelawatIHPC/opencode-encoding-tools.git#0.1.0"
  ]
}
```

本地开发时也可以让 `plugins` 指向仓库目录（必须是**目录**，不能指向单个文件；Windows 下写绝对路径，`~` 不会被展开）：

```jsonc
{
  "plugins": ["C:\\work\\opencode-encoding-tools"]
}
```

验证：

```bash
opencode plugin list
```

卸载：

```bash
opencode plugin remove opencode-encoding-tools
```

也可以直接删除 `opencode.jsonc` 中对应的条目。

## 功能

- `read`：目录列举、文本分页（默认 2000 行 / 50KB）、行号输出 `<path>/<type>/<content>`；中文编码文件直接正确解码显示；图片/PDF 按原生附件行为返回。
- `write`：写入新文件或全量重写；已存在文件时沿用其原编码、BOM 与换行风格（LF/CRLF）。
- `edit`：精确文本替换（`path/oldString/newString/replaceAll`），沿用原生「唯一匹配除非 replaceAll」语义与错误信息；**匹配与行尾无关**——oldString 用 LF 或 CRLF 都能命中，包括**混排文件**里 LF-only 的段。替换只落在命中区间，**未命中的行按原字节保留各自行尾**；按文件原编码读写，保留 BOM 与换行风格。
- `grep`：`pattern/path/include/literal/caseSensitive/limit` 与原生一致。
  - `include` 采用 gitignore / ripgrep 语义：不含 `/` 时按**文件名在任意深度**匹配（`*.cpp` 等价于 `**/*.cpp`），含 `/` 时相对搜索根匹配（如 `src/*.cpp`）。
  - 尊重 `.gitignore` / `.ignore` / `.rgignore`，默认跳过隐藏文件与已知二进制扩展名，并按内容嗅探二进制（大文件只读头部，如 `.bin`、`.pdb`，**不读全也不计入预算**）。
  - **不跟随符号链接 / junction**（与 ripgrep 默认一致）。
  - **只按时间限流**（默认 45s，可用 `ENCTOOLS_GREP_TIME_BUDGET_MS` 覆盖），异步让出事件循环；超时截断并说明原因与规模。
  - 每个候选文件至多读一次；跨文件时逐文件识别编码后匹配中文。
- `patch`：解析 `*** Begin Patch / *** Add File / *** Update File / *** Move to / *** Delete File / *** End Patch`，每个文件按其编码、BOM 与换行风格读出、修改、写回；上下文行沿用原行字节，新增行采用该文件的主流行尾；输出 `Success. Updated the following files:`，metadata 含 `diff/files`。

## 编码策略

1. 优先识别 BOM：UTF-8-BOM / UTF-16LE / UTF-16BE / UTF-32LE / UTF-32BE。
2. 无 BOM 先尝试严格 UTF-8 解码。
3. **近 UTF-8**（严格解码失败，但绝大多数多字节序列合法）：当 `valid_multibyte >= 16` 且 `invalid_starts * 2 <= valid_multibyte` 时仍按 UTF-8 解码——少数坏字节用 `U+FFFD` 呈现，而不是把整篇文本按单字节编码解开变成乱码。真正的 GBK/Big5/Shift_JIS 文本中非法序列多于合法序列（实测约 4:1），损坏的 UTF-8 则约 1:10，因此可以稳定区分。
4. **GB18030 四字节**：字节流含合法的 GB18030 四字节序列（`81-FE 30-39 81-FE 30-39`）且整体能严格按 GB18030 往返 → 直接判为 `gb18030`（确定）。该序列在 GBK/Big5/Shift_JIS/单字节文本里不可能出现（这些编码中前导字节后必须 ≥ `0x40`），而 chardet 常把「少量中文 + 大量 ASCII 代码」猜成 `windows-1252`——那样整篇会变乱码，且后续编辑会把这层乱码再按 GB18030 编码写回（二次损坏）。
5. 失败后用 `chardet.analyse` 取候选并归一化：`GB2312/GBK/GB18030` 统一按 `gb18030`（GBK 超集，保留 4 字节字符）；`BIG5`、`Shift_JIS`、`EUC-JP/KR` 按各自编码；`ISO-8859-*` / `windows-125*` / `KOI8-R` 等单字节按各自真实编码。
6. 置信度低且出现 CJK 候选时，按 中文(gb18030) → Big5 → Shift_JIS → EUC 优先；否则兜底 `gb18030`。
7. **判定分档**：UTF-8（BOM / 严格 UTF-8 / 近 UTF-8 / 纯 ASCII）、GB18030 四字节、chardet 满分 100 视为**确定**，静默处理；其余非 UTF-8 视为**不确定**，`write` / `edit` / `patch` 会追加字符集警告。

写盘：新文件默认 UTF-8 + 平台换行（Windows 为 CRLF，其余 LF）；已有文件保留原 `encoding + bom + 换行风格`。若为**确定**编码且内容无法无损表示（如往 Big5 文件写 emoji）→ 报错拒绝；若为**不确定**编码 → 仍写入（选用能表示内容的候选编码）并追加警告。

### 保持 GBK 严格性

- **未传 `charset`**：若现有字节不含四字节扩展、能严格按 GBK 往返（plain GBK），新内容必须落在 **GBK 字符集内**；已含四字节字符的 GB18030 文件不受限。
- **显式传 `charset="gbk"` / `"cp936"`**：这些别名会归一化成 `gb18030`，因此保留**原始拼写**来判断——只要模型要求的是 GBK，无论文件原本是 GBK 还是 GB18030、无论新建还是修改，都**严格按 GBK** 校验。
- **显式传 `charset="gb2312"` / `"GB2312-80"` / `"csgb2312"` / `"euc-cn"`**：按 **GB2312 字表**严格校验（内置 7445 个字符的码表：符号区 1–9、汉字区 16–87，含 5 个符号行的空位；由 GB2312 编解码器生成）。GBK 独有的字（如 `镕`、`喆`、`ⅰ`）与 GB18030 四字节字符都会被拒绝。`iconv-lite` 的 `gb2312` 名其实是 **CP936(GBK) 别名**，`iconv.encode("镕","gb2312")` 会得到 `E9 46` 而不会报错。
- **只有显式 `charset="gb18030"`** 才允许写入 GB18030 四字节字符。
- 违反时报错拒绝，最多列出 3 个越界字符。两条提示都按字符标注 **`GBK-only`** / **`GB18030-only`**（GBK 那条必然全是 `GB18030-only`）——前者用 `charset="gbk"` 即可放行，后者必须 `charset="gb18030"`。
- `charset` 参数**不能**用来「转码」，显式给出冲突字符集会被 `Charset mismatch` 拒绝。要转 UTF-8 只能在工具之外完成（或先删除再新建）。

## 换行处理

- 模型提供的 `content` / `oldString` / `newString` / `patchText` 只需写成纯 LF 或纯 CRLF；两者都会被接受。**新增/写入的内容**会转换为目标文件的换行风格（新文件用平台默认：Windows CRLF）。
- **匹配与行尾无关**：`edit` 的 `oldString`、`patch` 的上下文行都按「行尾归一化」比较，所以 LF 写的 oldString 也能命中 CRLF 文件，反之亦然——包括**混排文件**中 LF-only 的段。命中/上下文之外的字节（含各自的 `\r`）原样保留。
- 若模型输入**混用** LF 与 CRLF（或出现孤立 CR），工具仍会按目标风格写盘，并在成功结果末尾追加 Warning，指明该文件是 LF 还是 CRLF。
- 纯 LF、纯 CRLF 都静默通过，只有混合才被告警。

## 字符集参数（charset）

可选参数：显式声明文件字符集。判定与警告规则：

1. **确定字符集**（BOM、含非 ASCII 的合法 UTF-8、纯 ASCII、或 chardet 满分 100）：若模型给的 `charset` 与之不符，**直接报错拒绝**，并提示检测到的正确字符集。
2. **不确定字符集**（非 UTF-8 且 chardet < 100）：`charset` 仅在该值对该文件字节**可证明不可能**（无法严格解码，或不能字节往返）时报错；否则按模型给的 `charset` 解码与写回，且**不告警**。
3. **不传 `charset` 且文件不确定**：`write` / `edit` / `patch` 照常执行，并在结果末尾追加 Warning，给出最可能的候选字符集及其置信度，提示「确定就传 `charset` 屏蔽」。`read` 不告警。
4. **纯 UTF-8 环境（含纯 ASCII）永不出现字符集警告**。

其他规则：

- 名称会归一化别名（`gbk` / `gb2312` / `cp936` → `gb18030`，`latin1` / `iso-8859-1` → `windows-1252` 等）；未知名称报错并列出支持列表。
- 新建文件（`write` 新路径、`patch` 的 Add File）按 `charset` 编码；内容含该字符集无法表示的字符则报错。
- `patch` 涉及多文件时**逐文件独立判定**：失败的文件跳过并列出原因，其余照常写入，允许部分成功。

## shell（接管原生 shell）

宿主把子进程 stdout 按 **UTF-8** 解码，但 Windows PowerShell 5.1 默认按控制台代码页（GBK/cp936）输出，于是 `shell` 跑 `Get-ChildItem` 之类的中文会变成一片 `�`。

本插件用自带实现接管原生 `shell` 工具（保留同名与相同参数 `command/workdir/timeout/background`），不再依赖宿主的固定 UTF-8 解码：

1. 由插件自己 `spawn` 子进程（Windows：`powershell.exe -NoLogo -NoProfile -NonInteractive -Command`；POSIX：`/bin/sh -c`），`cwd` 取 `workdir`（相对则相对会话目录）。
2. 捕获 stdout/stderr 的**原始字节**（合并、保持到达顺序）。
3. 自适应解码：BOM → 严格 UTF-8 → 高置信 chardet（且命中项不是控制台代码页）→ 系统控制台代码页。
4. **不向命令注入任何内容**。同一命令可能混排不同编码，因此当整段不是合法 UTF-8 时**逐行**判断：该行是合法 UTF-8 就按 UTF-8，否则按控制台代码页；若 chardet 整体判成「控制台代码页本身」，则跳过整段解码直接走逐行。

行为对齐原生 `shell`：

- `workdir` 支持 `~` / `~/...` / `~\...` 展开，并在 spawn 前校验（不存在 → `Working directory does not exist: <abs>`，非目录 → `Working directory is not a directory: <abs>`）。
- 空命令输出 `(no output)`；状态文案与原生逐字一致（超时 `Timed out before completion (<ms> ms)`、中止 `Cancelled`、非零退出 `Exited with code N`、退出码未知 `Exited with code unknown`）。
- `background` 返回原生同款 `Command moved to the background (shell ID: <id>).` 与 `Output is streaming to: <file>`，并把子进程 stdout/stderr **流式写入该文件**；命令结束时通过 `ctx.session.synthetic` 向会话注入完成通知（正文为原生同款 `<shell …>` 块、metadata 同款 `{source:"shell", shellID, state, …}`，但输出按本插件的字符集解码）。
- 输出超过原生阈值（**2000 行 / 51200 字节**）时**保留尾部**，把**原始 stdout/stderr 字节**落盘到系统临时目录下的 `opencode/shell/*.out`，预览末尾附 `[showing lines X-Y of Z; full output saved to <path>]` 和 `[output truncated]`。
- `timeout` 不在 schema 声明 `minimum`（保持入参文案与原生逐字一致），由代码拒绝负数。
- `metadata` 附 `exitCode/encoding/decodeSource/timedOut/aborted/truncated/fullOutputPath`（background 另附 `shellID/outputPath`）。

**边界**：一次命令中若某个程序坚持输出非 UTF-8（如硬编码 GBK），与 UTF-8 部分混排后仍无法两全；可让该程序单独成一条命令。截断阈值取原生默认值；若在配置里自定义过 `tool_output`，本实现目前仍用默认值。

### 同批次错误汇总（batch digest）

OpenCode 对**并发**插件工具的异常有缺陷——同一批次（同一条 assistant 消息）里多个插件工具报错时，宿主会把所有 error 串成**第一条**的消息（原生 `shell` 不受影响）。插件的应对：按 `context.messageID` 归组同一批次的调用——**成功的调用照常返回自己的 content**；只要有一条失败，该批次里所有失败的调用都抛出同一份按序汇总：

```
Batch: N call(s), M failed
  [1] read    ok  <成功正文摘要>
  [2] shell   ERR <该调用错误>
  [3] shell   ok  <成功正文摘要>
```

汇总里**不含任何内部 ID**（不带 `messageID`、也不带调用 ID），只保留序号 + 工具名 + 状态 + 文本。由于失败者抛出的文本完全相同，宿主的串台就失效了，模型始终能看到该批次每条调用的成功/失败全貌。单次调用（批次只有一条）保持原始 error 语义。

边界：失败结果会等待同批兄弟结束（上限 5s，仍未结束者标 `…`）；正文按批次规模自适应截断——每行上限 `clamp(80, 2000/N, 500)` 字符，只保留头部并加 `…`。

## 接口与权限

替换工具沿用原生 `description/input/options`，只替换 `execute`：

- 输入使用**显式声明**的 JSON schema（原生字段 + 可选 `charset`）：`read {path,offset?,limit?,charset?}`、`write {path,content,charset?}`、`edit {path,oldString,newString,replaceAll?,charset?}`、`patch {patchText,charset?}`；`grep` 沿用原生 schema、不带 `charset`（跨多文件）。原生 schema 在插件侧被替换为桩函数，无法读取或合并，故显式声明。
- 执行上下文不提供 `directory`，工作目录取自 `setup` 的 `ctx.location.directory`（插件按 location 实例化）。
- 工具不声明 `output` schema，`execute` 返回 `{ content, metadata }`；`content` 为文本，或 `[{type:"file",uri,mime,name}]`（图片/PDF 附件）。权限走原生 `options.permission`（`read`/`grep`/`edit`）。
- `metadata` 与原生一致（`truncated/matches/diff/files/display` 等）。

## 已知差异

- 插件 `ToolContext` 不暴露宿主 LSP/formatter 服务，因此 `metadata.diagnostics` 恒为 `{}`、不会触发格式化。
- UTF-16/32（带 BOM）现已按文本读取；无 BOM 的 UTF-16 无法可靠识别，仍会走编码猜测。
- 极短或 ASCII 占绝对多数的中文文件（不足数十字节、仅零星中文）可能被 chardet 误判；正常体量的 GBK/GB18030 源码与文本可稳定识别。判定不确定的非 UTF-8 文件会照常读写并追加警告，可用 `charset` 显式指定并屏蔽。
- 图片 / PDF 沿用原生附件行为（按魔数识别常见图片与 `%PDF`）。
- `write` 仍是整文件写入，按文件主流行尾归一；`edit` / `patch` 只改命中区间。
- 字符集警告只在 `write` / `edit` / `patch` 且仅针对非 UTF-8 且判定不确定的文件；纯 UTF-8（含纯 ASCII）与 BOM 文件永不告警。
- `grep` 的 ignore 是 `.gitignore` **近似**实现（支持注释、`!` 反选、尾部 `/` 目录、前导/内嵌 `/` 锚定、`*`/`**`/`?`）；不支持全局 excludesFile 及部分边界语义。
- `grep` 的 `include` 若一个文件都没匹配上，会给出与真正无匹配不同的提示：`No files found — the include pattern "*.bin" matched none of the 52 file(s) scanned.`；metadata 里给出 `includeMatched` / `includeFiltered`。
- `grep` 对极短非 UTF-8 文件：非 ASCII 模式用 GB18030/Big5/Shift_JIS 候选回退解码；ASCII 模式也会对「单字节编码 + 连续 CJK 字符（≥5）且置信度 <40」的文件优先按 GB18030 显示。若原文件是 Big5/Shift_JIS 等其它 CJK 编码的短文件，显示可能仍不正确（匹配本身正确）。
- `grep` 只在**超时**时截断，并说明原因与规模，例如 `Search was cut short — timed out after 45s; scanned 43626 file(s), read 29756. Results may be incomplete.`（零匹配时为 `No matches — search was cut short (…)`）。metadata 给出 `{matches, truncated, budgetHit, budget:{skippedBinary, timedOut}, timedOut, scannedFiles, filesRead, bytesRead}`。
- `grep` 没有文件大小/总字节/文件数上限：真正限制成本的是时间预算；单个大文本文件会被完整读取与搜索。

## 开发

仓库根目录就是插件包根目录，入口为 `src/index.ts`，运行时由 OpenCode 直接加载 TypeScript 源码，不需要构建产物。

```bash
npm install
npm test            # tsc 编译到 dist/，再跑 tests/
npm run compile     # 只编译（供测试与独立 CLI 使用）
node dist/cli.js read/write/grep/patch ...   # 脱离宿主的调试 CLI
```

目录：

```
src/        插件源码（入口 index.ts）
tests/      单元/回归测试，node tests/run.js 统一执行
scripts/    仅构建期辅助（dist 的 CommonJS 标记）
```

测试说明：

- 测试通过 `require("../dist/...")` 加载编译产物，因此需要先 `npm run compile`。
- `shell` 相关用例依赖 Windows PowerShell 与控制台代码页；非 Windows 平台会自动跳过 `shell_test.js` / `plugin_reg_test.js`。
- 测试全部使用系统临时目录，不依赖固定路径。

## 兼容性

| OpenCode | Plugin |
|---|---|
| 2.2.x | 0.1.x |

## License

MIT，见 [LICENSE](LICENSE)。
