import type { AiTextMessage } from "@/services/api/image";
import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { buildNodeGenerationReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

export type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    label?: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext(inputs, prompt);
    }

    const upstreamText = inputs
        .map((input) => input.text)
        .filter(Boolean)
        .join("\n\n");
    const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = inputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = inputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const selectedInputs: NodeGenerationInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input) {
            let label = labelByNodeId.get(input.nodeId);
            if (!label) {
                label = input.label || generationLabel(input.type, counts[input.type]);
                counts[input.type] += 1;
                labelByNodeId.set(input.nodeId, label);
                if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
                else selectedInputs.push(input);
            }
            nextPrompt += input.type === "text" ? `【${label}】` : label;
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    // Keep the request order stable with the canvas/group order, even when tokens are inserted in reverse order.
    const selectedNodeIds = new Set(selectedInputs.map((input) => input.nodeId));
    const orderedSelectedInputs = inputs.filter((input) => selectedNodeIds.has(input.nodeId));
    const referenceImages = orderedSelectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = orderedSelectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = orderedSelectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    if (!hasToken) {
        return {
            prompt,
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return buildNodeGenerationReferences(nodeId, nodes, connections).flatMap((reference): NodeGenerationInput[] => {
        const sourceNode = nodeById.get(reference.groupNodeId || reference.nodeId);
        if (!sourceNode) return [];
        const image = readReferenceImage(reference, sourceNode);
        if (image) return [{ nodeId: reference.id, type: "image" as const, title: reference.title, label: reference.label, image }];
        const video = readReferenceVideo(reference, sourceNode);
        if (video) return [{ nodeId: reference.id, type: "video" as const, title: reference.title, label: reference.label, video }];
        const audio = readReferenceAudio(reference, sourceNode);
        if (audio) return [{ nodeId: reference.id, type: "audio" as const, title: reference.title, label: reference.label, audio }];
        const text = reference.text || readNodeTextInput(sourceNode);
        if (text) return [{ nodeId: reference.id, type: "text" as const, title: reference.title, label: reference.label, text }];
        return [];
    });
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (type === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function readReferenceImage(reference: CanvasResourceReference, node: CanvasNodeData): ReferenceImage | null {
    if (reference.kind !== "image" || node.type !== CanvasNodeType.Image) return null;
    const metadata = node.metadata;
    const image = reference.imageId ? node.metadata?.images?.find((item) => item.id === reference.imageId) : undefined;
    const storageKey = reference.storageKey || image?.storageKey || metadata?.storageKey;
    const previewUrl = reference.previewUrl || image?.content || metadata?.content || "";
    // Group children are persisted by storageKey. Keep the preview URL for the composer, but
    // let hydrateNodeGenerationContext resolve the actual bytes from local storage before sending.
    const dataUrl = reference.imageId && storageKey ? "" : previewUrl;
    if (!dataUrl && !storageKey) return null;
    return {
        id: reference.id,
        name: `${reference.title || node.title || node.id}.png`,
        type: image?.mimeType || metadata?.mimeType || "image/png",
        dataUrl,
        url: previewUrl || undefined,
        storageKey,
        width: reference.naturalWidth || image?.naturalWidth || metadata?.naturalWidth,
        height: reference.naturalHeight || image?.naturalHeight || metadata?.naturalHeight,
        bytes: image?.bytes || metadata?.bytes,
    };
}

function readReferenceVideo(reference: CanvasResourceReference, node: CanvasNodeData): ReferenceVideo | null {
    if (reference.kind !== "video" || node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(reference: CanvasResourceReference, node: CanvasNodeData): ReferenceAudio | null {
    if (reference.kind !== "audio" || node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
