import type { LangfuseClient } from "@langfuse/client";
import { BUILTIN_CASES } from "@/evaluation/cases.js";

type DatasetClient = Pick<LangfuseClient, "api" | "dataset">;

export async function syncBuiltinDataset(
  client: DatasetClient,
  datasetName: string,
): Promise<void> {
  try {
    await client.api.datasets.get(datasetName);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await client.api.datasets.create({
      name: datasetName,
      description: "mini-cc 编码 Agent 回归评测集",
      metadata: { schemaVersion: 1 },
    });
  }

  for (const evalCase of BUILTIN_CASES) {
    await client.dataset.createItem({
      id: evalCase.id,
      datasetName,
      input: {
        prompt: evalCase.prompt,
        files: evalCase.files,
      },
      expectedOutput: { objective: evalCase.objective },
      metadata: {
        source: "builtin",
        schemaVersion: 1,
        caseId: evalCase.id,
        name: evalCase.name,
        assertions: evalCase.assertions,
      },
    });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 404;
}
