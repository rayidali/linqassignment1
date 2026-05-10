import { z } from "zod";

const TextPart = z.object({
  type: z.literal("text"),
  value: z.string(),
});

const MediaPart = z.object({
  type: z.literal("media"),
  id: z.string(),
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  url: z.string().url(),
});

const Part = z.discriminatedUnion("type", [TextPart, MediaPart]);

export const LinqWebhookPayload = z.object({
  event_id: z.string(),
  event_type: z.string(),
  data: z.object({
    id: z.string(),
    chat: z.object({ id: z.string() }),
    sender_handle: z
      .object({
        id: z.string().optional(),
        handle: z.string(),
        service: z.string(),
      })
      .optional(),
    parts: z.array(Part).min(1),
  }),
});

export type LinqWebhookPayload = z.infer<typeof LinqWebhookPayload>;

export const TemplateChoice = z.object({
  template_id: z.string(),
  music_id: z.string(),
  clip_order: z.array(z.string()),
  text_overlays: z.array(
    z.object({
      text: z.string(),
      timestamp: z.number(),
    }),
  ),
});

export type TemplateChoice = z.infer<typeof TemplateChoice>;
