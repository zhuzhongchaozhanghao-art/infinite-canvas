import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeImage } from "@/types/canvas";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    /** The containing canvas node when this reference points at a group child. */
    groupNodeId?: string;
    /** Stable id of the image inside the group. */
    imageId?: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    storageKey?: string;
    naturalWidth?: number;
    naturalHeight?: number;
    text?: string;
    active: boolean;
};

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true);
}

/** Returns the same expanded references used by the generation pipeline. */
export function buildNodeGenerationReferences(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return labelResourceNodes(getGenerationResourceNodes(nodeId, nodes, connections), true);
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[]) {
    return labelResourceNodes(nodes, true);
}

export async function resolveCanvasReferenceImages(references: CanvasResourceReference[], nodes: CanvasNodeData[]) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    return Promise.all(references.filter((reference) => reference.kind === "image").map(async (reference) => {
        const node = nodesById.get(reference.groupNodeId || reference.nodeId);
        if (!node) throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: reference.title }));
        const metadata = node.metadata;
        const image = reference.imageId ? metadata?.images?.find((item) => item.id === reference.imageId) : undefined;
        const storageKey = reference.storageKey || image?.storageKey || metadata?.storageKey;
        const previewUrl = reference.previewUrl || image?.content || metadata?.content;
        const dataUrl = await imageToDataUrl({ storageKey, url: previewUrl });
        if (!dataUrl.startsWith("data:image/")) throw new Error(i18n.t("agent.composer.mentions.imageReadFailed", { title: reference.title }));
        const meta = reference.naturalWidth && reference.naturalHeight
            ? { width: reference.naturalWidth, height: reference.naturalHeight, mimeType: image?.mimeType || metadata?.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : metadata?.naturalWidth && metadata.naturalHeight && !reference.imageId
              ? { width: metadata.naturalWidth, height: metadata.naturalHeight, mimeType: metadata.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : await readImageMeta(dataUrl);
        return {
            id: `canvas:${reference.id}`,
            name: reference.title,
            type: image?.mimeType || metadata?.mimeType || meta.mimeType,
            size: image?.bytes || metadata?.bytes || getDataUrlByteSize(dataUrl),
            width: meta.width,
            height: meta.height,
            url: previewUrl || dataUrl,
            dataUrl,
        };
    }));
}

/** Expand group children before labels are assigned, so every image gets its own token. */
function expandResourceNode(node: CanvasNodeData): Array<{ node: CanvasNodeData; image?: CanvasNodeImage }> {
    if (node.type !== CanvasNodeType.Image || !isImageGroupNode(node)) return [{ node }];
    return (node.metadata?.images || []).filter(isUsableGroupImage).map((image) => ({ node, image }));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    const node = nodes.find((item) => item.id === nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    return [];
}

function getContextResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return connections
        .filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && isResourceNode(node)));
}

function getConnectedConfigResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextResourceNodes(configConnection.toNodeId, nodes, connections).filter((node) => node.id !== nodeId);
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const expanded = expandResourceNode(node);
        if (node.type === CanvasNodeType.Image && isImageGroupNode(node)) {
            return expanded.flatMap(({ node: groupNode, image }) => {
                if (!image) return [];
                const kind: CanvasResourceKind = "image";
                const index = counts[kind]++;
                const label = labelForKind(kind, index);
                const id = `${groupNode.id}::image:${image.id}`;
                return [{
                    id,
                    nodeId: id,
                    groupNodeId: groupNode.id,
                    imageId: image.id,
                    kind,
                    label,
                    title: `${groupNode.title || label} · ${index + 1}`,
                    previewUrl: image.content || undefined,
                    storageKey: image.storageKey || undefined,
                    naturalWidth: image.naturalWidth || undefined,
                    naturalHeight: image.naturalHeight || undefined,
                    text: undefined,
                    active,
                }];
            });
        }
        const kind = resourceKind(node);
        if (!kind) return [];
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        const index = counts[kind]++;
        const label = labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                previewUrl: node.metadata?.content || resource?.url,
                storageKey: node.metadata?.storageKey,
                naturalWidth: node.metadata?.naturalWidth,
                naturalHeight: node.metadata?.naturalHeight,
                text: resourceText(node),
                active,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (kind === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    return resource?.kind === "text" ? resource.text : undefined;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && (node.metadata?.content || isImageGroupNode(node))) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    // Plugin nodes declare their input eligibility through definition.resource.
    return getNodeDefinition(node.type)?.resource?.(node)?.kind || null;
}

function isImageGroupNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image && Boolean(node.metadata?.imageGroup || (node.metadata?.images?.length || 0) > 1);
}

function isUsableGroupImage(image: CanvasNodeImage) {
    return Boolean(image.content || image.storageKey);
}
