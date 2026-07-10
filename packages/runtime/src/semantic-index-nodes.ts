import path from "node:path";
import {
  semanticStableHash,
  type SemanticChunkMetadata,
  type SemanticIndexNode,
} from "@opencanon/core";

const SemanticNodeKind = {
  Root: "root",
  Dir: "dir",
  File: "file",
  Chunk: "chunk",
} as const satisfies Record<string, SemanticIndexNode["kind"]>;

export function semanticIndexNodesForChunks(chunks: SemanticChunkMetadata[]): SemanticIndexNode[] {
  const childrenByParent = new Map<string, Set<string>>();
  const nodeHashByKey = new Map<string, string>();
  const registerChild = (parent: string, child: string): void => {
    const children = childrenByParent.get(parent) ?? new Set<string>();
    children.add(child);
    childrenByParent.set(parent, children);
  };
  for (const chunk of chunks) {
    const chunkKey = semanticChunkNodeKey(chunk);
    nodeHashByKey.set(chunkKey, semanticStableHash({
      kind: SemanticNodeKind.Chunk,
      id: chunk.id,
      path: chunk.path,
      chunkHash: chunk.chunkHash,
      embeddingHash: chunk.embeddingHash,
      startByte: chunk.range.start.byte,
      endByte: chunk.range.end.byte,
    }));
    registerChild(chunk.path, chunkKey);
  }

  for (const chunk of chunks) {
    const directories = parentDirectories(chunk.path);
    const fileChildren = [...(childrenByParent.get(chunk.path) ?? [])].sort();
    nodeHashByKey.set(chunk.path, semanticStableHash({
      kind: SemanticNodeKind.File,
      path: chunk.path,
      children: fileChildren.map((key) => nodeHashByKey.get(key) ?? ""),
    }));
    registerChild(directories.at(-1) ?? ".", chunk.path);
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const directory = directories[index] ?? ".";
      const parent = directories[index - 1] ?? ".";
      registerChild(parent, directory);
    }
  }

  const directories = [...childrenByParent.keys()]
    .filter((key) => key !== "." && !nodeHashByKey.has(key))
    .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
  for (const directory of directories) {
    const children = [...(childrenByParent.get(directory) ?? [])].sort();
    nodeHashByKey.set(directory, semanticStableHash({
      kind: SemanticNodeKind.Dir,
      path: directory,
      children: children.map((key) => nodeHashByKey.get(key) ?? ""),
    }));
  }
  const rootChildren = [...(childrenByParent.get(".") ?? [])].sort();
  nodeHashByKey.set(".", semanticStableHash({
    kind: SemanticNodeKind.Root,
    children: rootChildren.map((key) => nodeHashByKey.get(key) ?? ""),
  }));

  const nodes: SemanticIndexNode[] = [];
  const addNode = (key: string, kind: SemanticIndexNode["kind"], parentKey: string | null): void => {
    nodes.push({
      key,
      kind,
      hash: nodeHashByKey.get(key) ?? semanticStableHash({ kind, key }),
      parentKey,
      children: [...(childrenByParent.get(key) ?? [])].sort(),
    });
  };
  addNode(".", SemanticNodeKind.Root, null);
  for (const key of [...nodeHashByKey.keys()].filter((key) => key !== ".").sort()) {
    const kind: SemanticIndexNode["kind"] = chunks.some((chunk) => semanticChunkNodeKey(chunk) === key)
      ? SemanticNodeKind.Chunk
      : chunks.some((chunk) => chunk.path === key)
        ? SemanticNodeKind.File
        : SemanticNodeKind.Dir;
    addNode(key, kind, kind === SemanticNodeKind.Chunk ? key.slice(0, key.lastIndexOf("#")) : parentDirectory(key));
  }
  return nodes;
}

export function semanticIndexAncestorNodeKeys(paths: string[]): string[] {
  const keys = new Set<string>(["."]);
  for (const filePath of paths) {
    for (const directory of parentDirectories(filePath)) keys.add(directory);
  }
  return [...keys].sort();
}

function semanticChunkNodeKey(chunk: SemanticChunkMetadata): string {
  return `${chunk.path}#${chunk.id}`;
}

function parentDirectories(filePath: string): string[] {
  const directory = path.posix.dirname(filePath);
  if (!directory || directory === ".") return [];
  const parts = directory.split("/").filter(Boolean);
  const directories: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    directories.push(parts.slice(0, index + 1).join("/"));
  }
  return directories;
}

function parentDirectory(key: string): string {
  const directory = path.posix.dirname(key);
  return directory && directory !== "." ? directory : ".";
}
