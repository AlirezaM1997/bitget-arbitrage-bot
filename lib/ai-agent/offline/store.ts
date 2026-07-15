import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  serializeOfflineModelArtifact,
  validateOfflineModelArtifact
} from "./artifact";
import type { OfflineModelArtifact } from "./types";

export function aiOfflineModelStorePath() {
  return process.env.AI_MODEL_ARTIFACTS_PATH?.trim()
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "ai-models");
}

/**
 * Writes through a synced temporary file and atomically hard-links it into
 * place. link(2) fails when the target exists, making artifact IDs immutable.
 */
export async function writeOfflineModelArtifact(
  artifactInput: OfflineModelArtifact,
  directory = aiOfflineModelStorePath()
) {
  const artifact = validateOfflineModelArtifact(artifactInput);
  await mkdir(directory, { recursive: true });
  const target = artifactPath(directory, artifact.artifactId);
  const temporary = path.join(directory, `.${artifact.artifactId}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serializeOfflineModelArtifact(artifact as OfflineModelArtifact), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Offline model artifact already exists: ${artifact.artifactId}`, { cause: error });
    }
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return target;
}

export async function readOfflineModelArtifact(
  artifactId: string,
  directory = aiOfflineModelStorePath()
) {
  const parsed = JSON.parse(await readFile(/*turbopackIgnore: true*/ artifactPath(directory, artifactId), "utf8"));
  return validateOfflineModelArtifact(parsed);
}

export async function listOfflineModelArtifactIds(directory = aiOfflineModelStorePath()) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
      .map(entry => entry.name.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function artifactPath(directory: string, artifactId: string) {
  if (!/^[a-zA-Z0-9._-]{1,180}$/.test(artifactId)) throw new Error("Invalid offline artifact id");
  return path.join(directory, `${artifactId}.json`);
}
