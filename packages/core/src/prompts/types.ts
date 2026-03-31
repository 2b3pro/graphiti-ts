export const MessageRoles = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool'
} as const;

export type MessageRole = (typeof MessageRoles)[keyof typeof MessageRoles];

export interface Message {
  role: string;
  content: string;
}

export type PromptContext = Record<string, unknown>;

export type PromptFunction = (context: PromptContext) => Message[];
