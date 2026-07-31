// Context message is a chat message tagged with a source for the context registry.
export type ContextMessage = {
  role: 'system' | 'user'
  content: string
  source: string
  createdAt: number
}
