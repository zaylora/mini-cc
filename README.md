# mini-coding-agent

最小可运行的 Claude Agent Loop：模型可以调用一个 `bash` 工具、读取执行结果并继续决策，直到给出最终回答。

## 开发

```bash
bun install
bun test
bun run typecheck
bun run build
```

源代码放在 `src/`，测试放在 `test/`，构建产物输出到 `dist/`。

## 运行

在项目根目录的 `.env` 中设置配置：

```dotenv
API_KEY=...
BASE_URL=...
MODEL_ID=...
```

```powershell
bun run start
```

默认在当前目录运行。也可以通过 `--cwd` 指定其他工作目录：

```powershell
bun run start -- --cwd E:\github\other-project
```

Agent 可以执行模型生成的 shell 命令，请只在你允许它读写的目录中启动。

## 本地 npm 安装

```powershell
npm run build
npm link
mini-agent
```

不想创建全局链接时，可以在另一个项目中直接安装当前目录：

```powershell
npm install E:\github\mini-cc
npx mini-agent
```
