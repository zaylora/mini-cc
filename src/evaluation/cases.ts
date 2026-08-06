import type { EvalCase } from "@/evaluation/types.js";

const FIXTURE_ENTRY_COUNT = 300;

export const BUILTIN_CASES: EvalCase[] = [
  {
    id: "mini-cc-context-audit-v1",
    name: "跨文件契约审计与压缩",
    prompt: [
      "这是一次上下文压缩压力评测。请先用 glob 找到工作区内全部 12 个夹具文件，再逐一使用 read_file 完整读取，不能只看前几行，也不要用 bash 把多个文件先拼成一个摘要。",
      "请用 todo_write 跟踪读取和核对进度，比较文档、源码契约、环境配置与测试预期中的 api、timeout、retry 和 owner 字段。区分 production 的明确环境覆盖与真正的契约漂移，保留每个结论对应的文件路径和字段值。",
      "完成全部核对后，只新建 audit-report.md，不要修改夹具文件。报告必须包含：读取清单、字段一致性矩阵、确认的环境覆盖、需要修复的漂移、仍需人工确认的风险，以及一段说明压缩后仍必须保留的约束。最后简要说明报告路径和结论。",
    ].join("\n\n"),
    files: {
      "docs/catalog.md": buildFixture({
        title: "Catalog contract",
        domain: "catalog",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "platform",
        status: "active",
      }),
      "docs/authentication.md": buildFixture({
        title: "Authentication contract",
        domain: "authentication",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "identity",
        status: "active",
      }),
      "docs/billing.md": buildFixture({
        title: "Billing contract",
        domain: "billing",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "finance",
        status: "active",
      }),
      "docs/notifications.md": buildFixture({
        title: "Notifications contract",
        domain: "notifications",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "messaging",
        status: "active",
      }),
      "src/contracts/catalog.ts": buildFixture({
        title: "Catalog source contract",
        domain: "catalog",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "platform",
        status: "active",
      }),
      "src/contracts/authentication.ts": buildFixture({
        title: "Authentication source contract",
        domain: "authentication",
        api: "v3",
        timeout: "30",
        retry: "3",
        owner: "identity",
        status: "active",
      }),
      "src/contracts/billing.ts": buildFixture({
        title: "Billing source contract",
        domain: "billing",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "finance",
        status: "active",
      }),
      "src/contracts/notifications.ts": buildFixture({
        title: "Notifications source contract",
        domain: "notifications",
        api: "v2",
        timeout: "45",
        retry: "3",
        owner: "messaging",
        status: "active",
      }),
      "config/staging.json": buildFixture({
        title: "Staging configuration",
        domain: "all-services",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "platform",
        status: "staging",
      }),
      "config/production.json": buildFixture({
        title: "Production configuration",
        domain: "all-services",
        api: "v3",
        timeout: "60",
        retry: "3",
        owner: "sre",
        status: "production-override",
      }),
      "tests/contract-cases.md": buildFixture({
        title: "Contract test expectations",
        domain: "all-services",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "quality",
        status: "required",
      }),
      "CHANGELOG.md": buildFixture({
        title: "Release history",
        domain: "all-services",
        api: "v3",
        timeout: "45",
        retry: "3",
        owner: "release",
        status: "documented",
      }),
    },
    assertions: [
      { type: "file_exists", path: "audit-report.md" },
      {
        type: "file_contains",
        path: "audit-report.md",
        text: "字段一致性矩阵",
      },
      { type: "final_contains", text: "audit-report.md" },
    ],
    objective:
      "完整读取并交叉核对 12 个文件，正确区分环境覆盖、契约漂移和待确认风险，并留下可追溯审计报告",
  },
];

interface FixtureProfile {
  title: string;
  domain: string;
  api: string;
  timeout: string;
  retry: string;
  owner: string;
  status: string;
}

interface PressureCaseInput {
  id: string;
  name: string;
  prompt: string;
  reportPath: string;
  reportHeading: string;
  objective: string;
  files: Record<string, FixtureProfile>;
}

function createPressureCase(input: PressureCaseInput): EvalCase {
  return {
    id: input.id,
    name: input.name,
    prompt: input.prompt,
    files: Object.fromEntries(
      Object.entries(input.files).map(([path, profile]) => [
        path,
        buildFixture(profile),
      ]),
    ),
    assertions: [
      { type: "file_exists", path: input.reportPath },
      {
        type: "file_contains",
        path: input.reportPath,
        text: input.reportHeading,
      },
      { type: "final_contains", text: input.reportPath },
    ],
    objective: input.objective,
  };
}

function buildFixture(profile: FixtureProfile): string {
  const entries = Array.from({ length: FIXTURE_ENTRY_COUNT }, (_, index) => {
    const entry = String(index + 1).padStart(3, "0");
    return [
      `entry-${entry}`,
      `domain=${profile.domain}`,
      `resource=resource-${entry}`,
      `api=${profile.api}`,
      `timeout=${profile.timeout}`,
      `retry=${profile.retry}`,
      `owner=${profile.owner}`,
      `status=${profile.status}`,
      `evidence=retain-${profile.domain}-${entry}`,
    ].join("|");
  });
  return [
    `# ${profile.title}`,
    `domain=${profile.domain}`,
    `api=${profile.api}`,
    `timeout=${profile.timeout}`,
    `retry=${profile.retry}`,
    `owner=${profile.owner}`,
    `status=${profile.status}`,
    "The repeated records below are independent evidence rows; inspect the complete file.",
    ...entries,
    "",
  ].join("\n");
}
